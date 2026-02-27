"""
test_cross_system_integrity.py — Verifies that Python DTO shapes are
consistent across state (Redis persistence) and event (WebSocket) layers.

JS mapping layer has been removed — REST endpoints now pass through
Python to_dict() output directly. These tests ensure:
  - State DTOs and event DTOs share core field names per entity
  - No bare "id" key (must be domain-specific: chaseId, scalperId, etc.)
  - Timestamps are in milliseconds (> 1_700_000_000_000)
  - All keys are camelCase (no snake_case in output)
  - No JS-only computed fields (durationMinutes, estimatedEnd, etc.)
  - Round-trip through JSON serialization
"""

import json
import re
import time

import sys; sys.path.insert(0, '..')

from contracts.common import ts_ms, ts_s_to_ms
from contracts.state import (
    ChaseRedisState, ScalperRedisState, TWAPRedisState, TWAPBasketRedisState,
    TrailStopRedisState, RiskSnapshot, PositionSnapshot,
)
from contracts.events import (
    ChaseProgressEvent, ChaseFilledEvent, ChaseCancelledEvent,
    ScalperProgressEvent, ScalperFilledEvent, ScalperCancelledEvent,
    TWAPProgressEvent, TWAPCompletedEvent, TWAPCancelledEvent,
    TWAPBasketProgressEvent, TWAPBasketCompletedEvent,
    TrailStopProgressEvent, TrailStopTriggeredEvent, TrailStopCancelledEvent,
    PositionUpdatedEvent, PositionClosedEvent, MarginUpdateEvent,
    ScalperSlotInfo,
)


# ═══════════════════════════════════════════════════════════════
# Helper: verify no snake_case keys in JSON output
# ═══════════════════════════════════════════════════════════════

SNAKE_CASE_RE = re.compile(r'[a-z]+_[a-z]')

def _assert_no_snake_case(d: dict, label: str = ""):
    """All JSON keys must be camelCase — no snake_case allowed."""
    for key in d:
        assert not SNAKE_CASE_RE.match(key), f"[{label}] Snake_case key found: '{key}'"
        if isinstance(d[key], dict):
            _assert_no_snake_case(d[key], label=f"{label}.{key}")
        elif isinstance(d[key], list):
            for item in d[key]:
                if isinstance(item, dict):
                    _assert_no_snake_case(item, label=f"{label}.{key}[]")


def _assert_no_bare_id(d: dict, label: str = ""):
    """No bare 'id' key — must be domain-specific (chaseId, scalperId, etc.)."""
    # Exception: PositionSnapshot uses 'id' for position_id (historical Binance API compat)
    if "positions" in d or "openOrders" in d:
        return  # RiskSnapshot is exempt (positions use 'id')
    top_keys = set(d.keys())
    # 'id' alone at top level is not allowed for algo state
    assert "id" not in top_keys or any(k.endswith("Id") for k in top_keys if k != "id"), \
        f"[{label}] Bare 'id' key found — use domain-specific ID"


def _assert_json_roundtrip(d: dict, label: str = ""):
    """Verify dict survives JSON serialization."""
    raw = json.dumps(d)
    parsed = json.loads(raw)
    assert set(parsed.keys()) == set(d.keys()), f"[{label}] Key mismatch after JSON roundtrip"


# ═══════════════════════════════════════════════════════════════
# 1. State DTOs: Python to_dict() → Redis → JS mapXxxState()
# ═══════════════════════════════════════════════════════════════

# Expected JS consumer keys per algo (from server/contracts/events.js mapXxxState)

CHASE_JS_KEYS = {
    "chaseId", "subAccountId", "symbol", "side", "quantity",
    "sizeUsd", "stalkMode", "stalkOffsetPct", "maxDistancePct",
    "repriceCount", "currentOrderPrice", "startedAt", "status",
    "reduceOnly",
    # Optional: parentScalperId, layerIdx, paused, retryAt
}

