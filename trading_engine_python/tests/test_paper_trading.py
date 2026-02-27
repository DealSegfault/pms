"""
Paper Trading — Unit + Integration Tests.

Tests the full paper trading pipeline:
    1. PaperWallet balance and Binance-format responses
    2. MatchingEngine order lifecycle (add, cancel, fill on tick)
    3. PaperExchangeClient drop-in compatibility
    4. PaperUserStream event routing
    5. Full pipeline: order → fill → OrderManager state machine

Run: cd /Users/mac/cgki/minimalte && PYTHONPATH=. python trading_engine_python/tests/test_paper_trading.py
"""

import asyncio
import sys
import time
from unittest.mock import AsyncMock, MagicMock

# ── Test Framework ──

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
                import traceback
                traceback.print_exc()
        return wrapper
    return decorator


# ═══════════════════════════════════════════════════════════
# 1. PaperWallet
# ═══════════════════════════════════════════════════════════

@test("wallet: initial balance")
def test_wallet_init():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=5000)
    assert w.balance == 5000


@test("wallet: adjust balance")
def test_wallet_adjust():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=10000)
    w.adjust_balance(-50)
    assert w.balance == 9950
    w.adjust_balance(100)
    assert w.balance == 10050


@test("wallet: get_balance returns Binance format")
def test_wallet_balance_format():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=10000)
    result = w.get_balance_response()
    assert isinstance(result, list)
    assert len(result) >= 1
    usdt = result[0]
    assert usdt["asset"] == "USDT"
    assert usdt["balance"] == "10000"
    assert usdt["availableBalance"] == "10000"


@test("wallet: get_account_info returns Binance format")
def test_wallet_account_info():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=10000)
    info = w.get_account_info_response()
    assert info["canTrade"] is True
    assert info["totalWalletBalance"] == "10000"
    assert len(info["assets"]) >= 1


@test("wallet: leverage management")
def test_wallet_leverage():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=10000)
    assert w.get_leverage("BTCUSDT") == 20  # Default
    w.set_leverage("BTCUSDT", 10)
    assert w.get_leverage("BTCUSDT") == 10


@test("wallet: position risk returns Binance format")
def test_wallet_position_risk():
    from trading_engine_python.paper.wallet import PaperWallet
    w = PaperWallet(starting_balance=10000)
    result = w.get_position_risk_response("BTCUSDT")
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["symbol"] == "BTCUSDT"
    assert result[0]["positionAmt"] == "0"


# ═══════════════════════════════════════════════════════════
# 2. MatchingEngine
# ═══════════════════════════════════════════════════════════

@test("matching: add market order")
def test_matching_add_market():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    order = engine.add_order(
        client_order_id="PMS_test_MKT_001",
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        quantity=0.001,
    )
    assert order.order_id >= 100000000
    assert order.client_order_id == "PMS_test_MKT_001"
    assert order.symbol == "BTCUSDT"
    assert order.side == "BUY"
    assert engine.pending_count == 1


@test("matching: add limit order")
def test_matching_add_limit():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    order = engine.add_order(
        client_order_id="PMS_test_LMT_001",
        symbol="BTCUSDT",
        side="BUY",
        order_type="LIMIT",
        quantity=0.001,
        price=60000.0,
    )
    assert order.price == 60000.0
    assert order.order_type == "LIMIT"
    assert engine.pending_count == 1


@test("matching: cancel order")
def test_matching_cancel():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    engine.add_order(
        client_order_id="PMS_test_LMT_002",
        symbol="BTCUSDT",
        side="BUY",
        order_type="LIMIT",
        quantity=0.001,
        price=60000.0,
    )
    assert engine.pending_count == 1
    cancelled = engine.cancel_order(client_order_id="PMS_test_LMT_002")
    assert cancelled is not None
    assert cancelled.status == "CANCELED"
    assert engine.pending_count == 0


@test("matching: cancel nonexistent returns None")
def test_matching_cancel_none():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    result = engine.cancel_order(client_order_id="nonexistent")
    assert result is None


