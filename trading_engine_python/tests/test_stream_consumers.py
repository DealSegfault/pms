import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from trading_engine_python.events.order_consumer import OrderConsumer
from trading_engine_python.events.frontend_consumer import FrontendConsumer
from trading_engine_python.events.risk_consumer import RiskConsumer
from trading_engine_python.orders.manager import OrderManager
from trading_engine_python.orders.state import OrderState
from trading_engine_python.orders.tracker import OrderTracker


def test_risk_consumer_reads_normalized_account_update_payload():
    async def run():
        risk = MagicMock()
        risk.on_account_update = AsyncMock()
        consumer = RiskConsumer(
            order_manager=MagicMock(),
            risk_engine=risk,
            redis_client=MagicMock(),
            db=MagicMock(),
        )

        payload = {
            "balances": [{"a": "USDT", "wb": "100.0"}],
            "positions": [{"symbol": "BTCUSDT", "position_amount": 0.5, "entry_price": 65000.0}],
            "event_time": 123,
            "transaction_time": 124,
        }
        await consumer.handle([{"type": "ACCOUNT_UPDATE", "payload": json.dumps(payload)}])
        risk.on_account_update.assert_awaited_once_with(payload)

    asyncio.run(run())


def test_frontend_consumer_publishes_on_contract_channel():
    async def run():
        redis = MagicMock()
        redis.publish = AsyncMock()
        consumer = FrontendConsumer(redis)

        await consumer.handle([{"type": "ORDER_STATE_FILLED", "client_order_id": "abc"}])
        redis.publish.assert_awaited_once()
        args = redis.publish.await_args.args
        assert args[0] == "pms:events:order_filled"
        assert json.loads(args[1])["client_order_id"] == "abc"

    asyncio.run(run())


def test_order_consumer_ignores_late_new_after_fill():
    async def run():
        tracker = OrderTracker()
        bus = MagicMock()
        bus.publish = AsyncMock()
        om = MagicMock()
        om._create_bot_order_from_feed = AsyncMock()
        consumer = OrderConsumer(tracker, bus, om)

        order = OrderState(
            client_order_id="PMS12345678_MKT_deadbeef0001",
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            exchange_order_id="42",
            symbol="BTCUSDT",
            side="BUY",
            order_type="MARKET",
            quantity=1.0,
        )
        order.transition("placing")
        tracker.register(order)

        await consumer.handle([{
            "type": "ORDER_FILLED",
            "client_order_id": order.client_order_id,
            "exchange_order_id": "42",
            "status": "FILLED",
            "fill_price": "100.0",
            "fill_qty": "1.0",
            "avg_price": "100.0",
        }])
        await consumer.handle([{
            "type": "ORDER_NEW",
            "client_order_id": order.client_order_id,
            "exchange_order_id": "42",
            "status": "NEW",
        }])

        published_types = [call.args[0] for call in bus.publish.await_args_list]
        assert published_types == ["ORDER_STATE_FILLED"]

    asyncio.run(run())


def test_risk_consumer_does_not_publish_order_active_for_market_orders():
    async def run():
        order = OrderState(
            client_order_id="PMS12345678_MKT_deadbeef0002",
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            symbol="BTCUSDT",
            side="BUY",
            order_type="MARKET",
            quantity=1.0,
            state="active",
        )
        om = MagicMock()
        om.get_order.return_value = order
        om._redis_set_open_order = AsyncMock()
        om._publish_event = AsyncMock()
        consumer = RiskConsumer(
            order_manager=om,
            risk_engine=MagicMock(),
            redis_client=MagicMock(),
            db=MagicMock(),
        )

        await consumer.handle([{"type": "ORDER_STATE_NEW", "client_order_id": order.client_order_id}])

        om._redis_set_open_order.assert_not_called()
        publish_types = [call.args[0] for call in om._publish_event.await_args_list]
        assert publish_types == []

    asyncio.run(run())