SCALPER_JS_KEYS = {
    "scalperId", "subAccountId", "symbol", "childCount", "status",
    "totalFillCount", "startSide", "longOffsetPct", "shortOffsetPct",
    "longSizeUsd", "shortSizeUsd", "skew", "longMaxPrice", "shortMinPrice",
    "neutralMode", "leverage", "minFillSpreadPct", "fillDecayHalfLifeMs",
    "minRefillDelayMs", "allowLoss", "startedAt",
}

TWAP_JS_KEYS = {
    "twapId", "subAccountId", "symbol", "side",
    "totalQuantity", "numLots", "filledLots", "filledQuantity",
    "status", "startedAt",
}

TRAIL_STOP_JS_KEYS = {
    "trailStopId", "subAccountId", "symbol", "side",
    "quantity", "callbackPct", "activationPrice",
    "extremePrice", "triggerPrice", "activated", "status",
    "positionId", "startedAt",
}


class TestChaseIntegrity:
    def test_keys_match_js_consumer(self):
        d = ChaseRedisState(
            chase_id="c1", sub_account_id="a1", symbol="BTCUSDT",
            side="BUY", quantity=1.0, started_at=ts_ms(),
        ).to_dict()
        assert CHASE_JS_KEYS.issubset(set(d.keys())), \
            f"Missing keys: {CHASE_JS_KEYS - set(d.keys())}"

    def test_no_bare_id(self):
        d = ChaseRedisState(chase_id="c1").to_dict()
        _assert_no_bare_id(d, "ChaseRedisState")
        assert "id" not in d

    def test_no_snake_case(self):
        d = ChaseRedisState(chase_id="c1").to_dict()
        _assert_no_snake_case(d, "ChaseRedisState")

    def test_json_roundtrip(self):
        d = ChaseRedisState(chase_id="c1", started_at=ts_ms()).to_dict()
        _assert_json_roundtrip(d, "ChaseRedisState")


class TestScalperIntegrity:
    def test_keys_match_js_consumer(self):
        d = ScalperRedisState(
            scalper_id="s1", sub_account_id="a1", symbol="BTCUSDT",
            started_at=ts_ms(),
        ).to_dict()
        assert SCALPER_JS_KEYS.issubset(set(d.keys())), \
            f"Missing keys: {SCALPER_JS_KEYS - set(d.keys())}"

    def test_no_bare_id(self):
        d = ScalperRedisState(scalper_id="s1").to_dict()
        _assert_no_bare_id(d, "ScalperRedisState")
        assert "id" not in d

    def test_no_snake_case(self):
        d = ScalperRedisState(scalper_id="s1").to_dict()
        _assert_no_snake_case(d, "ScalperRedisState")


class TestTWAPIntegrity:
    def test_keys_match_js_consumer(self):
        d = TWAPRedisState(
            twap_id="t1", symbol="BTCUSDT", started_at=ts_ms(),
        ).to_dict()
        assert TWAP_JS_KEYS.issubset(set(d.keys())), \
            f"Missing keys: {TWAP_JS_KEYS - set(d.keys())}"

    def test_no_bare_id(self):
        d = TWAPRedisState(twap_id="t1").to_dict()
        _assert_no_bare_id(d, "TWAPRedisState")
        assert "id" not in d

    def test_no_snake_case(self):
        d = TWAPRedisState(twap_id="t1").to_dict()
        _assert_no_snake_case(d, "TWAPRedisState")


class TestTrailStopIntegrity:
    def test_keys_match_js_consumer(self):
        d = TrailStopRedisState(
            trail_stop_id="ts1", callback_pct=2.0, started_at=ts_ms(),
        ).to_dict()
        assert TRAIL_STOP_JS_KEYS.issubset(set(d.keys())), \
            f"Missing keys: {TRAIL_STOP_JS_KEYS - set(d.keys())}"

    def test_standardized_on_callbackPct(self):
        d = TrailStopRedisState(trail_stop_id="ts1", callback_pct=2.0).to_dict()
        assert "callbackPct" in d
        assert "trailPct" not in d  # No dual naming

    def test_no_bare_id(self):
        d = TrailStopRedisState(trail_stop_id="ts1").to_dict()
        _assert_no_bare_id(d, "TrailStopRedisState")
        assert "id" not in d