@test("matching: cancel_all_for_symbol")
def test_matching_cancel_all():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    engine.add_order("o1", "BTCUSDT", "BUY", "LIMIT", 0.001, price=60000)
    engine.add_order("o2", "BTCUSDT", "SELL", "LIMIT", 0.001, price=70000)
    engine.add_order("o3", "ETHUSDT", "BUY", "LIMIT", 0.01, price=3000)
    assert engine.pending_count == 3
    count = engine.cancel_all_for_symbol("BTCUSDT")
    assert count == 2
    assert engine.pending_count == 1  # Only ETHUSDT remains


@test("matching: market order fills on tick")
async def test_matching_market_fill():
    from trading_engine_python.paper.matching import MatchingEngine
    events = []

    async def on_event(data):
        events.append(data)

    engine = MatchingEngine(event_callback=on_event)
    engine.add_order("MKT_001", "BTCUSDT", "BUY", "MARKET", 0.001)

    await engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)

    assert engine.pending_count == 0
    assert engine.fill_count == 1
    # Should have 2 events: NEW then FILLED
    assert len(events) == 2
    assert events[0]["status"] == "NEW"
    assert events[1]["status"] == "FILLED"
    assert events[1]["last_filled_price"] == "65001"  # Filled at ask for BUY


@test("matching: limit BUY doesn't fill when ask > price")
async def test_matching_limit_no_fill():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    engine.add_order("LMT_001", "BTCUSDT", "BUY", "LIMIT", 0.001, price=64000)

    await engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)

    assert engine.pending_count == 1  # Still pending
    assert engine.fill_count == 0


@test("matching: limit BUY fills when ask <= price")
async def test_matching_limit_fill():
    from trading_engine_python.paper.matching import MatchingEngine
    events = []

    async def on_event(data):
        events.append(data)

    engine = MatchingEngine(event_callback=on_event)
    engine.add_order("LMT_002", "BTCUSDT", "BUY", "LIMIT", 0.001, price=65100)

    await engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)

    assert engine.pending_count == 0
    assert engine.fill_count == 1
    assert events[-1]["status"] == "FILLED"
    assert events[-1]["last_filled_price"] == "65100"  # Filled at limit price


@test("matching: limit SELL fills when bid >= price")
async def test_matching_limit_sell_fill():
    from trading_engine_python.paper.matching import MatchingEngine
    events = []

    async def on_event(data):
        events.append(data)

    engine = MatchingEngine(event_callback=on_event)
    engine.add_order("LMT_003", "BTCUSDT", "SELL", "LIMIT", 0.001, price=64000)

    await engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)

    assert engine.pending_count == 0
    assert events[-1]["status"] == "FILLED"
    assert events[-1]["last_filled_price"] == "64000"


@test("matching: stop market BUY triggers when ask >= stop_price")
async def test_matching_stop_buy():
    from trading_engine_python.paper.matching import MatchingEngine
    events = []

    async def on_event(data):
        events.append(data)

    engine = MatchingEngine(event_callback=on_event)
    engine.add_order("STP_001", "BTCUSDT", "BUY", "STOP_MARKET", 0.001, stop_price=66000)

    # Below stop — shouldn't trigger
    await engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)
    assert engine.pending_count == 1

    # Above stop — should trigger
    await engine.on_tick("BTCUSDT", bid=66000, ask=66001, mid=66000.5)
    assert engine.pending_count == 0
    assert events[-1]["status"] == "FILLED"


@test("matching: get_open_orders returns Binance format")
def test_matching_open_orders():
    from trading_engine_python.paper.matching import MatchingEngine
    engine = MatchingEngine()
    engine.add_order("LMT_010", "BTCUSDT", "BUY", "LIMIT", 0.001, price=60000)
    engine.add_order("LMT_011", "ETHUSDT", "SELL", "LIMIT", 0.01, price=4000)

    all_orders = engine.get_open_orders()
    assert len(all_orders) == 2
    assert all(isinstance(o, dict) for o in all_orders)
    assert all("orderId" in o for o in all_orders)

    btc_orders = engine.get_open_orders("BTCUSDT")
    assert len(btc_orders) == 1
    assert btc_orders[0]["symbol"] == "BTCUSDT"


# ═══════════════════════════════════════════════════════════
# 3. PaperExchangeClient
# ═══════════════════════════════════════════════════════════

