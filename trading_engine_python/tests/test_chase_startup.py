import asyncio
import json
from types import SimpleNamespace

from trading_engine_python.algos.chase import ChaseEngine
from trading_engine_python.orders.state import OrderState


class _ImmediateSeedMarketData:
    def __init__(self):
        self._callbacks = {}
        self._l1 = {"bid": 100.0, "ask": 101.0, "mid": 100.5}

    def subscribe(self, symbol, callback):
        self._callbacks.setdefault(symbol, []).append(callback)
        asyncio.get_running_loop().create_task(callback(symbol, 100.0, 101.0, 100.5))

    def get_l1(self, symbol):
        return self._l1


def test_start_chase_does_not_double_place_during_startup_seed_tick():
    async def run():
        md = _ImmediateSeedMarketData()

        calls = []

        async def place_limit_order(**kwargs):
            parent_id = kwargs["parent_id"]
            calls.append(parent_id)
            assert parent_id in engine._active
            assert engine._active[parent_id]._initializing is True
            return OrderState(
                client_order_id=f"{parent_id}_coid",
                sub_account_id=kwargs["sub_account_id"],
                symbol=kwargs["symbol"],
                side=kwargs["side"],
                order_type="LIMIT",
                quantity=kwargs["quantity"],
                price=kwargs["price"],
                leverage=kwargs["leverage"],
                origin=kwargs["origin"],
                parent_id=parent_id,
                state="placing",
            )

        om = SimpleNamespace(
            place_limit_order=place_limit_order,
            get_order=lambda client_order_id: None,
        )
        engine = ChaseEngine(om, md, redis_client=None)

        await engine.start_chase({
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "quantity": 1.0,
            "leverage": 3,
        })

        await asyncio.sleep(0.05)
        assert len(calls) == 1

    asyncio.run(run())


def test_resume_chase_does_not_double_place_during_startup_seed_tick():
    async def run():
        md = _ImmediateSeedMarketData()
        stored = {
            "chaseId": "chase_resume_1",
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "quantity": 1.0,
            "leverage": 3,
            "stalkMode": "maintain",
            "stalkOffsetPct": 0.0,
            "maxDistancePct": 2.0,
            "status": "ACTIVE",
            "repriceCount": 0,
            "reduceOnly": False,
            "startedAt": 1,
        }

        class _Redis:
            async def keys(self, pattern):
                return ["pms:chase:chase_resume_1"]

            async def get(self, key):
                return json.dumps(stored)

            async def set(self, *args, **kwargs):
                return True

            async def hset(self, *args, **kwargs):
                return True

            async def expire(self, *args, **kwargs):
                return True

            async def delete(self, *args, **kwargs):
                return True

        calls = []

        async def place_limit_order(**kwargs):
            parent_id = kwargs["parent_id"]
            calls.append(parent_id)
            assert parent_id in engine._active
            assert engine._active[parent_id]._initializing is True
            return OrderState(
                client_order_id=f"{parent_id}_coid",
                sub_account_id=kwargs["sub_account_id"],
                symbol=kwargs["symbol"],
                side=kwargs["side"],
                order_type="LIMIT",
                quantity=kwargs["quantity"],
                price=kwargs["price"],
                leverage=kwargs["leverage"],
                origin=kwargs["origin"],
                parent_id=parent_id,
                state="placing",
            )

        om = SimpleNamespace(
            place_limit_order=place_limit_order,
            get_order=lambda client_order_id: None,
        )
        engine = ChaseEngine(om, md, redis_client=_Redis())

        resumed = await engine.resume_from_redis()

        await asyncio.sleep(0.05)
        assert resumed == 1
        assert calls == ["chase_resume_1"]
        assert engine._active["chase_resume_1"].current_order_id == "chase_resume_1_coid"

    asyncio.run(run())