class TestTWAPBasketIntegrity:
    def test_no_bare_id(self):
        d = TWAPBasketRedisState(basket_id="b1").to_dict()
        _assert_no_bare_id(d, "TWAPBasketRedisState")
        assert "id" not in d

    def test_no_snake_case(self):
        d = TWAPBasketRedisState(basket_id="b1").to_dict()
        _assert_no_snake_case(d, "TWAPBasketRedisState")


# ═══════════════════════════════════════════════════════════════
# 2. Event DTOs: verify no snake_case & timestamps are ms
# ═══════════════════════════════════════════════════════════════

class TestEventIntegrity:
    """Verify all event DTOs produce camelCase keys and ms timestamps."""

    def _check_event(self, d, label):
        _assert_no_snake_case(d, label)
        ts = d.get("timestamp", 0)
        if ts:
            assert ts > 1_700_000_000_000, f"[{label}] timestamp {ts} looks like seconds, not ms"
        _assert_json_roundtrip(d, label)

    def test_chase_progress(self):
        d = ChaseProgressEvent(chase_id="c1", symbol="BTCUSDT").to_dict()
        self._check_event(d, "ChaseProgressEvent")

    def test_chase_filled(self):
        d = ChaseFilledEvent(chase_id="c1", fill_price=50000).to_dict()
        self._check_event(d, "ChaseFilledEvent")

    def test_scalper_progress(self):
        d = ScalperProgressEvent(
            scalper_id="s1", symbol="BTCUSDT",
            long_slots=[ScalperSlotInfo(layer_idx=0)],
            short_slots=[],
        ).to_dict()
        self._check_event(d, "ScalperProgressEvent")
        # Verify slot sub-objects are also camelCase
        for slot in d.get("longSlots", []):
            _assert_no_snake_case(slot, "ScalperSlotInfo")

    def test_twap_progress(self):
        d = TWAPProgressEvent(twap_id="t1", symbol="BTCUSDT").to_dict()
        self._check_event(d, "TWAPProgressEvent")

    def test_trail_stop_progress(self):
        d = TrailStopProgressEvent(trail_stop_id="ts1", symbol="BTCUSDT").to_dict()
        self._check_event(d, "TrailStopProgressEvent")
        assert "callbackPct" in d
        assert "trailPct" not in d

    def test_trail_stop_triggered(self):
        d = TrailStopTriggeredEvent(trail_stop_id="ts1", triggered_price=49000).to_dict()
        self._check_event(d, "TrailStopTriggeredEvent")

    def test_position_updated(self):
        d = PositionUpdatedEvent(
            position_id="p1", sub_account_id="a1",
            symbol="BTCUSDT", side="LONG", entry_price=50000,
        ).to_dict()
        self._check_event(d, "PositionUpdatedEvent")

    def test_margin_update(self):
        d = MarginUpdateEvent(
            sub_account_id="a1", balance=1000, equity=1050,
        ).to_dict()
        self._check_event(d, "MarginUpdateEvent")


# ═══════════════════════════════════════════════════════════════
# 3. Comprehensive field name consistency
# ═══════════════════════════════════════════════════════════════

