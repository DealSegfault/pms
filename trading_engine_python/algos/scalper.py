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
    ScalperRuntimeSnapshotStreamEvent,
)
from contracts.state import ScalperRedisState, ScalperRuntimeSnapshot, ScalperSlotSnapshot

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
    offset_ticks: int = 0                # Fixed tick distance used by child chase
    reduce_only: bool = False
    chase_id: Optional[str] = None
    active: bool = False
    paused: bool = False
    pause_reason: Optional[str] = None
    retry_at: float = 0.0
    retry_count: int = 0
    fills: int = 0
    _restarting: bool = False
    _restart_pending: bool = False
    _start_pending: bool = False


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
    checkpoint_seq: int = 0
    resume_status: str = "LIVE"


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


def _offset_price(reference_price: float, side: str, offset_pct: float) -> float:
    side_upper = str(side or "").upper()
    if side_upper in ("BUY", "LONG"):
        return reference_price * (1 - offset_pct / 100.0)
    return reference_price * (1 + offset_pct / 100.0)


def _price_to_offset_pct(reference_price: float, side: str, price: float) -> float:
    if reference_price <= 0:
        return 0.0
    side_upper = str(side or "").upper()
    if side_upper in ("BUY", "LONG"):
        return max(0.0, (1 - (price / reference_price)) * 100.0)
    return max(0.0, ((price / reference_price) - 1) * 100.0)


def _truncate_to_tick(price: float, tick_size: float) -> float:
    if tick_size <= 0:
        return price
    steps = math.floor((price / tick_size) + 1e-12)
    return max(tick_size, steps * tick_size)


def _enforce_tick_spaced_offsets(
    reference_price: float,
    side: str,
    offsets: List[float],
    tick_size: float,
) -> List[float]:
    """Expand dense percentage offsets until each layer lands on a unique tick.

    Small-cap symbols like FUNUSDT can have a coarse tick relative to price, so
    several nearby percentage offsets collapse into the same rounded limit price.
    This widens later layers just enough to preserve one-tick spacing.
    """
    if reference_price <= 0 or tick_size <= 0 or len(offsets) <= 1:
        return list(offsets)

    side_upper = str(side or "").upper()
    adjusted: List[float] = []
    prev_price: Optional[float] = None

    for offset in offsets:
        rounded_price = _truncate_to_tick(_offset_price(reference_price, side_upper, offset), tick_size)
        if prev_price is not None:
            if side_upper in ("BUY", "LONG"):
                max_allowed = max(tick_size, prev_price - tick_size)
                if rounded_price > max_allowed:
                    rounded_price = max_allowed
            else:
                min_allowed = prev_price + tick_size
                if rounded_price < min_allowed:
                    rounded_price = min_allowed
                rounded_price = _truncate_to_tick(rounded_price, tick_size)

        adjusted_offset = max(offset, _price_to_offset_pct(reference_price, side_upper, rounded_price))
        adjusted.append(adjusted_offset)
        prev_price = rounded_price

    return adjusted


def _price_to_tick_steps(reference_price: float, side: str, price: float, tick_size: float) -> int:
    if reference_price <= 0 or tick_size <= 0:
        return 0
    side_upper = str(side or "").upper()
    if side_upper in ("BUY", "LONG"):
        delta = max(0.0, reference_price - price)
    else:
        delta = max(0.0, price - reference_price)
    return max(0, int(round(delta / tick_size)))


def _tick_steps_for_offsets(
    reference_price: float,
    side: str,
    offsets: List[float],
    tick_size: float,
) -> List[int]:
    if reference_price <= 0 or tick_size <= 0:
        return [0 for _ in offsets]

    steps: List[int] = []
    prev = -1
    side_upper = str(side or "").upper()
    for offset in offsets:
        rounded_price = _truncate_to_tick(_offset_price(reference_price, side_upper, offset), tick_size)
        tick_steps = _price_to_tick_steps(reference_price, side_upper, rounded_price, tick_size)
        if offset > 0:
            tick_steps = max(1, tick_steps)
        if tick_steps <= prev:
            tick_steps = prev + 1
        steps.append(tick_steps)
        prev = tick_steps
    return steps


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


def _is_active_pin_allowed(
    state: ScalperState,
    leg_side: str,
    price: float,
    get_entry_fn=None,
) -> bool:
    """Continuous pin-to-entry guard for already-active child chases.

    This intentionally applies only when the explicit pin flags are enabled.
    It does not extend the legacy allowLoss=false fallback to active repricing.
    """
    if price <= 0:
        return True
    if leg_side == "BUY" and not state.pin_long_to_entry:
        return True
    if leg_side == "SELL" and not state.pin_short_to_entry:
        return True

    effective_long_max = state.long_max_price
    effective_short_min = state.short_min_price
    long_entry = None
    short_entry = None
    if get_entry_fn:
        long_entry = get_entry_fn(state, "LONG")
        short_entry = get_entry_fn(state, "SHORT")

    if state.pin_long_to_entry:
        if short_entry and short_entry > 0:
            effective_long_max = min(effective_long_max, short_entry) if effective_long_max else short_entry
        if long_entry and long_entry > 0:
            effective_long_max = min(effective_long_max, long_entry) if effective_long_max else long_entry

    if state.pin_short_to_entry:
        if long_entry and long_entry > 0:
            effective_short_min = max(effective_short_min, long_entry) if effective_short_min else long_entry
        if short_entry and short_entry > 0:
            effective_short_min = max(effective_short_min, short_entry) if effective_short_min else short_entry

    if leg_side == "BUY" and effective_long_max and price > effective_long_max:
        return False
    if leg_side == "SELL" and effective_short_min and price < effective_short_min:
        return False
    return True


# Side normalization delegated to contracts.common
_to_exchange_side = normalize_side


