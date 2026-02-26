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
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

REPRICE_THROTTLE_MS = 500  # Minimum ms between reprices
CHASE_REDIS_TTL = 86400     # 24h


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
    reprice_count: int = 0
    last_reprice_time: float = 0.0
    created_at: float = field(default_factory=time.time)
    status: str = "ACTIVE"           # ACTIVE, FILLED, CANCELLED


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

    # ── Public API ──

    async def start_chase(self, params: dict) -> str:
        """Start a new chase. Returns chase ID."""
        chase_id = f"chase_{uuid.uuid4().hex[:12]}"
        state = ChaseState(
            id=chase_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            side=params["side"],
            quantity=float(params["quantity"]),
            leverage=int(params.get("leverage", 1)),
            stalk_mode=params.get("stalkMode", "maintain"),
            stalk_offset_pct=float(params.get("stalkOffsetPct", 0)),
            max_distance_pct=float(params.get("maxDistancePct", 2.0)),
        )

        # Get initial L1 price
        l1 = self._md.get_l1(state.symbol) if self._md else None
        if l1:
            state.initial_price = l1["mid"]

        # Place initial limit order
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
            )
            state.current_order_id = order.client_order_id

        self._active[chase_id] = state

        # Subscribe to L1 ticks for repricing
        if state.stalk_mode != "none" and self._md:
            self._md.subscribe(state.symbol, self._make_tick_handler(state))

        await self._save_state(state)
        await self._publish_event("chase_started", state)

        logger.info("Chase started: %s %s %s qty=%.6f", chase_id, state.symbol, state.side, state.quantity)
        return chase_id

    async def cancel_chase(self, chase_id: str) -> bool:
        """Cancel a chase order."""
        state = self._active.get(chase_id)
        if not state:
            return False

        state.status = "CANCELLED"
        if state.current_order_id:
            await self._om.cancel_order(state.current_order_id)

        await self._cleanup(state)
        await self._publish_event("chase_cancelled", state)
        return True

    async def resume_all(self) -> int:
        """Resume chases from Redis on startup."""
        if not self._redis:
            return 0
        count = 0
        try:
            keys = await self._redis.keys("pms:chase:*")
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
        """Compute limit order price from L1 + offset."""
        if not l1:
            return None
        if state.side == "BUY":
            base = l1["bid"]
            return base * (1 + state.stalk_offset_pct / 100.0)
        else:
            base = l1["ask"]
            return base * (1 - state.stalk_offset_pct / 100.0)

    def _make_tick_handler(self, state: ChaseState):
        """Create a bound tick handler for a specific chase."""
        async def handler(symbol: str, bid: float, ask: float, mid: float):
            await self._on_tick(state, symbol, bid, ask, mid)
        return handler

    async def _on_tick(
        self, state: ChaseState, symbol: str, bid: float, ask: float, mid: float
    ) -> None:
        """Handle L1 tick — reprice if needed."""
        if state.status != "ACTIVE" or not state.current_order_id:
            return

        # Throttle repricing
        now = time.time()
        if (now - state.last_reprice_time) * 1000 < REPRICE_THROTTLE_MS:
            return

        # Check max distance
        if state.initial_price > 0:
            distance_pct = abs(mid - state.initial_price) / state.initial_price * 100
            if distance_pct > state.max_distance_pct:
                logger.warning("Chase %s: max distance breached (%.2f%% > %.2f%%)", state.id, distance_pct, state.max_distance_pct)
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

        # Trail mode: only move in favorable direction
        if state.stalk_mode == "trail":
            current_order = self._om.get_order(state.current_order_id)
            if current_order and current_order.price:
                if state.side == "BUY" and new_price > current_order.price:
                    return  # Don't chase up for buys in trail mode
                if state.side == "SELL" and new_price < current_order.price:
                    return  # Don't chase down for sells in trail mode

        # Reprice via cancel+replace
        new_order = await self._om.replace_order(state.current_order_id, new_price)
        if new_order:
            state.current_order_id = new_order.client_order_id
            new_order.on_fill = lambda o: self._on_fill(state, o)
            new_order.on_cancel = lambda o, r: self._on_cancel(state, o, r)
            state.reprice_count += 1
            state.last_reprice_time = now

            await self._publish_event("chase_progress", state, price=new_price)

    async def _on_fill(self, state: ChaseState, order: Any) -> None:
        """Handle chase order fill."""
        state.status = "FILLED"
        await self._cleanup(state)
        await self._publish_event("chase_filled", state)
        logger.info("Chase filled: %s", state.id)

    async def _on_cancel(self, state: ChaseState, order: Any, reason: str) -> None:
        """Handle unexpected cancel (not from us)."""
        if state.status == "ACTIVE":
            # Unexpected cancel — try to re-arm
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
                )
                state.current_order_id = new_order.client_order_id

    async def _cleanup(self, state: ChaseState) -> None:
        """Remove from active tracking and Redis."""
        self._active.pop(state.id, None)
        if self._redis:
            await self._redis.delete(f"pms:chase:{state.id}")
            await self._redis.hdel(f"pms:active_chase:{state.sub_account_id}", state.id)

    async def _save_state(self, state: ChaseState) -> None:
        """Persist state to Redis."""
        if not self._redis:
            return
        data = {
            "id": state.id, "subAccountId": state.sub_account_id,
            "symbol": state.symbol, "side": state.side,
            "quantity": state.quantity, "leverage": state.leverage,
            "stalkMode": state.stalk_mode, "stalkOffsetPct": state.stalk_offset_pct,
            "maxDistancePct": state.max_distance_pct, "status": state.status,
            "repriceCount": state.reprice_count,
            "startedAt": state.created_at,
            "currentOrderPrice": state.initial_price,
            "sizeUsd": state.quantity * (state.initial_price or 0),
        }
        data_json = json.dumps(data)
        await self._redis.set(f"pms:chase:{state.id}", data_json, ex=CHASE_REDIS_TTL)
        # Also write to per-account hash for bulk queries
        acct_key = f"pms:active_chase:{state.sub_account_id}"
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, CHASE_REDIS_TTL)

    async def _publish_event(self, event_type: str, state: ChaseState, **extra) -> None:
        """Publish chase event to Redis."""
        if not self._redis:
            return
        payload = {
            "type": event_type, "chaseId": state.id,
            "symbol": state.symbol, "side": state.side,
            "quantity": state.quantity, "repriceCount": state.reprice_count,
            "status": state.status, "timestamp": time.time(), **extra,
        }
        try:
            await self._redis.publish(f"pms:events:{event_type}", json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish chase event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