@test("exchange: symbol normalization")
def test_exchange_symbol():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    assert PaperExchangeClient._to_binance_symbol("BTC/USDT:USDT") == "BTCUSDT"
    assert PaperExchangeClient._to_binance_symbol("BTCUSDT") == "BTCUSDT"
    assert PaperExchangeClient._to_binance_symbol("RAVE/USDT:USDT") == "RAVEUSDT"


@test("exchange: side normalization")
def test_exchange_side():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    assert PaperExchangeClient._to_binance_side("LONG") == "BUY"
    assert PaperExchangeClient._to_binance_side("SHORT") == "SELL"
    assert PaperExchangeClient._to_binance_side("BUY") == "BUY"
    assert PaperExchangeClient._to_binance_side("SELL") == "SELL"


@test("exchange: create_market_order returns Binance format")
async def test_exchange_market_order():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    result = await client.create_market_order(
        "BTCUSDT", "BUY", 0.001,
        newClientOrderId="PMS_test_MKT_101"
    )
    assert "orderId" in result
    assert result["symbol"] == "BTCUSDT"
    assert result["side"] == "BUY"
    assert result["type"] == "MARKET"


@test("exchange: create_limit_order returns Binance format")
async def test_exchange_limit_order():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    result = await client.create_limit_order(
        "BTCUSDT", "BUY", 0.001, 65000.0,
        newClientOrderId="PMS_test_LMT_101"
    )
    assert "orderId" in result
    assert result["symbol"] == "BTCUSDT"
    assert result["price"] == "65000.0"


@test("exchange: cancel_order returns response")
async def test_exchange_cancel():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    await client.create_limit_order(
        "BTCUSDT", "BUY", 0.001, 65000.0,
        newClientOrderId="PMS_cancel_test_001"
    )
    result = await client.cancel_order("BTCUSDT", origClientOrderId="PMS_cancel_test_001")
    assert result["status"] == "CANCELED"


@test("exchange: cancel nonexistent order returns gracefully")
async def test_exchange_cancel_nonexistent():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()
    result = await client.cancel_order("BTCUSDT", origClientOrderId="nonexistent")
    assert result["status"] == "CANCELED"
    assert result["alreadyGone"] is True


@test("exchange: get_open_orders returns pending")
async def test_exchange_open_orders():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    await client.create_limit_order("BTCUSDT", "BUY", 0.001, 60000.0,
                                     newClientOrderId="PMS_open_001")
    await client.create_limit_order("BTCUSDT", "SELL", 0.001, 70000.0,
                                     newClientOrderId="PMS_open_002")

    orders = await client.get_open_orders("BTCUSDT")
    assert len(orders) == 2


@test("exchange: get_balance returns virtual balance")
async def test_exchange_balance():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    balance = await client.get_balance()
    assert isinstance(balance, list)
    assert balance[0]["asset"] == "USDT"


@test("exchange: change_leverage stores setting")
async def test_exchange_leverage():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    result = await client.change_leverage("BTCUSDT", 10)
    assert result["leverage"] == 10


@test("exchange: batch limit orders")
async def test_exchange_batch():
    from trading_engine_python.paper.exchange import PaperExchangeClient
    client = PaperExchangeClient()

    orders = [
        {"symbol": "BTCUSDT", "side": "BUY", "quantity": "0.001", "price": "60000",
         "newClientOrderId": "PMS_batch_001"},
        {"symbol": "BTCUSDT", "side": "BUY", "quantity": "0.001", "price": "59000",
         "newClientOrderId": "PMS_batch_002"},
    ]
    results = await client.create_batch_limit_orders(orders)
    assert len(results) == 2
    assert all(r["symbol"] == "BTCUSDT" for r in results)


# ═══════════════════════════════════════════════════════════
# 4. PaperUserStream
# ═══════════════════════════════════════════════════════════

