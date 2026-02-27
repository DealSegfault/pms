"""
test_contracts.py — Validates all contract DTOs produce correct shapes.

Tests:
  1. Common normalization (side, symbol, timestamp)
  2. Command DTOs from_raw() with normalization
  3. Event DTOs to_dict() produce expected keys
  4. State DTOs to_dict() produce expected keys
  5. Round-trip: to_dict() → JSON serialize → parse → all keys present
"""

import json
import time

import sys; sys.path.insert(0, '..')

from contracts.common import (
    normalize_side, normalize_symbol, ts_ms, ts_s_to_ms,
    position_side_from_order, close_side_from_position,
    to_ccxt_symbol, to_slash_symbol,
    EventType, RedisKey,
)
from contracts.commands import (
    TradeCommand, LimitCommand, ScaleCommand,
    CloseCommand, CancelCommand, CancelAllCommand,
    ChaseCommand, ScalperCommand, TWAPCommand, TWAPBasketCommand, TrailStopCommand,
)
from contracts.events import (
    OrderPlacedEvent, OrderActiveEvent, OrderFilledEvent,
    OrderCancelledEvent, OrderFailedEvent, OrderEventBase,
    ChaseProgressEvent, ChaseFilledEvent, ChaseCancelledEvent,
    ScalperProgressEvent, ScalperFilledEvent, ScalperCancelledEvent,
    TWAPProgressEvent, TWAPCompletedEvent, TWAPCancelledEvent,
    TWAPBasketProgressEvent, TWAPBasketCompletedEvent, TWAPBasketCancelledEvent,
    TrailStopProgressEvent, TrailStopTriggeredEvent, TrailStopCancelledEvent,
    PositionUpdatedEvent, PositionClosedEvent, PositionReducedEvent,
    MarginUpdateEvent, PnlUpdateEvent,
    ScalperSlotInfo,
)
from contracts.state import (
    ChaseRedisState, ScalperRedisState, TWAPRedisState, TrailStopRedisState,
    RiskSnapshot, PositionSnapshot, OpenOrderSnapshot, ScalperSlotSnapshot,
)


# ═══════════════════════════════════════════════════════════════
# 1. Common Normalization
# ═══════════════════════════════════════════════════════════════

class TestNormalizeSide:
    def test_long_to_buy(self):
        assert normalize_side("LONG") == "BUY"

    def test_short_to_sell(self):
        assert normalize_side("SHORT") == "SELL"

    def test_buy_passthrough(self):
        assert normalize_side("BUY") == "BUY"

    def test_sell_passthrough(self):
        assert normalize_side("SELL") == "SELL"

    def test_case_insensitive(self):
        assert normalize_side("long") == "BUY"
        assert normalize_side("short") == "SELL"
        assert normalize_side("buy") == "BUY"

    def test_invalid_raises(self):
        import pytest
        with pytest.raises(ValueError):
            normalize_side("INVALID")


class TestNormalizeSymbol:
    def test_ccxt_format(self):
        assert normalize_symbol("DOGE/USDT:USDT") == "DOGEUSDT"

    def test_slash_format(self):
        assert normalize_symbol("BTC/USDT") == "BTCUSDT"

    def test_binance_passthrough(self):
        assert normalize_symbol("ETHUSDT") == "ETHUSDT"

    def test_bare_symbol(self):
        assert normalize_symbol("SOL") == "SOLUSDT"


class TestSideConversions:
    def test_position_side_from_order(self):
        assert position_side_from_order("BUY") == "LONG"
        assert position_side_from_order("SELL") == "SHORT"

    def test_close_side_from_position(self):
        assert close_side_from_position("LONG") == "SELL"
        assert close_side_from_position("SHORT") == "BUY"


class TestSymbolConversions:
    def test_to_ccxt(self):
        assert to_ccxt_symbol("DOGEUSDT") == "DOGE/USDT:USDT"

    def test_to_slash(self):
        assert to_slash_symbol("BTCUSDT") == "BTC/USDT"


