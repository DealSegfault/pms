"""
ChaseEngine — Limit order that chases the L1 price.

Places a limit order at L1 best bid/ask ± offset, then reprices on every
BBO change. All order operations go through OrderManager — never calls
exchange directly.

Stalk modes:
    none     — Place once, don't reprice
    maintain — Follow L1 with repricing (cancel+replace)
    trail    — Follow L1 only in favorable direction (ratchet)

Redis persistence: pms:chase:{chaseId} TTL 24h
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, Optional

from contracts.common import normalize_symbol, normalize_side, ts_ms, ts_s_to_ms, EventType, RedisKey
from contracts.events import ChaseProgressEvent, ChaseFilledEvent, ChaseCancelledEvent
from contracts.state import ChaseRedisState
from contracts.invariants import InvariantViolation, assert_chase_state, assert_valid_l1
from contracts.state_machines import CHASE_FSM
from contracts.pure_logic import chase_should_reprice, chase_is_max_distance_breached

logger = logging.getLogger(__name__)

REPRICE_THROTTLE_MS = 10  # Minimum ms between reprices
CHASE_REDIS_TTL = 86400     # 24h


# Symbol normalization delegated to contracts.common




@dataclass
class ChaseState:
    id: str
    sub_account_id: str
    symbol: str
    side: str                        # BUY / SELL
    quantity: float
    leverage: int = 1
    stalk_mode: str = "maintain"     # none, maintain, trail
    stalk_offset_pct: float = 0.0    # Offset from L1 as percentage
    max_distance_pct: float = 2.0    # Auto-cancel threshold
    initial_price: float = 0.0
    current_order_id: Optional[str] = None
    current_order_price: float = 0.0
    reprice_count: int = 0
    last_reprice_time: float = 0.0
    created_at: float = field(default_factory=time.time)
    status: str = "ACTIVE"           # ACTIVE, FILLED, CANCELLED
    reduce_only: bool = False
    parent_scalper_id: Optional[str] = None
    # Callbacks for parent algo (scalper) — NOT serialized
    on_chase_fill: Optional[Callable] = field(default=None, repr=False)
    on_chase_cancel: Optional[Callable] = field(default=None, repr=False)
    # Concurrency guard — prevents concurrent _on_tick from stacking orders
    _tick_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class ChaseEngine:
    """
    Manages chase order instances.
    Each chase is an independent state machine driven by L1 ticks.
    """

    def __init__(
        self,
        order_manager: Any,
        market_data: Any,
        redis_client: Any = None,
    ):
        self._om = order_manager
        self._md = market_data
        self._redis = redis_client
        self._active: Dict[str, ChaseState] = {}
        self._fill_checker_task: Optional[asyncio.Task] = None

    # ── Background tasks ──

    def start_background_tasks(self) -> None:
        """Start fill checker loop. Call after event loop is running."""
        if not self._fill_checker_task:
            self._fill_checker_task = asyncio.create_task(self._fill_checker_loop())
            logger.info("Chase fill checker started (polling every 5s)")

    async def stop(self) -> None:
        """Stop background tasks."""
        if self._fill_checker_task:
            self._fill_checker_task.cancel()
            try:
                await self._fill_checker_task
            except asyncio.CancelledError:
                pass
            self._fill_checker_task = None

    async def _fill_checker_loop(self) -> None:
        """Poll active chase orders for missed fills (JS startFillChecker pattern).

        UserStream is the primary fill detection, but it can miss fills during
        the cancel→replace window. This background loop catches those.
        """
        while True:
            try:
                await asyncio.sleep(5)
                for state in list(self._active.values()):
                    if state.status != "ACTIVE" or not state.current_order_id:
                        continue
                    order = self._om.get_order(state.current_order_id)
                    if order and order.state == "filled":
                        logger.info("Chase %s: fill detected by checker (order %s)",
                                    state.id, state.current_order_id)
                        await self._on_fill(state, order)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Fill checker error: %s", e)


    async def start_chase(self, params: dict) -> str:
        """Start a new chase. Returns chase ID."""
        chase_id = f"chase_{uuid.uuid4().hex[:12]}"
        state = ChaseState(
            id=chase_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            side=normalize_side(params["side"]),
            quantity=float(params["quantity"]),
            leverage=int(params.get("leverage", 1)),
            stalk_mode=params.get("stalkMode", "maintain"),
            stalk_offset_pct=float(params.get("stalkOffsetPct") or 0),
            max_distance_pct=float(params.get("maxDistancePct") or 0),  # 0 = unlimited
            reduce_only=bool(params.get("reduceOnly", False)),
            parent_scalper_id=params.get("parentScalperId"),
            on_chase_fill=params.get("onFill"),
            on_chase_cancel=params.get("onCancel"),
        )

        # ── Invariant check: validate state at creation ──
        try:
            assert_chase_state(state)
        except InvariantViolation as e:
            logger.error("Chase %s invariant violation at creation: %s", chase_id, e)

        # Subscribe to L1 ticks FIRST — this triggers Redis PubSub + seed from
        # existing orderbook data, so L1 will likely be available after a brief wait.
        # NOTE: use state.symbol (ccxt format) — MarketDataService keys by ccxt format.
        # Binance format conversion happens at the exchange boundary (OrderManager/ExchangeClient).
        if self._md:
            self._md.subscribe(state.symbol, self._make_tick_handler(state))

        # Brief yield to let the Redis seed task run
        await asyncio.sleep(0.1)

        # Now try to get seeded L1 data
        l1 = self._md.get_l1(state.symbol) if self._md else None
        if l1:
            state.initial_price = l1["mid"]

        # Place initial limit order (if L1 available)
        price = self._compute_chase_price(state, l1)
        if price:
            order = await self._om.place_limit_order(
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                quantity=state.quantity,
                price=price,
                leverage=state.leverage,
                origin="CHASE",
                parent_id=chase_id,
                on_fill=lambda o: self._on_fill(state, o),
                on_cancel=lambda o, r: self._on_cancel(state, o, r),
                reduce_only=state.reduce_only,
            )
            if order.state != "failed":
                state.current_order_id = order.client_order_id
                state.current_order_price = price
                logger.info("Chase %s: initial order placed at %.8f", chase_id, price)
            else:
                logger.warning("Chase %s: initial order failed, will retry on tick", chase_id)
        else:
            logger.warning("Chase %s: no L1 data yet, will place on first tick", chase_id)

        self._active[chase_id] = state

        await self._save_state(state)
        await self._publish_event("chase_started", state)

        logger.info("Chase started: %s %s %s qty=%.6f", chase_id, state.symbol, state.side, state.quantity)
        return chase_id

    async def start_chase_batch(self, params_list: list[dict]) -> list[str]:
        """Start multiple chases with batch order placement.
        
        Uses OrderManager.place_batch_limit_orders() to place all initial
        orders in one call (5 per REST request instead of N individual calls).
        
        Returns list of chase IDs (same order as input).
        """
        if not params_list:
            return []

        # 1. Create all chase states and compute prices
        states: list[ChaseState] = []
        order_params: list[dict] = []
        state_to_idx: dict[str, int] = {}  # chase_id → index in order_params

        for params in params_list:
            chase_id = f"chase_{uuid.uuid4().hex[:12]}"
            state = ChaseState(
                id=chase_id,
                sub_account_id=params["subAccountId"],
                symbol=params["symbol"],
                side=normalize_side(params["side"]),
                quantity=float(params["quantity"]),
                leverage=int(params.get("leverage", 1)),
                stalk_mode=params.get("stalkMode", "maintain"),
                stalk_offset_pct=float(params.get("stalkOffsetPct") or 0),
                max_distance_pct=float(params.get("maxDistancePct") or 0),
                reduce_only=bool(params.get("reduceOnly", False)),
                parent_scalper_id=params.get("parentScalperId"),
                on_chase_fill=params.get("onFill"),
                on_chase_cancel=params.get("onCancel"),
            )

            try:
                assert_chase_state(state)
            except InvariantViolation as e:
                logger.error("Chase %s invariant violation: %s", chase_id, e)

            # Subscribe to L1 ticks
            if self._md:
                self._md.subscribe(state.symbol, self._make_tick_handler(state))

            states.append(state)

        # Brief yield for L1 seed
        await asyncio.sleep(0.1)

        # 2. Compute initial prices and build batch params
        for i, state in enumerate(states):
            l1 = self._md.get_l1(state.symbol) if self._md else None
            if l1:
                state.initial_price = l1["mid"]

            price = self._compute_chase_price(state, l1)
            if price:
                state_to_idx[state.id] = len(order_params)
                order_params.append({
                    "sub_account_id": state.sub_account_id,
                    "symbol": state.symbol,
                    "side": state.side,
                    "quantity": state.quantity,
                    "price": price,
                    "leverage": state.leverage,
                    "origin": "CHASE",
                    "parent_id": state.id,
                    "on_fill": lambda o, s=state: self._on_fill(s, o),
                    "on_cancel": lambda o, r, s=state: self._on_cancel(s, o, r),
                    "reduce_only": state.reduce_only,
                })

        # 3. Batch place all orders
        if order_params:
            orders = await self._om.place_batch_limit_orders(order_params)

            # 4. Map results back to chase states
            for state in states:
                idx = state_to_idx.get(state.id)
                if idx is not None and idx < len(orders):
                    order = orders[idx]
                    if order.state != "failed":
                        state.current_order_id = order.client_order_id
                        state.current_order_price = order.price or 0
                        logger.info("Chase %s: batch order placed at %.8f", state.id, state.current_order_price)
                    else:
                        logger.warning("Chase %s: batch order failed, will retry on tick", state.id)
                else:
                    logger.warning("Chase %s: no L1 data, will place on first tick", state.id)

        # 5. Register all states and persist
        chase_ids = []
        for state in states:
            self._active[state.id] = state
            await self._save_state(state)
            await self._publish_event("chase_started", state)
            chase_ids.append(state.id)

        logger.info("Batch started %d chases", len(chase_ids))
        return chase_ids

    async def cancel_chase(self, chase_id: str) -> bool:
        """Cancel a chase order."""
        state = self._active.get(chase_id)
        if not state:
            return False

        # ── FSM guard: validate transition ──
        try:
            CHASE_FSM.validate_transition(state.status, "USER_CANCEL")
        except InvariantViolation as e:
            logger.error("Chase %s FSM violation on cancel: %s", chase_id, e)

        state.status = "CANCELLED"

        # Clean up chase Redis state BEFORE cancelling the exchange order,
        # because cancel_order triggers a feed event → frontend refetch.
        # If we cleanup after, the frontend sees stale pms:active_chase data.
        await self._cleanup(state)
        await self._publish_event("chase_cancelled", state)

        # Proactively remove the underlying limit order from Redis open orders
        # so it disappears from the UI immediately, regardless of exchange timing.
        if state.current_order_id:
            order = self._om._tracker.lookup(client_order_id=state.current_order_id)
            if order:
                await self._om._redis_remove_open_order(order)

            # Best-effort cancel on exchange (feed will confirm)
            try:
                await self._om.cancel_order(state.current_order_id)
            except Exception as e:
                logger.warning("Chase %s: cancel_order error (non-fatal): %s", chase_id, e)

        return True

    async def resume_all(self) -> int:
        """Resume chases from Redis on startup."""
        if not self._redis:
            return 0
        count = 0
        try:
            keys = await self._redis.keys("pms:chase:*")  # Pattern scan — not in RedisKey (one-off)
            for key in keys:
                raw = await self._redis.get(key)
                if raw:
                    data = json.loads(raw)
                    if data.get("status") == "ACTIVE":
                        # Re-create state and restart
                        await self.start_chase(data)
                        count += 1
        except Exception as e:
            logger.error("Failed to resume chases: %s", e)
        return count

    # ── Internal ──

    def _compute_chase_price(self, state: ChaseState, l1: Optional[dict]) -> Optional[float]:
        """Compute limit order price from L1 + offset.

        For a passive chase (stalk_offset_pct > 0):
          BUY:  bid - offset  → rests below bid, won't cross the spread
          SELL: ask + offset  → rests above ask, won't cross the spread

        For stalk_offset_pct == 0 the order joins the BBO exactly.
        """
        if not l1:
            return None
        if state.side in ("BUY", "LONG"):
            base = l1["bid"]
            return base * (1 - state.stalk_offset_pct / 100.0)
        else:
            base = l1["ask"]
            return base * (1 + state.stalk_offset_pct / 100.0)

    def _get_current_price(self, state: ChaseState) -> float:
        """Get actual current order price (not just initial)."""
        if state.current_order_id:
            order = self._om.get_order(state.current_order_id)
            if order and order.price:
                return order.price
        return state.initial_price

    def _make_tick_handler(self, state: ChaseState):
        """Create a bound tick handler for a specific chase."""
        async def handler(symbol: str, bid: float, ask: float, mid: float):
            await self._on_tick(state, symbol, bid, ask, mid)
        return handler

    async def _on_tick(
        self, state: ChaseState, symbol: str, bid: float, ask: float, mid: float
    ) -> None:
        """Handle L1 tick — place initial order or reprice."""
        if state.status != "ACTIVE":
            return

        # Non-blocking lock: skip tick if a reprice is already in flight.
        # This prevents concurrent replace_order calls from stacking orders.
        if state._tick_lock.locked():
            return
        async with state._tick_lock:
            # Deferred initial order: L1 wasn't available at start, place now
            if not state.current_order_id:
                # Throttle deferred retries to avoid spamming on repeated failures
                now = time.time()
                if hasattr(state, '_last_deferred_attempt') and (now - state._last_deferred_attempt) < 3.0:
                    return
                state._last_deferred_attempt = now
                if state.initial_price == 0:
                    state.initial_price = mid
                l1 = {"bid": bid, "ask": ask, "mid": mid}
                price = self._compute_chase_price(state, l1)
                if price:
                    try:
                        order = await self._om.place_limit_order(
                            sub_account_id=state.sub_account_id,
                            symbol=state.symbol,
                            side=state.side,
                            quantity=state.quantity,
                            price=price,
                            leverage=state.leverage,
                            origin="CHASE",
                            parent_id=state.id,
                            on_fill=lambda o: self._on_fill(state, o),
                            on_cancel=lambda o, r: self._on_cancel(state, o, r),
                            reduce_only=state.reduce_only,
                        )
                        if order.state == "failed":
                            logger.warning("Chase %s: deferred order failed, will retry on next tick", state.id)
                            return
                        state.current_order_id = order.client_order_id
                        state.current_order_price = price
                        logger.info("Chase %s: deferred initial order placed at %.8f", state.id, price)
                        await self._save_state(state)
                        await self._publish_event("chase_progress", state, currentOrderPrice=price)
                    except Exception as e:
                        logger.error("Chase %s: deferred order exception: %s", state.id, e)
                return

            # Throttle repricing
            now = time.time()
            if (now - state.last_reprice_time) * 1000 < REPRICE_THROTTLE_MS:
                return

            # Check max distance using pure function (0 = disabled / unlimited)
            if chase_is_max_distance_breached(mid, state.initial_price, state.max_distance_pct):
                distance_pct = abs(mid - state.initial_price) / state.initial_price * 100
                logger.warning("Chase %s: max distance breached (%.2f%% > %.2f%%)", state.id, distance_pct, state.max_distance_pct)
                try:
                    CHASE_FSM.validate_transition(state.status, "MAX_DISTANCE")
                except InvariantViolation as e:
                    logger.error("Chase %s FSM violation on max_distance: %s", state.id, e)
                state.status = "CANCELLED"
                await self._om.cancel_order(state.current_order_id)
                await self._cleanup(state)
                await self._publish_event("chase_cancelled", state, reason="MAX_DISTANCE")
                return

            # Compute new price
            l1 = {"bid": bid, "ask": ask, "mid": mid}
            new_price = self._compute_chase_price(state, l1)
            if not new_price:
                return

            # Reprice decision via pure function (handles none/maintain/trail)
            current_order = self._om.get_order(state.current_order_id)
            current_price = current_order.price if (current_order and current_order.price) else state.current_order_price
            if not chase_should_reprice(state.stalk_mode, state.side, current_price, new_price):
                return  # Pure function says no reprice needed

            # Reprice via cancel+replace
            new_order = await self._om.replace_order(state.current_order_id, new_price)

            # ── Post-await orphan guard (JS pattern L249-253) ──
            # Chase may have been cancelled/filled while we awaited replace_order.
            if state.status != "ACTIVE" or state.id not in self._active:
                if new_order:
                    logger.warning("Chase %s: killed during reprice — cancelling orphan %s",
                                   state.id, new_order.client_order_id)
                    try:
                        await self._om.cancel_order(new_order.client_order_id)
                    except Exception:
                        pass
                return

            if new_order:
                state.current_order_id = new_order.client_order_id
                state.current_order_price = new_price
                new_order.on_fill = lambda o: self._on_fill(state, o)
                new_order.on_cancel = lambda o, r: self._on_cancel(state, o, r)
                state.reprice_count += 1
                state.last_reprice_time = now

                await self._save_state(state)
                await self._publish_event("chase_progress", state, currentOrderPrice=new_price)
            elif new_order is None:
                # replace_order returned None — old order may have filled during cancel
                # Let _on_fill handle it (will arrive via UserStream or fill checker)
                pass

    async def _on_fill(self, state: ChaseState, order: Any) -> None:
        """Handle chase order fill."""
        # ── Guard: reject if already terminal (duplicate fill event) ──
        if state.status in ("FILLED", "CANCELLED"):
            logger.debug("Chase %s: ignoring duplicate fill (already %s)", state.id, state.status)
            return

        # ── FSM guard ──
        try:
            CHASE_FSM.validate_transition(state.status, "FILL")
        except InvariantViolation as e:
            logger.error("Chase %s FSM violation on fill: %s", state.id, e)
        state.status = "FILLED"

        # ── Cancel orphan order if the filled order isn't the current one ──
        # This handles: order A fills, but replace_order already placed order B.
        # Order B is now an orphan on the exchange — cancel it.
        filled_coid = order.client_order_id if order else None
        if filled_coid and state.current_order_id and filled_coid != state.current_order_id:
            logger.info("Chase %s: filled order %s != current %s — cancelling orphan",
                        state.id, filled_coid, state.current_order_id)
            try:
                await self._om.cancel_order(state.current_order_id)
            except Exception as e:
                logger.warning("Chase %s: failed to cancel orphan order: %s", state.id, e)

        # Notify parent algo (scalper) BEFORE cleanup removes state from _active
        if state.on_chase_fill:
            try:
                fill_price = order.avg_fill_price if order else 0
                fill_qty = order.filled_qty if order else state.quantity
                cb = state.on_chase_fill
                if asyncio.iscoroutinefunction(cb):
                    await cb(fill_price, fill_qty)
                else:
                    cb(fill_price, fill_qty)
            except Exception as e:
                logger.error("Chase %s on_chase_fill callback error: %s", state.id, e)
        await self._cleanup(state)
        await self._publish_event("chase_filled", state, fillPrice=order.avg_fill_price if order else 0)
        logger.info("Chase filled: %s", state.id)

    async def _on_cancel(self, state: ChaseState, order: Any, reason: str) -> None:
        """Handle unexpected cancel (not from us)."""
        if state.status != "ACTIVE":
            return

        # ── Critical guard: if _tick_lock is held, a reprice (replace_order) is in
        # progress. The cancel is expected — do NOT re-arm, or we'll create an
        # orphan order alongside the one replace_order is about to place. ──
        if state._tick_lock.locked():
            logger.debug("Chase %s: ignoring cancel during active reprice (lock held)", state.id)
            return

        # If this cancel is from a reprice (replace_order already placed a new order),
        # state.current_order_id has moved to the new order. Skip re-arm.
        cancelled_coid = order.client_order_id if order else None
        if cancelled_coid and cancelled_coid != state.current_order_id:
            logger.debug("Chase %s: ignoring cancel for old order %s (replaced by %s)",
                         state.id, cancelled_coid, state.current_order_id)
            return

        # ── FSM guard: EXTERNAL_CANCEL or CHILD_CANCEL ──
        fsm_event = "CHILD_CANCEL" if state.on_chase_cancel else "EXTERNAL_CANCEL"
        try:
            CHASE_FSM.validate_transition(state.status, fsm_event)
        except InvariantViolation as e:
            logger.error("Chase %s FSM violation on cancel (%s): %s", state.id, fsm_event, e)
        # If owned by a scalper, delegate restart to the scalper's onChildCancel
        if state.on_chase_cancel:
            try:
                cb = state.on_chase_cancel
                if asyncio.iscoroutinefunction(cb):
                    await cb(reason)
                else:
                    cb(reason)
            except Exception as e:
                logger.error("Chase %s on_chase_cancel callback error: %s", state.id, e)
            await self._cleanup(state)
            return
        # Standalone chase — unexpected cancel → try to re-arm
        logger.warning("Chase %s: order cancelled unexpectedly, re-arming", state.id)
        l1 = self._md.get_l1(state.symbol) if self._md else None
        price = self._compute_chase_price(state, l1)
        if price:
            new_order = await self._om.place_limit_order(
                sub_account_id=state.sub_account_id,
                symbol=state.symbol, side=state.side,
                quantity=state.quantity, price=price,
                leverage=state.leverage, origin="CHASE",
                parent_id=state.id,
                on_fill=lambda o: self._on_fill(state, o),
                on_cancel=lambda o, r: self._on_cancel(state, o, r),
                reduce_only=state.reduce_only,
            )
            state.current_order_id = new_order.client_order_id
            state.current_order_price = price

    async def _cleanup(self, state: ChaseState) -> None:
        """Remove from active tracking, Redis, and unsubscribe ticks."""
        self._active.pop(state.id, None)

        # Unsubscribe tick handler to stop receiving L1 updates
        if self._md and hasattr(self._md, '_callbacks'):
            cbs = self._md._callbacks.get(state.symbol, [])
            # Remove our tick handler (bound to this state)
            self._md._callbacks[state.symbol] = [
                cb for cb in cbs
                if not (hasattr(cb, '__closure__') and cb.__closure__ and
                        any(c.cell_contents is state for c in cb.__closure__ if hasattr(c, 'cell_contents')))
            ]

        # Remove chase state from Redis
        if self._redis:
            await self._redis.delete(RedisKey.chase(state.id))
            await self._redis.hdel(RedisKey.active_chase(state.sub_account_id), state.id)

        # Remove underlying limit order from Redis open orders (prevents stale row)
        if state.current_order_id:
            order = self._om.get_order(state.current_order_id)
            if order:
                await self._om._redis_remove_open_order(order)

    async def _save_state(self, state: ChaseState) -> None:
        """Persist state to Redis using ChaseRedisState DTO."""
        if not self._redis:
            return
        current_price = self._get_current_price(state)
        dto = ChaseRedisState(
            chase_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            side=state.side,
            quantity=state.quantity,
            leverage=state.leverage,
            stalk_mode=state.stalk_mode,
            stalk_offset_pct=state.stalk_offset_pct,
            max_distance_pct=state.max_distance_pct,
            status=state.status,
            reprice_count=state.reprice_count,
            started_at=ts_s_to_ms(state.created_at),
            current_order_price=current_price,
            size_usd=state.quantity * (current_price or 0),
            reduce_only=state.reduce_only,
            parent_scalper_id=state.parent_scalper_id,
        )
        data_json = json.dumps(dto.to_dict())
        await self._redis.set(RedisKey.chase(state.id), data_json, ex=CHASE_REDIS_TTL)
        # Also write to per-account hash for bulk queries
        acct_key = RedisKey.active_chase(state.sub_account_id)
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, CHASE_REDIS_TTL)

    async def _publish_event(self, event_type: str, state: ChaseState, **extra) -> None:
        """Publish chase event to Redis using typed event DTOs."""
        if not self._redis:
            return

        # Build the right DTO based on event_type
        if event_type == EventType.CHASE_FILLED:
            payload = ChaseFilledEvent(
                chase_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                quantity=state.quantity,
                fill_price=extra.get("fillPrice", 0),
                reprice_count=state.reprice_count,
                parent_scalper_id=state.parent_scalper_id,
            ).to_dict()
        elif event_type == EventType.CHASE_CANCELLED:
            payload = ChaseCancelledEvent(
                chase_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                reason=extra.get("reason", ""),
                reprice_count=state.reprice_count,
                parent_scalper_id=state.parent_scalper_id,
            ).to_dict()
        else:
            # chase_progress / chase_started
            payload = ChaseProgressEvent(
                chase_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                quantity=state.quantity,
                reprice_count=state.reprice_count,
                status=state.status,
                stalk_offset_pct=state.stalk_offset_pct,
                initial_price=state.initial_price,
                current_order_price=self._get_current_price(state),
                parent_scalper_id=state.parent_scalper_id,
            ).to_dict()
            # Override type if it's a custom event like chase_started
            if event_type not in (EventType.CHASE_PROGRESS,):
                payload["type"] = event_type

        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish chase event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
