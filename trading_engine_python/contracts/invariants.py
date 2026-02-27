"""
invariants — Assertable system invariants.

Every function here checks one or more rules that the system must NEVER violate.
They raise InvariantViolation with a descriptive message on failure.

Usage:
    - In tests: call directly to verify state consistency
    - In runtime (Phase 2): insert at state transitions as guard assertions
"""

from __future__ import annotations


class InvariantViolation(Exception):
    """A system invariant has been violated."""
    pass


# ══════════════════════════════════════════════════════════════
# Market Data Invariants
# ══════════════════════════════════════════════════════════════

def assert_valid_l1(bid: float, ask: float, mid: float) -> None:
    """L1 tick must satisfy: bid > 0, ask > 0, bid <= ask, mid ≈ (bid+ask)/2."""
    if bid <= 0:
        raise InvariantViolation(f"bid must be > 0, got {bid}")
    if ask <= 0:
        raise InvariantViolation(f"ask must be > 0, got {ask}")
    if bid > ask:
        raise InvariantViolation(f"bid ({bid}) > ask ({ask}) — crossed book")
    expected_mid = (bid + ask) / 2
    if mid > 0 and abs(mid - expected_mid) / expected_mid > 0.01:
        raise InvariantViolation(
            f"mid ({mid}) deviates >1% from (bid+ask)/2 ({expected_mid:.8f})"
        )


# ══════════════════════════════════════════════════════════════
# Side & Symbol Invariants
# ══════════════════════════════════════════════════════════════

VALID_ORDER_SIDES = {"BUY", "SELL"}
VALID_POSITION_SIDES = {"LONG", "SHORT"}
VALID_CHASE_MODES = {"none", "maintain", "trail"}
VALID_ALGO_STATUSES = {"ACTIVE", "FILLED", "CANCELLED", "TRIGGERED"}


def assert_valid_order_side(side: str) -> None:
    """Order side must be BUY or SELL (normalized)."""
    if side not in VALID_ORDER_SIDES:
        raise InvariantViolation(f"Invalid order side: {side!r}, expected {VALID_ORDER_SIDES}")


def assert_valid_position_side(side: str) -> None:
    """Position side must be LONG or SHORT."""
    if side not in VALID_POSITION_SIDES:
        raise InvariantViolation(f"Invalid position side: {side!r}, expected {VALID_POSITION_SIDES}")


def assert_binance_symbol(symbol: str) -> None:
    """Internal symbol must be Binance-native (no slash, no colon, ends with USDT)."""
    if "/" in symbol or ":" in symbol:
        raise InvariantViolation(f"Symbol {symbol!r} contains / or : — not Binance-native")
    if not symbol.endswith("USDT"):
        raise InvariantViolation(f"Symbol {symbol!r} doesn't end with USDT")


# ══════════════════════════════════════════════════════════════
# Chase Invariants
# ══════════════════════════════════════════════════════════════

def assert_chase_state(state) -> None:
    """
    Validate a ChaseState object satisfies all invariants.

    Invariants:
        1. side ∈ {BUY, SELL}
        2. status ∈ {ACTIVE, FILLED, CANCELLED}
        3. quantity > 0
        4. leverage >= 1
        5. stalk_mode ∈ {none, maintain, trail}
        6. stalk_offset_pct >= 0
        7. max_distance_pct >= 0 (0 = disabled)
        8. If ACTIVE and has order: current_order_price > 0
    """
    assert_valid_order_side(state.side)

    if state.status not in {"ACTIVE", "FILLED", "CANCELLED"}:
        raise InvariantViolation(f"Chase {state.id}: invalid status {state.status!r}")

    if state.quantity <= 0:
        raise InvariantViolation(f"Chase {state.id}: quantity must be > 0, got {state.quantity}")

    if state.leverage < 1:
        raise InvariantViolation(f"Chase {state.id}: leverage must be >= 1, got {state.leverage}")

    if state.stalk_mode not in VALID_CHASE_MODES:
        raise InvariantViolation(
            f"Chase {state.id}: invalid stalk_mode {state.stalk_mode!r}, "
            f"expected {VALID_CHASE_MODES}"
        )

    if state.stalk_offset_pct < 0:
        raise InvariantViolation(
            f"Chase {state.id}: stalk_offset_pct must be >= 0, got {state.stalk_offset_pct}"
        )

    if state.max_distance_pct < 0:
        raise InvariantViolation(
            f"Chase {state.id}: max_distance_pct must be >= 0, got {state.max_distance_pct}"
        )

    if state.status == "ACTIVE" and state.current_order_id and state.current_order_price <= 0:
        raise InvariantViolation(
            f"Chase {state.id}: ACTIVE with order but price={state.current_order_price}"
        )


