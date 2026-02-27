"""
TrailStopEngine — Trailing stop-loss using L1 mid-price.

Subscribes to L1 ticks and tracks extreme price (HWM for LONG, LWM for SHORT).
When L1 mid retraces N% from the extreme → triggers market close.

Key features:
    - Tracks high-water mark (LONG) or low-water mark (SHORT)
    - Configurable trail percentage and activation price
    - Fires reduce-only market order on trigger
    - Redis persistence: pms:trailstop:{trailStopId} TTL 24h
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from contracts.common import ts_ms, EventType, RedisKey
from contracts.events import (
    TrailStopProgressEvent, TrailStopTriggeredEvent, TrailStopCancelledEvent,
)
from contracts.state import TrailStopRedisState
from contracts.invariants import (
    InvariantViolation, assert_trail_stop_state, assert_trail_stop_extreme_monotone,
)
from contracts.state_machines import TRAIL_STOP_FSM
from contracts.pure_logic import (
    trail_stop_update_extreme, trail_stop_is_triggered,
    trail_stop_compute_trigger, trail_stop_close_side,
)

logger = logging.getLogger(__name__)

TRAIL_STOP_REDIS_TTL = 86400


@dataclass
class TrailStopState:
    id: str
    sub_account_id: str
    symbol: str
    side: str                       # LONG or SHORT (position side being protected)
    quantity: float
    trail_pct: float                # Trail distance as percentage
    activation_price: Optional[float] = None  # Only activate after this price
    extreme_price: float = 0.0      # HWM (LONG) or LWM (SHORT)
    trigger_price: float = 0.0      # Market close price
    activated: bool = False
    status: str = "ACTIVE"          # ACTIVE, TRIGGERED, CANCELLED
    position_id: Optional[str] = None  # DB position ID (for frontend linkage)
    created_at: float = field(default_factory=time.time)
    _last_progress: float = 0.0     # Throttle progress events (~1/sec)


class TrailStopEngine:
    """Manages trailing stop instances driven by L1 ticks."""

    def __init__(
        self,
        order_manager: Any,
        market_data: Any,
        redis_client: Any = None,
    ):
        self._om = order_manager
        self._md = market_data
        self._redis = redis_client
        self._active: Dict[str, TrailStopState] = {}
        self._tick_handlers: Dict[str, Any] = {}  # trail_id → handler ref

    async def start_trail_stop(self, params: dict) -> str:
        """Start a new trailing stop. Returns trail stop ID."""
        ts_id = f"ts_{uuid.uuid4().hex[:12]}"

        # Accept callbackPct as alias for trailPct (frontend sends callbackPct)
        trail_pct = float(params.get("trailPct", params.get("callbackPct", 1)))

        state = TrailStopState(
            id=ts_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            side=params.get("positionSide", "LONG"),
            quantity=float(params["quantity"]),
            trail_pct=trail_pct,
            activation_price=float(params["activationPrice"]) if params.get("activationPrice") else None,
            position_id=params.get("positionId"),
        )

        # Initialize extreme with current L1
        l1 = self._md.get_l1(state.symbol) if self._md else None
        if l1:
            state.extreme_price = l1["mid"]
            state.trigger_price = self._compute_trigger(state)
            # Check if already activated
            if not state.activation_price:
                state.activated = True
            elif state.side == "LONG" and l1["mid"] >= state.activation_price:
                state.activated = True
            elif state.side == "SHORT" and l1["mid"] <= state.activation_price:
                state.activated = True

        # ── Invariant check: validate state at creation ──
        try:
            assert_trail_stop_state(state)
        except InvariantViolation as e:
            logger.error("Trail stop %s invariant violation at creation: %s", ts_id, e)

        self._active[ts_id] = state

        # Subscribe to L1
        if self._md:
            handler = self._make_tick_handler(state)
            self._tick_handlers[ts_id] = handler
            self._md.subscribe(state.symbol, handler)

        await self._save_state(state)
        await self._publish_event("trail_stop_started", state)

        logger.info("Trail stop started: %s %s %s trail=%.1f%%", ts_id, state.symbol, state.side, state.trail_pct)
        return ts_id

    async def cancel_trail_stop(self, trail_stop_id: str) -> bool:
        """Cancel a trailing stop."""
        state = self._active.get(trail_stop_id)
        if not state:
            return False

        # ── FSM guard ──
        try:
            TRAIL_STOP_FSM.validate_transition(state.status, "USER_CANCEL")
        except InvariantViolation as e:
            logger.error("Trail stop %s FSM violation on cancel: %s", trail_stop_id, e)

        state.status = "CANCELLED"
        await self._cleanup(state)
        await self._publish_event("trail_stop_cancelled", state)
        return True

    def _make_tick_handler(self, state: TrailStopState):
        async def handler(symbol: str, bid: float, ask: float, mid: float):
            await self._on_tick(state, mid)
        return handler

    async def _on_tick(self, state: TrailStopState, mid: float) -> None:
        """Process L1 tick for trail stop."""
        if state.status != "ACTIVE":
            return

        # Check activation
        if not state.activated:
            if state.activation_price:
                if state.side == "LONG" and mid >= state.activation_price:
                    state.activated = True
                    state.extreme_price = mid
                    logger.info("Trail stop %s activated at %.2f", state.id, mid)
                elif state.side == "SHORT" and mid <= state.activation_price:
                    state.activated = True
                    state.extreme_price = mid
                    logger.info("Trail stop %s activated at %.2f", state.id, mid)
            return

        # Update extreme price using pure function
        old_extreme = state.extreme_price
        new_extreme, changed = trail_stop_update_extreme(state.side, state.extreme_price, mid)
        if changed:
            # ── Monotonicity assertion ──
            try:
                assert_trail_stop_extreme_monotone(state.side, old_extreme, new_extreme)
            except InvariantViolation as e:
                logger.error("Trail stop %s monotonicity violation: %s", state.id, e)
            state.extreme_price = new_extreme
            state.trigger_price = self._compute_trigger(state)

        # Publish progress event (throttled ~1/sec)
        if changed:
            await self._publish_progress(state)

        # Check trigger using pure function
        triggered = trail_stop_is_triggered(state.side, mid, state.trigger_price)

        if triggered:
            # ── FSM guard ──
            try:
                TRAIL_STOP_FSM.validate_transition(state.status, "TRIGGER")
            except InvariantViolation as e:
                logger.error("Trail stop %s FSM violation on trigger: %s", state.id, e)
            state.status = "TRIGGERED"
            close_side = trail_stop_close_side(state.side)

            logger.warning(
                "Trail stop TRIGGERED: %s %s mid=%.2f extreme=%.2f trigger=%.2f",
                state.id, state.symbol, mid, state.extreme_price, state.trigger_price,
            )

            try:
                await self._om.place_market_order(
                    sub_account_id=state.sub_account_id,
                    symbol=state.symbol,
                    side=close_side,
                    quantity=state.quantity,
                    reduce_only=True,
                    origin="TRAIL_STOP",
                    parent_id=state.id,
                )
            except Exception as e:
                logger.error("Trail stop %s trigger failed: %s", state.id, e)

            await self._cleanup(state)
            await self._publish_event("trail_stop_triggered", state, triggerMid=mid)

    def _compute_trigger(self, state: TrailStopState) -> float:
        """Compute trigger price from extreme and trail percentage (delegates to pure function)."""
        return trail_stop_compute_trigger(state.side, state.extreme_price, state.trail_pct)

    async def _cleanup(self, state: TrailStopState) -> None:
        self._active.pop(state.id, None)
        handler = self._tick_handlers.pop(state.id, None)
        if handler and self._md:
            self._md.unsubscribe(state.symbol, handler)
        if self._redis:
            await self._redis.delete(RedisKey.trail_stop(state.id))
            await self._redis.hdel(RedisKey.active_trail_stop(state.sub_account_id), state.id)

    async def _save_state(self, state: TrailStopState) -> None:
        """Persist state to Redis using TrailStopRedisState DTO."""
        if not self._redis:
            return
        dto = TrailStopRedisState(
            trail_stop_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            side=state.side,
            quantity=state.quantity,
            callback_pct=state.trail_pct,
            activation_price=state.activation_price,
            extreme_price=state.extreme_price,
            trigger_price=state.trigger_price,
            activated=state.activated,
            status=state.status,
            position_id=state.position_id,
        )
        data_json = json.dumps(dto.to_dict())
        await self._redis.set(RedisKey.trail_stop(state.id), data_json, ex=TRAIL_STOP_REDIS_TTL)
        acct_key = RedisKey.active_trail_stop(state.sub_account_id)
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, TRAIL_STOP_REDIS_TTL)

    async def _publish_progress(self, state: TrailStopState) -> None:
        """Publish progress event, throttled to ~1/second."""
        now = time.time()
        if now - state._last_progress < 1.0:
            return
        state._last_progress = now
        await self._publish_event(EventType.TRAIL_STOP_PROGRESS, state)
        await self._save_state(state)

    async def _publish_event(self, event_type: str, state: TrailStopState, **extra) -> None:
        """Publish trail stop event to Redis using typed event DTOs."""
        if not self._redis:
            return

        if event_type == EventType.TRAIL_STOP_TRIGGERED:
            payload = TrailStopTriggeredEvent(
                trail_stop_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                callback_pct=state.trail_pct,
                extreme_price=state.extreme_price,
                triggered_price=extra.get("triggerMid", state.trigger_price),
                position_id=state.position_id,
                quantity=state.quantity,
            ).to_dict()
        elif event_type == EventType.TRAIL_STOP_CANCELLED:
            payload = TrailStopCancelledEvent(
                trail_stop_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                callback_pct=state.trail_pct,
            ).to_dict()
        else:
            # trail_stop_progress / trail_stop_started
            payload = TrailStopProgressEvent(
                trail_stop_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                callback_pct=state.trail_pct,
                extreme_price=state.extreme_price,
                trigger_price=state.trigger_price,
                activated=state.activated,
                position_id=state.position_id,
                quantity=state.quantity,
                status=state.status,
            ).to_dict()
            if event_type not in (EventType.TRAIL_STOP_PROGRESS,):
                payload["type"] = event_type

        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish trail stop event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
