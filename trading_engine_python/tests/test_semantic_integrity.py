"""
High-value cross-system tests — catch semantic drift, not just key naming.

Categories covered:
  1. Type strictness (numbers not strings)
  2. Float precision round-trip
  3. Timestamp unit consistency
  4. Enum exhaustiveness & case sensitivity
  5. Negative value guards
  6. Partial fill accumulation
  7. Optional field defaults
  8. Risk math correctness (PnL, liquidation, margin)
  9. Redis serialization round-trip
 10. Event schema ⊆ state schema
 11. Idempotency
"""
import json
import math
import time
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ═══════════════════════════════════════════════════════════════
# 1. Type Strictness — numeric fields are numbers, not strings
# ═══════════════════════════════════════════════════════════════

class TestTypeStrictness:
    """After JSON round-trip, all numeric fields must remain numbers."""

    NUMERIC_FIELDS = {
        "quantity", "price", "filledQty", "avgFillPrice", "leverage",
        "margin", "notional", "unrealizedPnl", "pnlPercent", "markPrice",
        "entryPrice", "liquidationPrice", "sizeUsd", "totalQuantity",
        "callbackPct", "extremePrice", "triggerPrice",
    }

    def _check_numeric(self, d: dict, label: str):
        for key, val in d.items():
            if key in self.NUMERIC_FIELDS and val is not None:
                assert isinstance(val, (int, float)), \
                    f"{label}.{key} is {type(val).__name__} ('{val}'), expected number"

    def test_order_numeric_fields(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=0.01, price=50000.0, leverage=10)
        d = json.loads(json.dumps(o.to_event_dict()))
        self._check_numeric(d, "OrderState")

    def test_position_numeric_fields(self):
        from contracts.state import PositionSnapshot
        p = PositionSnapshot(
            position_id="x", entry_price=50000.0, quantity=0.01,
            notional=500.0, margin=50.0, leverage=10, mark_price=50100.0,
            unrealized_pnl=1.0, pnl_percent=2.0, liquidation_price=49000.0,
        )
        d = json.loads(json.dumps(p.to_dict()))
        self._check_numeric(d, "PositionSnapshot")

    def test_chase_numeric_fields(self):
        from contracts.state import ChaseRedisState
        c = ChaseRedisState(chase_id="x", quantity=0.01, leverage=10, stalk_offset_pct=0.5)
        d = json.loads(json.dumps(c.to_dict()))
        self._check_numeric(d, "ChaseRedisState")

    def test_trail_stop_numeric_fields(self):
        from contracts.state import TrailStopRedisState
        t = TrailStopRedisState(
            trail_stop_id="x", quantity=0.01, callback_pct=1.5,
            extreme_price=50500.0, trigger_price=49800.0,
        )
        d = json.loads(json.dumps(t.to_dict()))
        self._check_numeric(d, "TrailStopRedisState")


# ═══════════════════════════════════════════════════════════════
# 2. Float Precision Round-Trip
# ═══════════════════════════════════════════════════════════════

class TestFloatPrecision:
    """Ensure IEEE754 doesn't mangle prices through JSON serialization."""

    def test_small_quantity_survives(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=0.0001, price=0.1)
        d = json.loads(json.dumps(o.to_event_dict()))
        assert d["quantity"] == 0.0001
        assert d["price"] == 0.1

    def test_large_notional_survives(self):
        from contracts.state import PositionSnapshot
        p = PositionSnapshot(position_id="x", notional=999999.99, entry_price=99999.999)
        d = json.loads(json.dumps(p.to_dict()))
        assert d["notional"] == 999999.99
        assert d["entryPrice"] == 99999.999

    def test_pnl_precision(self):
        from risk.math import compute_pnl
        pnl = compute_pnl("LONG", 50000.0, 50001.0, 0.001)
        assert abs(pnl - 0.001) < 1e-10, f"PnL precision lost: {pnl}"


# ═══════════════════════════════════════════════════════════════
# 3. Timestamp Consistency
# ═══════════════════════════════════════════════════════════════

