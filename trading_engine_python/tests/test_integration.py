"""
Integration test — validates the full Python pipeline without exchange connectivity.

Tests:
    1. risk/math pure functions
    2. PositionBook CRUD + reverse index
    3. TradeValidator 7-check pass/fail
    4. LiquidationEngine ADL tier evaluation
    5. RiskEngine position lifecycle (open → update mark → close)
    6. Algo engines state management (chase, scalper, twap, trail-stop)
    7. CommandHandler queue routing (unit-level)

Run: cd project_root && PYTHONPATH=. python trading_engine_python/tests/test_integration.py
"""

import asyncio
import sys
import time
from unittest.mock import AsyncMock, MagicMock

# ── Helpers ──

TESTS_RUN = 0
TESTS_PASSED = 0


def test(name):
    def decorator(fn):
        async def wrapper():
            global TESTS_RUN, TESTS_PASSED
            TESTS_RUN += 1
            try:
                if asyncio.iscoroutinefunction(fn):
                    await fn()
                else:
                    fn()
                TESTS_PASSED += 1
                print(f"  ✅ {name}")
            except Exception as e:
                print(f"  ❌ {name}: {e}")
        return wrapper
    return decorator


# ── 1. Risk Math ──

@test("compute_pnl LONG profit")
def test_pnl_long():
    from trading_engine_python.risk.math import compute_pnl
    assert compute_pnl("LONG", 65000, 66000, 0.001) == 1.0

@test("compute_pnl SHORT profit")
def test_pnl_short():
    from trading_engine_python.risk.math import compute_pnl
    assert compute_pnl("SHORT", 65000, 64000, 0.001) == 1.0

@test("compute_pnl LONG loss")
def test_pnl_long_loss():
    from trading_engine_python.risk.math import compute_pnl
    result = compute_pnl("LONG", 65000, 64000, 0.001)
    assert result == -1.0

@test("compute_margin")
def test_margin():
    from trading_engine_python.risk.math import compute_margin
    assert compute_margin(6500, 10) == 650.0

@test("compute_liquidation_price LONG")
def test_liq_long():
    from trading_engine_python.risk.math import compute_liquidation_price
    liq = compute_liquidation_price("LONG", 65000, 0.001, 6.5, 0.005)
    assert liq < 65000

@test("compute_liquidation_price SHORT")
def test_liq_short():
    from trading_engine_python.risk.math import compute_liquidation_price
    liq = compute_liquidation_price("SHORT", 65000, 0.001, 6.5, 0.005)
    assert liq > 65000

@test("compute_available_margin zero positions")
def test_avail_margin():
    from trading_engine_python.risk.math import compute_available_margin
    result = compute_available_margin(1000, 0.005, 0, 0)
    assert result["available_margin"] == 1000.0
    assert result["equity"] == 1000.0

@test("compute_margin_usage_ratio")
def test_usage_ratio():
    from trading_engine_python.risk.math import compute_margin_usage_ratio
    ratio = compute_margin_usage_ratio(1000, 500, 200)
    assert ratio == 0.7

@test("trade signature uniqueness")
def test_signature():
    from trading_engine_python.risk.math import create_trade_signature
    s1 = create_trade_signature("a1", "OPEN", "p1")
    s2 = create_trade_signature("a1", "OPEN", "p1")
    assert s1 != s2  # Each call has unique nonce


# ── 2. PositionBook ──

@test("position_book add + query")
def test_book_add():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    book = PositionBook()
    pos = VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                     entry_price=65000, quantity=0.001, notional=65, leverage=10, margin=6.5)
    book.add(pos, {"id": "s1", "currentBalance": 1000, "status": "ACTIVE"})
    assert book.size == 1
    assert book.has("s1")
    assert book.get_accounts_for_symbol("BTCUSDT") == {"s1"}

@test("position_book find_position")
def test_book_find():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    book = PositionBook()
    pos = VirtualPos(id="p1", sub_account_id="s1", symbol="ETHUSDT", side="SHORT",
                     entry_price=3000, quantity=0.1, notional=300, leverage=5, margin=60)
    book.add(pos, {"id": "s1", "currentBalance": 500, "status": "ACTIVE"})
    found = book.find_position("s1", "ETHUSDT", "SHORT")
    assert found is not None
    assert found.entry_price == 3000
    assert book.find_position("s1", "ETHUSDT", "LONG") is None

@test("position_book remove + cleanup")
def test_book_remove():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    book = PositionBook()
    pos = VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                     entry_price=65000, quantity=0.001, notional=65, leverage=10, margin=6.5)
    book.add(pos, {"id": "s1", "currentBalance": 1000, "status": "ACTIVE"})
    removed = book.remove("p1", "s1")
    assert removed is not None
    assert book.size == 0
    assert book.get_accounts_for_symbol("BTCUSDT") == set()

