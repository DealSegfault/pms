"""
ScalperEngine — Dual-leg scalper with layered limit orders.

Spawns two groups of chase orders on the same symbol:
  - Long leg  — N child chases at exponentially-spread offsets below bid
  - Short leg — N child chases at exponentially-spread offsets above ask

Side rules (startSide controls reduce-only enforcement):
  startSide=LONG  → long chases normal, short chases reduceOnly
  startSide=SHORT → short chases normal, long chases reduceOnly
  neutralMode     → both legs non-reduceOnly

When a child chase fills → that slot re-arms a new chase at the same offset,
subject to fill-spread cooldown, burst rate limiting, and price filters.

Layer geometry:
  Exponentially distributed around the base offset with a fixed spread factor (2x).
  Skew weights adjust the USD size allocation across layers.

Redis persistence: pms:scalper:{scalperId} TTL 48h
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from contracts.common import normalize_side, ts_ms, ts_s_to_ms, EventType, RedisKey
from contracts.events import (
    ScalperProgressEvent, ScalperFilledEvent, ScalperCancelledEvent,
    ScalperSlotInfo,
)
from contracts.state import ScalperRedisState

logger = logging.getLogger(__name__)

SCALPER_REDIS_TTL = 172800  # 48h
MIN_NOTIONAL_USD = 5        # Binance minimum
BACKOFF_BASE_S = 2.0        # 2s initial backoff
BACKOFF_MAX_S = 300.0       # 5min cap


# ── Dataclasses ────────────────────────────────────────────────


@dataclass
class ScalperSlot:
    layer_idx: int
    side: str                             # BUY / SELL
    qty: float = 0.0                      # Coin quantity for this layer
    offset_pct: float = 0.0              # Stalk offset %
    reduce_only: bool = False
    chase_id: Optional[str] = None
    active: bool = False
    paused: bool = False
    pause_reason: Optional[str] = None
    retry_at: float = 0.0
    retry_count: int = 0
    fills: int = 0
    _restarting: bool = False


@dataclass
class ScalperState:
    id: str
    sub_account_id: str
    symbol: str
    start_side: str                       # LONG / SHORT (maps to BUY/SELL internally)
    leverage: int = 1
    child_count: int = 1
    skew: int = 0
    long_offset_pct: float = 0.0
    short_offset_pct: float = 0.0
    long_size_usd: float = 0.0
    short_size_usd: float = 0.0
    long_max_price: Optional[float] = None
    short_min_price: Optional[float] = None
    neutral_mode: bool = False
    min_fill_spread_pct: float = 0.0
    fill_decay_half_life_ms: float = 30000
    min_refill_delay_ms: float = 0.0
    allow_loss: bool = True
    max_loss_per_close_bps: int = 0
    max_fills_per_minute: int = 0
    pnl_feedback_mode: str = "off"
    # ── Runtime state ──
    long_slots: List[ScalperSlot] = field(default_factory=list)
    short_slots: List[ScalperSlot] = field(default_factory=list)
    fill_count: int = 0
    status: str = "active"                # active / stopped
    created_at: float = field(default_factory=time.time)
    reduce_only_armed: bool = False
    last_known_price: float = 0.0
    pin_long_to_entry: bool = False
    pin_short_to_entry: bool = False
    # Per-side fill tracking for spread/burst guards
    _last_fill_price: Dict[str, float] = field(default_factory=dict)
    _last_fill_time: Dict[str, float] = field(default_factory=dict)
    _recent_fill_times: Dict[str, list] = field(default_factory=dict)
    _fill_refill_count: Dict[str, int] = field(default_factory=dict)


# ── Layer Geometry ─────────────────────────────────────────────


def _generate_layer_offsets(base_offset: float, count: int, max_spread: float = 2.0) -> List[float]:
    """Exponentially-spread offset percentages centered on base_offset."""
    if count <= 1:
        return [base_offset]
    step = math.log(max_spread) / (count - 1)
    return [
        base_offset * math.exp(-math.log(max_spread) / 2 + step * i)
        for i in range(count)
    ]


def _generate_skew_weights(count: int, skew: int) -> List[float]:
    """Compute skew-weighted allocations. Positive skew → heavier on further-out layers."""
    if count <= 1:
        return [1.0]
    s = skew / 100.0
    weights = [8 ** (s * (2 * (i / (count - 1)) - 1)) for i in range(count)]
    total = sum(weights)
    return [w / total for w in weights]


def _backoff_delay(retry_count: int) -> float:
    """Exponential backoff: 2^retryCount * base, capped at max."""
    return min(BACKOFF_BASE_S * (2 ** retry_count), BACKOFF_MAX_S)


def _burst_cooldown_s(state: ScalperState, leg_side: str) -> float:
    """Returns 0 if ok, else seconds to wait until burst window clears."""
    if state.max_fills_per_minute <= 0:
        return 0
    now = time.time()
    window = 60.0
    times = state._recent_fill_times.get(leg_side, [])
    # Prune old times
    times = [t for t in times if now - t < window]
    state._recent_fill_times[leg_side] = times
    if len(times) < state.max_fills_per_minute:
        return 0
    oldest = times[0]
    return max(0, oldest + window - now)


def _fill_spread_cooldown_s(state: ScalperState, leg_side: str) -> float:
    """Time to wait before fill-spread is wide enough."""
    if state.min_fill_spread_pct <= 0:
        return 0
    last_price = state._last_fill_price.get(leg_side)
    last_time = state._last_fill_time.get(leg_side, 0)
    price = state.last_known_price
    if not last_price or not price or price <= 0:
        return 0
    elapsed = time.time() - last_time
    half_life = state.fill_decay_half_life_ms / 1000.0
    if half_life <= 0:
        return 0
    decay = 0.5 ** (elapsed / half_life)
    effective_spread = state.min_fill_spread_pct * decay
    actual_spread = abs(price - last_price) / last_price * 100
    if actual_spread >= effective_spread:
        return 0
    remaining = half_life * math.log2(state.min_fill_spread_pct / max(actual_spread, 0.0001)) - elapsed
    return max(0, remaining)


def _fill_refill_delay_s(state: ScalperState, leg_side: str) -> float:
    """Exponential per-side refill delay."""
    if state.min_refill_delay_ms <= 0:
        return 0
    count = min(state._fill_refill_count.get(leg_side, 0), 4)
    delay_ms = min(state.min_refill_delay_ms * (2 ** count), BACKOFF_MAX_S * 1000)
    return delay_ms / 1000.0


def _is_price_allowed(state: ScalperState, leg_side: str,
                      get_entry_fn=None) -> bool:
    """Check if current price is within bounds for this leg side.

    When pin_long_to_entry is True, the LONG leg's max price is clamped to
    the current long/short position entry price (whichever is applicable).
    When pin_short_to_entry is True, the SHORT leg's min price is clamped to
    the current long/short position entry price.

    This matches the archived JS isPriceAllowed() logic.
    """
    price = state.last_known_price
    if not price:
        return True

    effective_long_max = state.long_max_price
    effective_short_min = state.short_min_price

    # Look up position entries if we have the getter
    long_entry = None
    short_entry = None
    if get_entry_fn and (state.pin_long_to_entry or state.pin_short_to_entry
                         or not state.allow_loss):
        long_entry = get_entry_fn(state, "LONG")
        short_entry = get_entry_fn(state, "SHORT")

    # Pin LONG bounds — restrict buying above the position entry
    if state.pin_long_to_entry:
        if short_entry and short_entry > 0:
            effective_long_max = min(effective_long_max, short_entry) if effective_long_max else short_entry
        if long_entry and long_entry > 0:
            effective_long_max = min(effective_long_max, long_entry) if effective_long_max else long_entry

    # Pin SHORT bounds — restrict selling below the position entry
    if state.pin_short_to_entry:
        if long_entry and long_entry > 0:
            effective_short_min = max(effective_short_min, long_entry) if effective_short_min else long_entry
        if short_entry and short_entry > 0:
            effective_short_min = max(effective_short_min, short_entry) if effective_short_min else short_entry

    # Legacy fallback: allowLoss=false
    if not state.allow_loss:
        if leg_side == "BUY" and short_entry and short_entry > 0:
            effective_long_max = min(effective_long_max, short_entry) if effective_long_max else short_entry
        if leg_side == "SELL" and long_entry and long_entry > 0:
            effective_short_min = max(effective_short_min, long_entry) if effective_short_min else long_entry

    if leg_side == "BUY" and effective_long_max and price > effective_long_max:
        return False
    if leg_side == "SELL" and effective_short_min and price < effective_short_min:
        return False
    return True


# Side normalization delegated to contracts.common
_to_exchange_side = normalize_side


# ── Scalper Engine ─────────────────────────────────────────────


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
        # Timer handles for slot retries: key = f"{scalperId}:{side}:{layerIdx}"
        self._slot_tasks: Dict[str, asyncio.Task] = {}
        self._price_handlers: Dict[str, Callable] = {}  # scalper_id → L1 handler ref

    # ── Public API ──

    async def start_scalper(self, params: dict) -> str:
        """Start a new scalper. Returns scalper ID."""
        scalper_id = f"scalper_{uuid.uuid4().hex[:12]}"

        start_side = params.get("startSide", "LONG").upper()
        child_count = max(1, min(10, int(params.get("childCount", params.get("numLayers", 1)))))
        skew = max(-100, min(100, int(params.get("skew", 0))))
        long_offset = max(0, min(10, float(params.get("longOffsetPct", params.get("layerSpreadBps", 10) / 100))))
        short_offset = max(0, min(10, float(params.get("shortOffsetPct", long_offset))))
        long_size_usd = max(0, float(params.get("longSizeUsd", params.get("quantity", 0))))
        short_size_usd = max(0, float(params.get("shortSizeUsd", long_size_usd)))
        neutral_mode = bool(params.get("neutralMode", False))

        # Subscribe to market data FIRST — this starts the depth stream for
        # the symbol so L1 data becomes available. Without this, get_l1()
        # returns None if no other component has subscribed yet.
        if self._md:
            self._md.subscribe(params["symbol"], self._make_price_handler(scalper_id))

        # Pre-warm: if MarketData has no L1 yet, seed it from bookTicker REST
        # (takes ~50ms vs ~3.5s for the full depth pipeline).
        l1 = self._md.get_l1(params["symbol"]) if self._md else None
        if not l1 and self._md:
            try:
                import aiohttp
                binance_sym = params["symbol"].split(":")[0].replace("/", "").upper()
                url = f"https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol={binance_sym}"
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            bid = float(data.get("bidPrice", 0))
                            ask = float(data.get("askPrice", 0))
                            if bid > 0 and ask > 0:
                                mid = (bid + ask) / 2
                                import time as _t
                                self._md._last_l1[params["symbol"]] = {
                                    "bid": bid, "ask": ask, "mid": mid, "ts": _t.time()
                                }
                                logger.info("Pre-warmed L1 for %s from bookTicker: bid=%.6f ask=%.6f", params["symbol"], bid, ask)
            except Exception as e:
                logger.debug("bookTicker pre-warm failed for %s: %s", params["symbol"], e)

        # Retry getting L1 price — depth stream needs time to connect + seed.
        # Try up to 10 times with 500ms waits (~5s total). The depth pipeline
        # (WS connect + REST snapshot) typically takes 3-4s, so 2s was too short
        # for any coin, and particularly for low-liquidity ones.
        price = 0
        for attempt in range(10):
            l1 = self._md.get_l1(params["symbol"]) if self._md else None
            if l1 and l1.get("mid", 0) > 0:
                price = l1["mid"]
                break
            if attempt < 9:
                logger.debug("Scalper %s: waiting for L1 price (attempt %d/10)", scalper_id, attempt + 1)
            await asyncio.sleep(0.5)

        state = ScalperState(
            id=scalper_id,
            sub_account_id=params["subAccountId"],
            symbol=params["symbol"],
            start_side=start_side,
            leverage=int(params.get("leverage", 1)),
            child_count=child_count,
            skew=skew,
            long_offset_pct=long_offset,
            short_offset_pct=short_offset,
            long_size_usd=long_size_usd,
            short_size_usd=short_size_usd,
            long_max_price=_parse_opt_float(params.get("longMaxPrice")),
            short_min_price=_parse_opt_float(params.get("shortMinPrice")),
            neutral_mode=neutral_mode,
            min_fill_spread_pct=max(0, min(10, float(params.get("minFillSpreadPct", 0)))),
            fill_decay_half_life_ms=max(1000, float(params.get("fillDecayHalfLifeMs", 30000))),
            min_refill_delay_ms=max(0, float(params.get("minRefillDelayMs", 0))),
            allow_loss=params.get("allowLoss", True) not in (False, "false"),
            max_loss_per_close_bps=max(0, int(params.get("maxLossPerCloseBps", 0))),
            max_fills_per_minute=max(0, int(params.get("maxFillsPerMinute", 0))),
            pnl_feedback_mode=params.get("pnlFeedbackMode", "off"),
            last_known_price=price,
            reduce_only_armed=neutral_mode,
            pin_long_to_entry=bool(params.get("pinLongToEntry", False)),
            pin_short_to_entry=bool(params.get("pinShortToEntry", False)),
        )

        self._active[scalper_id] = state

        if not price:
            logger.error("Scalper %s: cannot get price for %s after 5s — stopping (never proceed with dummy price)", scalper_id, state.symbol)
            state.status = "stopped"
            # Unsubscribe since we're not going to use this handler
            handler = self._price_handlers.pop(scalper_id, None)
            if handler and self._md:
                self._md.unsubscribe(state.symbol, handler)
            return scalper_id

        # ── Compute layer offsets and quantities ──
        opening_side = _to_exchange_side(start_side)
        opening_offset = long_offset if start_side == "LONG" else short_offset
        opening_size_usd = long_size_usd if start_side == "LONG" else short_size_usd
        offsets = _generate_layer_offsets(opening_offset, child_count)
        weights = _generate_skew_weights(child_count, skew)
        qtys = [(opening_size_usd * w) / price for w in weights]

        # Start opening leg
        opening_slots = await self._start_leg(state, opening_side, offsets, qtys, reduce_only=False)
        if opening_side == "BUY":
            state.long_slots = opening_slots
        else:
            state.short_slots = opening_slots

        # Retry failed slots
        for slot in opening_slots:
            if not slot.chase_id and slot.qty > 0:
                await self._schedule_restart(state, slot, delay=2.0)

        # Neutral mode: start both legs immediately
        other_slots = []
        if neutral_mode:
            other_side = "SELL" if opening_side == "BUY" else "BUY"
            other_offset = short_offset if start_side == "LONG" else long_offset
            other_size_usd = short_size_usd if start_side == "LONG" else long_size_usd
            other_offsets = _generate_layer_offsets(other_offset, child_count)
            other_qtys = [(other_size_usd * w) / price for w in weights]
            other_slots = await self._start_leg(state, other_side, other_offsets, other_qtys, reduce_only=False)
            if other_side == "BUY":
                state.long_slots = other_slots
            else:
                state.short_slots = other_slots
            for slot in other_slots:
                if not slot.chase_id and slot.qty > 0:
                    await self._schedule_restart(state, slot, delay=2.0)
        else:
            # Normal mode: reduce-only leg deferred until first fill
            if opening_side == "BUY":
                state.short_slots = []
            else:
                state.long_slots = []

        await self._save_state(state)
        await self._broadcast_progress(state)

        total_opening = sum(1 for s in opening_slots if s.chase_id)
        total_other = sum(1 for s in other_slots if s.chase_id)
        logger.info(
            "Scalper started: %s %s %s %d+%d layers",
            scalper_id, state.symbol, start_side, total_opening, total_other,
        )

        return scalper_id

    async def cancel_scalper(self, scalper_id: str, close_positions: bool = False) -> bool:
        """Stop a scalper, cancel all its chase orders."""
        state = self._active.get(scalper_id)
        if not state:
            return False

        if state.status == "stopped":
            return False
        state.status = "stopped"

        # Clear all pending retry tasks
        keys_to_cancel = [k for k in self._slot_tasks if k.startswith(f"{scalper_id}:")]
        for key in keys_to_cancel:
            task = self._slot_tasks.pop(key, None)
            if task and not task.done():
                task.cancel()

        # Clean up Redis state BEFORE cancelling child chases,
        # because cancel_chase → cancel_order triggers feed events
        # that cause the frontend to refetch pms:active_scalper.
        self._active.pop(scalper_id, None)

        # Unsubscribe the scalper's own L1 price handler
        handler = self._price_handlers.pop(scalper_id, None)
        if handler and self._md:
            self._md.unsubscribe(state.symbol, handler)

        if self._redis:
            try:
                await self._redis.delete(RedisKey.scalper(scalper_id))
                await self._redis.hdel(RedisKey.active_scalper(state.sub_account_id), scalper_id)
            except Exception:
                pass
        await self._publish_event("scalper_cancelled", state)

        # Cancel all child chases (first pass)
        all_slots = state.long_slots + state.short_slots
        for slot in all_slots:
            if slot.chase_id:
                try:
                    await self._chase.cancel_chase(slot.chase_id)
                except Exception as e:
                    logger.warning("Scalper %s: cancel child %s error: %s", scalper_id, slot.chase_id, e)
                slot.chase_id = None
                slot.active = False

        # Second sweep for chases spawned by in-flight restarts
        for slot in state.long_slots + state.short_slots:
            if slot.chase_id:
                try:
                    await self._chase.cancel_chase(slot.chase_id)
                except Exception:
                    pass
                slot.chase_id = None

        # Close positions if requested (#16)
        if close_positions:
            try:
                positions = self._om._risk.position_book.get_by_sub_account(state.sub_account_id)
                for pos in positions:
                    if pos.symbol == state.symbol:
                        close_side = "SELL" if pos.side == "LONG" else "BUY"
                        await self._om.place_market_order(
                            sub_account_id=state.sub_account_id,
                            symbol=pos.symbol,
                            side=close_side,
                            quantity=pos.quantity,
                            reduce_only=True,
                            origin="SCALPER",
                            parent_id=scalper_id,
                        )
                        logger.info("Scalper %s: closed position %s %s", scalper_id, pos.symbol, pos.side)
            except Exception as e:
                logger.error("Scalper %s: close positions failed: %s", scalper_id, e)

        return True

    def get_state(self, scalper_id: str) -> Optional[ScalperState]:
        return self._active.get(scalper_id)

    def _make_price_handler(self, scalper_id: str):
        """Create a bound L1 handler that updates last_known_price for a scalper."""
        async def handler(symbol: str, bid: float, ask: float, mid: float):
            state = self._active.get(scalper_id)
            if state and state.status == "active" and mid > 0:
                state.last_known_price = mid
        self._price_handlers[scalper_id] = handler
        return handler

    def _get_position_entry(self, state: ScalperState, side: str) -> Optional[float]:
        """Get the position entry price for a given side from the risk engine.

        Used by _is_price_allowed for pin-to-entry clamping.
        Returns entry_price or None.
        """
        try:
            book = getattr(self._om, '_risk', None)
            if book:
                book = getattr(book, 'position_book', None)
            if not book:
                return None
            pos = book.find_position(state.sub_account_id, state.symbol, side)
            if pos and pos.entry_price and pos.entry_price > 0:
                return pos.entry_price
        except Exception:
            pass
        return None

    # ── Leg Management ──

    async def _start_leg(
        self,
        state: ScalperState,
        side: str,
        offsets: List[float],
        qtys: List[float],
        reduce_only: bool,
    ) -> List[ScalperSlot]:
        """Start all child chases for one leg using batch placement.
        
        Uses ChaseEngine.start_chase_batch() to place all orders in batches
        of 5 (Binance limit) instead of N sequential REST calls.
        """
        slots: List[ScalperSlot] = []
        price = state.last_known_price or 0

        # 1. Create slots and collect batch params for valid ones
        batch_params: list[dict] = []
        batch_slot_indices: list[int] = []  # maps batch_params index → slots index

        for i, (offset, qty) in enumerate(zip(offsets, qtys)):
            slot = ScalperSlot(
                layer_idx=i, side=side, qty=qty, offset_pct=offset,
                reduce_only=reduce_only,
            )
            slots.append(slot)

            # Skip layers below min notional
            if not reduce_only and price > 0 and (qty * price) + 0.001 < MIN_NOTIONAL_USD:
                logger.warning("Scalper %s: %s layer %d skipped (notional $%.2f < $%d)",
                               state.id, side, i, qty * price, MIN_NOTIONAL_USD)
                continue
            if qty <= 0:
                continue

            # Add to batch
            batch_params.append({
                "subAccountId": state.sub_account_id,
                "symbol": state.symbol,
                "side": slot.side,
                "quantity": slot.qty,
                "leverage": state.leverage,
                "stalkOffsetPct": slot.offset_pct,
                "stalkMode": "maintain",
                "maxDistancePct": 0,
                "reduceOnly": slot.reduce_only,
                "parentScalperId": state.id,
                "onFill": lambda fp, fq, _s=state, _sl=slot: asyncio.ensure_future(
                    self._on_child_fill(_s, _sl, fp, fq)
                ),
                "onCancel": lambda reason, _s=state, _sl=slot: asyncio.ensure_future(
                    self._on_child_cancel(_s, _sl, reason)
                ),
            })
            batch_slot_indices.append(i)

        # 2. Batch start all chases
        if batch_params:
            try:
                chase_ids = await self._chase.start_chase_batch(batch_params)
                for j, chase_id in enumerate(chase_ids):
                    slot_idx = batch_slot_indices[j]
                    if chase_id:
                        slots[slot_idx].chase_id = chase_id
                        slots[slot_idx].active = True
            except Exception as e:
                logger.error("Scalper %s: batch start_leg failed: %s — falling back to sequential", state.id, e)
                # Fallback: start individually
                for j, params in enumerate(batch_params):
                    slot_idx = batch_slot_indices[j]
                    chase_id = await self._place_chase_for_slot(state, slots[slot_idx])
                    if chase_id:
                        slots[slot_idx].chase_id = chase_id
                        slots[slot_idx].active = True

        return slots

    async def _place_chase_for_slot(self, state: ScalperState, slot: ScalperSlot) -> Optional[str]:
        """Place a chase order for a single slot. Returns chase ID or None."""
        try:
            chase_params = {
                "subAccountId": state.sub_account_id,
                "symbol": state.symbol,
                "side": slot.side,
                "quantity": slot.qty,
                "leverage": state.leverage,
                "stalkOffsetPct": slot.offset_pct,
                "stalkMode": "maintain",
                "maxDistancePct": 0,     # Scalper manages its own lifecycle
                "reduceOnly": slot.reduce_only,
                "parentScalperId": state.id,
                # Wire fill/cancel callbacks back to this scalper
                "onFill": lambda fp, fq, _s=state, _sl=slot: asyncio.ensure_future(
                    self._on_child_fill(_s, _sl, fp, fq)
                ),
                "onCancel": lambda reason, _s=state, _sl=slot: asyncio.ensure_future(
                    self._on_child_cancel(_s, _sl, reason)
                ),
            }
            chase_id = await self._chase.start_chase(chase_params)
            return chase_id
        except Exception as e:
            logger.error("Scalper %s: failed to start chase for %s layer %d: %s",
                         state.id, slot.side, slot.layer_idx, e)
            return None

    # ── Child Callbacks ──

    async def _on_child_fill(self, state: ScalperState, slot: ScalperSlot,
                              fill_price: float, fill_qty: float) -> None:
        """Called when a child chase fills."""
        if state.status != "active":
            return

        slot.chase_id = None
        slot.active = False
        slot.fills += 1
        state.fill_count += 1

        # Track fill for spread/burst guards
        now = time.time()
        state._last_fill_price[slot.side] = fill_price
        state._last_fill_time[slot.side] = now
        if slot.side not in state._recent_fill_times:
            state._recent_fill_times[slot.side] = []
        state._recent_fill_times[slot.side].append(now)

        # Update price
        if fill_price > 0:
            state.last_known_price = fill_price

        # Determine if this is the opening or closing leg
        opening_side = _to_exchange_side(state.start_side)
        is_opening = slot.side == opening_side

        logger.info("Scalper %s: %s layer %d filled @ %.6f qty %.6f (%s)",
                     state.id, slot.side, slot.layer_idx, fill_price, fill_qty,
                     "opening" if is_opening else "closing")

        # Publish fill event
        await self._publish_event("scalper_filled", state,
                                   side=slot.side, layerIdx=slot.layer_idx,
                                   fillPrice=fill_price, fillQty=fill_qty)

        # Normal mode: first fill on opening leg → arm reduce-only (closing) leg
        if not state.neutral_mode and is_opening and not state.reduce_only_armed:
            await self._arm_reduce_only_leg(state)

        # Re-arm this slot with fill spread/burst guards
        await self._restart_slot(state, slot, is_fill_restart=True)

    async def _on_child_cancel(self, state: ScalperState, slot: ScalperSlot, reason: str) -> None:
        """Called when a child chase is cancelled externally."""
        if state.status != "active":
            return

        slot.chase_id = None
        slot.active = False

        # Terminal reasons — use a longer backoff
        terminal_reasons = [
            "reduce_only_reject", "position_gone", "insufficient_margin",
            "ReduceOnly Order is rejected", "notional must be no smaller",
            "-4164", "minimum quantity", "minimum notional",
        ]
        is_terminal = any(t.lower() in (reason or "").lower() for t in terminal_reasons)

        if reason == "cancelled":
            return  # Cancelled by us (cancel_scalper) — don't restart

        delay = 30.0 if is_terminal else 2.0
        logger.info("Scalper %s: %s layer %d auto-cancelled (%s), restarting in %.0fs",
                     state.id, slot.side, slot.layer_idx, reason, delay)
        await self._schedule_restart(state, slot, delay=delay)

    # ── Reduce-Only Leg Arming ──

    async def _arm_reduce_only_leg(self, state: ScalperState) -> None:
        """Arm the reduce-only (closing) leg on first opening fill."""
        if state.status != "active" or state.neutral_mode:
            return
        if state.reduce_only_armed:
            return
        state.reduce_only_armed = True

        ro_side = "SELL" if state.start_side == "LONG" else "BUY"
        ro_offset = state.short_offset_pct if state.start_side == "LONG" else state.long_offset_pct
        ro_size_usd = state.short_size_usd if state.start_side == "LONG" else state.long_size_usd
        price = state.last_known_price or 1

        offsets = _generate_layer_offsets(ro_offset, state.child_count)
        weights = _generate_skew_weights(state.child_count, state.skew)
        qtys = [(ro_size_usd * w) / price for w in weights]

        logger.info("Scalper %s: arming reduce-only %s leg (first opening fill)", state.id, ro_side)
        slots = await self._start_leg(state, ro_side, offsets, qtys, reduce_only=True)

        if state.status != "active":
            for s in slots:
                if s.chase_id:
                    try:
                        await self._chase.cancel_chase(s.chase_id)
                    except Exception:
                        pass
            return

        if ro_side == "BUY":
            state.long_slots = slots
        else:
            state.short_slots = slots

        # Retry failed slots
        for slot in slots:
            if not slot.chase_id and slot.qty > 0:
                await self._schedule_restart(state, slot, delay=2.0)

        await self._save_state(state)
        await self._broadcast_progress(state)

    # ── Slot Restart Logic ──

    async def _restart_slot(self, state: ScalperState, slot: ScalperSlot,
                             is_fill_restart: bool = False) -> None:
        """Restart a slot with all the guards (spread, burst, backoff, price filter)."""
        if state.status != "active":
            return
        if slot._restarting:
            return
        slot._restarting = True

        try:
            # ── Fill spread guard ──
            if is_fill_restart and state.min_fill_spread_pct > 0:
                wait_s = _fill_spread_cooldown_s(state, slot.side)
                if wait_s > 0:
                    slot.paused = True
                    slot.pause_reason = "fill_spread"
                    slot.retry_at = time.time() + wait_s
                    await self._broadcast_progress(state)
                    slot._restarting = False
                    await self._schedule_restart(state, slot, delay=wait_s, is_fill=True)
                    return

            # ── Burst fill guard ──
            if is_fill_restart:
                wait_s = _burst_cooldown_s(state, slot.side)
                if wait_s > 0:
                    slot.paused = True
                    slot.pause_reason = "burst_limit"
                    slot.retry_at = time.time() + wait_s
                    await self._broadcast_progress(state)
                    slot._restarting = False
                    await self._schedule_restart(state, slot, delay=wait_s, is_fill=False)
                    return

            # ── Fill refill delay ──
            if is_fill_restart and state.min_refill_delay_ms > 0:
                delay_s = _fill_refill_delay_s(state, slot.side)
                if delay_s > 0:
                    slot.paused = True
                    slot.pause_reason = "refill_delay"
                    slot.retry_at = time.time() + delay_s
                    await self._broadcast_progress(state)
                    slot._restarting = False
                    await self._schedule_restart(state, slot, delay=delay_s, is_fill=False)
                    return

            # ── Price filter ──
            if not _is_price_allowed(state, slot.side,
                                     get_entry_fn=self._get_position_entry):
                slot.paused = True
                slot.pause_reason = "price_filter"
                slot.retry_at = time.time() + 30.0
                await self._broadcast_progress(state)
                slot._restarting = False
                await self._schedule_restart(state, slot, delay=30.0)
                return

            slot.paused = False
            slot.pause_reason = None

            # Final status check
            if state.status != "active":
                return

            # Place new chase
            chase_id = await self._place_chase_for_slot(state, slot)
            if chase_id:
                slot.chase_id = chase_id
                slot.active = True
                slot.retry_count = 0
                slot.retry_at = 0
                # Reset refill count on successful restart
                state._fill_refill_count[slot.side] = 0
                await self._save_state(state)
                await self._broadcast_progress(state)
            else:
                # Failed — exponential backoff retry
                slot.retry_count += 1
                delay = _backoff_delay(slot.retry_count - 1)
                slot.retry_at = time.time() + delay
                logger.warning("Scalper %s: restart %s layer %d failed (attempt %d), retrying in %.0fs",
                               state.id, slot.side, slot.layer_idx, slot.retry_count, delay)
                await self._broadcast_progress(state)
                slot._restarting = False
                await self._schedule_restart(state, slot, delay=delay)
                return

        finally:
            slot._restarting = False

    async def _schedule_restart(self, state: ScalperState, slot: ScalperSlot,
                                 delay: float, is_fill: bool = False) -> None:
        """Schedule a delayed restart for a slot."""
        timer_key = f"{state.id}:{slot.side}:{slot.layer_idx}"

        # Cancel any existing timer for this slot
        existing = self._slot_tasks.pop(timer_key, None)
        if existing and not existing.done():
            existing.cancel()

        async def _delayed_restart():
            await asyncio.sleep(delay)
            self._slot_tasks.pop(timer_key, None)
            slot.pause_reason = None
            if state.status == "active":
                await self._restart_slot(state, slot, is_fill_restart=is_fill)

        task = asyncio.ensure_future(_delayed_restart())
        self._slot_tasks[timer_key] = task

    # ── Events ──

    async def _publish_event(self, event_type: str, state: ScalperState, **extra) -> None:
        """Publish scalper event to Redis using typed event DTOs."""
        if not self._redis:
            return

        if event_type == EventType.SCALPER_FILLED:
            payload = ScalperFilledEvent(
                scalper_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                side=extra.get("side", ""),
                layer_idx=extra.get("layerIdx", 0),
                fill_price=extra.get("fillPrice", 0),
                fill_qty=extra.get("fillQty", 0),
                fill_count=state.fill_count,
            ).to_dict()
        elif event_type == EventType.SCALPER_CANCELLED:
            payload = ScalperCancelledEvent(
                scalper_id=state.id,
                sub_account_id=state.sub_account_id,
                symbol=state.symbol,
                fill_count=state.fill_count,
            ).to_dict()
        else:
            # Generic event — use base payload
            payload = {
                "type": event_type, "scalperId": state.id,
                "subAccountId": state.sub_account_id,
                "symbol": state.symbol, "startSide": state.start_side,
                "status": state.status,
                "totalFillCount": state.fill_count,
                "timestamp": ts_ms(), **extra,
            }

        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish scalper event: %s", e)

    async def _broadcast_progress(self, state: ScalperState) -> None:
        """Broadcast scalper_progress with per-slot state using typed DTO."""
        if not self._redis:
            return

        def _map_slot(s: ScalperSlot) -> ScalperSlotInfo:
            return ScalperSlotInfo(
                layer_idx=s.layer_idx,
                offset_pct=s.offset_pct,
                qty=s.qty,
                active=bool(s.chase_id),
                paused=s.paused,
                retry_at=int(s.retry_at * 1000) if s.retry_at else None,
                retry_count=s.retry_count,
                pause_reason=s.pause_reason,
                fills=s.fills,
            )

        evt = ScalperProgressEvent(
            scalper_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            start_side=state.start_side,
            status=state.status,
            fill_count=state.fill_count,
            long_max_price=state.long_max_price,
            short_min_price=state.short_min_price,
            neutral_mode=state.neutral_mode,
            long_slots=[_map_slot(s) for s in state.long_slots],
            short_slots=[_map_slot(s) for s in state.short_slots],
            started_at=ts_s_to_ms(state.created_at),
        )
        try:
            await self._redis.publish(RedisKey.event_channel(EventType.SCALPER_PROGRESS), json.dumps(evt.to_dict()))
        except Exception as e:
            logger.error("Failed to publish scalper_progress: %s", e)

    # ── Persistence ──

    async def _save_state(self, state: ScalperState) -> None:
        """Persist state to Redis using ScalperRedisState DTO."""
        if not self._redis:
            return
        dto = ScalperRedisState(
            scalper_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            start_side=state.start_side,
            child_count=state.child_count,
            status=state.status,
            fill_count=state.fill_count,
            long_offset_pct=state.long_offset_pct,
            short_offset_pct=state.short_offset_pct,
            long_size_usd=state.long_size_usd,
            short_size_usd=state.short_size_usd,
            neutral_mode=state.neutral_mode,
            leverage=state.leverage,
            skew=state.skew,
            long_max_price=state.long_max_price,
            short_min_price=state.short_min_price,
            min_fill_spread_pct=state.min_fill_spread_pct,
            fill_decay_half_life_ms=state.fill_decay_half_life_ms,
            min_refill_delay_ms=state.min_refill_delay_ms,
            allow_loss=state.allow_loss,
            pin_long_to_entry=state.pin_long_to_entry,
            pin_short_to_entry=state.pin_short_to_entry,
            started_at=ts_s_to_ms(state.created_at),
            reduce_only_armed=state.reduce_only_armed,
        )
        data_json = json.dumps(dto.to_dict())
        try:
            await self._redis.set(RedisKey.scalper(state.id), data_json, ex=SCALPER_REDIS_TTL)
            acct_key = RedisKey.active_scalper(state.sub_account_id)
            await self._redis.hset(acct_key, state.id, data_json)
            await self._redis.expire(acct_key, SCALPER_REDIS_TTL)
        except Exception as e:
            logger.error("Failed to save scalper state: %s", e)

    @property
    def active_count(self) -> int:
        return len(self._active)

    # ── Resume from Redis ──

    async def resume_from_redis(self) -> int:
        """Resume active scalpers from Redis on startup/reconnect.

        Scans pms:scalper:* keys, reconstructs ScalperState, re-subscribes
        to market data, and re-creates child chases for all slots.

        Returns count of resumed scalpers.
        """
        if not self._redis:
            return 0

        resumed = 0
        try:
            keys = await self._redis.keys("pms:scalper:*")
        except Exception as e:
            logger.error("Scalper resume: failed to scan Redis keys: %s", e)
            return 0

        for key in keys:
            try:
                raw = await self._redis.get(key)
                if not raw:
                    continue
                data = json.loads(raw)

                scalper_id = data.get("scalperId", "")
                if not scalper_id:
                    continue

                # Skip if already active
                if scalper_id in self._active:
                    continue

                # Skip non-active
                status = data.get("status", "").lower()
                if status not in ("active",):
                    await self._redis.delete(key)
                    continue

                # Reconstruct ScalperState
                start_side = data.get("startSide", "LONG")
                child_count = int(data.get("childCount", 1))
                long_offset = float(data.get("longOffsetPct", 0.3))
                short_offset = float(data.get("shortOffsetPct", 0.3))
                long_size_usd = float(data.get("longSizeUsd", 0))
                short_size_usd = float(data.get("shortSizeUsd", 0))
                symbol = data.get("symbol", "")
                leverage = int(data.get("leverage", 1))

                state = ScalperState(
                    id=scalper_id,
                    sub_account_id=data.get("subAccountId", ""),
                    symbol=symbol,
                    start_side=start_side,
                    leverage=leverage,
                    child_count=child_count,
                    skew=int(data.get("skew", 0)),
                    long_offset_pct=long_offset,
                    short_offset_pct=short_offset,
                    long_size_usd=long_size_usd,
                    short_size_usd=short_size_usd,
                    neutral_mode=bool(data.get("neutralMode", False)),
                    min_fill_spread_pct=float(data.get("minFillSpreadPct", 0)),
                    fill_decay_half_life_ms=float(data.get("fillDecayHalfLifeMs", 30000)),
                    min_refill_delay_ms=float(data.get("minRefillDelayMs", 0)),
                    allow_loss=data.get("allowLoss", True) not in (False, "false"),
                    fill_count=int(data.get("totalFillCount", 0)),
                    reduce_only_armed=bool(data.get("reduceOnlyArmed", False)),
                    pin_long_to_entry=bool(data.get("pinLongToEntry", False)),
                    pin_short_to_entry=bool(data.get("pinShortToEntry", False)),
                    created_at=data.get("startedAt", 0) / 1000.0 if data.get("startedAt") else time.time(),
                )

                # Subscribe to market data
                if self._md:
                    self._md.subscribe(symbol, self._make_price_handler(scalper_id))

                # Wait for L1 price seed
                price = 0
                for attempt in range(5):
                    await asyncio.sleep(0.4)
                    l1 = self._md.get_l1(symbol) if self._md else None
                    if l1 and l1.get("mid", 0) > 0:
                        price = l1["mid"]
                        break

                if not price:
                    logger.error("Scalper resume %s: cannot get price for %s — skipping", scalper_id, symbol)
                    handler = self._price_handlers.pop(scalper_id, None)
                    if handler and self._md:
                        self._md.unsubscribe(symbol, handler)
                    continue

                state.last_known_price = price
                self._active[scalper_id] = state

                # Re-create child chases for opening leg
                opening_side = _to_exchange_side(start_side)
                opening_offset = long_offset if start_side == "LONG" else short_offset
                opening_size_usd = long_size_usd if start_side == "LONG" else short_size_usd
                offsets = _generate_layer_offsets(opening_offset, child_count)
                weights = _generate_skew_weights(child_count, state.skew)
                qtys = [(opening_size_usd * w) / price for w in weights]

                opening_slots = await self._start_leg(state, opening_side, offsets, qtys,
                                                      reduce_only=False)
                if opening_side == "BUY":
                    state.long_slots = opening_slots
                else:
                    state.short_slots = opening_slots

                # Neutral mode: start closing leg too
                if state.neutral_mode:
                    other_side = "SELL" if opening_side == "BUY" else "BUY"
                    other_offset = short_offset if start_side == "LONG" else long_offset
                    other_size_usd = short_size_usd if start_side == "LONG" else long_size_usd
                    other_offsets = _generate_layer_offsets(other_offset, child_count)
                    other_qtys = [(other_size_usd * w) / price for w in weights]
                    other_slots = await self._start_leg(state, other_side, other_offsets, other_qtys,
                                                        reduce_only=False)
                    if other_side == "BUY":
                        state.long_slots = other_slots
                    else:
                        state.short_slots = other_slots

                # Schedule restart for any failed slots
                for slot in state.long_slots + state.short_slots:
                    if not slot.chase_id and slot.qty > 0:
                        await self._schedule_restart(state, slot, delay=2.0)

                resumed += 1
                logger.info("Scalper resumed: %s %s %s (child_count=%d)", scalper_id, symbol, start_side, child_count)

            except Exception as e:
                logger.error("Scalper resume: failed to restore %s: %s", key, e)

        if resumed:
            logger.warning("Scalper engine: resumed %d active scalper(s) from Redis", resumed)
        return resumed


def _parse_opt_float(val) -> Optional[float]:
    """Parse optional float. Returns None if falsy or invalid."""
    if val is None or val == "" or val == "null":
        return None
    try:
        v = float(val)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None