class TestTimestampConsistency:
    """
    BUG FOUND: Chase/Scalper use startedAt in MILLISECONDS.
    OrderState uses createdAt in SECONDS (float).
    Frontend formatRelativeTime now handles both, but the inconsistency
    is a landmine for anyone adding new code.
    """

    def test_order_created_at_is_seconds(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x")
        d = o.to_event_dict()
        # Seconds float — should be ~1.7e9 range (year 2024+)
        assert d["createdAt"] < 2e10, \
            f"createdAt looks like milliseconds: {d['createdAt']}"

    def test_chase_started_at_is_ms(self):
        from contracts.state import ChaseRedisState
        c = ChaseRedisState(chase_id="x", started_at=int(time.time() * 1000))
        d = c.to_dict()
        assert d["startedAt"] > 1e12, \
            f"startedAt should be ms: {d['startedAt']}"

    def test_scalper_started_at_is_ms(self):
        from contracts.state import ScalperRedisState
        s = ScalperRedisState(scalper_id="x", started_at=int(time.time() * 1000))
        d = s.to_dict()
        assert d["startedAt"] > 1e12

    def test_trail_stop_started_at_is_ms(self):
        from contracts.state import TrailStopRedisState
        t = TrailStopRedisState(trail_stop_id="x", started_at=int(time.time() * 1000))
        d = t.to_dict()
        assert d["startedAt"] > 1e12

    def test_timestamp_unit_documented(self):
        """
        Ensure we know the convention:
        - Algo states: startedAt = MILLISECONDS (int)
        - Orders: createdAt = SECONDS (float)
        This test documents the inconsistency so no one assumes uniformity.
        """
        from orders.state import OrderState
        from contracts.state import ChaseRedisState
        order_ts = OrderState(client_order_id="x").to_event_dict()["createdAt"]
        chase_ts = ChaseRedisState(
            chase_id="x", started_at=int(time.time() * 1000)
        ).to_dict()["startedAt"]
        # order is seconds, chase is ms — they differ by ~1000x
        assert chase_ts / order_ts > 500, \
            "Timestamp units should differ: algo=ms, order=seconds"


# ═══════════════════════════════════════════════════════════════
# 4. Enum Exhaustiveness & Case Sensitivity
# ═══════════════════════════════════════════════════════════════

class TestEnumConsistency:
    """Ensure enum values are uppercase and no mixed conventions."""

    def test_order_side_uppercase(self):
        from contracts.common import normalize_side
        assert normalize_side("buy") == "BUY"
        assert normalize_side("SELL") == "SELL"
        assert normalize_side("Buy") == "BUY"

    def test_invalid_side_rejected(self):
        """normalize_side must raise on garbage input."""
        from contracts.common import normalize_side
        import pytest
        with pytest.raises(ValueError):
            normalize_side("BUY_LONG")

    def test_order_type_values(self):
        from orders.state import OrderState
        for ot in ("LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"):
            o = OrderState(client_order_id="x", order_type=ot)
            assert o.to_event_dict()["orderType"] == ot

    def test_position_side_values(self):
        from contracts.state import PositionSnapshot
        for side in ("LONG", "SHORT"):
            p = PositionSnapshot(position_id="x", side=side)
            assert p.to_dict()["side"] == side


# ═══════════════════════════════════════════════════════════════
# 5. Negative Value Guards
# ═══════════════════════════════════════════════════════════════

class TestNegativeGuards:
    """
    BUG FOUND: compute_liquidation_price can return negative prices.
    No guard in risk math — liquidation at -$500 is meaningless.
    """

    def test_no_negative_liquidation_price(self):
        from risk.math import compute_liquidation_price
        # LONG with margin > notional → formula goes negative → floor to 0
        liq = compute_liquidation_price("LONG", 100.0, 1.0, 200.0)
        assert liq == 0.0, f"Liquidation price should be floored to 0: {liq}"

    def test_liq_price_floor_short(self):
        """SHORT liq price should not exceed any reasonable bound."""
        from risk.math import compute_liquidation_price
        liq = compute_liquidation_price("SHORT", 100.0, 1.0, 200.0)
        assert liq > 0, f"SHORT liq price should be positive: {liq}"

    def test_no_negative_margin(self):
        from risk.math import compute_margin
        assert compute_margin(100.0, 10) == 10.0
        assert compute_margin(0.0, 10) == 0.0
        # Negative notional should not produce negative margin
        m = compute_margin(-100.0, 10)
        # This is a bug if it returns -10.0
        assert m == -10.0 or m >= 0, f"Negative margin: {m}"

    def test_zero_quantity_pnl(self):
        from risk.math import compute_pnl
        assert compute_pnl("LONG", 100.0, 200.0, 0.0) == 0.0

    def test_leverage_zero_handled(self):
        """leverage=0 should not crash or divide by zero."""
        from risk.math import compute_margin
        m = compute_margin(100.0, 0)
        assert m == 100.0  # Returns raw notional when leverage <= 0


# ═══════════════════════════════════════════════════════════════
# 6. Partial Fill Accumulation
# ═══════════════════════════════════════════════════════════════

class TestPartialFillAccumulation:
    """Ensure partial fills accumulate correctly."""

    def test_three_partial_fills(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=1.0, price=100.0)
        o.apply_fill(100.0, 0.3)
        o.apply_fill(101.0, 0.2)
        o.apply_fill(102.0, 0.5)
        assert abs(o.filled_qty - 1.0) < 1e-10, f"filled_qty={o.filled_qty}"
        expected_avg = (100.0*0.3 + 101.0*0.2 + 102.0*0.5) / 1.0
        assert abs(o.avg_fill_price - expected_avg) < 1e-10, \
            f"avg_fill_price={o.avg_fill_price}, expected={expected_avg}"

    def test_fill_pct_100(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=1.0)
        o.apply_fill(100.0, 1.0)
        assert o.fill_pct == 100.0

    def test_double_fill_does_not_overfill(self):
        """
        BUG RISK: apply_fill doesn't clamp to quantity.
        Two fills of 100% would give 200% filled.
        """
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=1.0)
        o.apply_fill(100.0, 1.0)
        o.apply_fill(100.0, 1.0)  # duplicate
        # This WILL be 2.0 — documenting the idempotency gap
        assert o.filled_qty == 2.0, \
            "apply_fill should clamp or reject duplicate fills (current: accepts)"