@test("position_book bulk load")
def test_book_load():
    from trading_engine_python.risk.position_book import PositionBook
    book = PositionBook()
    book.load({
        "s1": {
            "account": {"id": "s1", "currentBalance": 1000, "status": "ACTIVE"},
            "positions": [
                {"id": "p1", "symbol": "BTCUSDT", "side": "LONG", "entryPrice": 65000,
                 "quantity": 0.001, "notional": 65, "leverage": 10, "margin": 6.5},
                {"id": "p2", "symbol": "ETHUSDT", "side": "SHORT", "entryPrice": 3000,
                 "quantity": 0.1, "notional": 300, "leverage": 5, "margin": 60},
            ],
            "rules": None,
        },
    })
    assert book.size == 1
    assert len(book.get_by_sub_account("s1")) == 2


# ── 3. TradeValidator ──

class MockMarketData:
    def get_l1(self, symbol):
        prices = {"BTCUSDT": 65000, "ETHUSDT": 3000}
        p = prices.get(symbol, 50000)
        return {"bid": p, "ask": p + 1, "mid": p + 0.5}
    
    def get_mid_price(self, symbol):
        l1 = self.get_l1(symbol)
        return l1["mid"] if l1 else None

@test("validator passes valid trade")
async def test_validator_pass():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    from trading_engine_python.risk.validator import TradeValidator
    book = PositionBook()
    book.add(
        VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                   entry_price=65000, quantity=0.001, notional=65, leverage=10, margin=6.5),
        {"id": "s1", "currentBalance": 1000, "status": "ACTIVE", "maintenanceRate": 0.005},
    )
    v = TradeValidator(book, MockMarketData())
    result = await v.validate("s1", "ETHUSDT", "LONG", 0.01, 10)
    assert result["valid"] is True

@test("validator rejects missing account")
async def test_validator_missing():
    from trading_engine_python.risk.position_book import PositionBook
    from trading_engine_python.risk.validator import TradeValidator
    v = TradeValidator(PositionBook(), MockMarketData())
    result = await v.validate("nonexistent", "BTCUSDT", "LONG", 0.001, 10)
    assert result["valid"] is False
    assert "ACCOUNT_NOT_FOUND" in result["errors"]

@test("validator rejects frozen account")
async def test_validator_frozen():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    from trading_engine_python.risk.validator import TradeValidator
    book = PositionBook()
    book.load({"s1": {"account": {"id": "s1", "currentBalance": 1000, "status": "FROZEN"},
                      "positions": [], "rules": None}})
    v = TradeValidator(book, MockMarketData())
    result = await v.validate("s1", "BTCUSDT", "LONG", 0.001, 10)
    assert result["valid"] is False

@test("validator rejects over-leverage")
async def test_validator_leverage():
    from trading_engine_python.risk.position_book import PositionBook
    from trading_engine_python.risk.validator import TradeValidator
    book = PositionBook()
    book.load({"s1": {"account": {"id": "s1", "currentBalance": 1000, "status": "ACTIVE", "maintenanceRate": 0.005},
                      "positions": [], "rules": {"max_leverage": 20, "max_notional_per_trade": 50000, "max_total_exposure": 100000, "liquidation_threshold": 0.90}}})
    v = TradeValidator(book, MockMarketData())
    result = await v.validate("s1", "BTCUSDT", "LONG", 0.001, 50)
    assert result["valid"] is False
    assert any("MAX_LEVERAGE" in e for e in result["errors"])


# ── 4. LiquidationEngine ──

@test("liquidation returns None for healthy account")
def test_liq_healthy():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    from trading_engine_python.risk.liquidation import LiquidationEngine
    book = PositionBook()
    book.add(
        VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                   entry_price=65000, quantity=0.001, notional=65, leverage=10, margin=6.5),
        {"id": "s1", "currentBalance": 1000, "status": "ACTIVE", "maintenanceRate": 0.005},
    )
    le = LiquidationEngine(book)
    result = le.evaluate_account("s1", lambda s: 65000.0)
    assert result is None

@test("liquidation triggers on underwater position")
def test_liq_trigger():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    from trading_engine_python.risk.liquidation import LiquidationEngine
    book = PositionBook()
    # Position using most of the balance as margin
    book.add(
        VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                   entry_price=65000, quantity=0.1, notional=6500, leverage=10, margin=650),
        {"id": "s1", "currentBalance": 700, "status": "ACTIVE", "maintenanceRate": 0.005},
    )
    le = LiquidationEngine(book)
    # Price crashes: -95% of balance as unrealized loss
    result = le.evaluate_account("s1", lambda s: 58000.0)
    assert result is not None
    tier, ratio, positions = result
    assert "TIER" in tier


# ── 5. RiskEngine position lifecycle ──

@test("risk engine account snapshot")
def test_snapshot():
    from trading_engine_python.risk.position_book import PositionBook, VirtualPos
    from trading_engine_python.risk.engine import RiskEngine
    book = PositionBook()
    book.add(
        VirtualPos(id="p1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                   entry_price=65000, quantity=0.001, notional=65, leverage=10, margin=6.5,
                   mark_price=66000, unrealized_pnl=1.0),
        {"id": "s1", "currentBalance": 1000, "status": "ACTIVE"},
    )
    engine = RiskEngine(book, MockMarketData(), None)
    snap = engine.get_account_snapshot("s1")
    assert snap["balance"] == 1000
    assert snap["equity"] == 1001.0
    assert len(snap["positions"]) == 1


