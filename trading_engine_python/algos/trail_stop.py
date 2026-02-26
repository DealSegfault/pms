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
    created_at: float = field(default_factory=time.time)


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

        state = TrailStopState(
            id=ts_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            side=params.get("positionSide", "LONG"),
            quantity=float(params["quantity"]),
            trail_pct=float(params["trailPct"]),
            activation_price=float(params["activationPrice"]) if params.get("activationPrice") else None,
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

        # Update extreme price
        if state.side == "LONG":
            if mid > state.extreme_price:
                state.extreme_price = mid
                state.trigger_price = self._compute_trigger(state)
        else:
            if mid < state.extreme_price:
                state.extreme_price = mid
                state.trigger_price = self._compute_trigger(state)

        # Check trigger
        triggered = False
        if state.side == "LONG" and mid <= state.trigger_price:
            triggered = True
        elif state.side == "SHORT" and mid >= state.trigger_price:
            triggered = True

        if triggered:
            state.status = "TRIGGERED"
            close_side = "SELL" if state.side == "LONG" else "BUY"

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
        """Compute trigger price from extreme and trail percentage."""
        if state.side == "LONG":
            return state.extreme_price * (1 - state.trail_pct / 100.0)
        return state.extreme_price * (1 + state.trail_pct / 100.0)

    async def _cleanup(self, state: TrailStopState) -> None:
        self._active.pop(state.id, None)
        handler = self._tick_handlers.pop(state.id, None)
        if handler and self._md:
            self._md.unsubscribe(state.symbol, handler)
        if self._redis:
            await self._redis.delete(f"pms:trailstop:{state.id}")
            await self._redis.hdel(f"pms:active_trail_stop:{state.sub_account_id}", state.id)

    async def _save_state(self, state: TrailStopState) -> None:
        if not self._redis:
            return
        data = {
            "id": state.id, "subAccountId": state.sub_account_id,
            "symbol": state.symbol, "side": state.side,
            "quantity": state.quantity, "trailPct": state.trail_pct,
            "activationPrice": state.activation_price,
            "extremePrice": state.extreme_price, "triggerPrice": state.trigger_price,
            "activated": state.activated, "status": state.status,
        }
        data_json = json.dumps(data)
        await self._redis.set(f"pms:trailstop:{state.id}", data_json, ex=TRAIL_STOP_REDIS_TTL)
        acct_key = f"pms:active_trail_stop:{state.sub_account_id}"
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, TRAIL_STOP_REDIS_TTL)

    async def _publish_event(self, event_type: str, state: TrailStopState, **extra) -> None:
        if not self._redis:
            return
        payload = {
            "type": event_type, "trailStopId": state.id,
            "symbol": state.symbol, "side": state.side,
            "trailPct": state.trail_pct, "extremePrice": state.extreme_price,
            "triggerPrice": state.trigger_price, "status": state.status,
            "timestamp": time.time(), **extra,
        }
        try:
            await self._redis.publish(f"pms:events:{event_type}", json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish trail stop event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