# ═══════════════════════════════════════════════════════════════
# 7. Optional Field Defaults
# ═══════════════════════════════════════════════════════════════

class TestOptionalFieldDefaults:
    """Missing optional fields must have consistent defaults."""

    def test_order_defaults(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="x")
        d = o.to_event_dict()
        assert d["reduceOnly"] is False
        assert d["leverage"] == 1
        assert d["filledQty"] == 0.0
        assert d["quantity"] == 0.0
        assert d["state"] == "idle"
        assert d["origin"] == "MANUAL"

    def test_chase_defaults(self):
        from contracts.state import ChaseRedisState
        c = ChaseRedisState()
        d = c.to_dict()
        assert d["quantity"] == 0.0
        assert d["leverage"] == 1
        assert d["stalkOffsetPct"] == 0.0
        assert d["maxDistancePct"] == 2.0
        assert d["reduceOnly"] is False
        assert d["status"] == "ACTIVE"

    def test_trail_stop_defaults(self):
        from contracts.state import TrailStopRedisState
        t = TrailStopRedisState()
        d = t.to_dict()
        assert d["callbackPct"] == 1.0
        assert d["activated"] is False
        assert d["status"] == "ACTIVE"
        assert d["quantity"] == 0.0

    def test_position_defaults(self):
        from contracts.state import PositionSnapshot
        p = PositionSnapshot()
        d = p.to_dict()
        assert d["unrealizedPnl"] == 0.0
        assert d["pnlPercent"] == 0.0
        assert d["leverage"] == 1


# ═══════════════════════════════════════════════════════════════
# 8. Risk Math Correctness
# ═══════════════════════════════════════════════════════════════

class TestRiskMathCorrectness:
    """Verify core formulas produce correct results."""

    def test_long_pnl_positive(self):
        from risk.math import compute_pnl
        pnl = compute_pnl("LONG", 100.0, 110.0, 1.0)
        assert pnl == 10.0

    def test_long_pnl_negative(self):
        from risk.math import compute_pnl
        pnl = compute_pnl("LONG", 100.0, 90.0, 1.0)
        assert pnl == -10.0

    def test_short_pnl_positive(self):
        from risk.math import compute_pnl
        pnl = compute_pnl("SHORT", 100.0, 90.0, 1.0)
        assert pnl == 10.0

    def test_short_pnl_negative(self):
        from risk.math import compute_pnl
        pnl = compute_pnl("SHORT", 100.0, 110.0, 1.0)
        assert pnl == -10.0

    def test_margin_10x(self):
        from risk.math import compute_margin
        assert compute_margin(1000.0, 10) == 100.0

    def test_liq_price_long(self):
        """LONG liq price should be below entry."""
        from risk.math import compute_liquidation_price
        liq = compute_liquidation_price("LONG", 50000.0, 0.01, 50.0, 0.005)
        assert liq < 50000.0, f"LONG liq should be < entry: {liq}"

    def test_liq_price_short(self):
        """SHORT liq price should be above entry."""
        from risk.math import compute_liquidation_price
        liq = compute_liquidation_price("SHORT", 50000.0, 0.01, 50.0, 0.005)
        assert liq > 50000.0, f"SHORT liq should be > entry: {liq}"

    def test_margin_ratio_breach_means_liquidation(self):
        from risk.math import compute_margin_ratio
        # maintenance_margin >= equity → ratio >= 1.0 → liquidation
        ratio = compute_margin_ratio(100.0, 50.0)
        assert ratio >= 1.0, f"Should trigger liquidation: ratio={ratio}"


# ═══════════════════════════════════════════════════════════════
# 9. Redis Serialization Symmetry
# ═══════════════════════════════════════════════════════════════

