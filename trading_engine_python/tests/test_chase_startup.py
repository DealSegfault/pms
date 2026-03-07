import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from trading_engine_python.algos.chase import ChaseEngine, ChaseState
from trading_engine_python.algos.scalper import (
    ScalperEngine,
    ScalperSlot,
    ScalperState,
    _enforce_tick_spaced_offsets,
    _generate_layer_offsets,
    _offset_price,
    _tick_steps_for_offsets,
    _truncate_to_tick,
)
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


class _StaticSymbolInfo:
    def __init__(self, tick_size=1.0):
        self._tick_size = tick_size

    def get(self, symbol):
        return SimpleNamespace(tick_size=self._tick_size)

    def round_price(self, symbol, price):
        return price


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


def test_chase_delays_one_tick_aggressive_reprice():
    async def run():
        old_order = OrderState(
            client_order_id="coid_old",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=100.0,
            state="active",
        )
        new_order = OrderState(
            client_order_id="coid_new",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=101.0,
            state="placing",
        )
        replace_order = AsyncMock(return_value=new_order)
        om = SimpleNamespace(
            replace_order=replace_order,
            get_order=lambda client_order_id: old_order if client_order_id == "coid_old" else None,
            _symbol_info=_StaticSymbolInfo(),
        )
        engine = ChaseEngine(om, None, redis_client=None)
        state = ChaseState(
            id="chase_delay_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            quantity=1.0,
            current_order_id="coid_old",
            current_order_price=100.0,
            status="ACTIVE",
        )
        state._initializing = False
        engine._active[state.id] = state

        await engine._on_tick(state, "BTCUSDT", 101.0, 102.0, 101.5)
        assert replace_order.await_count == 0
        assert state._pending_aggressive_reprice_price == 101.0

        state._pending_aggressive_reprice_since = time.time() - 0.2
        await engine._on_tick(state, "BTCUSDT", 101.0, 102.0, 101.5)

        assert replace_order.await_count == 1
        assert state.current_order_id == "coid_new"
        assert state.current_order_price == 101.0
        assert state.reprice_count == 1
        assert state._pending_aggressive_reprice_price is None

    asyncio.run(run())


def test_chase_reprices_protective_move_immediately():
    async def run():
        old_order = OrderState(
            client_order_id="coid_old",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=100.0,
            state="active",
        )
        new_order = OrderState(
            client_order_id="coid_new",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=99.0,
            state="placing",
        )
        replace_order = AsyncMock(return_value=new_order)
        om = SimpleNamespace(
            replace_order=replace_order,
            get_order=lambda client_order_id: old_order if client_order_id == "coid_old" else None,
            _symbol_info=_StaticSymbolInfo(),
        )
        engine = ChaseEngine(om, None, redis_client=None)
        state = ChaseState(
            id="chase_protective_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            quantity=1.0,
            current_order_id="coid_old",
            current_order_price=100.0,
            status="ACTIVE",
        )
        state._initializing = False
        engine._active[state.id] = state

        await engine._on_tick(state, "BTCUSDT", 99.0, 100.0, 99.5)

        assert replace_order.await_count == 1
        assert state.current_order_id == "coid_new"
        assert state.current_order_price == 99.0
        assert state.reprice_count == 1
        assert state._pending_aggressive_reprice_price is None

    asyncio.run(run())


def test_chase_reprices_two_tick_aggressive_move_immediately():
    async def run():
        old_order = OrderState(
            client_order_id="coid_old",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=100.0,
            state="active",
        )
        new_order = OrderState(
            client_order_id="coid_new",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=102.0,
            state="placing",
        )
        replace_order = AsyncMock(return_value=new_order)
        om = SimpleNamespace(
            replace_order=replace_order,
            get_order=lambda client_order_id: old_order if client_order_id == "coid_old" else None,
            _symbol_info=_StaticSymbolInfo(),
        )
        engine = ChaseEngine(om, None, redis_client=None)
        state = ChaseState(
            id="chase_aggressive_fast_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            quantity=1.0,
            current_order_id="coid_old",
            current_order_price=100.0,
            status="ACTIVE",
        )
        state._initializing = False
        engine._active[state.id] = state

        await engine._on_tick(state, "BTCUSDT", 102.0, 103.0, 102.5)

        assert replace_order.await_count == 1
        assert state.current_order_id == "coid_new"
        assert state.current_order_price == 102.0
        assert state.reprice_count == 1
        assert state._pending_aggressive_reprice_price is None

    asyncio.run(run())


