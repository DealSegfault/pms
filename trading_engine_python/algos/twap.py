"""
TWAPEngine — Time-Weighted Average Price execution.

Fires market order lots at regular intervals to fill a total quantity.
Each lot goes through OrderManager.place_market_order().

Key features:
    - Jitter: randomize interval ±30%
    - Irregular lots: randomize individual lot sizes (sum = total)
    - Price limit: skip lot if L1 mid exceeds limit
    - Basket: multi-symbol TWAP with per-leg config

Redis persistence: pms:twap:{twapId} TTL 12h
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

TWAP_REDIS_TTL = 43200  # 12h


@dataclass
class TWAPState:
    id: str
    sub_account_id: str
    symbol: str
    side: str
    total_quantity: float
    num_lots: int
    interval_seconds: float
    leverage: int = 1
    jitter_pct: float = 30.0       # ±30% randomize interval
    irregular: bool = False         # Randomize lot sizes
    price_limit: Optional[float] = None  # Skip lot if price exceeds
    filled_quantity: float = 0.0
    filled_lots: int = 0
    lot_sizes: List[float] = field(default_factory=list)
    status: str = "ACTIVE"
    created_at: float = field(default_factory=time.time)
    _task: Optional[asyncio.Task] = field(default=None, repr=False)


class TWAPEngine:
    """Manages TWAP execution instances."""

    def __init__(
        self,
        order_manager: Any,
        market_data: Any,
        redis_client: Any = None,
    ):
        self._om = order_manager
        self._md = market_data
        self._redis = redis_client
        self._active: Dict[str, TWAPState] = {}

    async def start_twap(self, params: dict) -> str:
        """Start a new TWAP. Returns TWAP ID."""
        twap_id = f"twap_{uuid.uuid4().hex[:12]}"
        total_qty = float(params["quantity"])
        num_lots = int(params.get("numLots", 10))
        irregular = bool(params.get("irregular", False))

        # Generate lot sizes
        if irregular:
            # Random sizes that sum to total
            weights = [random.random() for _ in range(num_lots)]
            total_w = sum(weights)
            lot_sizes = [(w / total_w) * total_qty for w in weights]
        else:
            lot_sizes = [total_qty / num_lots] * num_lots

        state = TWAPState(
            id=twap_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            side=params["side"],
            total_quantity=total_qty,
            num_lots=num_lots,
            interval_seconds=float(params.get("intervalSeconds", 60)),
            leverage=int(params.get("leverage", 1)),
            jitter_pct=float(params.get("jitterPct", 30)),
            irregular=irregular,
            price_limit=float(params["priceLimit"]) if params.get("priceLimit") else None,
            lot_sizes=lot_sizes,
        )

        self._active[twap_id] = state
        state._task = asyncio.create_task(self._run_twap(state))

        await self._save_state(state)
        await self._publish_event("twap_started", state)

        logger.info("TWAP started: %s %s %s qty=%.6f lots=%d interval=%.0fs",
                     twap_id, state.symbol, state.side, total_qty, num_lots, state.interval_seconds)
        return twap_id

    async def cancel_twap(self, twap_id: str) -> bool:
        """Cancel a TWAP."""
        state = self._active.get(twap_id)
        if not state:
            return False

        state.status = "CANCELLED"
        if state._task:
            state._task.cancel()

        await self._cleanup(state)
        await self._publish_event("twap_cancelled", state)
        return True

    async def start_basket_twap(self, params: dict) -> List[str]:
        """Start multiple TWAPs for a basket trade."""
        twap_ids = []
        for leg in params.get("legs", []):
            leg_params = {**params, **leg}  # Merge common + leg-specific
            twap_id = await self.start_twap(leg_params)
            twap_ids.append(twap_id)
        return twap_ids

    async def _run_twap(self, state: TWAPState) -> None:
        """Main TWAP loop — fire lots at intervals."""
        try:
            for i in range(state.num_lots):
                if state.status != "ACTIVE":
                    break

                # Apply jitter to interval
                jitter = 1.0 + (random.uniform(-1, 1) * state.jitter_pct / 100.0)
                interval = max(1.0, state.interval_seconds * jitter)

                if i > 0:
                    await asyncio.sleep(interval)

                if state.status != "ACTIVE":
                    break

                # Price limit check
                if state.price_limit:
                    l1 = self._md.get_l1(state.symbol) if self._md else None
                    if l1:
                        mid = l1["mid"]
                        if state.side == "BUY" and mid > state.price_limit:
                            logger.info("TWAP %s: skipping lot %d — price %.2f > limit %.2f", state.id, i, mid, state.price_limit)
                            continue
                        if state.side == "SELL" and mid < state.price_limit:
                            logger.info("TWAP %s: skipping lot %d — price %.2f < limit %.2f", state.id, i, mid, state.price_limit)
                            continue

                # Fire lot
                lot_qty = state.lot_sizes[i]
                try:
                    await self._om.place_market_order(
                        sub_account_id=state.sub_account_id,
                        symbol=state.symbol,
                        side=state.side,
                        quantity=lot_qty,
                        leverage=state.leverage,
                        origin="TWAP",
                        parent_id=state.id,
                    )
                    state.filled_lots += 1
                    state.filled_quantity += lot_qty

                    await self._publish_event("twap_progress", state,
                        lotIndex=i, lotQty=lot_qty, filledLots=state.filled_lots)

                except Exception as e:
                    logger.error("TWAP %s lot %d failed: %s", state.id, i, e)

            # Complete
            if state.status == "ACTIVE":
                state.status = "COMPLETED"
                await self._publish_event("twap_completed", state)

        except asyncio.CancelledError:
            pass
        finally:
            await self._cleanup(state)

    async def _cleanup(self, state: TWAPState) -> None:
        self._active.pop(state.id, None)
        if self._redis:
            await self._redis.delete(f"pms:twap:{state.id}")

    async def _save_state(self, state: TWAPState) -> None:
        if not self._redis:
            return
        data = {
            "id": state.id, "subAccountId": state.sub_account_id,
            "symbol": state.symbol, "side": state.side,
            "totalQuantity": state.total_quantity, "numLots": state.num_lots,
            "intervalSeconds": state.interval_seconds, "status": state.status,
            "filledLots": state.filled_lots, "filledQuantity": state.filled_quantity,
        }
        await self._redis.set(f"pms:twap:{state.id}", json.dumps(data), ex=TWAP_REDIS_TTL)

    async def _publish_event(self, event_type: str, state: TWAPState, **extra) -> None:
        if not self._redis:
            return
        payload = {
            "type": event_type, "twapId": state.id,
            "symbol": state.symbol, "side": state.side,
            "filledLots": state.filled_lots, "totalLots": state.num_lots,
            "filledQuantity": state.filled_quantity, "totalQuantity": state.total_quantity,
            "status": state.status, "timestamp": time.time(), **extra,
        }
        try:
            await self._redis.publish(f"pms:events:{event_type}", json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish TWAP event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