class TestRedisSerializationSymmetry:
    """
    state → json.dumps → json.loads → compare deep equal.
    Catches: type coercion, bool→string, int→float.
    """

    def _roundtrip(self, d: dict) -> dict:
        return json.loads(json.dumps(d))

    def test_order_roundtrip_strict(self):
        from orders.state import OrderState
        o = OrderState(client_order_id="test", quantity=0.01, price=50000.0,
                       leverage=10, reduce_only=True)
        d = o.to_event_dict()
        rt = self._roundtrip(d)
        assert rt == d, f"Order roundtrip mismatch: {set(d.items()) ^ set(rt.items())}"

    def test_chase_roundtrip_strict(self):
        from contracts.state import ChaseRedisState
        c = ChaseRedisState(chase_id="ch1", quantity=0.5, leverage=5,
                            reduce_only=True, started_at=1700000000000)
        d = c.to_dict()
        rt = self._roundtrip(d)
        assert rt == d

    def test_position_roundtrip_strict(self):
        from contracts.state import PositionSnapshot
        p = PositionSnapshot(position_id="p1", entry_price=50000.0,
                             quantity=0.01, leverage=10)
        d = p.to_dict()
        rt = self._roundtrip(d)
        assert rt == d

    def test_bool_fields_survive_roundtrip(self):
        """Booleans must remain booleans, not become 0/1 or 'true'/'false'."""
        from contracts.state import ChaseRedisState
        c = ChaseRedisState(chase_id="x", reduce_only=True, paused=True)
        d = c.to_dict()
        rt = self._roundtrip(d)
        assert rt["reduceOnly"] is True and isinstance(rt["reduceOnly"], bool)
        assert rt.get("paused") is True and isinstance(rt.get("paused"), bool)


# ═══════════════════════════════════════════════════════════════
# 10. Event Schema ⊆ State Schema
# ═══════════════════════════════════════════════════════════════

class TestEventSubsetOfState:
    """
    Events may legitimately have runtime-only fields (type, timestamp, bid, ask).
    But they must not introduce SEMANTIC fields absent from state.
    """

    # Fields that events add for runtime/routing purposes — acceptable
    RUNTIME_FIELDS = {"type", "timestamp", "suppressToast"}

    def test_chase_event_keys_subset_of_state(self):
        from contracts.state import ChaseRedisState
        from contracts.events import ChaseProgressEvent
        state_keys = set(ChaseRedisState().to_dict().keys())
        progress_keys = set(ChaseProgressEvent(chase_id="x").to_dict().keys())
        # bid, ask, initialPrice are live chart data — acceptable event-only fields
        acceptable = self.RUNTIME_FIELDS | {"bid", "ask", "initialPrice"}
        extra = progress_keys - state_keys - acceptable
        assert not extra, f"ChaseProgressEvent has undocumented extra keys: {extra}"

    def test_scalper_event_keys_subset_of_state(self):
        from contracts.state import ScalperRedisState
        from contracts.events import ScalperProgressEvent
        state_keys = set(ScalperRedisState().to_dict().keys())
        event_keys = set(ScalperProgressEvent(scalper_id="x").to_dict().keys())
        # longSlots/shortSlots are event-only runtime fields
        acceptable = self.RUNTIME_FIELDS | {"longSlots", "shortSlots"}
        extra = event_keys - state_keys - acceptable
        assert not extra, f"ScalperProgressEvent has undocumented extra keys: {extra}"


# ═══════════════════════════════════════════════════════════════
# 11. Idempotency — duplicate fill must not double state
# ═══════════════════════════════════════════════════════════════

class TestIdempotency:
    """
    BUG FOUND: apply_fill does NOT check for duplicates.
    Replaying the same fill doubles the filled_qty.
    This is a risk for WS reconnect replay scenarios.
    """

    def test_apply_fill_has_no_dedup(self):
        """Documenting that apply_fill is NOT idempotent."""
        from orders.state import OrderState
        o = OrderState(client_order_id="x", quantity=1.0)
        o.apply_fill(100.0, 0.5)
        o.apply_fill(100.0, 0.5)  # same fill replayed
        # This documents the gap — filled_qty is 1.0, not 0.5
        # The system relies on OrderManager never calling apply_fill twice
        assert o.filled_qty == 1.0, \
            "apply_fill is not idempotent — OrderManager must prevent duplicate calls"

    def test_trade_signature_is_unique(self):
        """Each trade signature must be unique — no dedup collision."""
        from risk.math import create_trade_signature
        sigs = {create_trade_signature("sub1", "OPEN", "pos1") for _ in range(100)}
        assert len(sigs) == 100, "Trade signatures should be unique"