def test_chase_does_not_aggressively_reprice_while_order_is_still_placing():
    async def run():
        old_order = OrderState(
            client_order_id="coid_old",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=100.0,
            state="placing",
        )
        new_order = OrderState(
            client_order_id="coid_new",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            order_type="LIMIT",
            quantity=1.0,
            price=101.0,
            state="placing",
        )
        replace_order = AsyncMock(return_value=new_order)
        om = SimpleNamespace(
            replace_order=replace_order,
            get_order=lambda client_order_id: old_order if client_order_id == "coid_old" else None,
            _symbol_info=_StaticSymbolInfo(),
        )
        engine = ChaseEngine(om, None, redis_client=None)
        state = ChaseState(
            id="chase_placing_hold_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            quantity=1.0,
            current_order_id="coid_old",
            current_order_price=100.0,
            status="ACTIVE",
        )
        state._initializing = False
        engine._active[state.id] = state

        await engine._on_tick(state, "BTCUSDT", 101.0, 102.0, 101.5)
        state._pending_aggressive_reprice_since = time.time() - 0.3
        await engine._on_tick(state, "BTCUSDT", 101.0, 102.0, 101.5)
        assert replace_order.await_count == 0

        old_order.state = "active"
        await engine._on_tick(state, "BTCUSDT", 101.0, 102.0, 101.5)

        assert replace_order.await_count == 1
        assert state.current_order_id == "coid_new"
        assert state.reprice_count == 1

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


