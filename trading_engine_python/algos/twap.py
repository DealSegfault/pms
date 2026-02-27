"""
TWAPEngine — Time-Weighted Average Price execution.

Fires market order lots at regular intervals to fill a total quantity.
Each lot goes through OrderManager.place_market_order().

Key features:
    - Jitter: randomize interval ±30%
    - Irregular lots: randomize individual lot sizes (sum = total)
    - Price limit: skip lot if L1 mid exceeds limit
    - Basket: multi-symbol TWAP with basket-level tracking & events

Redis persistence:
    - Single TWAP:  pms:twap:{twapId}               TTL 12h
    - Active index:  pms:active_twap:{subAccountId}  hash
    - Basket TWAP:   pms:twapb:{basketId}            TTL 12h
    - Basket index:  pms:active_twap_basket:{subAccountId} hash
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

from contracts.common import normalize_side, normalize_symbol, ts_ms, EventType, RedisKey
from contracts.events import (
    TWAPProgressEvent, TWAPCompletedEvent, TWAPCancelledEvent,
    TWAPBasketProgressEvent, TWAPBasketCompletedEvent, TWAPBasketCancelledEvent,
)
from contracts.state import TWAPRedisState, TWAPBasketRedisState

logger = logging.getLogger(__name__)

TWAP_REDIS_TTL = 43200  # 12h

# Side normalization delegated to contracts.common
_normalize_side = normalize_side


# ── Dataclasses ──

@dataclass
class TWAPState:
    id: str
    sub_account_id: str
    symbol: str                      # Binance format (BTCUSDT)
    side: str                        # BUY or SELL (normalized)
    total_quantity: float
    num_lots: int
    interval_seconds: float
    leverage: int = 1
    jitter_pct: float = 30.0        # ±30% randomize interval
    irregular: bool = False          # Randomize lot sizes
    price_limit: Optional[float] = None  # Skip lot if price exceeds
    filled_quantity: float = 0.0
    filled_lots: int = 0
    lot_sizes: List[float] = field(default_factory=list)
    status: str = "ACTIVE"
    created_at: float = field(default_factory=time.time)
    basket_id: Optional[str] = None  # Set if part of a basket
    _task: Optional[asyncio.Task] = field(default=None, repr=False)


@dataclass
class TWAPBasketState:
    id: str
    sub_account_id: str
    basket_name: str
    twap_ids: List[str]             # child TWAP IDs
    num_lots: int
    total_lots: int
    filled_lots: int = 0
    status: str = "ACTIVE"
    created_at: float = field(default_factory=time.time)


class TWAPEngine:
    """Manages single and basket TWAP execution instances."""

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
        self._baskets: Dict[str, TWAPBasketState] = {}

    # ── Single TWAP ──

    async def start_twap(self, params: dict) -> str:
        """Start a new TWAP. Returns TWAP ID.

        Accepts either:
          - quantity: in coin units (direct)
          - sizeUsdt: in USD (auto-converts using market mid price)
        Side: LONG/SHORT or BUY/SELL (normalized to BUY/SELL)
        Symbol: ccxt or Binance format (normalized to Binance)
        """
        twap_id = f"twap_{uuid.uuid4().hex[:12]}"
        symbol = params["symbol"]  # Keep ccxt format — convert at exchange boundary only
        side = _normalize_side(params["side"])

        # Resolve quantity — support both coin amount and USD amount
        if "sizeUsdt" in params and params["sizeUsdt"]:
            size_usdt = float(params["sizeUsdt"])
            price = self._md.get_mid_price(symbol) if self._md else None
            if not price or price <= 0:
                raise ValueError(f"Cannot get price for {symbol} to convert sizeUsdt to quantity")
            total_qty = size_usdt / price
        else:
            total_qty = float(params["quantity"])

        num_lots = int(params.get("numLots", params.get("lots", 10)))
        irregular = bool(params.get("irregular", False))

        # Compute interval: support both intervalSeconds and durationMinutes
        if "intervalSeconds" in params:
            interval_seconds = float(params["intervalSeconds"])
        elif "durationMinutes" in params:
            interval_seconds = (float(params["durationMinutes"]) * 60) / num_lots
        else:
            interval_seconds = 60.0

        # Generate lot sizes
        if irregular:
            weights = [random.random() for _ in range(num_lots)]
            total_w = sum(weights)
            lot_sizes = [(w / total_w) * total_qty for w in weights]
        else:
            lot_sizes = [total_qty / num_lots] * num_lots

        state = TWAPState(
            id=twap_id,
            sub_account_id=params["subAccountId"],
            symbol=symbol,
            side=side,
            total_quantity=total_qty,
            num_lots=num_lots,
            interval_seconds=interval_seconds,
            leverage=int(params.get("leverage", 1)),
            jitter_pct=float(params.get("jitterPct", params.get("jitter_pct", 30))),
            irregular=irregular,
            price_limit=float(params["priceLimit"]) if params.get("priceLimit") else None,
            lot_sizes=lot_sizes,
            basket_id=params.get("_basketId"),  # internal: set by basket starter
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

    # ── Basket TWAP ──

    async def start_basket_twap(self, params: dict) -> dict:
        """Start a basket TWAP — grouped legs with basket-level tracking.

        Returns: { twapBasketId, twapIds }
        """
        basket_id = f"twapb_{uuid.uuid4().hex[:12]}"
        sub_account_id = params["subAccountId"]
        basket_name = params.get("basketName", "Unnamed Index")
        num_lots = int(params.get("lots", params.get("numLots", 10)))

        twap_ids = []
        for leg in params.get("legs", []):
            leg_params = {
                **leg,
                "subAccountId": sub_account_id,
                "numLots": num_lots,
                "_basketId": basket_id,
            }
            # Pass through basket-level config
            for key in ("durationMinutes", "intervalSeconds", "jitter", "irregular", "leverage"):
                if key in params and key not in leg_params:
                    leg_params[key] = params[key]
            # Handle jitter: if truthy, set default jitterPct
            if leg_params.get("jitter") and "jitterPct" not in leg_params:
                leg_params["jitterPct"] = 30

            twap_id = await self.start_twap(leg_params)
            twap_ids.append(twap_id)

        basket = TWAPBasketState(
            id=basket_id,
            sub_account_id=sub_account_id,
            basket_name=basket_name,
            twap_ids=twap_ids,
            num_lots=num_lots,
            total_lots=num_lots,
        )
        self._baskets[basket_id] = basket

        await self._save_basket_state(basket)

        logger.info("TWAP basket started: %s — %d legs, %d lots",
                     basket_id, len(twap_ids), num_lots)
        return {"twapBasketId": basket_id, "twapIds": twap_ids}

    async def cancel_basket_twap(self, basket_id: str) -> bool:
        """Cancel a basket TWAP — cancels all child TWAPs."""
        basket = self._baskets.get(basket_id)
        if not basket:
            return False

        basket.status = "CANCELLED"
        for twap_id in basket.twap_ids:
            await self.cancel_twap(twap_id)

        await self._cleanup_basket(basket)
        await self._publish_basket_event("twap_basket_cancelled", basket)
        return True

    def get_active_baskets(self, sub_account_id: str) -> List[dict]:
        """Get active baskets for a sub-account (for REST endpoint)."""
        results = []
        for basket in self._baskets.values():
            if basket.sub_account_id != sub_account_id:
                continue
            if basket.status != "ACTIVE":
                continue

            # Compute progress from child TWAPs
            legs_info = []
            min_filled = basket.total_lots
            for twap_id in basket.twap_ids:
                state = self._active.get(twap_id)
                if state:
                    legs_info.append({
                        "symbol": state.symbol,
                        "side": state.side,
                        "filledLots": state.filled_lots,
                        "totalLots": state.num_lots,
                        "filledSize": state.filled_quantity,
                        "totalSize": state.total_quantity,
                    })
                    min_filled = min(min_filled, state.filled_lots)

            results.append({
                "id": basket.id,
                "twapBasketId": basket.id,
                "basketName": basket.basket_name,
                "subAccountId": basket.sub_account_id,
                "totalLots": basket.total_lots,
                "filledLots": min_filled if legs_info else 0,
                "legs": legs_info,
                "status": basket.status,
            })
        return results

    # ── TWAP Loop ──

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

                    # Persist progress after each lot (crash recovery)
                    await self._save_state(state)

                    await self._publish_event("twap_progress", state,
                        lotIndex=i, lotQty=lot_qty, filledLots=state.filled_lots)

                    # Update basket progress if part of one
                    if state.basket_id:
                        await self._update_basket_progress(state.basket_id)

                except Exception as e:
                    logger.error("TWAP %s lot %d failed: %s", state.id, i, e)

            # Complete
            if state.status == "ACTIVE":
                state.status = "COMPLETED"
                await self._publish_event("twap_completed", state)

                # Check if basket is complete
                if state.basket_id:
                    await self._check_basket_completion(state.basket_id)

        except asyncio.CancelledError:
            pass
        finally:
            await self._cleanup(state)

    # ── Basket Progress Tracking ──

    async def _update_basket_progress(self, basket_id: str) -> None:
        """Publish basket-level progress event after a child TWAP lot fills."""
        basket = self._baskets.get(basket_id)
        if not basket or basket.status != "ACTIVE":
            return

        await self._publish_basket_event("twap_basket_progress", basket)

    async def _check_basket_completion(self, basket_id: str) -> None:
        """Check if all child TWAPs are done; if so, complete the basket."""
        basket = self._baskets.get(basket_id)
        if not basket or basket.status != "ACTIVE":
            return

        all_done = all(
            twap_id not in self._active or self._active[twap_id].status != "ACTIVE"
            for twap_id in basket.twap_ids
        )
        if all_done:
            basket.status = "COMPLETED"
            await self._cleanup_basket(basket)
            await self._publish_basket_event("twap_basket_completed", basket)

    # ── Cleanup ──

    async def _cleanup(self, state: TWAPState) -> None:
        self._active.pop(state.id, None)
        if self._redis:
            await self._redis.delete(RedisKey.twap(state.id))
            await self._redis.hdel(RedisKey.active_twap(state.sub_account_id), state.id)

    async def _cleanup_basket(self, basket: TWAPBasketState) -> None:
        self._baskets.pop(basket.id, None)
        if self._redis:
            await self._redis.delete(RedisKey.twap_basket(basket.id))
            await self._redis.hdel(RedisKey.active_twap_basket(basket.sub_account_id), basket.id)

    # ── Redis State Persistence ──

    async def _save_state(self, state: TWAPState) -> None:
        """Persist state to Redis using TWAPRedisState DTO."""
        if not self._redis:
            return
        dto = TWAPRedisState(
            twap_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            side=state.side,
            total_quantity=state.total_quantity,
            num_lots=state.num_lots,
            interval_seconds=state.interval_seconds,
            status=state.status,
            filled_lots=state.filled_lots,
            filled_quantity=state.filled_quantity,
            basket_id=state.basket_id,
            lot_sizes=state.lot_sizes,
        )
        data_json = json.dumps(dto.to_dict())
        await self._redis.set(RedisKey.twap(state.id), data_json, ex=TWAP_REDIS_TTL)
        acct_key = RedisKey.active_twap(state.sub_account_id)
        await self._redis.hset(acct_key, state.id, data_json)
        await self._redis.expire(acct_key, TWAP_REDIS_TTL)

    async def _save_basket_state(self, basket: TWAPBasketState) -> None:
        """Persist basket state to Redis using TWAPBasketRedisState DTO."""
        if not self._redis:
            return
        dto = TWAPBasketRedisState(
            basket_id=basket.id,
            sub_account_id=basket.sub_account_id,
            basket_name=basket.basket_name,
            twap_ids=basket.twap_ids,
            total_lots=basket.total_lots,
            filled_lots=basket.filled_lots,
            status=basket.status,
        )
        data_json = json.dumps(dto.to_dict())
        await self._redis.set(RedisKey.twap_basket(basket.id), data_json, ex=TWAP_REDIS_TTL)
        acct_key = RedisKey.active_twap_basket(basket.sub_account_id)
        await self._redis.hset(acct_key, basket.id, data_json)
        await self._redis.expire(acct_key, TWAP_REDIS_TTL)

    # ── Event Publishing ──

    async def _publish_event(self, event_type: str, state: TWAPState, **extra) -> None:
        """Publish TWAP event to Redis using typed event DTOs."""
        if not self._redis:
            return

        if event_type == EventType.TWAP_COMPLETED:
            payload = TWAPCompletedEvent(
                twap_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                filled_lots=state.filled_lots,
                total_lots=state.num_lots,
                filled_quantity=state.filled_quantity,
                total_quantity=state.total_quantity,
            ).to_dict()
        elif event_type == EventType.TWAP_CANCELLED:
            payload = TWAPCancelledEvent(
                twap_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                filled_lots=state.filled_lots,
                total_lots=state.num_lots,
                filled_quantity=state.filled_quantity,
                total_quantity=state.total_quantity,
            ).to_dict()
        else:
            # twap_progress / twap_started
            payload = TWAPProgressEvent(
                twap_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=state.side,
                filled_lots=state.filled_lots,
                total_lots=state.num_lots,
                filled_quantity=state.filled_quantity,
                total_quantity=state.total_quantity,
                status=state.status,
            ).to_dict()
            if event_type not in (EventType.TWAP_PROGRESS,):
                payload["type"] = event_type

        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish TWAP event: %s", e)

    async def _publish_basket_event(self, event_type: str, basket: TWAPBasketState, **extra) -> None:
        """Publish basket TWAP event to Redis using typed event DTOs."""
        if not self._redis:
            return

        # Build legs info from active TWAPs
        legs_info = []
        min_filled = basket.total_lots
        for twap_id in basket.twap_ids:
            state = self._active.get(twap_id)
            if state:
                legs_info.append({
                    "symbol": state.symbol, "side": state.side,
                    "filledSize": state.filled_quantity, "totalSize": state.total_quantity,
                })
                min_filled = min(min_filled, state.filled_lots)

        if event_type == EventType.TWAP_BASKET_COMPLETED:
            payload = TWAPBasketCompletedEvent(
                twap_basket_id=basket.id,
                sub_account_id=basket.sub_account_id,
                basket_name=basket.basket_name,
                filled_lots=min_filled if legs_info else basket.filled_lots,
                total_lots=basket.total_lots,
                legs=legs_info,
            ).to_dict()
        elif event_type == EventType.TWAP_BASKET_CANCELLED:
            payload = TWAPBasketCancelledEvent(
                twap_basket_id=basket.id,
                sub_account_id=basket.sub_account_id,
                basket_name=basket.basket_name,
                filled_lots=min_filled if legs_info else basket.filled_lots,
                total_lots=basket.total_lots,
                legs=legs_info,
            ).to_dict()
        else:
            payload = TWAPBasketProgressEvent(
                twap_basket_id=basket.id,
                sub_account_id=basket.sub_account_id,
                basket_name=basket.basket_name,
                filled_lots=min_filled if legs_info else basket.filled_lots,
                total_lots=basket.total_lots,
                legs=legs_info,
                status=basket.status,
            ).to_dict()
            if event_type not in (EventType.TWAP_BASKET_PROGRESS,):
                payload["type"] = event_type

        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish TWAP basket event: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)