@test("feed: symbol conversion binance↔ccxt")
def test_feed_symbol_conversion():
    from trading_engine_python.paper.feed import PaperUserStream
    assert PaperUserStream._binance_to_ccxt("BTCUSDT") == "BTC/USDT:USDT"
    assert PaperUserStream._ccxt_to_binance("BTC/USDT:USDT") == "BTCUSDT"
    assert PaperUserStream._binance_to_ccxt("ETHUSDT") == "ETH/USDT:USDT"
    # Already ccxt format should pass through
    assert PaperUserStream._binance_to_ccxt("BTC/USDT:USDT") == "BTC/USDT:USDT"


@test("feed: event routing to OrderManager")
async def test_feed_event_routing():
    from trading_engine_python.paper.feed import PaperUserStream
    from trading_engine_python.paper.matching import MatchingEngine

    events = []
    mock_om = AsyncMock()
    mock_om.on_order_update = AsyncMock(side_effect=lambda data: events.append(data))

    matching = MatchingEngine()
    feed = PaperUserStream(
        order_manager=mock_om,
        matching_engine=matching,
    )

    # Add a market order and tick to fill it
    matching.add_order("PMS_feed_001", "BTCUSDT", "BUY", "MARKET", 0.001)
    await feed._on_l1_tick("BTC/USDT:USDT", bid=65000, ask=65001, mid=65000.5)

    # OrderManager.on_order_update should have been called
    assert mock_om.on_order_update.call_count >= 1


# ═══════════════════════════════════════════════════════════
# 5. Full Pipeline
# ═══════════════════════════════════════════════════════════

@test("pipeline: market order → feed event → correct format")
async def test_full_pipeline():
    """
    Full pipeline: PaperExchangeClient.create_market_order()
    → MatchingEngine.on_tick()
    → event_callback fires ORDER_TRADE_UPDATE
    → data has all required fields for OrderManager.on_order_update()
    """
    from trading_engine_python.paper.exchange import PaperExchangeClient

    events = []

    client = PaperExchangeClient()
    client.matching_engine.set_event_callback(
        lambda data: _collect_event(events, data)
    )

    # Place market order
    result = await client.create_market_order(
        "BTCUSDT", "BUY", 0.001,
        newClientOrderId="PMS_pipeline_001",
    )

    # Trigger tick to fill the market order
    await client.matching_engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)

    # Verify events have all required fields
    assert len(events) >= 2  # NEW + FILLED

    for ev in events:
        assert "symbol" in ev
        assert "client_order_id" in ev
        assert "order_id" in ev
        assert "side" in ev
        assert "status" in ev
        assert "orig_qty" in ev
        assert "last_filled_price" in ev
        assert "accumulated_filled_qty" in ev

    filled = [e for e in events if e["status"] == "FILLED"]
    assert len(filled) == 1
    assert filled[0]["client_order_id"] == "PMS_pipeline_001"
    assert filled[0]["symbol"] == "BTCUSDT"
    assert filled[0]["side"] == "BUY"


async def _collect_event(events, data):
    events.append(data)


@test("pipeline: limit order pending → tick fills → correct lifecycle")
async def test_limit_lifecycle():
    from trading_engine_python.paper.exchange import PaperExchangeClient

    events = []

    client = PaperExchangeClient()
    client.matching_engine.set_event_callback(
        lambda data: _collect_event(events, data)
    )

    # Place limit BUY at 64000
    await client.create_limit_order(
        "BTCUSDT", "BUY", 0.001, 64000.0,
        newClientOrderId="PMS_limit_lifecycle_001",
    )

    # Tick above limit price — should NOT fill
    await client.matching_engine.on_tick("BTCUSDT", bid=65000, ask=65001, mid=65000.5)
    pending = await client.get_open_orders("BTCUSDT")
    assert len(pending) == 1

    # Tick at/below limit price — SHOULD fill
    events.clear()
    await client.matching_engine.on_tick("BTCUSDT", bid=63999, ask=64000, mid=63999.5)
    pending = await client.get_open_orders("BTCUSDT")
    assert len(pending) == 0

    filled = [e for e in events if e["status"] == "FILLED"]
    assert len(filled) == 1
    assert filled[0]["last_filled_price"] == "64000.0"  # Filled at limit price


# ═══════════════════════════════════════════════════════════
# Runner
# ═══════════════════════════════════════════════════════════

async def run_all():
    print("\n🧻 Paper Trading — Tests\n")
    print("=" * 55)

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