class TestTimestamps:
    def test_ts_ms_is_milliseconds(self):
        ms = ts_ms()
        assert ms > 1_700_000_000_000  # After 2023
        assert ms < 2_000_000_000_000  # Before 2033

    def test_ts_s_to_ms(self):
        s = 1709000000.123
        ms = ts_s_to_ms(s)
        assert ms == 1709000000123


# ═══════════════════════════════════════════════════════════════
# 2. Command DTOs
# ═══════════════════════════════════════════════════════════════

class TestTradeCommand:
    def test_from_raw_normalizes(self):
        cmd = TradeCommand.from_raw({
            "requestId": "req-1",
            "subAccountId": "acc-1",
            "symbol": "DOGE/USDT:USDT",
            "side": "LONG",
            "quantity": "100.5",
            "leverage": 5,
        })
        assert cmd.symbol == "DOGE/USDT:USDT"  # Pass-through, no normalization
        assert cmd.side == "BUY"
        assert cmd.quantity == 100.5
        assert cmd.leverage == 5
        assert cmd.request_id == "req-1"


class TestChaseCommand:
    def test_from_raw_normalizes(self):
        cmd = ChaseCommand.from_raw({
            "subAccountId": "acc-1",
            "symbol": "ETH/USDT",
            "side": "SHORT",
            "quantity": 1.5,
            "stalkOffsetPct": 0.5,
            "stalkMode": "maintain",
            "maxDistancePct": 3.0,
        })
        assert cmd.symbol == "ETH/USDT"  # Pass-through, no normalization
        assert cmd.side == "SELL"
        assert cmd.stalk_offset_pct == 0.5
        assert cmd.max_distance_pct == 3.0


class TestScalperCommand:
    def test_from_raw(self):
        cmd = ScalperCommand.from_raw({
            "subAccountId": "acc-1",
            "symbol": "BTC/USDT:USDT",
            "startSide": "LONG",
            "childCount": 3,
            "longOffsetPct": 0.5,
            "shortOffsetPct": 0.3,
            "longSizeUsd": 100,
            "shortSizeUsd": 100,
        })
        assert cmd.symbol == "BTC/USDT:USDT"  # Pass-through, no normalization
        assert cmd.child_count == 3


class TestTWAPCommand:
    def test_from_raw(self):
        cmd = TWAPCommand.from_raw({
            "subAccountId": "acc-1",
            "symbol": "SOL/USDT",
            "side": "BUY",
            "quantity": 50,
            "numLots": 10,
            "intervalSeconds": 30,
        })
        assert cmd.symbol == "SOL/USDT"  # Pass-through, no normalization
        assert cmd.num_lots == 10


class TestTrailStopCommand:
    def test_from_raw_accepts_both_pct_names(self):
        cmd1 = TrailStopCommand.from_raw({
            "subAccountId": "acc-1",
            "symbol": "BTCUSDT",
            "side": "LONG",
            "quantity": 0.01,
            "callbackPct": 2.0,
        })
        assert cmd1.callback_pct == 2.0

        cmd2 = TrailStopCommand.from_raw({
            "subAccountId": "acc-1",
            "symbol": "BTCUSDT",
            "side": "LONG",
            "quantity": 0.01,
            "trailPct": 3.0,
        })
        assert cmd2.callback_pct == 3.0


# ═══════════════════════════════════════════════════════════════
# 3. Event DTOs — key verification
# ═══════════════════════════════════════════════════════════════

def _assert_keys(d, required_keys):
    """Assert all required keys are present in dict."""
    for key in required_keys:
        assert key in d, f"Missing key: {key}"


def _assert_json_roundtrip(d):
    """Assert dict can be serialized and deserialized."""
    raw = json.dumps(d)
    parsed = json.loads(raw)
    assert set(parsed.keys()) == set(d.keys())