def test_scalper_allow_loss_defaults_are_mode_aware_and_explicit_value_wins():
    async def run():
        md = _ImmediateSeedMarketData()

        async def start_chase_batch(params_list):
            return [f"chase_{idx}" for idx, _ in enumerate(params_list)]

        chase = SimpleNamespace(
            start_chase_batch=AsyncMock(side_effect=start_chase_batch),
            cancel_chase=AsyncMock(return_value=True),
        )

        engine = ScalperEngine(SimpleNamespace(), md, chase, redis_client=None)

        regular_id = await engine.start_scalper({
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
        regular_state = engine.get_state(regular_id)
        assert regular_state is not None
        assert regular_state.allow_loss is True
        await engine.cancel_scalper(regular_id)

        neutral_id = await engine.start_scalper({
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "startSide": "LONG",
            "neutralMode": True,
            "leverage": 3,
            "childCount": 1,
            "longOffsetPct": 0.1,
            "shortOffsetPct": 0.1,
            "longSizeUsd": 100,
            "shortSizeUsd": 100,
        })
        neutral_state = engine.get_state(neutral_id)
        assert neutral_state is not None
        assert neutral_state.allow_loss is False
        await engine.cancel_scalper(neutral_id)

        explicit_false_id = await engine.start_scalper({
            "subAccountId": "s1",
            "symbol": "BTCUSDT",
            "startSide": "SHORT",
            "allowLoss": False,
            "leverage": 3,
            "childCount": 1,
            "longOffsetPct": 0.1,
            "shortOffsetPct": 0.1,
            "longSizeUsd": 100,
            "shortSizeUsd": 100,
        })
        explicit_false_state = engine.get_state(explicit_false_id)
        assert explicit_false_state is not None
        assert explicit_false_state.allow_loss is False
        await engine.cancel_scalper(explicit_false_id)

    asyncio.run(run())


def test_tick_spaced_offsets_expand_dense_microcap_layers_to_unique_ticks():
    reference_price = 0.0011675
    tick_size = 0.000001
    for side, base_offset in (("BUY", 0.2), ("SELL", 0.85)):
        raw_offsets = _generate_layer_offsets(base_offset, 9)
        raw_prices = [
            _truncate_to_tick(_offset_price(reference_price, side, offset), tick_size)
            for offset in raw_offsets
        ]
        adjusted_offsets = _enforce_tick_spaced_offsets(reference_price, side, raw_offsets, tick_size)
        adjusted_prices = [
            _truncate_to_tick(_offset_price(reference_price, side, offset), tick_size)
            for offset in adjusted_offsets
        ]
        tick_steps = _tick_steps_for_offsets(reference_price, side, adjusted_offsets, tick_size)

        assert len(set(raw_prices)) < len(raw_prices) or side == "SELL"
        assert len(set(adjusted_prices)) == len(adjusted_prices)
        assert adjusted_offsets == sorted(adjusted_offsets)
        assert all(adjusted >= raw for adjusted, raw in zip(adjusted_offsets, raw_offsets))
        assert tick_steps == sorted(tick_steps)
        assert len(set(tick_steps)) == len(tick_steps)


def test_scalper_progress_payload_preserves_pause_reason():
    async def run():
        class _RedisCapture:
            def __init__(self):
                self.events = []

            async def publish(self, channel, payload):
                self.events.append((channel, json.loads(payload)))

        redis = _RedisCapture()
        engine = ScalperEngine(SimpleNamespace(), _ImmediateSeedMarketData(), SimpleNamespace(), redis_client=redis)
        state = ScalperState(
            id="scalper_pause_reason_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            long_slots=[
                ScalperSlot(
                    layer_idx=0,
                    side="BUY",
                    qty=1.0,
                    offset_pct=0.1,
                    paused=True,
                    pause_reason="price_filter",
                )
            ],
        )

        await engine._broadcast_progress(state)

        assert redis.events, "Expected scalper_progress publish"
        _, payload = redis.events[-1]
        assert payload["longSlots"][0]["pauseReason"] == "price_filter"

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


def test_chase_fill_event_falls_back_to_callback_when_scalper_slot_lookup_misses():
    async def run():
        om = SimpleNamespace(cancel_order=AsyncMock())
        md = SimpleNamespace(_callbacks={})
        engine = ChaseEngine(om, md, redis_client=None)

        fills = []

        async def on_fill(fill_price, fill_qty):
            fills.append((fill_price, fill_qty))

        state = ChaseState(
            id="chase_race_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="BUY",
            quantity=1.0,
            current_order_id="coid_1",
            parent_scalper_id="scalper_1",
            on_chase_fill=on_fill,
        )
        engine._active[state.id] = state
        engine._scalper = SimpleNamespace(on_chase_fill_event=AsyncMock(return_value=False))

        await engine.on_fill_event(state, {
            "client_order_id": "coid_1",
            "avg_price": 101.25,
            "fill_qty": 0.75,
        })

        engine._scalper.on_chase_fill_event.assert_awaited_once_with(
            "scalper_1", "chase_race_1", 101.25, 0.75
        )
        assert fills == [(101.25, 0.75)]
        assert "chase_race_1" not in engine._active

    asyncio.run(run())


def test_scalper_batch_start_does_not_rebind_slot_after_early_fill_callback():
    async def run():
        md = _ImmediateSeedMarketData()
        batch_calls = 0

        async def start_chase_batch(params_list):
            nonlocal batch_calls
            batch_calls += 1
            if batch_calls == 1:
                result = params_list[0]["onFill"](100.5, params_list[0]["quantity"])
                if asyncio.iscoroutine(result):
                    await result
                return ["boot_opening_0"]
            return [f"boot_other_{idx}" for idx, _ in enumerate(params_list)]

        chase = SimpleNamespace(
            start_chase_batch=AsyncMock(side_effect=start_chase_batch),
            start_chase=AsyncMock(return_value="restart_after_fill"),
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
            "neutralMode": True,
            "minRefillDelayMs": 60000,
        })

        await asyncio.sleep(0)

        state = engine.get_state(scalper_id)
        assert state is not None
        slot = state.long_slots[0]
        assert state.fill_count == 1
        assert slot.fills == 1
        assert slot.chase_id is None
        assert slot.active is False
        assert slot._start_pending is False

        await engine.cancel_scalper(scalper_id)

    asyncio.run(run())


def test_reduce_only_restart_clamps_runtime_qty_without_shrinking_slot():
    async def run():
        md = _ImmediateSeedMarketData()
        captured = {}

        async def start_chase(params):
            captured.update(params)
            return "reduce_only_clamped"

        actual_pos = SimpleNamespace(quantity=2.0)
        om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(find_position=lambda sub_id, symbol, side: actual_pos)
            )
        )
        chase = SimpleNamespace(start_chase=AsyncMock(side_effect=start_chase))
        engine = ScalperEngine(om, md, chase, redis_client=None)

        state = ScalperState(
            id="scalper_test_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            leverage=3,
            last_known_price=10.0,
        )
        slot = ScalperSlot(layer_idx=0, side="SELL", qty=5.0, offset_pct=0.1, reduce_only=True)
        state.short_slots = [slot]
        engine._active[state.id] = state

        await engine._restart_slot(state, slot)

        assert captured["quantity"] == 2.0
        assert slot.qty == 5.0
        assert slot.chase_id == "reduce_only_clamped"

    asyncio.run(run())


