import asyncio
from unittest.mock import AsyncMock, MagicMock

from trading_engine_python.orders.manager import OrderManager
from trading_engine_python.orders.state import OrderState


def test_reconcile_reattaches_exchange_id_for_tracked_order_missing_eid():
    async def run():
        exchange = MagicMock()
        exchange.get_order = AsyncMock(return_value={
            "status": "NEW",
            "symbol": "PIPPINUSDT",
            "side": "BUY",
            "price": "0.35787",
            "origQty": "18",
            "executedQty": "0",
            "reduceOnly": False,
        })
        exchange.get_open_orders = AsyncMock(return_value=[{
            "clientOrderId": "PMS64f8e5c3_LMT_missingeid01",
            "orderId": "5358263337",
            "symbol": "PIPPINUSDT",
            "side": "BUY",
            "price": "0.35787",
            "origQty": "18",
            "executedQty": "0",
            "type": "LIMIT",
            "reduceOnly": False,
        }])
        redis = MagicMock()
        redis.hset = AsyncMock()
        redis.expire = AsyncMock()
        manager = OrderManager(exchange_client=exchange, redis_client=redis)

        order = OrderState(
            client_order_id="PMS64f8e5c3_LMT_missingeid01",
            sub_account_id="64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb",
            symbol="PIPPINUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=18.0,
            price=0.35787,
            state="placing",
        )
        manager.tracker.register(order)

        summary = await manager.reconcile_on_reconnect()

        assert summary["orphans_registered"] == 0
        tracked = manager.tracker.lookup(client_order_id=order.client_order_id)
        assert tracked is not None
        assert tracked.exchange_order_id == "5358263337"
        assert tracked.state == "active"
        exchange.get_order.assert_awaited_once_with(
            "PIPPINUSDT",
            orderId=None,
            origClientOrderId="PMS64f8e5c3_LMT_missingeid01",
        )

    asyncio.run(run())