class TestChaseEvents:
    def test_progress_keys(self):
        evt = ChaseProgressEvent(
            chase_id="c1", sub_account_id="a1", symbol="BTCUSDT",
            side="BUY", quantity=1.0, current_order_price=50000,
        )
        d = evt.to_dict()
        _assert_keys(d, ["type", "chaseId", "subAccountId", "symbol", "side",
                         "quantity", "repriceCount", "status", "stalkOffsetPct",
                         "initialPrice", "currentOrderPrice", "timestamp"])
        assert d["type"] == "chase_progress"
        _assert_json_roundtrip(d)

    def test_filled_keys(self):
        d = ChaseFilledEvent(chase_id="c1", sub_account_id="a1",
                             symbol="BTCUSDT", side="BUY",
                             fill_price=50000).to_dict()
        _assert_keys(d, ["type", "chaseId", "fillPrice", "status"])
        assert d["status"] == "FILLED"

    def test_cancelled_keys(self):
        d = ChaseCancelledEvent(chase_id="c1", reason="user").to_dict()
        _assert_keys(d, ["type", "chaseId", "reason", "status"])
        assert d["status"] == "CANCELLED"


class TestScalperEvents:
    def test_progress_keys(self):
        slot = ScalperSlotInfo(layer_idx=0, active=True, fills=3)
        d = ScalperProgressEvent(
            scalper_id="s1", sub_account_id="a1", symbol="BTCUSDT",
            long_slots=[slot], short_slots=[],
        ).to_dict()
        _assert_keys(d, ["type", "scalperId", "totalFillCount", "longSlots", "shortSlots"])
        assert d["longSlots"][0]["layerIdx"] == 0
        assert d["longSlots"][0]["fills"] == 3

    def test_filled_keys(self):
        d = ScalperFilledEvent(scalper_id="s1", fill_price=50000, layer_idx=1).to_dict()
        _assert_keys(d, ["type", "scalperId", "fillPrice", "layerIdx"])

    def test_cancelled_keys(self):
        d = ScalperCancelledEvent(scalper_id="s1").to_dict()
        _assert_keys(d, ["type", "scalperId", "status"])


class TestTWAPEvents:
    def test_progress_keys(self):
        d = TWAPProgressEvent(twap_id="t1", filled_lots=3, total_lots=10).to_dict()
        _assert_keys(d, ["type", "twapId", "filledLots", "totalLots",
                         "filledQuantity", "totalQuantity"])

    def test_basket_progress_keys(self):
        d = TWAPBasketProgressEvent(twap_basket_id="tb1", filled_lots=2, total_lots=5).to_dict()
        _assert_keys(d, ["type", "twapBasketId", "filledLots", "totalLots", "legs"])


class TestTrailStopEvents:
    def test_progress_keys(self):
        d = TrailStopProgressEvent(
            trail_stop_id="ts1", symbol="BTCUSDT", side="LONG",
            callback_pct=2.0, extreme_price=50000, trigger_price=49000,
        ).to_dict()
        _assert_keys(d, ["type", "trailStopId", "callbackPct", "extremePrice",
                         "triggerPrice", "activated", "side"])
        assert "trailPct" not in d  # Standardized name only

    def test_triggered_keys(self):
        d = TrailStopTriggeredEvent(trail_stop_id="ts1", triggered_price=49000).to_dict()
        _assert_keys(d, ["type", "trailStopId", "triggeredPrice", "status"])
        assert d["status"] == "TRIGGERED"


class TestPositionEvents:
    def test_updated_keys(self):
        d = PositionUpdatedEvent(
            position_id="p1", sub_account_id="a1", symbol="BTCUSDT",
            side="LONG", entry_price=50000, quantity=0.1,
        ).to_dict()
        _assert_keys(d, ["type", "positionId", "entryPrice", "quantity",
                         "notional", "margin", "leverage", "liquidationPrice"])

    def test_closed_keys(self):
        d = PositionClosedEvent(position_id="p1", realized_pnl=100.5).to_dict()
        _assert_keys(d, ["type", "positionId", "realizedPnl", "closePrice"])

    def test_reduced_keys(self):
        d = PositionReducedEvent(position_id="p1", closed_qty=0.05, remaining_qty=0.05).to_dict()
        _assert_keys(d, ["type", "positionId", "closedQty", "remainingQty", "realizedPnl"])