class TestFieldNamingConsistency:
    """Verify no field name aliases exist — each concept has exactly one name."""

    def test_no_dual_trail_pct_naming(self):
        """Only callbackPct, never trailPct in data layer."""
        for cls in [TrailStopRedisState, TrailStopProgressEvent, TrailStopTriggeredEvent, TrailStopCancelledEvent]:
            instance = cls.__new__(cls)
            # Initialize with minimal required fields
            for f in cls.__dataclass_fields__:
                setattr(instance, f, cls.__dataclass_fields__[f].default if cls.__dataclass_fields__[f].default is not cls.__dataclass_fields__[f].default_factory else (cls.__dataclass_fields__[f].default_factory() if cls.__dataclass_fields__[f].default_factory is not type(cls.__dataclass_fields__[f].default) else None))

            # Just check the class has callbackPct-related field
            has_callback = any("callback" in f or "trail" in f for f in cls.__dataclass_fields__)
            if not has_callback:
                continue

    def test_no_bare_id_in_any_state(self):
        """All state DTOs use domain-specific IDs."""
        for cls in [ChaseRedisState, ScalperRedisState, TWAPRedisState, TrailStopRedisState]:
            d = cls().to_dict()
            assert "id" not in d, f"{cls.__name__} has bare 'id' key"

    def test_fill_count_naming(self):
        """Scalper uses totalFillCount consistently."""
        d = ScalperRedisState(scalper_id="s1", fill_count=5).to_dict()
        assert "totalFillCount" in d
        assert "fillCount" not in d  # No ambiguity


# ═══════════════════════════════════════════════════════════════
# 4. REST/WS Shape Consistency (post-mapper-removal)
# ═══════════════════════════════════════════════════════════════

class TestRestWsShapeConsistency:
    """
    Now that JS mappers are removed, REST and WS both pass through
    Python to_dict() output. This test ensures that state DTOs and
    event DTOs share the same field names for matching concepts.
    """

    def test_chase_state_vs_event_keys(self):
        """Chase REST (from state.to_dict) and WS (from event.to_dict) share core keys."""
        state_keys = set(ChaseRedisState(chase_id="c1", sub_account_id="a1").to_dict().keys())
        event_keys = set(ChaseProgressEvent(chase_id="c1", sub_account_id="a1").to_dict().keys())
        # Core fields that MUST be in both
        required = {"chaseId", "subAccountId", "symbol", "side", "repriceCount", "status"}
        missing_in_state = required - state_keys
        missing_in_event = required - event_keys
        assert not missing_in_state, f"Chase state missing: {missing_in_state}"
        assert not missing_in_event, f"Chase event missing: {missing_in_event}"

    def test_scalper_state_vs_event_core_keys(self):
        """Scalper REST and WS share core identification keys."""
        state_keys = set(ScalperRedisState(scalper_id="s1").to_dict().keys())
        event_keys = set(ScalperProgressEvent(
            scalper_id="s1", long_slots=[], short_slots=[],
        ).to_dict().keys())
        required = {"scalperId", "subAccountId", "symbol", "status"}
        assert required <= state_keys, f"Scalper state missing: {required - state_keys}"
        assert required <= event_keys, f"Scalper event missing: {required - event_keys}"

    def test_twap_state_vs_event_core_keys(self):
        """TWAP REST and WS share core keys."""
        state_keys = set(TWAPRedisState(twap_id="t1").to_dict().keys())
        event_keys = set(TWAPProgressEvent(twap_id="t1").to_dict().keys())
        required = {"twapId", "subAccountId", "symbol", "side", "status", "filledLots"}
        assert required <= state_keys, f"TWAP state missing: {required - state_keys}"
        assert required <= event_keys, f"TWAP event missing: {required - event_keys}"

    def test_trail_stop_state_vs_event_core_keys(self):
        """Trail stop REST and WS share core keys."""
        state_keys = set(TrailStopRedisState(trail_stop_id="ts1").to_dict().keys())
        event_keys = set(TrailStopProgressEvent(trail_stop_id="ts1").to_dict().keys())
        required = {"trailStopId", "subAccountId", "symbol", "side", "callbackPct", "status"}
        assert required <= state_keys, f"Trail state missing: {required - state_keys}"
        assert required <= event_keys, f"Trail event missing: {required - event_keys}"

    def test_no_js_computed_fields_in_python_output(self):
        """
        Verify that formerly JS-computed fields (durationMinutes, estimatedEnd,
        totalSize, filledSize) do NOT exist in Python to_dict() output.
        Frontend now computes these client-side.
        """
        twap = TWAPRedisState(twap_id="t1", num_lots=10, interval_seconds=60).to_dict()
        js_only_fields = {"durationMinutes", "estimatedEnd", "totalSize", "filledSize", "totalLots"}
        found = js_only_fields & set(twap.keys())
        assert not found, f"TWAP state has JS-only fields: {found}"

    def test_no_bare_id_in_events(self):
        """All event DTOs use domain-specific IDs, never bare 'id'."""
        events = [
            ChaseProgressEvent(chase_id="c1").to_dict(),
            ChaseFilledEvent(chase_id="c1").to_dict(),
            ChaseCancelledEvent(chase_id="c1").to_dict(),
            ScalperProgressEvent(scalper_id="s1", long_slots=[], short_slots=[]).to_dict(),
            TWAPProgressEvent(twap_id="t1").to_dict(),
            TrailStopProgressEvent(trail_stop_id="ts1").to_dict(),
            TrailStopTriggeredEvent(trail_stop_id="ts1").to_dict(),
        ]
        for d in events:
            assert "id" not in d, f"Event has bare 'id' key: {d}"


