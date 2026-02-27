"""
pure_logic — Pure, stateless decision functions extracted from algo engines.

These functions contain the CORE logic of each algo with zero I/O.
They take values in, return values out. No Redis, no exchange, no asyncio.

This makes them:
    - Directly testable with truth tables and property tests
    - Composable into simulation harnesses
    - Specifiable as mathematical functions
"""

from __future__ import annotations

from typing import Optional, Tuple


# ══════════════════════════════════════════════════════════════
# Chase: Pure Price Computation
# ══════════════════════════════════════════════════════════════

def chase_compute_price(
    side: str,
    bid: float,
    ask: float,
    offset_pct: float,
) -> float:
    """
    Compute chase limit order price from L1 + offset.

    Pure function — no state, no I/O.

    For BUY:  base = bid, price = bid * (1 - offset_pct/100)
    For SELL: base = ask, price = ask * (1 + offset_pct/100)

    offset_pct == 0 → joins BBO exactly
    offset_pct > 0  → passive offset from BBO
    """
    if side == "BUY":
        return bid * (1 - offset_pct / 100.0)
    return ask * (1 + offset_pct / 100.0)


def chase_should_reprice(
    stalk_mode: str,
    side: str,
    current_price: float,
    new_price: float,
) -> bool:
    """
    Should the chase engine reprice the order?

    Returns True if a cancel+replace should happen.

    Rules:
        none:     NEVER reprice
        maintain: ALWAYS reprice (follow BBO both ways)
        trail:    Only in favorable direction
                  BUY:  only lower (new_price < current_price)
                  SELL: only higher (new_price > current_price)
    """
    if stalk_mode == "none":
        return False

    if stalk_mode == "maintain":
        return True

    if stalk_mode == "trail":
        if side == "BUY":
            return new_price < current_price  # Only move down (favorable for buyer)
        return new_price > current_price  # Only move up (favorable for seller)

    # Unknown mode — don't reprice (safe default)
    return False


def chase_is_max_distance_breached(
    mid: float,
    initial_price: float,
    max_distance_pct: float,
) -> bool:
    """
    Has the market moved too far from the chase's initial price?

    max_distance_pct == 0 → disabled (never breached)

    distance = |mid - initial| / initial * 100
    """
    if max_distance_pct <= 0:
        return False
    if initial_price <= 0:
        return False
    distance_pct = abs(mid - initial_price) / initial_price * 100
    return distance_pct > max_distance_pct


# ══════════════════════════════════════════════════════════════
# Trail Stop: Pure Logic
# ══════════════════════════════════════════════════════════════

def trail_stop_compute_trigger(
    side: str,
    extreme: float,
    trail_pct: float,
) -> float:
    """
    Compute trigger price from extreme and trail percentage.

    LONG:  trigger = extreme * (1 - trail_pct/100)  →  below HWM
    SHORT: trigger = extreme * (1 + trail_pct/100)  →  above LWM
    """
    if side == "LONG":
        return extreme * (1 - trail_pct / 100.0)
    return extreme * (1 + trail_pct / 100.0)


def trail_stop_update_extreme(
    side: str,
    current_extreme: float,
    mid: float,
) -> Tuple[float, bool]:
    """
    Update extreme price (monotone watermark logic).

    Returns (new_extreme, changed).

    LONG:  extreme = max(current, mid)  — high-water mark
    SHORT: extreme = min(current, mid)  — low-water mark
    """
    if side == "LONG":
        if mid > current_extreme:
            return mid, True
        return current_extreme, False
    else:
        if mid < current_extreme:
            return mid, True
        return current_extreme, False


def trail_stop_is_triggered(
    side: str,
    mid: float,
    trigger_price: float,
) -> bool:
    """
    Check if trail stop should trigger.

    LONG:  trigger when mid <= trigger_price (price dropped too far from HWM)
    SHORT: trigger when mid >= trigger_price (price rose too far from LWM)
    """
    if side == "LONG":
        return mid <= trigger_price
    return mid >= trigger_price


def trail_stop_should_activate(
    side: str,
    mid: float,
    activation_price: Optional[float],
) -> bool:
    """
    Check if trail stop should activate (if activation_price is set).

    LONG:  activate when mid >= activation_price
    SHORT: activate when mid <= activation_price
    None:  always activated
    """
    if activation_price is None:
        return True
    if side == "LONG":
        return mid >= activation_price
    return mid <= activation_price


def trail_stop_close_side(position_side: str) -> str:
    """
    Determine the order side for the close market order.

    LONG  → SELL
    SHORT → BUY
    """
    return "SELL" if position_side == "LONG" else "BUY"


# ══════════════════════════════════════════════════════════════
# Risk: Pure PnL & Margin
# ══════════════════════════════════════════════════════════════
# (These already exist in risk/math.py — re-export here for
#  centralized pure logic access in tests)

def pnl(side: str, entry_price: float, close_price: float, quantity: float) -> float:
    """Compute PnL. LONG: (close-entry)*qty. SHORT: (entry-close)*qty."""
    if side == "LONG":
        return (close_price - entry_price) * quantity
    return (entry_price - close_price) * quantity


def pnl_sign(side: str, price_went_up: bool) -> str:
    """
    Expected PnL sign given side and price direction.

    Returns "POSITIVE" or "NEGATIVE".
    """
    if side == "LONG":
        return "POSITIVE" if price_went_up else "NEGATIVE"
    return "NEGATIVE" if price_went_up else "POSITIVE"


# ══════════════════════════════════════════════════════════════
# Symbol: Pure Normalization
# ══════════════════════════════════════════════════════════════

def normalize_symbol_pure(symbol: str) -> str:
    """Normalize any symbol format to Binance native. Pure, no side effects."""
    s = symbol.replace("/", "").replace(":USDT", "").upper()
    if not s.endswith("USDT"):
        s += "USDT"
    return s


def to_ccxt_pure(binance_symbol: str) -> str:
    """Binance native → CCXT format."""
    base = binance_symbol.replace("USDT", "")
    return f"{base}/USDT:USDT"


def to_slash_pure(binance_symbol: str) -> str:
    """Binance native → slash format."""
    base = binance_symbol.replace("USDT", "")
    return f"{base}/USDT"


# ══════════════════════════════════════════════════════════════
# Scalper: Pure helpers
# ══════════════════════════════════════════════════════════════

def scalper_is_price_allowed(
    leg_side: str,
    mid: float,
    long_max_price: Optional[float],
    short_min_price: Optional[float],
) -> bool:
    """
    Check if current price is within bounds for this leg side.

    BUY leg:  mid must be <= long_max_price  (if set)
    SELL leg: mid must be >= short_min_price (if set)
    """
    if leg_side == "BUY" and long_max_price is not None:
        return mid <= long_max_price
    if leg_side == "SELL" and short_min_price is not None:
        return mid >= short_min_price
    return True  # No bound set → always allowed


def scalper_compute_offsets(
    base_offset: float,
    count: int,
    max_spread: float = 2.0,
) -> list:
    """
    Generate exponentially-spread offset percentages centered on base_offset.

    Uses logarithmic distribution matching the engine's _generate_layer_offsets().
    """
    import math
    if count <= 1:
        return [base_offset]
    step = math.log(max_spread) / (count - 1)
    return [
        base_offset * math.exp(-math.log(max_spread) / 2 + step * i)
        for i in range(count)
    ]