def _parse_optional_bool(value: object, default: bool) -> bool:
    """Parse permissive bool payloads from JS and Redis snapshots."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "on"):
        return True
    if text in ("false", "0", "no", "off", ""):
        return False
    return default


def _resolve_allow_loss(payload: dict, neutral_mode: bool) -> bool:
    """
    Resolve allowLoss with mode-aware defaults.

    - Explicit payload value always wins.
    - Omitted allowLoss defaults to True for regular LONG/SHORT scalper.
    - Omitted allowLoss defaults to False for neutral mode.
    """
    if "allowLoss" in payload:
        return _parse_optional_bool(payload.get("allowLoss"), default=False)
    return False if neutral_mode else True


# ── Scalper Engine ─────────────────────────────────────────────


class ScalperEngine:
    """Manages scalper instances — dual-leg layered order grid."""

    def __init__(
        self,
        order_manager: Any,
        market_data: Any,
        chase_engine: Any,
        redis_client: Any = None,
        runtime_bus: Any = None,
        db: Any = None,
    ):
        self._om = order_manager
        self._md = market_data
        self._chase = chase_engine
        self._redis = redis_client
        self._runtime_bus = runtime_bus
        self._db = db
        self._active: Dict[str, ScalperState] = {}
        # Timer handles for slot retries: key = f"{scalperId}:{side}:{layerIdx}"
        self._slot_tasks: Dict[str, asyncio.Task] = {}
        self._bg_tasks: Dict[str, set[asyncio.Task]] = {}
        self._price_handlers: Dict[str, Callable] = {}  # scalper_id → L1 handler ref

    def _tick_size_for_symbol(self, symbol: str) -> float:
        symbol_info = getattr(self._om, "_symbol_info", None)
        if not symbol_info or not hasattr(symbol_info, "get"):
            return 0.0
        try:
            spec = symbol_info.get(symbol)
            return float(getattr(spec, "tick_size", 0.0) or 0.0)
        except Exception:
            return 0.0

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
        allow_loss = _resolve_allow_loss(params, neutral_mode)

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
                                logger.debug("Pre-warmed L1 for %s from bookTicker: bid=%.6f ask=%.6f", params["symbol"], bid, ask)
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
            allow_loss=allow_loss,
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
        tick_size = self._tick_size_for_symbol(state.symbol)
        opening_reference_price = (
            l1["bid"] if opening_side == "BUY" else l1["ask"]
        ) if l1 else price
        adjusted_offsets = _enforce_tick_spaced_offsets(
            opening_reference_price,
            opening_side,
            offsets,
            tick_size,
        )
        if adjusted_offsets != offsets:
            logger.info(
                "Scalper %s: widened %s offsets for %s tick spacing (%s -> %s ticks)",
                scalper_id,
                start_side,
                state.symbol,
                len({round(_truncate_to_tick(_offset_price(opening_reference_price, opening_side, offset), tick_size), 12) for offset in offsets}),
                len({round(_truncate_to_tick(_offset_price(opening_reference_price, opening_side, offset), tick_size), 12) for offset in adjusted_offsets}),
            )
            offsets = adjusted_offsets
        opening_tick_steps = _tick_steps_for_offsets(opening_reference_price, opening_side, offsets, tick_size)
        weights = _generate_skew_weights(child_count, skew)
        qtys = [(opening_size_usd * w) / price for w in weights]

        # Start opening leg
        opening_slots = await self._start_leg(state, opening_side, offsets, opening_tick_steps, qtys, reduce_only=False)
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
            other_reference_price = (
                l1["ask"] if other_side == "SELL" else l1["bid"]
            ) if l1 else price
            other_adjusted_offsets = _enforce_tick_spaced_offsets(
                other_reference_price,
                other_side,
                other_offsets,
                tick_size,
            )
            if other_adjusted_offsets != other_offsets:
                other_offsets = other_adjusted_offsets
            other_tick_steps = _tick_steps_for_offsets(other_reference_price, other_side, other_offsets, tick_size)
            other_qtys = [(other_size_usd * w) / price for w in weights]
            other_slots = await self._start_leg(state, other_side, other_offsets, other_tick_steps, other_qtys, reduce_only=False)
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

        await self._publish_runtime_checkpoint(state, "START")
        await self._start_heartbeat(state)
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
        state.resume_status = "STOPPED"

        await self._publish_runtime_checkpoint(
            state,
            "STOP",
            status_override="CANCELLED",
            resume_status="STOPPED",
            save_hot_snapshot=False,
            update_active_hash=False,
        )

        # Clear all pending retry tasks and await their termination
        # to prevent in-flight restarts from spawning orphan chases
        keys_to_cancel = [k for k in self._slot_tasks if k.startswith(f"{scalper_id}:")]
        tasks_to_await = []
        for key in keys_to_cancel:
            task = self._slot_tasks.pop(key, None)
            if task and not task.done():
                task.cancel()
                tasks_to_await.append(task)
        if tasks_to_await:
            await asyncio.gather(*tasks_to_await, return_exceptions=True)

        bg_tasks = list(self._bg_tasks.pop(scalper_id, set()))
        for task in bg_tasks:
            if not task.done():
                task.cancel()
        if bg_tasks:
            await asyncio.gather(*bg_tasks, return_exceptions=True)

        # Clean up Redis state BEFORE cancelling child chases,
        # because cancel_chase → cancel_order triggers feed events
        # that cause the frontend to refetch pms:active_scalper.
        self._active.pop(scalper_id, None)

        # Unsubscribe the scalper's own L1 price handler
        handler = self._price_handlers.pop(scalper_id, None)
        if handler and self._md and hasattr(self._md, "unsubscribe"):
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
                        close_result = await self._om.close_virtual_position(
                            position=pos,
                            requested_qty=pos.quantity,
                            origin="SCALPER",
                            parent_id=scalper_id,
                            order_role="FLATTEN",
                            strategy_session_id=scalper_id,
                            root_strategy_session_id=scalper_id,
                            cleanup_if_unexecutable=True,
                        )
                        if close_result.get("placed") or close_result.get("cleaned_up"):
                            logger.info("Scalper %s: closed position %s %s", scalper_id, pos.symbol, pos.side)
                        else:
                            logger.warning(
                                "Scalper %s: close skipped for %s %s: %s",
                                scalper_id, pos.symbol, pos.side, close_result.get("reason", ""),
                            )
            except Exception as e:
                logger.error("Scalper %s: close positions failed: %s", scalper_id, e)

        return True

    async def shutdown(self) -> None:
        """Persist restartable checkpoints, cancel child chases, and stop background work."""
        active_ids = list(self._active.keys())
        for scalper_id in active_ids:
            state = self._active.get(scalper_id)
            if not state:
                continue
            try:
                await self._prepare_restartable_shutdown(state)
            except Exception as e:
                logger.warning("Scalper %s: shutdown prep failed: %s", scalper_id, e)

        leftover_tasks = []
        for scalper_id, tasks in list(self._bg_tasks.items()):
            self._bg_tasks.pop(scalper_id, None)
            for task in tasks:
                if not task.done():
                    task.cancel()
                leftover_tasks.append(task)
        if leftover_tasks:
            await asyncio.gather(*leftover_tasks, return_exceptions=True)

    async def _prepare_restartable_shutdown(self, state: ScalperState) -> None:
        if state.status != "active":
            return

        await self._publish_runtime_checkpoint(
            state,
            "SHUTDOWN_PREP",
            status_override="PAUSED_RESTARTABLE",
            resume_status="RESTARTABLE",
            update_active_hash=False,
        )

        state.status = "stopped"
        state.resume_status = "RESTARTABLE"

        keys_to_cancel = [k for k in self._slot_tasks if k.startswith(f"{state.id}:")]
        tasks_to_await = []
        for key in keys_to_cancel:
            task = self._slot_tasks.pop(key, None)
            if task and not task.done():
                task.cancel()
                tasks_to_await.append(task)
        if tasks_to_await:
            await asyncio.gather(*tasks_to_await, return_exceptions=True)

        bg_tasks = list(self._bg_tasks.pop(state.id, set()))
        for task in bg_tasks:
            if not task.done():
                task.cancel()
        if bg_tasks:
            await asyncio.gather(*bg_tasks, return_exceptions=True)

        self._active.pop(state.id, None)

        handler = self._price_handlers.pop(state.id, None)
        if handler and self._md and hasattr(self._md, "unsubscribe"):
            self._md.unsubscribe(state.symbol, handler)

        if self._redis:
            try:
                await self._redis.hdel(RedisKey.active_scalper(state.sub_account_id), state.id)
            except Exception:
                pass

        for slot in state.long_slots + state.short_slots:
            if not slot.chase_id:
                continue
            try:
                await self._chase.cancel_chase(slot.chase_id)
            except Exception as e:
                logger.warning("Scalper %s: shutdown child cancel failed for %s: %s", state.id, slot.chase_id, e)

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

    def _has_active_pin_guard(self, state: ScalperState, leg_side: str) -> bool:
        """Whether this leg should enforce dynamic pin-to-entry while already active."""
        return (
            (leg_side == "BUY" and state.pin_long_to_entry)
            or (leg_side == "SELL" and state.pin_short_to_entry)
        )

    def _make_active_pin_guard(self, state: ScalperState, leg_side: str) -> Callable[[float], bool]:
        """Build a runtime-only price guard callback for ChaseEngine."""
        return lambda market_price, _s=state, _side=leg_side: _is_active_pin_allowed(
            _s, _side, market_price, get_entry_fn=self._get_position_entry
        )

    def _resolve_child_order_role(self, state: ScalperState, slot: ScalperSlot) -> str:
        if state.neutral_mode:
            return "HEDGE"
        if slot.reduce_only:
            return "UNWIND"
        return "ADD"

    # ── Leg Management ──

    async def _start_leg(
        self,
        state: ScalperState,
        side: str,
        offsets: List[float],
        offset_ticks: List[int],
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
                layer_idx=i,
                side=side,
                qty=qty,
                offset_pct=offset,
                offset_ticks=int(offset_ticks[i]) if i < len(offset_ticks) else 0,
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
                "stalkOffsetTicks": slot.offset_ticks,
                "stalkMode": "maintain",
                "maxDistancePct": 0,
                "reduceOnly": slot.reduce_only,
                "orderRole": self._resolve_child_order_role(state, slot),
                "parentScalperId": state.id,
                "onFill": lambda fp, fq, _s=state, _sl=slot: self._on_child_fill(_s, _sl, fp, fq),
                "onCancel": lambda reason, _s=state, _sl=slot: self._on_child_cancel(_s, _sl, reason),
            })
            if self._has_active_pin_guard(state, slot.side):
                batch_params[-1]["priceGuard"] = self._make_active_pin_guard(state, slot.side)
            slot._start_pending = True
            batch_slot_indices.append(i)

        # 2. Batch start all chases
        if batch_params:
            try:
                chase_ids = await self._chase.start_chase_batch(batch_params)
                for j, chase_id in enumerate(chase_ids):
                    slot_idx = batch_slot_indices[j]
                    slot = slots[slot_idx]
                    if chase_id and slot._start_pending:
                        slot.chase_id = chase_id
                        slot.active = True
                    slot._start_pending = False
            except Exception as e:
                logger.error("Scalper %s: batch start_leg failed: %s — falling back to sequential", state.id, e)
                # Fallback: start individually
                for j, params in enumerate(batch_params):
                    slot_idx = batch_slot_indices[j]
                    slot = slots[slot_idx]
                    if not slot._start_pending:
                        continue
                    chase_id = await self._place_chase_for_slot(state, slot)
                    if chase_id and slot._start_pending:
                        slot.chase_id = chase_id
                        slot.active = True
                    slot._start_pending = False

        return slots

    async def _place_chase_for_slot(
        self,
        state: ScalperState,
        slot: ScalperSlot,
        quantity_override: Optional[float] = None,
    ) -> Optional[str]:
        """Place a chase order for a single slot. Returns chase ID or None."""
        if state.status != "active":
            return None
        try:
            quantity = float(quantity_override if quantity_override is not None else slot.qty)
            chase_params = {
                "subAccountId": state.sub_account_id,
                "symbol": state.symbol,
                "side": slot.side,
                "quantity": quantity,
                "leverage": state.leverage,
                "stalkOffsetPct": slot.offset_pct,
                "stalkOffsetTicks": slot.offset_ticks,
                "stalkMode": "maintain",
                "maxDistancePct": 0,     # Scalper manages its own lifecycle
                "reduceOnly": slot.reduce_only,
                "orderRole": self._resolve_child_order_role(state, slot),
                "parentScalperId": state.id,
                # Wire fill/cancel callbacks back to this scalper
                "onFill": lambda fp, fq, _s=state, _sl=slot: self._on_child_fill(_s, _sl, fp, fq),
                "onCancel": lambda reason, _s=state, _sl=slot: self._on_child_cancel(_s, _sl, reason),
            }
            if self._has_active_pin_guard(state, slot.side):
                chase_params["priceGuard"] = self._make_active_pin_guard(state, slot.side)
            chase_id = await self._chase.start_chase(chase_params)
            return chase_id
        except Exception as e:
            logger.error("Scalper %s: failed to start chase for %s layer %d: %s",
                         state.id, slot.side, slot.layer_idx, e)
            return None

    # ── Child Callbacks ──

    async def _on_child_fill(self, state: ScalperState, slot: ScalperSlot,
                              fill_price: float, fill_qty: float) -> None:
        """Called when a child chase fills.

        Split into fast path (bookkeeping, awaited by chase ~1ms) and slow path
        (arm + restart, supervised fire-and-forget ~50-200ms).
        This keeps the WS reader unblocked during REST order placement.
        """
        if state.status != "active":
            return

        # ── Fast path: bookkeeping (must complete before chase cleanup) ──
        slot._start_pending = False
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

        # Publish fill event (fast — Redis publish ~1ms)
        await self._publish_event("scalper_filled", state,
                                   side=slot.side, layerIdx=slot.layer_idx,
                                   fillPrice=fill_price, fillQty=fill_qty)
        await self._publish_runtime_checkpoint(state, "FILL")

        # ── Slow path: arm + restart (fire-and-forget with error logging) ──
        # Launched as a supervised task so the WS reader isn't blocked
        # during REST order placement (50-200ms).
        async def _restart_after_fill():
            try:
                # Normal mode: first fill on opening leg → arm reduce-only (closing) leg
                if not state.neutral_mode and is_opening:
                    if not state.reduce_only_armed:
                        await self._arm_reduce_only_leg(state)
                    else:
                        await self._reactivate_reduce_only_leg(state)

                # Re-arm this slot with fill spread/burst guards
                await self._restart_slot(state, slot, is_fill_restart=True)
            except Exception as e:
                logger.error("Scalper %s: restart after %s layer %d fill failed: %s",
                             state.id, slot.side, slot.layer_idx, e)

        self._track_task(state.id, asyncio.create_task(_restart_after_fill()))

    async def _on_child_cancel(self, state: ScalperState, slot: ScalperSlot, reason: str) -> None:
        """Called when a child chase is cancelled externally."""
        if state.status != "active":
            return

        slot._start_pending = False
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

        # For reduce-only slots with terminal rejection, check if position still exists
        # Prevents infinite 30s retry loop when position is already gone/dust
        if slot.reduce_only and is_terminal:
            try:
                pos_side = "LONG" if slot.side == "SELL" else "SHORT"
                actual_pos = self._om._risk.position_book.find_position(
                    state.sub_account_id, state.symbol, pos_side
                )
                if not actual_pos or actual_pos.quantity <= 0:
                    logger.info("Scalper %s: %s reduce-only slot disabled — no position left",
                                state.id, slot.side)
                    slot.paused = True
                    slot.pause_reason = "no_position"
                    await self._broadcast_progress(state)
                    return
            except Exception as e:
                logger.debug("Scalper %s: position check failed: %s", state.id, e)

        delay = 30.0 if is_terminal else 2.0
        logger.info("Scalper %s: %s layer %d auto-cancelled (%s), restarting in %.0fs",
                     state.id, slot.side, slot.layer_idx, reason, delay)
        await self._schedule_restart(state, slot, delay=delay)

    # ── Event-Driven Methods (used by chase.on_fill_event instead of callbacks) ──

    async def on_chase_fill_event(
        self, scalper_id: str, chase_id: str, fill_price: float, fill_qty: float
    ) -> bool:
        """Handle chase fill via event stream (replaces lambda callback).

        Called by ChaseEngine.on_fill_event when a chase-owned order fills.
        Looks up the scalper and matching slot, then delegates to _on_child_fill.
        """
        state = self._active.get(scalper_id)
        if not state:
            logger.debug("ScalperEngine: scalper %s not active for fill event", scalper_id)
            return False

        slot = self._find_slot_by_chase(state, chase_id)
        if not slot:
            logger.debug("ScalperEngine: no slot found for chase %s in scalper %s",
                         chase_id, scalper_id)
            return False

        await self._on_child_fill(state, slot, fill_price, fill_qty)
        return True

    async def on_chase_cancel_event(
        self, scalper_id: str, chase_id: str, reason: str
    ) -> bool:
        """Handle chase cancel via event stream (replaces lambda callback).

        Called by ChaseEngine.on_cancel_event when a chase-owned order is cancelled.
        """
        state = self._active.get(scalper_id)
        if not state:
            logger.debug("ScalperEngine: scalper %s not active for cancel event", scalper_id)
            return False

        slot = self._find_slot_by_chase(state, chase_id)
        if not slot:
            logger.debug("ScalperEngine: no slot found for chase %s in scalper %s (may already be cleaned up)",
                         chase_id, scalper_id)
            return False

        await self._on_child_cancel(state, slot, reason)
        return True

    def _find_slot_by_chase(self, state: ScalperState, chase_id: str) -> Optional[ScalperSlot]:
        """Find the slot that owns a specific chase ID."""
        for slot in state.long_slots + state.short_slots:
            if slot.chase_id == chase_id:
                return slot
        return None

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
        l1 = self._md.get_l1(state.symbol) if self._md else None

        offsets = _generate_layer_offsets(ro_offset, state.child_count)
        tick_size = self._tick_size_for_symbol(state.symbol)
        ro_reference_price = (
            l1["ask"] if ro_side == "SELL" else l1["bid"]
        ) if l1 else price
        offsets = _enforce_tick_spaced_offsets(
            ro_reference_price,
            ro_side,
            offsets,
            tick_size,
        )
        ro_tick_steps = _tick_steps_for_offsets(ro_reference_price, ro_side, offsets, tick_size)
        weights = _generate_skew_weights(state.child_count, state.skew)
        qtys = [(ro_size_usd * w) / price for w in weights]

        logger.debug("Scalper %s: arming reduce-only %s leg (first opening fill)", state.id, ro_side)
        try:
            slots = await self._start_leg(state, ro_side, offsets, ro_tick_steps, qtys, reduce_only=True)
        except Exception:
            state.reduce_only_armed = False  # Reset — allow next fill to retry
            raise

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

        await self._publish_runtime_checkpoint(state, "RESTART")
        await self._broadcast_progress(state)

    async def _reactivate_reduce_only_leg(self, state: ScalperState) -> None:
        """Re-arm any unwind slots that were parked only because the position went flat."""
        if state.status != "active" or state.neutral_mode or not state.reduce_only_armed:
            return

        ro_slots = state.short_slots if state.start_side == "LONG" else state.long_slots
        woke = 0
        for slot in ro_slots:
            if not slot.reduce_only:
                continue
            if slot.active or slot.chase_id or slot._restarting or slot._start_pending:
                continue
            if slot.pause_reason != "no_position":
                continue

            slot.paused = False
            slot.pause_reason = None
            slot.retry_at = 0
            await self._restart_slot(state, slot, is_fill_restart=False)
            woke += 1

        if woke:
            await self._publish_runtime_checkpoint(state, "RESTART")
            logger.debug("Scalper %s: reactivated %d reduce-only slot(s) after opening fill",
                        state.id, woke)

    # ── Slot Restart Logic ──

    async def _restart_slot(self, state: ScalperState, slot: ScalperSlot,
                             is_fill_restart: bool = False) -> None:
        """Restart a slot with all the guards (spread, burst, backoff, price filter)."""
        if state.status != "active":
            return
        if slot._restarting:
            slot._restart_pending = True
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
                    await self._publish_runtime_checkpoint(state, "PAUSE")
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
                    await self._publish_runtime_checkpoint(state, "PAUSE")
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
                    await self._publish_runtime_checkpoint(state, "PAUSE")
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
                await self._publish_runtime_checkpoint(state, "PAUSE")
                slot._restarting = False
                await self._schedule_restart(state, slot, delay=30.0)
                return

            slot.paused = False
            slot.pause_reason = None

            # Final status check
            if state.status != "active":
                return

            place_qty = slot.qty

            # Clamp reduce-only qty to actual exchange position without ratcheting
            # the configured slot size downward across the life of the scalper.
            if slot.reduce_only:
                try:
                    pos_side = "LONG" if slot.side == "SELL" else "SHORT"
                    actual_pos = self._om._risk.position_book.find_position(
                        state.sub_account_id, state.symbol, pos_side
                    )
                    if not actual_pos or actual_pos.quantity <= 0:
                        slot.paused = True
                        slot.pause_reason = "no_position"
                        await self._broadcast_progress(state)
                        await self._publish_runtime_checkpoint(state, "PAUSE")
                        return
                    place_qty = min(slot.qty, actual_pos.quantity)
                    price = state.last_known_price or 0
                    if price > 0 and place_qty * price < MIN_NOTIONAL_USD:
                        # Binance accepts an exact reduce-only close even under the
                        # normal minimum notional threshold. Use the live position
                        # size for dust cleanup instead of abandoning unwind coverage.
                        place_qty = actual_pos.quantity
                        logger.info(
                            "Scalper %s: dust override for %s reduce-only slot %.6f → %.6f",
                            state.id, slot.side, slot.qty, place_qty,
                        )
                    elif place_qty < slot.qty:
                        logger.info(
                            "Scalper %s: clamping %s reduce-only qty %.6f → %.6f (actual position)",
                            state.id, slot.side, slot.qty, place_qty,
                        )
                except Exception as e:
                    logger.debug("Scalper %s: position clamp check failed: %s", state.id, e)

            # Place new chase
            slot._start_pending = True
            chase_id = await self._place_chase_for_slot(state, slot, quantity_override=place_qty)
            if chase_id and (state.status != "active" or state.id not in self._active):
                logger.warning(
                    "Scalper %s: slot restart completed after stop — cancelling orphan chase %s",
                    state.id, chase_id,
                )
                try:
                    await self._chase.cancel_chase(chase_id)
                except Exception as e:
                    logger.warning("Scalper %s: orphan chase cancel failed: %s", state.id, e)
                slot.chase_id = None
                slot.active = False
                slot.retry_at = 0
                slot._start_pending = False
                return
            if chase_id and not slot._start_pending:
                logger.debug("Scalper %s: %s layer %d start resolved during await",
                            state.id, slot.side, slot.layer_idx)
                return
            if chase_id:
                slot.chase_id = chase_id
                slot.active = True
                slot.retry_count = 0
                slot.retry_at = 0
                slot._start_pending = False
                # Reset refill count on successful restart
                state._fill_refill_count[slot.side] = 0
                await self._publish_runtime_checkpoint(state, "RESTART")
                await self._broadcast_progress(state)
            else:
                # Failed — exponential backoff retry
                slot._start_pending = False
                slot.retry_count += 1
                delay = _backoff_delay(slot.retry_count - 1)
                slot.retry_at = time.time() + delay
                logger.warning("Scalper %s: restart %s layer %d failed (attempt %d), retrying in %.0fs",
                               state.id, slot.side, slot.layer_idx, slot.retry_count, delay)
                await self._broadcast_progress(state)
                await self._publish_runtime_checkpoint(state, "PAUSE")
                slot._restarting = False
                await self._schedule_restart(state, slot, delay=delay)
                return

        finally:
            slot._restarting = False
            # Catchup: if another fill arrived while we were restarting,
            # process the queued restart now instead of silently dropping it
            if slot._restart_pending:
                slot._restart_pending = False
                if state.status == "active":
                    await self._restart_slot(state, slot, is_fill_restart=True)

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

        task = asyncio.create_task(_delayed_restart())
        self._slot_tasks[timer_key] = task
        self._track_task(state.id, task)

    def _track_task(self, scalper_id: str, task: asyncio.Task) -> None:
        """Track fire-and-forget tasks so cancel/shutdown can stop them deterministically."""
        tasks = self._bg_tasks.setdefault(scalper_id, set())
        tasks.add(task)

        def _cleanup(_task: asyncio.Task) -> None:
            tracked = self._bg_tasks.get(scalper_id)
            if not tracked:
                return
            tracked.discard(_task)
            if not tracked:
                self._bg_tasks.pop(scalper_id, None)

        task.add_done_callback(_cleanup)

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
                offset_ticks=s.offset_ticks,
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

    def _slot_snapshot(self, slot: ScalperSlot) -> ScalperSlotSnapshot:
        current_order_client_id = None
        if slot.chase_id and getattr(self._chase, "_active", None):
            chase_state = self._chase._active.get(slot.chase_id)
            if chase_state:
                current_order_client_id = getattr(chase_state, "current_order_id", None)
        return ScalperSlotSnapshot(
            layer_idx=slot.layer_idx,
            side=slot.side,
            qty=slot.qty,
            offset_pct=slot.offset_pct,
            offset_ticks=slot.offset_ticks,
            active=bool(slot.chase_id),
            paused=slot.paused,
            pause_reason=slot.pause_reason,
            retry_at=int(slot.retry_at * 1000) if slot.retry_at else None,
            retry_count=slot.retry_count,
            fills=slot.fills,
            reduce_only=slot.reduce_only,
            chase_id=slot.chase_id,
            current_order_client_id=current_order_client_id,
            restarting=slot._restarting,
            restart_pending=slot._restart_pending,
            start_pending=slot._start_pending,
        )

    def _slim_dto(self, state: ScalperState) -> ScalperRedisState:
        return ScalperRedisState(
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

    def _runtime_snapshot(
        self,
        state: ScalperState,
        checkpoint_reason: str,
        *,
        status_override: Optional[str] = None,
        resume_status: Optional[str] = None,
    ) -> ScalperRuntimeSnapshot:
        child_chase_ids = [slot.chase_id for slot in state.long_slots + state.short_slots if slot.chase_id]
        child_order_client_ids = []
        if getattr(self._chase, "_active", None):
            for chase_id in child_chase_ids:
                chase_state = self._chase._active.get(chase_id)
                if chase_state and getattr(chase_state, "current_order_id", None):
                    child_order_client_ids.append(chase_state.current_order_id)
        return ScalperRuntimeSnapshot(
            scalper_id=state.id,
            sub_account_id=state.sub_account_id,
            symbol=state.symbol,
            start_side=state.start_side,
            child_count=state.child_count,
            status=status_override or state.status.upper(),
            checkpoint_seq=state.checkpoint_seq,
            checkpoint_reason=checkpoint_reason,
            total_fill_count=state.fill_count,
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
            max_loss_per_close_bps=state.max_loss_per_close_bps,
            max_fills_per_minute=state.max_fills_per_minute,
            pnl_feedback_mode=state.pnl_feedback_mode,
            pin_long_to_entry=state.pin_long_to_entry,
            pin_short_to_entry=state.pin_short_to_entry,
            reduce_only_armed=state.reduce_only_armed,
            last_known_price=state.last_known_price,
            started_at=ts_s_to_ms(state.created_at),
            source_ts=ts_ms(),
            resume_status=resume_status or state.resume_status,
            last_fill_price={k: float(v) for k, v in state._last_fill_price.items()},
            last_fill_time={k: ts_s_to_ms(v) for k, v in state._last_fill_time.items()},
            recent_fill_times={k: [ts_s_to_ms(item) for item in values] for k, values in state._recent_fill_times.items()},
            fill_refill_count={k: int(v) for k, v in state._fill_refill_count.items()},
            child_chase_ids=child_chase_ids,
            child_order_client_ids=child_order_client_ids,
            long_slots=[self._slot_snapshot(slot) for slot in state.long_slots],
            short_slots=[self._slot_snapshot(slot) for slot in state.short_slots],
        )

    async def _publish_runtime_checkpoint(
        self,
        state: ScalperState,
        checkpoint_reason: str,
        *,
        status_override: Optional[str] = None,
        resume_status: Optional[str] = None,
        save_hot_snapshot: bool = True,
        update_active_hash: bool = True,
    ) -> None:
        state.checkpoint_seq += 1
        runtime = self._runtime_snapshot(
            state,
            checkpoint_reason,
            status_override=status_override,
            resume_status=resume_status,
        )
        runtime_json = json.dumps(runtime.to_dict())

        if self._redis and save_hot_snapshot:
            try:
                await self._redis.set(RedisKey.scalper(state.id), runtime_json, ex=SCALPER_REDIS_TTL)
            except Exception as e:
                logger.error("Failed to save scalper runtime snapshot: %s", e)

        if self._redis and update_active_hash:
            slim_json = json.dumps(self._slim_dto(state).to_dict())
            try:
                acct_key = RedisKey.active_scalper(state.sub_account_id)
                await self._redis.hset(acct_key, state.id, slim_json)
                await self._redis.expire(acct_key, SCALPER_REDIS_TTL)
            except Exception as e:
                logger.error("Failed to save active scalper snapshot: %s", e)

        if self._runtime_bus:
            try:
                await self._runtime_bus.publish(
                    "SCALPER_RUNTIME_SNAPSHOT",
                    ScalperRuntimeSnapshotStreamEvent(
                        strategy_session_id=state.id,
                        sub_account_id=state.sub_account_id,
                        checkpoint_seq=state.checkpoint_seq,
                        checkpoint_reason=checkpoint_reason,
                        status=status_override or state.status.upper(),
                        snapshot_json=runtime_json,
                        source_ts=runtime.source_ts,
                    ).to_stream_dict(),
                )
            except Exception as e:
                logger.error("Failed to publish scalper runtime checkpoint: %s", e)

    async def _start_heartbeat(self, state: ScalperState) -> None:
        async def _heartbeat_loop() -> None:
            try:
                while state.id in self._active and self._active.get(state.id) is state and state.status == "active":
                    await asyncio.sleep(5.0)
                    if state.id not in self._active or state.status != "active":
                        break
                    await self._publish_runtime_checkpoint(state, "HEARTBEAT")
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error("Scalper %s heartbeat failed: %s", state.id, e)

        self._track_task(state.id, asyncio.create_task(_heartbeat_loop()))

    async def _save_state(self, state: ScalperState) -> None:
        """Persist hot runtime snapshot + slim active snapshot."""
        await self._publish_runtime_checkpoint(state, "STATE_CHANGE")

    @property
    def active_count(self) -> int:
        return len(self._active)

    # ── Resume from Redis ──

    async def _resume_price(self, scalper_id: str, symbol: str) -> float:
        if self._md:
            self._md.subscribe(symbol, self._make_price_handler(scalper_id))
        price = 0.0
        for _ in range(5):
            await asyncio.sleep(0.4)
            l1 = self._md.get_l1(symbol) if self._md else None
            if l1 and l1.get("mid", 0) > 0:
                price = float(l1["mid"])
                break
        return price

    def _slot_from_payload(self, payload: dict) -> ScalperSlot:
        retry_at_ms = payload.get("retryAt")
        retry_at = (float(retry_at_ms) / 1000.0) if retry_at_ms else 0.0
        return ScalperSlot(
            layer_idx=int(payload.get("layerIdx", 0) or 0),
            side=str(payload.get("side", "") or ""),
            qty=float(payload.get("qty", 0) or 0),
            offset_pct=float(payload.get("offsetPct", 0) or 0),
            offset_ticks=int(payload.get("offsetTicks", 0) or 0),
            reduce_only=bool(payload.get("reduceOnly", False)),
            chase_id=payload.get("chaseId") or None,
            active=bool(payload.get("active", False)),
            paused=bool(payload.get("paused", False)),
            pause_reason=payload.get("pauseReason") or None,
            retry_at=retry_at,
            retry_count=int(payload.get("retryCount", 0) or 0),
            fills=int(payload.get("fills", 0) or 0),
            _restarting=bool(payload.get("restarting", False)),
            _restart_pending=bool(payload.get("restartPending", False)),
            _start_pending=bool(payload.get("startPending", False)),
        )

    def _state_from_runtime_snapshot(self, data: dict) -> ScalperState:
        neutral_mode = bool(data.get("neutralMode", False))
        allow_loss = _resolve_allow_loss(data, neutral_mode)
        return ScalperState(
            id=data.get("scalperId", ""),
            sub_account_id=data.get("subAccountId", ""),
            symbol=data.get("symbol", ""),
            start_side=data.get("startSide", "LONG"),
            leverage=int(data.get("leverage", 1) or 1),
            child_count=int(data.get("childCount", 1) or 1),
            skew=int(data.get("skew", 0) or 0),
            long_offset_pct=float(data.get("longOffsetPct", 0) or 0),
            short_offset_pct=float(data.get("shortOffsetPct", 0) or 0),
            long_size_usd=float(data.get("longSizeUsd", 0) or 0),
            short_size_usd=float(data.get("shortSizeUsd", 0) or 0),
            long_max_price=_parse_opt_float(data.get("longMaxPrice")),
            short_min_price=_parse_opt_float(data.get("shortMinPrice")),
            neutral_mode=neutral_mode,
            min_fill_spread_pct=float(data.get("minFillSpreadPct", 0) or 0),
            fill_decay_half_life_ms=float(data.get("fillDecayHalfLifeMs", 30000) or 30000),
            min_refill_delay_ms=float(data.get("minRefillDelayMs", 0) or 0),
            allow_loss=allow_loss,
            max_loss_per_close_bps=int(data.get("maxLossPerCloseBps", 0) or 0),
            max_fills_per_minute=int(data.get("maxFillsPerMinute", 0) or 0),
            pnl_feedback_mode=str(data.get("pnlFeedbackMode", "off") or "off"),
            long_slots=[self._slot_from_payload(slot) for slot in (data.get("longSlots") or [])],
            short_slots=[self._slot_from_payload(slot) for slot in (data.get("shortSlots") or [])],
            fill_count=int(data.get("totalFillCount", 0) or 0),
            status="active",
            created_at=(float(data.get("startedAt")) / 1000.0) if data.get("startedAt") else time.time(),
            reduce_only_armed=bool(data.get("reduceOnlyArmed", False)),
            last_known_price=float(data.get("lastKnownPrice", 0) or 0),
            pin_long_to_entry=bool(data.get("pinLongToEntry", False)),
            pin_short_to_entry=bool(data.get("pinShortToEntry", False)),
            _last_fill_price={k: float(v) for k, v in (data.get("lastFillPrice") or {}).items()},
            _last_fill_time={k: (float(v) / 1000.0) for k, v in (data.get("lastFillTime") or {}).items()},
            _recent_fill_times={k: [(float(item) / 1000.0) for item in values] for k, values in (data.get("recentFillTimes") or {}).items()},
            _fill_refill_count={k: int(v) for k, v in (data.get("fillRefillCount") or {}).items()},
            checkpoint_seq=int(data.get("checkpointSeq", 0) or 0),
            resume_status=str(data.get("resumeStatus", "RESTARTABLE") or "RESTARTABLE"),
        )

    async def _mark_resume_failed(self, strategy_session_id: str, reason: str) -> None:
        if not self._db:
            return
        try:
            await self._db.execute(
                "UPDATE algo_runtime_sessions SET status = ?, updated_at = datetime('now') WHERE strategy_session_id = ?",
                ("FAILED", strategy_session_id),
            )
            logger.error("Scalper resume failed for %s: %s", strategy_session_id, reason)
        except Exception:
            logger.error("Scalper resume failed for %s: %s", strategy_session_id, reason)

    async def _load_resume_snapshots(self) -> list[dict]:
        snapshots: dict[str, dict] = {}
        if self._redis:
            try:
                keys = await self._redis.keys("pms:scalper:*")
            except Exception as e:
                logger.error("Scalper resume: failed to scan Redis keys: %s", e)
                keys = []

            for key in keys:
                try:
                    raw = await self._redis.get(key)
                    if not raw:
                        continue
                    data = json.loads(raw)
                    scalper_id = data.get("scalperId")
                    if scalper_id:
                        snapshots[str(scalper_id)] = data
                except Exception as e:
                    logger.error("Scalper resume: failed to decode %s: %s", key, e)

        if self._db:
            rows = await self._db.fetch_all(
                """SELECT strategy_session_id, status
                   FROM algo_runtime_sessions
                   WHERE strategy_type = ? AND status IN (?, ?)""",
                ("SCALPER", "ACTIVE", "PAUSED_RESTARTABLE"),
            )
            for row in rows or []:
                session_id = row.get("strategy_session_id")
                if not session_id or session_id in snapshots:
                    continue
                checkpoint = await self._db.fetch_one(
                    """SELECT snapshot_json
                       FROM algo_runtime_checkpoints
                       WHERE strategy_session_id = ?
                       ORDER BY checkpoint_seq DESC
                       LIMIT 1""",
                    (session_id,),
                )
                if not checkpoint or not checkpoint.get("snapshot_json"):
                    await self._mark_resume_failed(session_id, "missing checkpoint snapshot")
                    continue
                try:
                    snapshots[session_id] = json.loads(checkpoint["snapshot_json"])
                except Exception:
                    await self._mark_resume_failed(session_id, "invalid checkpoint snapshot")
        return list(snapshots.values())

    async def _cancel_persisted_child_orders(self, data: dict) -> None:
        for client_order_id in data.get("childOrderClientIds") or []:
            if not client_order_id:
                continue
            try:
                await self._om.cancel_order(client_order_id)
            except Exception as e:
                logger.warning("Scalper resume: persisted child cancel failed for %s: %s", client_order_id, e)

    async def _restore_runtime_slots(self, state: ScalperState, data: dict) -> None:
        await self._cancel_persisted_child_orders(data)
        now = time.time()
        for slot in state.long_slots + state.short_slots:
            slot.chase_id = None
            slot.active = False
            slot._start_pending = False
            if slot.paused and slot.pause_reason == "no_position":
                continue
            if slot.retry_at and slot.retry_at > now:
                await self._schedule_restart(state, slot, delay=max(0.0, slot.retry_at - now))
                continue
            await self._restart_slot(state, slot, is_fill_restart=False)

    async def _resume_legacy_snapshot(self, data: dict) -> Optional[ScalperState]:
        start_side = data.get("startSide", "LONG")
        child_count = int(data.get("childCount", 1) or 1)
        long_offset = float(data.get("longOffsetPct", 0.3) or 0.3)
        short_offset = float(data.get("shortOffsetPct", 0.3) or 0.3)
        long_size_usd = float(data.get("longSizeUsd", 0) or 0)
        short_size_usd = float(data.get("shortSizeUsd", 0) or 0)
        symbol = data.get("symbol", "")
        leverage = int(data.get("leverage", 1) or 1)
        neutral_mode = bool(data.get("neutralMode", False))
        allow_loss = _resolve_allow_loss(data, neutral_mode)

        state = ScalperState(
            id=data.get("scalperId", ""),
            sub_account_id=data.get("subAccountId", ""),
            symbol=symbol,
            start_side=start_side,
            leverage=leverage,
            child_count=child_count,
            skew=int(data.get("skew", 0) or 0),
            long_offset_pct=long_offset,
            short_offset_pct=short_offset,
            long_size_usd=long_size_usd,
            short_size_usd=short_size_usd,
            neutral_mode=neutral_mode,
            min_fill_spread_pct=float(data.get("minFillSpreadPct", 0) or 0),
            fill_decay_half_life_ms=float(data.get("fillDecayHalfLifeMs", 30000) or 30000),
            min_refill_delay_ms=float(data.get("minRefillDelayMs", 0) or 0),
            allow_loss=allow_loss,
            fill_count=int(data.get("totalFillCount", 0) or 0),
            reduce_only_armed=bool(data.get("reduceOnlyArmed", False)),
            pin_long_to_entry=bool(data.get("pinLongToEntry", False)),
            pin_short_to_entry=bool(data.get("pinShortToEntry", False)),
            created_at=(float(data.get("startedAt")) / 1000.0) if data.get("startedAt") else time.time(),
            checkpoint_seq=int(data.get("checkpointSeq", 0) or 0),
            resume_status="RESTARTABLE",
        )

        price = await self._resume_price(state.id, symbol)
        if not price:
            handler = self._price_handlers.pop(state.id, None)
            if handler and self._md:
                self._md.unsubscribe(symbol, handler)
            return None

        state.last_known_price = price
        self._active[state.id] = state

        opening_side = _to_exchange_side(start_side)
        opening_offset = long_offset if start_side == "LONG" else short_offset
        opening_size_usd = long_size_usd if start_side == "LONG" else short_size_usd
        offsets = _generate_layer_offsets(opening_offset, child_count)
        tick_size = self._tick_size_for_symbol(state.symbol)
        l1 = self._md.get_l1(state.symbol) if self._md else None
        opening_reference_price = (
            l1["bid"] if opening_side == "BUY" else l1["ask"]
        ) if l1 else price
        offsets = _enforce_tick_spaced_offsets(
            opening_reference_price,
            opening_side,
            offsets,
            tick_size,
        )
        opening_tick_steps = _tick_steps_for_offsets(opening_reference_price, opening_side, offsets, tick_size)
        weights = _generate_skew_weights(child_count, state.skew)
        qtys = [(opening_size_usd * w) / price for w in weights]

        opening_slots = await self._start_leg(state, opening_side, offsets, opening_tick_steps, qtys, reduce_only=False)
        if opening_side == "BUY":
            state.long_slots = opening_slots
        else:
            state.short_slots = opening_slots

        if state.neutral_mode:
            other_side = "SELL" if opening_side == "BUY" else "BUY"
            other_offset = short_offset if start_side == "LONG" else long_offset
            other_size_usd = short_size_usd if start_side == "LONG" else long_size_usd
            other_offsets = _generate_layer_offsets(other_offset, child_count)
            other_reference_price = (
                l1["ask"] if other_side == "SELL" else l1["bid"]
            ) if l1 else price
            other_offsets = _enforce_tick_spaced_offsets(
                other_reference_price,
                other_side,
                other_offsets,
                tick_size,
            )
            other_tick_steps = _tick_steps_for_offsets(other_reference_price, other_side, other_offsets, tick_size)
            other_qtys = [(other_size_usd * w) / price for w in weights]
            other_slots = await self._start_leg(state, other_side, other_offsets, other_tick_steps, other_qtys, reduce_only=False)
            if other_side == "BUY":
                state.long_slots = other_slots
            else:
                state.short_slots = other_slots
        elif state.reduce_only_armed:
            ro_side = "SELL" if start_side == "LONG" else "BUY"
            ro_offset = short_offset if start_side == "LONG" else long_offset
            ro_size_usd = short_size_usd if start_side == "LONG" else long_size_usd
            ro_offsets = _generate_layer_offsets(ro_offset, child_count)
            ro_reference_price = (
                l1["ask"] if ro_side == "SELL" else l1["bid"]
            ) if l1 else price
            ro_offsets = _enforce_tick_spaced_offsets(
                ro_reference_price,
                ro_side,
                ro_offsets,
                tick_size,
            )
            ro_tick_steps = _tick_steps_for_offsets(ro_reference_price, ro_side, ro_offsets, tick_size)
            ro_qtys = [(ro_size_usd * w) / price for w in weights]
            ro_slots = await self._start_leg(state, ro_side, ro_offsets, ro_tick_steps, ro_qtys, reduce_only=True)
            if ro_side == "BUY":
                state.long_slots = ro_slots
            else:
                state.short_slots = ro_slots

        for slot in state.long_slots + state.short_slots:
            if not slot.chase_id and slot.qty > 0:
                await self._schedule_restart(state, slot, delay=2.0)
        return state

    async def resume_from_redis(self) -> int:
        """Resume scalpers from hot Redis snapshots, with DB checkpoint fallback."""
        snapshots = await self._load_resume_snapshots()
        resumed = 0

        for data in snapshots:
            scalper_id = str(data.get("scalperId", "") or "")
            symbol = str(data.get("symbol", "") or "")
            if not scalper_id or not symbol or scalper_id in self._active:
                continue

            status = str(data.get("status", "") or "").upper()
            if status not in ("ACTIVE", "PAUSED_RESTARTABLE", "ACTIVE".lower()):
                continue

            try:
                if data.get("longSlots") is not None or data.get("shortSlots") is not None:
                    state = self._state_from_runtime_snapshot(data)
                    price = await self._resume_price(state.id, state.symbol)
                    if not price and state.last_known_price <= 0:
                        await self._mark_resume_failed(state.id, f"cannot seed price for {state.symbol}")
                        handler = self._price_handlers.pop(state.id, None)
                        if handler and self._md:
                            self._md.unsubscribe(state.symbol, handler)
                        continue
                    state.last_known_price = price or state.last_known_price
                    self._active[state.id] = state
                    await self._restore_runtime_slots(state, data)
                else:
                    state = await self._resume_legacy_snapshot(data)
                    if not state:
                        await self._mark_resume_failed(scalper_id, f"cannot seed legacy price for {symbol}")
                        continue

                await self._publish_runtime_checkpoint(
                    state,
                    "RESUME",
                    status_override="ACTIVE",
                    resume_status="LIVE",
                )
                await self._start_heartbeat(state)
                await self._broadcast_progress(state)
                resumed += 1
                logger.info("Scalper resumed: %s %s %s (child_count=%d)", state.id, state.symbol, state.start_side, state.child_count)
            except Exception as e:
                await self._mark_resume_failed(scalper_id, str(e))
                logger.error("Scalper resume: failed to restore %s: %s", scalper_id, e)

        if resumed:
            logger.warning("Scalper engine: resumed %d active scalper(s) from checkpoint", resumed)
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