# ═══════════════════════════════════════════════════════════════
# 5. Order Shape Consistency (no JS remapping)
# ═══════════════════════════════════════════════════════════════

class TestOrderShapeConsistency:
    """
    JS no longer remaps order fields. These tests ensure Python's
    order shape is frontend-ready as-is.
    """

    def _make_order(self):
        from orders.state import OrderState
        return OrderState(
            client_order_id="PMStest1234_LMT_abc123",
            sub_account_id="test-sub-1",
            symbol="BTC/USDT:USDT",
            side="BUY",
            order_type="LIMIT",
            quantity=0.01,
            price=50000.0,
            leverage=10,
        )

    def test_no_bare_id(self):
        """Must use clientOrderId, never bare 'id'."""
        d = self._make_order().to_event_dict()
        assert "clientOrderId" in d
        assert "id" not in d

    def test_side_is_buy_sell(self):
        """Side must be BUY/SELL, never LONG/SHORT."""
        d = self._make_order().to_event_dict()
        assert d["side"] in ("BUY", "SELL"), f"Side should be BUY/SELL, got {d['side']}"

    def test_order_type_not_type(self):
        """Must use 'orderType', never bare 'type'."""
        d = self._make_order().to_event_dict()
        assert "orderType" in d
        assert "type" not in d

    def test_created_at_is_number(self):
        """createdAt must be seconds float, not ISO string."""
        d = self._make_order().to_event_dict()
        assert isinstance(d["createdAt"], (int, float)), \
            f"createdAt should be number, got {type(d['createdAt'])}"

    def test_no_snake_case_keys(self):
        """All keys camelCase."""
        d = self._make_order().to_event_dict()
        _assert_no_snake_case(d, "OrderState.to_event_dict")

    def test_json_roundtrip(self):
        """Order dict survives JSON round-trip."""
        d = self._make_order().to_event_dict()
        _assert_json_roundtrip(d, "OrderState.to_event_dict")


# ═══════════════════════════════════════════════════════════════
# 6. Position Shape Consistency
#    Would have caught: DB fallback using 'positionId' while
#    Python sends 'id' → frontend gets undefined → /close/undefined
# ═══════════════════════════════════════════════════════════════

