import asyncio
from unittest.mock import AsyncMock, MagicMock

from trading_engine_python.orders.manager import OrderManager
from trading_engine_python.orders.state import OrderState, derive_legacy_routing_prefix, derive_routing_prefix


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


def test_reconcile_load_open_orders_accepts_legacy_uuid_slice_prefix():
    async def run():
        sub_account_id = "64f8e5c3-dfe3-4d1d-92d8-4f7df6b0cafb"
        legacy_prefix = derive_legacy_routing_prefix(sub_account_id)
        exchange = MagicMock()
        exchange.get_open_orders = AsyncMock(return_value=[{
            "clientOrderId": f"PMS{legacy_prefix}_LMT_oldformat0001",
            "orderId": "5358263338",
            "symbol": "PIPPINUSDT",
            "side": "BUY",
            "price": "0.35787",
            "origQty": "18",
            "executedQty": "0",
            "type": "LIMIT",
            "reduceOnly": False,
            "time": 1700000000000,
        }])
        redis = MagicMock()
        redis.hset = AsyncMock()
        redis.expire = AsyncMock()
        db = MagicMock()
        db.fetch_all = AsyncMock(return_value=[{
            "id": sub_account_id,
            "status": "ACTIVE",
            "routing_prefix": derive_routing_prefix(sub_account_id),
        }])
        manager = OrderManager(exchange_client=exchange, redis_client=redis, db=db)

        count = await manager.load_open_orders_from_exchange()

        assert count == 1
        tracked = manager.tracker.lookup(client_order_id=f"PMS{legacy_prefix}_LMT_oldformat0001")
        assert tracked is not None
        assert tracked.sub_account_id == sub_account_id
        assert tracked.exchange_order_id == "5358263338"

    asyncio.run(run())