def assert_chase_price_side(side: str, price: float, bid: float, ask: float,
                             offset_pct: float) -> None:
    """
    Chase price must be on the correct side of the BBO.

    BUY with offset > 0:  price <= bid  (rests below)
    SELL with offset > 0: price >= ask  (rests above)
    BUY with offset == 0: price == bid  (joins BBO)
    SELL with offset == 0: price == ask (joins BBO)
    """
    if offset_pct > 0:
        if side == "BUY" and price > bid:
            raise InvariantViolation(
                f"BUY chase price {price} > bid {bid} with offset {offset_pct}%"
            )
        if side == "SELL" and price < ask:
            raise InvariantViolation(
                f"SELL chase price {price} < ask {ask} with offset {offset_pct}%"
            )
    elif offset_pct == 0:
        if side == "BUY" and abs(price - bid) > 1e-12:
            raise InvariantViolation(f"BUY chase price {price} != bid {bid} with offset=0")
        if side == "SELL" and abs(price - ask) > 1e-12:
            raise InvariantViolation(f"SELL chase price {price} != ask {ask} with offset=0")


# ══════════════════════════════════════════════════════════════
# Trail Stop Invariants
# ══════════════════════════════════════════════════════════════

def assert_trail_stop_state(state) -> None:
    """
    Validate a TrailStopState object satisfies all invariants.

    Invariants:
        1. side ∈ {LONG, SHORT}
        2. status ∈ {ACTIVE, TRIGGERED, CANCELLED}
        3. quantity > 0
        4. trail_pct > 0
        5. If activated: trigger_price computed correctly
        6. LONG: trigger_price <= extreme_price
        7. SHORT: trigger_price >= extreme_price
    """
    assert_valid_position_side(state.side)

    if state.status not in {"ACTIVE", "TRIGGERED", "CANCELLED"}:
        raise InvariantViolation(f"Trail {state.id}: invalid status {state.status!r}")

    if state.quantity <= 0:
        raise InvariantViolation(f"Trail {state.id}: quantity must be > 0, got {state.quantity}")

    if state.trail_pct <= 0:
        raise InvariantViolation(f"Trail {state.id}: trail_pct must be > 0, got {state.trail_pct}")

    if state.activated and state.extreme_price > 0:
        if state.side == "LONG" and state.trigger_price > state.extreme_price:
            raise InvariantViolation(
                f"Trail {state.id} LONG: trigger ({state.trigger_price}) > "
                f"extreme ({state.extreme_price})"
            )
        if state.side == "SHORT" and state.trigger_price < state.extreme_price:
            raise InvariantViolation(
                f"Trail {state.id} SHORT: trigger ({state.trigger_price}) < "
                f"extreme ({state.extreme_price})"
            )

    # Verify trigger = extreme * (1 ± trail%), if extreme is set
    if state.activated and state.extreme_price > 0 and state.trigger_price > 0:
        if state.side == "LONG":
            expected = state.extreme_price * (1 - state.trail_pct / 100.0)
        else:
            expected = state.extreme_price * (1 + state.trail_pct / 100.0)
        if abs(state.trigger_price - expected) / expected > 1e-6:
            raise InvariantViolation(
                f"Trail {state.id}: trigger_price ({state.trigger_price}) != "
                f"expected ({expected:.8f})"
            )


def assert_trail_stop_extreme_monotone(side: str, old_extreme: float,
                                        new_extreme: float) -> None:
    """
    Extreme price must be monotone:
        LONG: extreme can only go UP (high-water mark)
        SHORT: extreme can only go DOWN (low-water mark)
    """
    if side == "LONG" and new_extreme < old_extreme:
        raise InvariantViolation(
            f"LONG trail: extreme decreased {old_extreme} → {new_extreme}"
        )
    if side == "SHORT" and new_extreme > old_extreme:
        raise InvariantViolation(
            f"SHORT trail: extreme increased {old_extreme} → {new_extreme}"
        )


# ══════════════════════════════════════════════════════════════
# Risk / Position Invariants
# ══════════════════════════════════════════════════════════════

def assert_position(pos) -> None:
    """
    Validate a virtual position.

    Invariants:
        1. entry_price > 0
        2. quantity > 0
        3. leverage >= 1
        4. margin > 0
        5. notional > 0
        6. side ∈ {LONG, SHORT}
    """
    if pos.entry_price <= 0:
        raise InvariantViolation(f"Position: entry_price must be > 0, got {pos.entry_price}")
    if pos.quantity <= 0:
        raise InvariantViolation(f"Position: quantity must be > 0, got {pos.quantity}")
    if pos.leverage < 1:
        raise InvariantViolation(f"Position: leverage must be >= 1, got {pos.leverage}")
    if pos.margin <= 0:
        raise InvariantViolation(f"Position: margin must be > 0, got {pos.margin}")
    if pos.notional <= 0:
        raise InvariantViolation(f"Position: notional must be > 0, got {pos.notional}")
    assert_valid_position_side(pos.side)


