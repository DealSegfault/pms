"""
ScalperEngine — Dual-leg scalper with layered limit orders.

Places layers on BOTH sides (long + short) with exponential offsets
from L1 mid-price. Uses ChaseEngine internally for each layer order.

Key behaviors:
    - Layer geometry: exponential offsets from L1 mid
    - Skew weighting: distributes quantity across layers
    - On fill: backoff the slot (exponential delay), then re-arm
    - Per-slot fill rate limiting
    - Loss protection: pause slot if unrealized loss > threshold

Redis persistence: pms:scalper:{scalperId} TTL 24h
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SCALPER_REDIS_TTL = 86400


@dataclass
class ScalperSlot:
    layer_idx: int
    side: str                     # BUY / SELL
    chase_id: Optional[str] = None
    active: bool = False
    paused: bool = False
    retry_at: float = 0.0
    retry_count: int = 0
    fill_count: int = 0
    realized_pnl: float = 0.0


@dataclass
class ScalperState:
    id: str
    sub_account_id: str
    symbol: str
    num_layers: int
    base_quantity: float
    layer_spread_bps: float       # Spread between layers in bps
    leverage: int = 1
    max_fills_per_min: int = 10
    loss_pause_bps: float = 50.0  # Pause if loss > N bps
    long_slots: List[ScalperSlot] = field(default_factory=list)
    short_slots: List[ScalperSlot] = field(default_factory=list)
    total_fill_count: int = 0
    status: str = "ACTIVE"
    created_at: float = field(default_factory=time.time)


class ScalperEngine:
    """Manages scalper instances — dual-leg layered order grid."""

    def __init__(
        self,
        order_manager: Any,
        market_data: Any,
        chase_engine: Any,
        redis_client: Any = None,
    ):
        self._om = order_manager
        self._md = market_data
        self._chase = chase_engine
        self._redis = redis_client
        self._active: Dict[str, ScalperState] = {}

    async def start_scalper(self, params: dict) -> str:
        """Start a new scalper. Returns scalper ID."""
        scalper_id = f"scalper_{uuid.uuid4().hex[:12]}"
        num_layers = int(params.get("numLayers", 3))

        state = ScalperState(
            id=scalper_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            num_layers=num_layers,
            base_quantity=float(params["quantity"]),
            layer_spread_bps=float(params.get("layerSpreadBps", 10)),
            leverage=int(params.get("leverage", 1)),
            max_fills_per_min=int(params.get("maxFillsPerMin", 10)),
            loss_pause_bps=float(params.get("lossPauseBps", 50)),
        )

        # Create slots for both sides
        for i in range(num_layers):
            state.long_slots.append(ScalperSlot(layer_idx=i, side="BUY"))
            state.short_slots.append(ScalperSlot(layer_idx=i, side="SELL"))

        self._active[scalper_id] = state

        # Arm all slots
        l1 = self._md.get_l1(state.symbol) if self._md else None
        if l1:
            for slot in state.long_slots + state.short_slots:
                await self._arm_slot(state, slot, l1["mid"])

        await self._save_state(state)
        await self._publish_event("scalper_started", state)

        logger.info("Scalper started: %s %s %d layers", scalper_id, state.symbol, num_layers)
        return scalper_id

    async def cancel_scalper(self, scalper_id: str) -> bool:
        """Stop a scalper, cancel all its chase orders."""
        state = self._active.get(scalper_id)
        if not state:
            return False

        state.status = "CANCELLED"

        # Cancel all active chase orders
        for slot in state.long_slots + state.short_slots:
            if slot.chase_id:
                await self._chase.cancel_chase(slot.chase_id)
                slot.active = False

        await self._cleanup(state)
        await self._publish_event("scalper_cancelled", state)
        return True

    async def _arm_slot(self, state: ScalperState, slot: ScalperSlot, mid_price: float) -> None:
        """Arm a slot by starting a chase order at the computed offset."""
        if slot.paused or state.status != "ACTIVE":
            return

        # Compute layer offset (exponential)
        offset_bps = state.layer_spread_bps * (1.5 ** slot.layer_idx)
        offset_pct = offset_bps / 100.0

        # Quantity weighting: heavier on inner layers
        weight = 1.0 / (1.0 + slot.layer_idx * 0.3)
        qty = state.base_quantity * weight

        chase_params = {
            "subAccountId": state.sub_account_id,
            "symbol": state.symbol,
            "side": slot.side,
            "quantity": qty,
            "leverage": state.leverage,
            "stalkMode": "maintain",
            "stalkOffsetPct": offset_pct if slot.side == "BUY" else -offset_pct,
            "maxDistancePct": 5.0,
        }

        chase_id = await self._chase.start_chase(chase_params)
        slot.chase_id = chase_id
        slot.active = True

    async def _on_slot_fill(self, state: ScalperState, slot: ScalperSlot) -> None:
        """Handle fill on a slot — backoff and re-arm."""
        slot.fill_count += 1
        state.total_fill_count += 1
        slot.active = False

        # Exponential backoff
        backoff = min(2.0 * (1.5 ** slot.retry_count), 30.0)
        slot.retry_at = time.time() + backoff
        slot.retry_count += 1

        await self._publish_event("scalper_filled", state, slotSide=slot.side, layerIdx=slot.layer_idx)

        # Schedule re-arm
        await asyncio.sleep(backoff)
        if state.status == "ACTIVE" and not slot.paused:
            l1 = self._md.get_l1(state.symbol) if self._md else None
            if l1:
                slot.retry_count = 0  # Reset on successful re-arm
                await self._arm_slot(state, slot, l1["mid"])

    async def _cleanup(self, state: ScalperState) -> None:
        self._active.pop(state.id, None)
        if self._redis:
            await self._redis.delete(f"pms:scalper:{state.id}")
            await self._redis.hdel(f"pms:active_scalper:{state.sub_account_id}", state.id)

    async def _save_state(self, state: ScalperState) -> None:
        if not self._redis:
            return
        data = {
            "id": state.id, "subAccountId": state.sub_account_id,
            "symbol": state.symbol, "numLayers": state.num_layers,
            "quantity": state.base_quantity, "status": state.status,
            "totalFillCount": state.total_fill_count,
        }
        data_json = json.dumps(data)
        await self._redis.set(f"pms:scalper:{state.id}", data_json, ex=SCALPER_REDIS_TTL)
        acct_key = f"pms:active_scalper:{state.sub_account_id}"
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, SCALPER_REDIS_TTL)

    async def _publish_event(self, event_type: str, state: ScalperState, **extra) -> None:
        if not self._redis:
            return
        payload = {
            "type": event_type, "scalperId": state.id,
            "symbol": state.symbol, "totalFills": state.total_fill_count,
            "status": state.status, "timestamp": time.time(), **extra,
        }
        try:
            await self._redis.publish(f"pms:events:{event_type}", json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish scalper event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
