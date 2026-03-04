import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from trading_engine_python.algos.chase import ChaseEngine
from trading_engine_python.algos.scalper import ScalperEngine
from trading_engine_python.contracts.state import ScalperRedisState
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


def test_resume_scalper_restores_reduce_only_leg_when_armed():
    async def run():
        md = _ImmediateSeedMarketData()
        stored = ScalperRedisState(
            scalper_id="scalper_resume_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            child_count=2,
            status="active",
            long_offset_pct=0.1,
            short_offset_pct=0.2,
            long_size_usd=100.0,
            short_size_usd=100.0,
            leverage=3,
            started_at=1,
            reduce_only_armed=True,
        ).to_dict()

        class _Redis:
            async def keys(self, pattern):
                return ["pms:scalper:scalper_resume_1"]

            async def get(self, key):
                return json.dumps(stored)

            async def delete(self, *args, **kwargs):
                return True

        async def start_chase_batch(params_list):
            return [f"chase_{idx}" for idx, _ in enumerate(params_list)]

        chase = SimpleNamespace(start_chase_batch=AsyncMock(side_effect=start_chase_batch))
        engine = ScalperEngine(SimpleNamespace(), md, chase, redis_client=_Redis())

        resumed = await engine.resume_from_redis()

        assert resumed == 1
        assert chase.start_chase_batch.await_count == 2
        state = engine.get_state("scalper_resume_1")
        assert state is not None
        assert state.reduce_only_armed is True
        assert len(state.long_slots) == 2
        assert len(state.short_slots) == 2
        assert all(slot.chase_id for slot in state.long_slots)
        assert all(slot.chase_id for slot in state.short_slots)

    asyncio.run(run())


def test_scalper_cancel_kills_restart_orphan_created_after_stop():
    async def run():
        md = _ImmediateSeedMarketData()
        start_release = asyncio.Event()
        start_started = asyncio.Event()

        async def start_chase_batch(params_list):
            return [f"boot_{idx}" for idx, _ in enumerate(params_list)]

        async def start_chase(params):
            start_started.set()
            await start_release.wait()
            return "orphan_after_stop"

        chase = SimpleNamespace(
            start_chase_batch=AsyncMock(side_effect=start_chase_batch),
            start_chase=AsyncMock(side_effect=start_chase),
            cancel_chase=AsyncMock(return_value=True),
        )

        engine = ScalperEngine(SimpleNamespace(), md, chase, redis_client=None)
        scalper_id = await engine.start_scalper({
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "startSide": "LONG",
            "leverage": 3,
            "childCount": 1,
            "longOffsetPct": 0.1,
            "shortOffsetPct": 0.1,
            "longSizeUsd": 100,
            "shortSizeUsd": 100,
        })

        state = engine.get_state(scalper_id)
        assert state is not None
        slot = state.long_slots[0]
        slot.chase_id = None
        slot.active = False

        restart_task = asyncio.create_task(engine._restart_slot(state, slot))
        await start_started.wait()

        ok = await engine.cancel_scalper(scalper_id)
        assert ok is True

        start_release.set()
        await restart_task

        chase.cancel_chase.assert_called_with("orphan_after_stop")
        assert slot.chase_id is None
        assert slot.active is False

    asyncio.run(run())