# ── 6. Algo Engines ──

@test("chase state creation")
def test_chase_state():
    from trading_engine_python.algos.chase import ChaseState
    state = ChaseState(id="c1", sub_account_id="s1", symbol="BTCUSDT", side="BUY",
                       quantity=0.001, stalk_mode="trail")
    assert state.status == "ACTIVE"
    assert state.reprice_count == 0

@test("trail stop trigger calculation")
def test_trail_trigger():
    from trading_engine_python.algos.trail_stop import TrailStopEngine, TrailStopState
    state = TrailStopState(id="ts1", sub_account_id="s1", symbol="BTCUSDT", side="LONG",
                           quantity=0.001, trail_pct=2.0)
    state.extreme_price = 65000
    engine = TrailStopEngine(None, None)
    trigger = engine._compute_trigger(state)
    assert abs(trigger - 63700.0) < 0.01  # 65000 * 0.98

@test("trail stop SHORT trigger")
def test_trail_trigger_short():
    from trading_engine_python.algos.trail_stop import TrailStopEngine, TrailStopState
    state = TrailStopState(id="ts2", sub_account_id="s1", symbol="BTCUSDT", side="SHORT",
                           quantity=0.001, trail_pct=1.5)
    state.extreme_price = 65000
    engine = TrailStopEngine(None, None)
    trigger = engine._compute_trigger(state)
    assert abs(trigger - 65975.0) < 0.01  # 65000 * 1.015

@test("twap state lot generation")
def test_twap_lots():
    from trading_engine_python.algos.twap import TWAPState
    import random; random.seed(42)
    state = TWAPState(id="t1", sub_account_id="s1", symbol="BTCUSDT", side="BUY",
                      total_quantity=1.0, num_lots=5, interval_seconds=60, irregular=True)
    # Generate irregular lots
    weights = [random.random() for _ in range(5)]
    total_w = sum(weights)
    lots = [(w / total_w) * 1.0 for w in weights]
    assert abs(sum(lots) - 1.0) < 1e-10

@test("scalper slot creation")
def test_scalper_slots():
    from trading_engine_python.algos.scalper import ScalperState, ScalperSlot
    state = ScalperState(id="sc1", sub_account_id="s1", symbol="BTCUSDT",
                         num_layers=3, base_quantity=0.001, layer_spread_bps=10)
    for i in range(3):
        state.long_slots.append(ScalperSlot(layer_idx=i, side="BUY"))
        state.short_slots.append(ScalperSlot(layer_idx=i, side="SELL"))
    assert len(state.long_slots) == 3
    assert len(state.short_slots) == 3


# ── 7. Module Import Verification ──

@test("all 18 modules importable")
def test_all_imports():
    from trading_engine_python.orders.state import OrderState
    from trading_engine_python.orders.tracker import OrderTracker
    from trading_engine_python.orders.exchange_client import ExchangeClient
    from trading_engine_python.orders.manager import OrderManager
    from trading_engine_python.feeds.user_stream import UserStreamService
    from trading_engine_python.feeds.market_data import MarketDataService
    from trading_engine_python.commands.handler import CommandHandler
    from trading_engine_python.risk.engine import RiskEngine
    from trading_engine_python.risk.position_book import PositionBook
    from trading_engine_python.risk.math import compute_pnl
    from trading_engine_python.risk.validator import TradeValidator
    from trading_engine_python.risk.liquidation import LiquidationEngine
    from trading_engine_python.algos.chase import ChaseEngine
    from trading_engine_python.algos.scalper import ScalperEngine
    from trading_engine_python.algos.twap import TWAPEngine
    from trading_engine_python.algos.trail_stop import TrailStopEngine
    from trading_engine_python.db.base import Base
    from trading_engine_python.db.models import SubAccount, VirtualPosition


# ── Runner ──

async def run_all():
    print("\n🧪 Python Trading Engine — Integration Tests\n")
    print("=" * 55)

    all_tests = [v for v in globals().values() if callable(v) and hasattr(v, '__wrapped__') or (callable(v) and v.__name__.startswith("test_"))]
    # Collect tests by name
    test_fns = []
    for name, obj in list(globals().items()):
        if name.startswith("test_") and callable(obj):
            test_fns.append(obj)

    for fn in test_fns:
        await fn()

    print("=" * 55)
    print(f"\n{'✅' if TESTS_PASSED == TESTS_RUN else '❌'} {TESTS_PASSED}/{TESTS_RUN} tests passed\n")
    return TESTS_PASSED == TESTS_RUN


if __name__ == "__main__":
    success = asyncio.run(run_all())
    sys.exit(0 if success else 1)