def test_reduce_only_restart_uses_dust_override_for_live_position():
    async def run():
        md = _ImmediateSeedMarketData()
        captured = {}

        async def start_chase(params):
            captured.update(params)
            return "reduce_only_dust"

        actual_pos = SimpleNamespace(quantity=7.0)
        om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(find_position=lambda sub_id, symbol, side: actual_pos)
            )
        )
        chase = SimpleNamespace(start_chase=AsyncMock(side_effect=start_chase))
        engine = ScalperEngine(om, md, chase, redis_client=None)

        state = ScalperState(
            id="scalper_test_2",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            leverage=3,
            last_known_price=1.0,
        )
        slot = ScalperSlot(layer_idx=0, side="SELL", qty=1.0, offset_pct=0.1, reduce_only=True)
        state.short_slots = [slot]
        engine._active[state.id] = state

        await engine._restart_slot(state, slot)

        assert captured["quantity"] == 7.0
        assert slot.qty == 1.0
        assert slot.chase_id == "reduce_only_dust"

    asyncio.run(run())


def test_reduce_only_deferred_reject_pauses_scalper_slot_when_position_gone():
    async def run():
        md = SimpleNamespace(_callbacks={}, get_l1=lambda symbol: None)

        async def place_limit_order(**kwargs):
            order = OrderState(
                client_order_id="failed_reduce_only",
                sub_account_id=kwargs["sub_account_id"],
                symbol=kwargs["symbol"],
                side=kwargs["side"],
                order_type="LIMIT",
                quantity=kwargs["quantity"],
                price=kwargs["price"],
                leverage=kwargs["leverage"],
                origin=kwargs["origin"],
                parent_id=kwargs["parent_id"],
                reduce_only=kwargs["reduce_only"],
                state="placing",
            )
            order.transition("failed")
            order._extra["error"] = "ReduceOnly Order is rejected."
            return order

        chase_om = SimpleNamespace(
            place_limit_order=place_limit_order,
            get_order=lambda client_order_id: None,
        )
        chase = ChaseEngine(chase_om, md, redis_client=None)

        scalper_om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(find_position=lambda *_args: None)
            )
        )
        scalper = ScalperEngine(scalper_om, md, SimpleNamespace(), redis_client=None)
        chase.set_scalper(scalper)

        slot = ScalperSlot(
            layer_idx=0,
            side="SELL",
            qty=1.0,
            offset_pct=0.1,
            reduce_only=True,
            chase_id="chase_reduce_only_1",
            active=True,
        )
        scalper_state = ScalperState(
            id="scalper_reduce_only_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            short_slots=[slot],
        )
        scalper._active[scalper_state.id] = scalper_state

        chase_state = ChaseState(
            id="chase_reduce_only_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="SELL",
            quantity=1.0,
            reduce_only=True,
            parent_scalper_id=scalper_state.id,
            status="ACTIVE",
        )
        chase_state._initializing = False
        chase._active[chase_state.id] = chase_state

        await chase._on_tick(chase_state, "BTCUSDT", 100.0, 101.0, 100.5)

        assert slot.chase_id is None
        assert slot.active is False
        assert slot.paused is True
        assert slot.pause_reason == "no_position"
        assert chase_state.id not in chase._active

    asyncio.run(run())


def test_reduce_only_restart_does_not_rebind_after_immediate_reject_callback():
    async def run():
        md = _ImmediateSeedMarketData()

        lookup_results = iter([
            SimpleNamespace(quantity=1.0),
            None,
        ])

        def find_position(*_args):
            return next(lookup_results, None)

        async def start_chase(params):
            result = params["onCancel"]("ReduceOnly Order is rejected.")
            if asyncio.iscoroutine(result):
                await result
            return "reject_immediate"

        om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(find_position=find_position)
            )
        )
        chase = SimpleNamespace(start_chase=AsyncMock(side_effect=start_chase))
        engine = ScalperEngine(om, md, chase, redis_client=None)

        state = ScalperState(
            id="scalper_restart_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            leverage=3,
            last_known_price=10.0,
        )
        slot = ScalperSlot(layer_idx=0, side="SELL", qty=1.0, offset_pct=0.1, reduce_only=True)
        state.short_slots = [slot]
        engine._active[state.id] = state

        await engine._restart_slot(state, slot)

        assert slot.chase_id is None
        assert slot.active is False
        assert slot.paused is True
        assert slot.pause_reason == "no_position"
        assert slot._start_pending is False

    asyncio.run(run())