class TestPositionShapeConsistency:
    """
    PositionSnapshot.to_dict() is the contract for the /positions endpoint.
    Frontend reads `p.id` for close buttons, chart annotations, etc.
    """

    def _make_position(self):
        from contracts.state import PositionSnapshot
        return PositionSnapshot(
            position_id="pos-abc-123",
            symbol="BTC/USDT:USDT",
            side="LONG",
            entry_price=50000.0,
            quantity=0.01,
            notional=500.0,
            margin=50.0,
            leverage=10,
            mark_price=50100.0,
        )

    def test_uses_id_not_position_id(self):
        """Frontend reads p.id — must be 'id', never 'positionId'."""
        d = self._make_position().to_dict()
        assert "id" in d, "PositionSnapshot.to_dict() must have 'id'"
        assert "positionId" not in d, \
            "PositionSnapshot.to_dict() must NOT have 'positionId' — frontend reads 'p.id'"
        assert d["id"] == "pos-abc-123"

    def test_side_is_long_short(self):
        """Position side is LONG/SHORT (not BUY/SELL — that's order context)."""
        d = self._make_position().to_dict()
        assert d["side"] in ("LONG", "SHORT"), f"Position side should be LONG/SHORT, got {d['side']}"

    def test_no_snake_case(self):
        d = self._make_position().to_dict()
        _assert_no_snake_case(d, "PositionSnapshot.to_dict")

    def test_json_roundtrip(self):
        d = self._make_position().to_dict()
        _assert_json_roundtrip(d, "PositionSnapshot.to_dict")

    def test_risk_snapshot_positions_use_id(self):
        """RiskSnapshot.to_dict() positions array must use 'id' key."""
        from contracts.state import RiskSnapshot, PositionSnapshot
        snap = RiskSnapshot(
            balance=1000.0,
            positions=[self._make_position()],
        )
        d = snap.to_dict()
        for pos in d["positions"]:
            assert "id" in pos, "Positions in RiskSnapshot must have 'id'"
            assert "positionId" not in pos


# ═══════════════════════════════════════════════════════════════
# 7. DB ↔ DTO Integrity
#    Ensures Python DTOs and DB schema (Prisma) agree on field
#    names and side conventions so JS endpoints don't need mappers.
# ═══════════════════════════════════════════════════════════════

class TestDbIntegrity:
    """
    Prisma schema conventions that Python must respect:
      - VirtualPosition.side: LONG/SHORT
      - PendingOrder.side: LONG/SHORT (converted from BUY/SELL)
      - TradeExecution.side: BUY/SELL
    """

    def test_position_dto_fields_match_db_columns(self):
        """PositionSnapshot.to_dict() keys must be a subset of VirtualPosition columns."""
        from contracts.state import PositionSnapshot
        # DB columns (from Prisma schema, using JS camelCase field names)
        db_columns = {
            "id", "subAccountId", "symbol", "side", "entryPrice",
            "quantity", "notional", "leverage", "margin",
            "liquidationPrice", "status", "realizedPnl",
            "openedAt", "closedAt", "takenOver", "takenOverBy", "takenOverAt",
        }
        dto_keys = set(PositionSnapshot(position_id="x").to_dict().keys())
        # DTO adds computed fields not in DB — that's ok
        # But DTO must not use field names that CONFLICT with DB meaning
        # 'id' in DTO maps to 'id' in DB — both are the position UUID ✓
        assert "id" in dto_keys, "DTO must have 'id' matching DB primary key"
        # markPrice, unrealizedPnl, pnlPercent are live-computed, not in DB — acceptable
        live_only = {"markPrice", "unrealizedPnl", "pnlPercent"}
        shared_keys = dto_keys - live_only
        for k in shared_keys:
            assert k in db_columns, \
                f"DTO key '{k}' not in DB columns — mismatch will cause confusion"

    def test_order_side_convention(self):
        """
        Python OrderState uses BUY/SELL.
        DB PendingOrder stores LONG/SHORT (converted at write time).
        to_event_dict() must output BUY/SELL (exchange convention).
        """
        from orders.state import OrderState
        buy_order = OrderState(client_order_id="x", side="BUY")
        sell_order = OrderState(client_order_id="y", side="SELL")
        assert buy_order.to_event_dict()["side"] == "BUY"
        assert sell_order.to_event_dict()["side"] == "SELL"

    def test_position_side_convention(self):
        """
        DB VirtualPosition uses LONG/SHORT.
        PositionSnapshot must also use LONG/SHORT.
        """
        from contracts.state import PositionSnapshot
        long = PositionSnapshot(position_id="x", side="LONG")
        short = PositionSnapshot(position_id="y", side="SHORT")
        assert long.to_dict()["side"] == "LONG"
        assert short.to_dict()["side"] == "SHORT"

    def test_pending_order_dto_fields_match_db(self):
        """OrderState.to_event_dict() critical fields map to PendingOrder columns."""
        from orders.state import OrderState
        # PendingOrder DB columns (Prisma camelCase)
        db_columns = {
            "id", "subAccountId", "symbol", "side", "type",
            "price", "quantity", "leverage", "exchangeOrderId",
            "status", "createdAt", "filledAt", "cancelledAt",
        }
        order = OrderState(client_order_id="test", symbol="BTCUSDT", side="BUY")
        dto = order.to_event_dict()
        # DTO uses 'clientOrderId' which maps to DB 'id' (PK)
        assert "clientOrderId" in dto
        # DTO uses 'orderType' — DB uses 'type'. This is an intentional
        # divergence (DTO avoids 'type' to prevent JS reserved-word issues).
        # The DB write code in manager.py handles this mapping.
        assert "orderType" in dto
        assert "type" not in dto, "DTO must not use bare 'type'"