def test_order_manager_legacy_path_ignores_late_new_after_fill():
    async def run():
        manager = OrderManager(exchange_client=MagicMock(), redis_client=MagicMock(), risk_engine=None, db=MagicMock())
        manager._redis_set_open_order = AsyncMock()
        manager._publish_event = AsyncMock()
        manager._redis_remove_open_order = AsyncMock()
        manager._db_update_pending_order = AsyncMock()

        order = OrderState(
            client_order_id="PMS12345678_MKT_deadbeef0003",
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            exchange_order_id="77",
            symbol="BTCUSDT",
            side="BUY",
            order_type="MARKET",
            quantity=1.0,
        )
        order.transition("placing")
        manager.tracker.register(order)

        await manager.on_order_update({
            "client_order_id": order.client_order_id,
            "order_id": "77",
            "order_status": "FILLED",
            "last_filled_price": "100.0",
            "last_filled_qty": "1.0",
            "avg_price": "100.0",
        })
        await manager.on_order_update({
            "client_order_id": order.client_order_id,
            "order_id": "77",
            "order_status": "NEW",
        })

        manager._redis_set_open_order.assert_not_called()
        publish_types = [call.args[0] for call in manager._publish_event.await_args_list]
        assert publish_types == ["order_filled"]

    asyncio.run(run())


def test_market_order_rest_filled_fast_path_creates_feedback_without_user_stream():
    async def run():
        exchange = MagicMock()
        exchange.create_market_order = AsyncMock(return_value={
            "orderId": 99,
            "status": "FILLED",
            "executedQty": "3",
            "avgPrice": "2.5",
            "origQty": "3",
        })
        risk = MagicMock()
        risk.on_order_fill = AsyncMock()
        manager = OrderManager(exchange_client=exchange, redis_client=MagicMock(), risk_engine=risk, db=MagicMock())
        manager._publish_event = AsyncMock()
        manager._redis_remove_open_order = AsyncMock()
        manager._db_update_pending_order = AsyncMock()

        order = await manager.place_market_order(
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            symbol="POWERUSDT",
            side="SELL",
            quantity=3.0,
        )

        assert order.state == "filled"
        assert order.filled_qty == 3.0
        risk.on_order_fill.assert_awaited_once()
        publish_types = [call.args[0] for call in manager._publish_event.await_args_list]
        assert "order_filled" in publish_types

    asyncio.run(run())


def test_limit_order_stays_placing_until_feed_new():
    async def run():
        exchange = MagicMock()
        exchange.create_limit_order = AsyncMock(return_value={
            "orderId": 123,
            "status": "NEW",
            "origQty": "2",
            "price": "2.561",
        })
        manager = OrderManager(
            exchange_client=exchange,
            redis_client=MagicMock(),
            risk_engine=None,
            db=MagicMock(),
        )

        order = await manager.place_limit_order(
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            symbol="POWERUSDT",
            side="SELL",
            quantity=2.0,
            price=2.561,
        )

        assert order.state == "placing"
        assert order.exchange_order_id == "123"

    asyncio.run(run())


def test_cancel_order_allows_cancelling_from_placing():
    async def run():
        exchange = MagicMock()
        exchange.create_limit_order = AsyncMock(return_value={
            "orderId": 456,
            "status": "NEW",
            "origQty": "2",
            "price": "2.561",
        })
        exchange.cancel_order = AsyncMock(return_value={"status": "CANCELED"})
        manager = OrderManager(
            exchange_client=exchange,
            redis_client=MagicMock(),
            risk_engine=None,
            db=MagicMock(),
        )

        order = await manager.place_limit_order(
            sub_account_id="12345678-aaaa-bbbb-cccc-1234567890ab",
            symbol="POWERUSDT",
            side="SELL",
            quantity=2.0,
            price=2.561,
        )
        sent = await manager.cancel_order(order.client_order_id)

        assert sent is True
        assert order.state == "cancelling"
        exchange.cancel_order.assert_awaited_once()

    asyncio.run(run())