def test_opening_fill_reactivates_reduce_only_slot_paused_for_no_position():
    async def run():
        md = _ImmediateSeedMarketData()
        chase_ids = iter(["reactivated_unwind", "restarted_opening"])

        async def start_chase(params):
            return next(chase_ids)

        om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(
                    find_position=lambda *_args: SimpleNamespace(quantity=2.0)
                )
            )
        )
        chase = SimpleNamespace(start_chase=AsyncMock(side_effect=start_chase))
        engine = ScalperEngine(om, md, chase, redis_client=None)

        opening_slot = ScalperSlot(
            layer_idx=0,
            side="BUY",
            qty=1.0,
            offset_pct=0.1,
            reduce_only=False,
            chase_id="opening_old",
            active=True,
        )
        unwind_slot = ScalperSlot(
            layer_idx=0,
            side="SELL",
            qty=1.0,
            offset_pct=0.1,
            reduce_only=True,
            paused=True,
            pause_reason="no_position",
        )
        state = ScalperState(
            id="scalper_reactivate_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            leverage=3,
            last_known_price=10.0,
            reduce_only_armed=True,
            long_slots=[opening_slot],
            short_slots=[unwind_slot],
        )
        engine._active[state.id] = state

        await engine._on_child_fill(state, opening_slot, fill_price=10.0, fill_qty=1.0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        assert unwind_slot.chase_id == "reactivated_unwind"
        assert unwind_slot.active is True
        assert unwind_slot.pause_reason is None
        assert opening_slot.chase_id == "restarted_opening"
        assert opening_slot.active is True

    asyncio.run(run())


def test_place_chase_for_slot_only_attaches_price_guard_when_pin_enabled():
    async def run():
        md = _ImmediateSeedMarketData()
        captured = {}

        async def start_chase(params):
            captured.clear()
            captured.update(params)
            return "guarded_chase"

        om = SimpleNamespace(
            _risk=SimpleNamespace(
                position_book=SimpleNamespace(
                    find_position=lambda *_args: SimpleNamespace(entry_price=100.0)
                )
            )
        )
        chase = SimpleNamespace(start_chase=AsyncMock(side_effect=start_chase))
        engine = ScalperEngine(om, md, chase, redis_client=None)

        state = ScalperState(
            id="scalper_guard_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            start_side="LONG",
            leverage=3,
            last_known_price=101.0,
        )
        slot = ScalperSlot(layer_idx=0, side="SELL", qty=1.0, offset_pct=0.1, reduce_only=True)

        await engine._place_chase_for_slot(state, slot)
        assert "priceGuard" not in captured

        state.pin_short_to_entry = True
        await engine._place_chase_for_slot(state, slot)

        assert callable(captured["priceGuard"])
        assert captured["priceGuard"](101.0) is True
        assert captured["priceGuard"](99.0) is False

    asyncio.run(run())


def test_active_price_guard_cancels_parent_chase_on_pin_breach():
    async def run():
        om = SimpleNamespace(
            cancel_order=AsyncMock(return_value=True),
            replace_order=AsyncMock(),
            get_order=lambda client_order_id: SimpleNamespace(price=100.0),
        )
        md = SimpleNamespace(_callbacks={})
        engine = ChaseEngine(om, md, redis_client=None)

        cancelled = []

        async def on_cancel(reason):
            cancelled.append(reason)

        state = ChaseState(
            id="chase_pin_guard_1",
            sub_account_id="s1",
            symbol="BTCUSDT",
            side="SELL",
            quantity=1.0,
            current_order_id="coid_guard_1",
            current_order_price=100.0,
            status="ACTIVE",
            on_chase_cancel=on_cancel,
            price_guard=lambda market_price: market_price >= 100.0,
        )
        state._initializing = False
        engine._active[state.id] = state

        await engine._on_tick(state, "BTCUSDT", 99.0, 99.2, 99.1)

        om.cancel_order.assert_awaited_once_with("coid_guard_1")
        om.replace_order.assert_not_awaited()
        assert cancelled == ["price_filter"]
        assert state.id not in engine._active

    asyncio.run(run())