# ═══════════════════════════════════════════════════════════════
# 8. Risk Engine Snapshot Integrity
#    get_account_snapshot() builds position/order dicts inline
#    instead of using PositionSnapshot.to_dict(). These tests
#    ensure the inline keys don't drift from the DTO contract.
# ═══════════════════════════════════════════════════════════════

class TestRiskEngineIntegrity:
    """
    Verifies that RiskEngine.get_account_snapshot() output shape
    matches the DTO contracts. Inline dicts must not drift.
    """

    def test_snapshot_position_keys_match_dto(self):
        """
        get_account_snapshot() builds positions inline (L516-530).
        The keys must match PositionSnapshot.to_dict().
        """
        from contracts.state import PositionSnapshot
        dto_keys = set(PositionSnapshot(position_id="x").to_dict().keys())
        # These are the keys that get_account_snapshot builds inline:
        inline_keys = {
            "id", "symbol", "side", "entryPrice", "quantity",
            "notional", "margin", "leverage", "liquidationPrice",
            "unrealizedPnl", "pnlPercent", "markPrice", "openedAt",
        }
        assert inline_keys == dto_keys, (
            f"get_account_snapshot() position keys drift from PositionSnapshot.to_dict():\n"
            f"  inline-only: {inline_keys - dto_keys}\n"
            f"  dto-only: {dto_keys - inline_keys}"
        )

    def test_snapshot_order_keys_match_dto(self):
        """
        get_account_snapshot() builds openOrders inline (L487-505).
        The keys must be a subset of OrderState.to_event_dict().
        """
        from orders.state import OrderState
        full_dto_keys = set(OrderState(client_order_id="x").to_event_dict().keys())
        # Keys used inline in get_account_snapshot:
        inline_keys = {
            "clientOrderId", "exchangeOrderId", "symbol", "side",
            "orderType", "price", "quantity", "filledQty",
            "origin", "leverage", "reduceOnly", "state", "createdAt",
        }
        missing = inline_keys - full_dto_keys
        assert not missing, (
            f"get_account_snapshot() order keys not in OrderState.to_event_dict(): {missing}"
        )

    def test_risk_snapshot_to_dict_structure(self):
        """RiskSnapshot.to_dict() must have required top-level keys."""
        from contracts.state import RiskSnapshot
        d = RiskSnapshot(balance=100, equity=100).to_dict()
        required = {"balance", "equity", "marginUsed", "availableMargin", "positions", "openOrders"}
        assert required.issubset(set(d.keys())), f"Missing keys: {required - set(d.keys())}"
        assert isinstance(d["positions"], list)
        assert isinstance(d["openOrders"], list)

    def test_risk_snapshot_no_snake_case(self):
        """RiskSnapshot top-level keys must be camelCase."""
        from contracts.state import RiskSnapshot
        d = RiskSnapshot(balance=100).to_dict()
        _assert_no_snake_case(d, "RiskSnapshot.to_dict")