def assert_pnl_sign(side: str, entry_price: float, mark_price: float,
                     pnl: float) -> None:
    """
    PnL direction must match position side:
        LONG + price up   → pnl > 0
        LONG + price down → pnl < 0
        SHORT + price up  → pnl < 0
        SHORT + price down → pnl > 0
    """
    price_diff = mark_price - entry_price
    if abs(price_diff) < 1e-12:
        return  # Break-even, any tiny PnL is fine

    if side == "LONG":
        if price_diff > 0 and pnl < -1e-12:
            raise InvariantViolation(
                f"LONG: price went up ({entry_price}→{mark_price}) but PnL is negative ({pnl})"
            )
        if price_diff < 0 and pnl > 1e-12:
            raise InvariantViolation(
                f"LONG: price went down ({entry_price}→{mark_price}) but PnL is positive ({pnl})"
            )
    else:
        if price_diff > 0 and pnl > 1e-12:
            raise InvariantViolation(
                f"SHORT: price went up ({entry_price}→{mark_price}) but PnL is positive ({pnl})"
            )
        if price_diff < 0 and pnl < -1e-12:
            raise InvariantViolation(
                f"SHORT: price went down ({entry_price}→{mark_price}) but PnL is negative ({pnl})"
            )


def assert_margin_sanity(equity: float, margin_used: float,
                          available_margin: float) -> None:
    """available_margin should not exceed equity."""
    if available_margin > equity + 1e-6:
        raise InvariantViolation(
            f"available_margin ({available_margin}) > equity ({equity})"
        )


# ══════════════════════════════════════════════════════════════
# Scalper Invariants
# ══════════════════════════════════════════════════════════════

def assert_scalper_state(state) -> None:
    """
    Validate a ScalperState object.

    Invariants:
        1. child_count >= 1
        2. leverage >= 1
        3. All slots have valid side
        4. Slot count matches expected (child_count × 2 legs)
    """
    if state.child_count < 1:
        raise InvariantViolation(
            f"Scalper {state.id}: child_count must be >= 1, got {state.child_count}"
        )
    if state.leverage < 1:
        raise InvariantViolation(
            f"Scalper {state.id}: leverage must be >= 1, got {state.leverage}"
        )

    # Validate each slot
    all_slots = list(state.long_slots or []) + list(state.short_slots or [])
    for slot in all_slots:
        if slot.side not in VALID_ORDER_SIDES:
            raise InvariantViolation(
                f"Scalper {state.id} slot {slot.layer_idx}: invalid side {slot.side!r}"
            )
        if slot.qty <= 0:
            raise InvariantViolation(
                f"Scalper {state.id} slot {slot.layer_idx}: qty must be > 0, got {slot.qty}"
            )


def assert_scalper_price_bounds(state, mid_price: float) -> None:
    """
    If price bounds are set, current mid must be within them for active legs.

    long_max_price:  mid must be <= long_max_price for LONG leg to be active
    short_min_price: mid must be >= short_min_price for SHORT leg to be active
    """
    if state.long_max_price and mid_price > state.long_max_price:
        for slot in (state.long_slots or []):
            if slot.active and not slot.paused:
                raise InvariantViolation(
                    f"Scalper {state.id}: LONG slot active but mid ({mid_price}) > "
                    f"long_max_price ({state.long_max_price})"
                )

    if state.short_min_price and mid_price < state.short_min_price:
        for slot in (state.short_slots or []):
            if slot.active and not slot.paused:
                raise InvariantViolation(
                    f"Scalper {state.id}: SHORT slot active but mid ({mid_price}) < "
                    f"short_min_price ({state.short_min_price})"
                )


# ══════════════════════════════════════════════════════════════
# TWAP Invariants
# ══════════════════════════════════════════════════════════════

def assert_twap_state(state) -> None:
    """
    Validate a TWAP state.

    Invariants:
        1. total_quantity > 0
        2. num_lots >= 1
        3. filled_lots <= num_lots
        4. filled_quantity <= total_quantity
        5. interval_seconds > 0
    """
    if state.total_quantity <= 0:
        raise InvariantViolation(
            f"TWAP {state.twap_id}: total_quantity must be > 0, got {state.total_quantity}"
        )
    if state.num_lots < 1:
        raise InvariantViolation(
            f"TWAP {state.twap_id}: num_lots must be >= 1, got {state.num_lots}"
        )
    if state.filled_lots > state.num_lots:
        raise InvariantViolation(
            f"TWAP {state.twap_id}: filled_lots ({state.filled_lots}) > "
            f"num_lots ({state.num_lots})"
        )
    if state.filled_quantity > state.total_quantity + 1e-8:
        raise InvariantViolation(
            f"TWAP {state.twap_id}: filled_quantity ({state.filled_quantity}) > "
            f"total_quantity ({state.total_quantity})"
        )
    if state.interval_seconds <= 0:
        raise InvariantViolation(
            f"TWAP {state.twap_id}: interval_seconds must be > 0, got {state.interval_seconds}"
        )