class TestMarginUpdateEvent:
    def test_keys(self):
        d = MarginUpdateEvent(
            sub_account_id="a1", balance=1000, equity=1050,
            margin_used=200, available_margin=850,
        ).to_dict()
        _assert_keys(d, ["type", "subAccountId", "balance", "equity",
                         "marginUsed", "availableMargin", "update"])
        # update should also contain the same snapshot fields
        _assert_keys(d["update"], ["balance", "equity", "marginUsed", "availableMargin"])


# ═══════════════════════════════════════════════════════════════
# 4. State DTOs — key verification
# ═══════════════════════════════════════════════════════════════

class TestChaseRedisState:
    def test_keys(self):
        d = ChaseRedisState(
            chase_id="c1", sub_account_id="a1", symbol="BTCUSDT",
            side="BUY", quantity=1.0, started_at=ts_ms(),
        ).to_dict()
        _assert_keys(d, ["chaseId", "subAccountId", "symbol", "side",
                         "quantity", "stalkMode", "stalkOffsetPct", "startedAt",
                         "currentOrderPrice", "sizeUsd", "reduceOnly"])
        # No bare "id" key
        assert "id" not in d

    def test_roundtrip(self):
        state = ChaseRedisState(chase_id="c1", sub_account_id="a1",
                                 symbol="BTCUSDT", side="BUY")
        d = state.to_dict()
        _assert_json_roundtrip(d)


class TestScalperRedisState:
    def test_keys(self):
        d = ScalperRedisState(
            scalper_id="s1", sub_account_id="a1", symbol="BTCUSDT",
            started_at=ts_ms(),
        ).to_dict()
        _assert_keys(d, ["scalperId", "subAccountId", "symbol", "childCount",
                         "totalFillCount", "startedAt", "leverage", "startSide"])
        assert "id" not in d


class TestTWAPRedisState:
    def test_keys(self):
        d = TWAPRedisState(twap_id="t1", num_lots=10).to_dict()
        _assert_keys(d, ["twapId", "totalQuantity", "numLots", "filledLots",
                         "filledQuantity", "status"])
        assert "id" not in d


class TestTrailStopRedisState:
    def test_keys(self):
        d = TrailStopRedisState(
            trail_stop_id="ts1", callback_pct=2.0,
        ).to_dict()
        _assert_keys(d, ["trailStopId", "callbackPct", "extremePrice",
                         "triggerPrice", "activated", "status"])
        # Standardized name only — no trailPct
        assert "trailPct" not in d


class TestRiskSnapshot:
    def test_keys(self):
        pos = PositionSnapshot(position_id="p1", symbol="BTCUSDT",
                                side="LONG", entry_price=50000)
        snap = RiskSnapshot(
            balance=1000, equity=1050,
            margin_used=200, available_margin=850,
            positions=[pos],
        )
        d = snap.to_dict()
        _assert_keys(d, ["balance", "equity", "marginUsed", "availableMargin",
                         "positions", "openOrders"])
        assert len(d["positions"]) == 1
        _assert_keys(d["positions"][0], ["id", "symbol", "side", "entryPrice"])


# ═══════════════════════════════════════════════════════════════
# 5. RedisKey + EventType completeness
# ═══════════════════════════════════════════════════════════════

class TestRedisKey:
    def test_chase_keys(self):
        assert RedisKey.chase("abc") == "pms:chase:abc"
        assert RedisKey.active_chase("acc1") == "pms:active_chase:acc1"

    def test_event_channel(self):
        assert RedisKey.event_channel("chase_progress") == "pms:events:chase_progress"


class TestEventType:
    def test_all_types_exist(self):
        expected = [
            "order_placed", "order_active", "order_filled", "order_cancelled", "order_failed",
            "chase_progress", "chase_filled", "chase_cancelled",
            "scalper_progress", "scalper_filled", "scalper_cancelled",
            "twap_progress", "twap_completed", "twap_cancelled",
            "twap_basket_progress", "twap_basket_completed", "twap_basket_cancelled",
            "trail_stop_progress", "trail_stop_triggered", "trail_stop_cancelled",
            "position_updated", "position_closed", "position_reduced",
            "margin_update", "pnl_update",
        ]
        for et in expected:
            attr = et.upper()
            assert hasattr(EventType, attr), f"Missing EventType.{attr}"