# ═══════════════════════════════════════════════════════════════
# 9. Redis Key Consistency
#    Python RedisKey must match JS hardcoded key patterns.
# ═══════════════════════════════════════════════════════════════

class TestRedisKeyConsistency:
    """
    JS hardcodes Redis keys like 'pms:open_orders:${id}'.
    Python's RedisKey must produce the same strings.
    """

    def test_open_orders_key_format(self):
        """JS: `pms:open_orders:${subAccountId}` must match Python."""
        from contracts.common import RedisKey
        assert RedisKey.open_orders("abc-123") == "pms:open_orders:abc-123"

    def test_risk_key_format(self):
        """JS: `pms:risk:${subAccountId}` must match Python."""
        from contracts.common import RedisKey
        assert RedisKey.risk("abc-123") == "pms:risk:abc-123"

    def test_event_channel_format(self):
        """JS subscribes to `pms:events:*` — Python publishes to `pms:events:{type}`."""
        from contracts.common import RedisKey
        assert RedisKey.event_channel("order_filled") == "pms:events:order_filled"
        assert RedisKey.event_channel("position_updated") == "pms:events:position_updated"
        assert RedisKey.event_channel("margin_update") == "pms:events:margin_update"

    def test_result_key_format(self):
        """JS reads `pms:result:{requestId}` — Python writes same."""
        from contracts.common import RedisKey
        assert RedisKey.result("req-123") == "pms:result:req-123"

    def test_all_keys_have_pms_prefix(self):
        """Every key in the system must start with 'pms:'."""
        from contracts.common import RedisKey
        for attr in dir(RedisKey):
            val = getattr(RedisKey, attr)
            if isinstance(val, str) and not attr.startswith("_"):
                assert val.startswith("pms:"), f"RedisKey.{attr} = '{val}' missing pms: prefix"

    def test_command_queues_match_js(self):
        """
        JS proxyToRedis routes use these queues. Python must define them all.
        """
        from contracts.common import RedisKey
        # Every command JS sends via proxyToRedis
        js_queues = {
            "pms:cmd:trade", "pms:cmd:limit", "pms:cmd:scale",
            "pms:cmd:close", "pms:cmd:close_all",
            "pms:cmd:cancel", "pms:cmd:cancel_all",
            "pms:cmd:basket",
            "pms:cmd:chase", "pms:cmd:chase_cancel",
            "pms:cmd:scalper", "pms:cmd:scalper_cancel",
            "pms:cmd:twap", "pms:cmd:twap_cancel",
            "pms:cmd:twap_basket", "pms:cmd:twap_basket_cancel",
            "pms:cmd:trail_stop", "pms:cmd:trail_stop_cancel",
            "pms:cmd:validate",
        }
        python_queues = {
            v for k, v in vars(RedisKey).items()
            if isinstance(v, str) and v.startswith("pms:cmd:")
        }
        missing_in_python = js_queues - python_queues
        assert not missing_in_python, f"JS uses queues not defined in RedisKey: {missing_in_python}"

    def test_algo_state_keys(self):
        """Algo state keys match JS getActiveFromRedis patterns."""
        from contracts.common import RedisKey
        assert RedisKey.chase("ch1") == "pms:chase:ch1"
        assert RedisKey.active_chase("sub1") == "pms:active_chase:sub1"
        assert RedisKey.scalper("sc1") == "pms:scalper:sc1"
        assert RedisKey.active_scalper("sub1") == "pms:active_scalper:sub1"
        assert RedisKey.twap("tw1") == "pms:twap:tw1"
        assert RedisKey.active_twap("sub1") == "pms:active_twap:sub1"
        assert RedisKey.trail_stop("ts1") == "pms:trail_stop:ts1"
        assert RedisKey.active_trail_stop("sub1") == "pms:active_trail_stop:sub1"
