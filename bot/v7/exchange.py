#!/usr/bin/env python3
"""
V7 EXCHANGE — Binance Futures order execution via ccxt async.

Latency optimizations:
- ccxt.async_support → native aiohttp (no thread pool overhead)
- Persistent aiohttp session reuse across requests
- uvloop (set in run.py) for faster event loop scheduling

Order strategy:
- LIMIT POST-ONLY (GTX) for entries → maker fills only
- Market orders for exits (TP, stop-loss, shutdown)

Execution truth:
- Only return FillResult when order status='closed' and filled>0
- Poll unfilled orders with timeout + auto-cancel
- Track open orders for cancel-on-shutdown
"""
import asyncio
import hashlib
import hmac
import logging
import math
import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import aiohttp
import ccxt.async_support as ccxt_async  # Native aiohttp — no thread overhead
import websockets

try:
    import orjson
except ImportError:
    orjson = None

logger = logging.getLogger(__name__)

_SCOPE_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _sanitize_scope(value: str) -> str:
    cleaned = _SCOPE_SANITIZE_RE.sub("-", str(value or "").strip().lower()).strip("-._")
    if len(cleaned) > 64:
        cleaned = cleaned[:64]
    return cleaned


def derive_account_scope(api_key: str, preferred_scope: str = "") -> str:
    """
    Stable account namespace for storage/routing.
    Priority:
      1) explicit preferred_scope (e.g. subaccount/user alias)
      2) deterministic hash of API key
      3) fallback static tag
    """
    manual = _sanitize_scope(preferred_scope)
    if manual:
        return manual
    key = str(api_key or "").strip()
    if not key:
        return "acct-unknown"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return f"acct-{digest}"


@dataclass
class SymbolInfo:
    """Exchange symbol metadata."""
    symbol: str           # e.g. "LA/USDT:USDT"
    raw: str              # e.g. "LAUSDT"
    min_qty: float        # Minimum order qty
    qty_step: float       # Lot step size
    price_precision: int  # Price decimal places
    price_step: float     # Tick size
    qty_precision: int    # Qty decimal places
    min_notional: float   # Minimum notional (usually $5)


@dataclass
class FillResult:
    """Result from a confirmed filled order."""
    order_id: str
    symbol: str
    side: str             # "buy" or "sell"
    qty: float            # Filled qty
    avg_price: float      # Average fill price
    cost: float           # Total cost (qty * price)
    fee: float            # Fee paid
    is_maker: bool        # True if filled as maker
    timestamp: float


class BinanceExecutor:
    """
    Async-safe Binance Futures executor — zero-timeout, fully reactive.

    Latency stack:
    - ccxt.async_support → native aiohttp (no thread pool)
    - No polling loops — GTX fills or cancels instantly
    - Market orders parse fill from response directly
    - uvloop (set in run.py) for faster event loop scheduling
    """

    def __init__(self, api_key: str, secret: str, testnet: bool = False, account_scope: str = ""):
        config = {
            'apiKey': api_key,
            'secret': secret,
            'options': {
                'defaultType': 'future',
                'adjustForTimeDifference': True,
                'fetchCurrencies': False,   # Skip SAPI /capital/config — needs Spot perms we don't have
                'fetchMarkets': ['linear'],  # Only fetch USDT-M futures, skip Spot + Coin-M
            },
            'enableRateLimit': False,  # We handle our own rate + speed is priority
            'timeout': 5000,           # 5s timeout on HTTP requests
        }
        if testnet:
            config['options']['testnet'] = True

        # Async ccxt: uses aiohttp natively — no thread pool overhead
        self.exchange = ccxt_async.binance(config)
        self.symbol_cache: Dict[str, SymbolInfo] = {}
        self._markets_loaded = False
        # Track open orders for shutdown cleanup
        self._open_orders: Dict[str, dict] = {}  # order_id -> {symbol, side, qty, ts}

        # ─── User data stream ────────────────────────────────────
        self._api_key = api_key
        self._api_secret = secret
        self._account_scope = derive_account_scope(api_key, preferred_scope=account_scope)
        self._testnet = testnet
        self._listen_key: Optional[str] = None
        self._user_stream_running = False
        self._user_stream_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        # Fill events: order_id -> Event (set when fill arrives via WS)
        self._fill_events: Dict[str, asyncio.Event] = {}
        self._fill_results: Dict[str, FillResult] = {}
        # Callback for external fill notification
        self.on_fill: Optional[Callable] = None
        # Fire-and-forget callback: (order_id, status, FillResult|None) -> None
        self.on_order_update: Optional[Callable] = None
        self._fapi_base = 'https://testnet.binancefuture.com' if testnet else 'https://fapi.binance.com'
        self._ws_base = 'wss://fstream.binance.com' if not testnet else 'wss://stream.binancefuture.com'

    @property
    def account_scope(self) -> str:
        return self._account_scope

    def get_api_credentials(self) -> Tuple[str, str]:
        """Expose currently bound credentials for scoped downstream services."""
        return self._api_key, self._api_secret

    async def close(self):
        """Close the aiohttp session and user stream. Call on shutdown."""
        await self.stop_user_stream()
        try:
            await self.exchange.close()
        except Exception:
            pass

    # ─── User data WebSocket stream ──────────────────────────────

    async def _create_listen_key(self) -> str:
        """Create listen key via REST. Returns the key string."""
        url = f"{self._fapi_base}/fapi/v1/listenKey"
        headers = {'X-MBX-APIKEY': self._api_key}
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers) as resp:
                data = await resp.json()
                return data['listenKey']

    async def _keepalive_listen_key(self):
        """Keep listen key alive (call every 30min, expires after 60min)."""
        if not self._listen_key:
            return
        url = f"{self._fapi_base}/fapi/v1/listenKey"
        headers = {'X-MBX-APIKEY': self._api_key}
        async with aiohttp.ClientSession() as session:
            async with session.put(url, headers=headers) as resp:
                if resp.status == 200:
                    logger.debug("Listen key keepalive OK")

    async def _delete_listen_key(self):
        """Delete listen key on shutdown."""
        if not self._listen_key:
            return
        url = f"{self._fapi_base}/fapi/v1/listenKey"
        headers = {'X-MBX-APIKEY': self._api_key}
        try:
            async with aiohttp.ClientSession() as session:
                await session.delete(url, headers=headers)
        except Exception:
            pass

    async def _keepalive_loop(self):
        """Keepalive every 30min while stream is running."""
        while self._user_stream_running:
            await asyncio.sleep(1800)  # 30 min
            try:
                await self._keepalive_listen_key()
            except Exception as e:
                logger.warning(f"Listen key keepalive failed: {e}")

    def _parse_ws_json(self, raw: str) -> dict:
        """Fast JSON parse with orjson fallback."""
        if orjson is not None:
            return orjson.loads(raw)
        import json
        return json.loads(raw)

    async def _user_stream_loop(self, stop: asyncio.Event):
        """User data WebSocket loop with auto-reconnect."""
        while not stop.is_set() and self._user_stream_running:
            try:
                self._listen_key = await self._create_listen_key()
                ws_url = f"{self._ws_base}/ws/{self._listen_key}"
                logger.info(f"🔌 User stream connecting...")

                async with websockets.connect(
                    ws_url, ping_interval=30, ping_timeout=30,
                ) as ws:
                    logger.info("✓ User data stream connected")

                    async for message in ws:
                        if stop.is_set() or not self._user_stream_running:
                            break
                        try:
                            data = self._parse_ws_json(message)
                            event_type = data.get('e')

                            if event_type == 'ORDER_TRADE_UPDATE':
                                self._handle_order_update(data)
                            elif event_type == 'ACCOUNT_UPDATE':
                                self._handle_account_update(data)
                            elif event_type == 'TRADE_LITE':
                                self._handle_trade_lite(data)

                        except Exception as e:
                            logger.debug(f"User stream parse error: {e}")

            except Exception as e:
                if self._user_stream_running and not stop.is_set():
                    logger.warning(f"User stream error: {e} — reconnecting in 3s")
                    await asyncio.sleep(3)

        # Cleanup
        await self._delete_listen_key()

    def _handle_order_update(self, data: dict):
        """
        Handle ORDER_TRADE_UPDATE event.
        
        Key fields in data['o']:
          i = orderId, s = symbol, S = side, X = status,
          q = origQty, z = filledQty, ap = avgPrice,
          n = commission, N = commissionAsset
        """
        o = data.get('o', {})
        order_id = str(o.get('i', ''))
        status = o.get('X', '')         # NEW, FILLED, PARTIALLY_FILLED, CANCELED, EXPIRED
        symbol = o.get('s', '')         # Raw symbol e.g. BTCUSDT
        side = o.get('S', '')           # BUY or SELL
        filled_qty = float(o.get('z', 0) or 0)
        avg_price = float(o.get('ap', 0) or 0)
        orig_qty = float(o.get('q', 0) or 0)
        commission = float(o.get('n', 0) or 0)
        is_maker = o.get('m', False)

        # If this order has a fill event waiting (blocking path), deliver the result
        if order_id in self._fill_events and filled_qty > 0 and status in ('FILLED', 'PARTIALLY_FILLED'):
            fill = FillResult(
                order_id=order_id,
                symbol=symbol,
                side=side.lower(),
                qty=filled_qty,
                avg_price=avg_price,
                cost=filled_qty * avg_price,
                fee=commission,
                is_maker=is_maker,
                timestamp=time.time(),
            )
            self._fill_results[order_id] = fill
            self._fill_events[order_id].set()
            logger.debug(f"📡 WS fill: {symbol} {side} {filled_qty} @ {avg_price} (order {order_id[:8]}…)")

        elif status == 'CANCELED' and order_id in self._fill_events:
            # Order was cancelled (no fill) — wake the waiter
            self._fill_events[order_id].set()

        # Fire-and-forget path: dispatch to external callback
        if self.on_order_update:
            if filled_qty > 0 and status in ('FILLED', 'PARTIALLY_FILLED'):
                fill = FillResult(
                    order_id=order_id,
                    symbol=symbol,
                    side=side.lower(),
                    qty=filled_qty,
                    avg_price=avg_price,
                    cost=filled_qty * avg_price,
                    fee=commission,
                    is_maker=is_maker,
                    timestamp=time.time(),
                )
                self.on_order_update(order_id, 'FILLED', fill)
            elif status in ('CANCELED', 'EXPIRED'):
                self.on_order_update(order_id, 'CANCELED', None)

    def _handle_account_update(self, data: dict):
        """Handle ACCOUNT_UPDATE — log position changes."""
        a = data.get('a', {})
        positions = a.get('P', [])
        for pos in positions:
            sym = pos.get('s', '')
            amt = float(pos.get('pa', 0) or 0)
            entry = float(pos.get('ep', 0) or 0)
            upnl = float(pos.get('up', 0) or 0)
            if abs(amt) > 0:
                side = 'short' if amt < 0 else 'long'
                logger.debug(f"📡 Position update: {sym} {side} {abs(amt)} @ {entry} uPnL ${upnl:.4f}")

    def _handle_trade_lite(self, data: dict):
        """Handle TRADE_LITE — fast fill notification (subset of ORDER_TRADE_UPDATE)."""
        order_id = str(data.get('i', ''))
        if order_id in self._fill_events:
            # TRADE_LITE arrives before ORDER_TRADE_UPDATE — prepare fill
            symbol = data.get('s', '')
            side = data.get('S', '').lower()
            qty = float(data.get('l', 0) or 0)
            price = float(data.get('L', 0) or 0)
            commission = float(data.get('n', 0) or 0)
            is_maker = data.get('m', False)

            if qty > 0:
                fill = FillResult(
                    order_id=order_id,
                    symbol=symbol,
                    side=side,
                    qty=qty,
                    avg_price=price,
                    cost=qty * price,
                    fee=commission,
                    is_maker=is_maker,
                    timestamp=time.time(),
                )
                self._fill_results[order_id] = fill
                self._fill_events[order_id].set()
                logger.debug(f"📡 TRADE_LITE fill: {symbol} {side} {qty} @ {price}")

    async def start_user_stream(self, stop: asyncio.Event):
        """Start user data stream (call from orchestrator)."""
        if self._user_stream_running:
            return
        self._user_stream_running = True
        self._user_stream_task = asyncio.create_task(self._user_stream_loop(stop))
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())
        logger.info("User data stream started")

    async def stop_user_stream(self):
        """Stop user data stream."""
        self._user_stream_running = False
        if self._keepalive_task:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._user_stream_task:
            self._user_stream_task.cancel()
            try:
                await self._user_stream_task
            except (asyncio.CancelledError, Exception):
                pass
        await self._delete_listen_key()

    async def load_markets(self):
        """Load exchange markets (call once at startup)."""
        if self._markets_loaded:
            return
        # Direct async call — no thread needed
        await self.exchange.load_markets()
        self._markets_loaded = True
        logger.info(f"✓ Loaded {len(self.exchange.markets)} futures markets")

    def _to_ccxt_symbol(self, raw: str) -> str:
        """Convert raw symbol like 'LAUSDT' to ccxt format 'LA/USDT:USDT'."""
        if not raw.endswith("USDT"):
            return raw
        base = raw[:-4]
        return f"{base}/USDT:USDT"

    async def get_symbol_info(self, raw_symbol: str) -> Optional[SymbolInfo]:
        """Get symbol metadata."""
        if raw_symbol in self.symbol_cache:
            return self.symbol_cache[raw_symbol]

        await self.load_markets()
        ccxt_sym = self._to_ccxt_symbol(raw_symbol)

        if ccxt_sym not in self.exchange.markets:
            logger.warning(f"Symbol {raw_symbol} ({ccxt_sym}) not found")
            return None

        market = self.exchange.markets[ccxt_sym]
        limits = market.get('limits', {})
        precision = market.get('precision', {})

        # Compute decimal places from step size
        raw_price_step = float(precision.get('price', 0.0001) or 0.0001)
        price_prec = self._step_to_precision(raw_price_step)

        raw_qty_step = float(precision.get('amount', 0.001) or 0.001)
        qty_prec = self._step_to_precision(raw_qty_step)

        info = SymbolInfo(
            symbol=ccxt_sym,
            raw=raw_symbol,
            min_qty=float(limits.get('amount', {}).get('min', 0) or 0),
            qty_step=raw_qty_step,
            price_precision=price_prec,
            price_step=raw_price_step,
            qty_precision=qty_prec,
            min_notional=float(limits.get('cost', {}).get('min', 5) or 5),
        )
        self.symbol_cache[raw_symbol] = info
        return info

    @staticmethod
    def _step_to_precision(step: float) -> int:
        """Convert a step size (e.g., 0.001) to decimal precision (3)."""
        if step >= 1.0:
            return 0
        return max(0, -int(math.floor(math.log10(abs(step)) + 1e-9)))

    def _round_qty(self, qty: float, info: SymbolInfo) -> float:
        """Round qty to lot step precision."""
        if info.qty_step > 0:
            qty = round(qty / info.qty_step) * info.qty_step
        return round(qty, info.qty_precision)

    def _round_price(self, price: float, info: SymbolInfo) -> float:
        """Round price to tick size precision — no float drift."""
        if info.price_step > 0:
            price = round(price / info.price_step) * info.price_step
        return round(price, info.price_precision)

    # ─── STEALTH ORDER SPREADING ──────────────────────────────

    @staticmethod
    def compute_stealth_slices(
        total_qty: float,
        base_price: float,
        price_step: float,
        l1_depth_qty: float,
        max_fraction: float = 0.5,
        max_ticks: int = 5,
        min_qty: float = 0.0,
        direction: str = "up",  # "up" for entries (sell), "down" for exits (buy)
        always_split: bool = False,
        min_slices: int = 2,
        max_slices: int = 5,
        min_notional: float = 5.0,  # Binance min notional per order
    ) -> list:
        """
        Split an order into random-sized pieces across price ticks.

        Anti-front-running: sizes are randomized so they look organic.
        Returns list of (qty, price) tuples.
        - direction="up":   entries spread to higher prices (better short entry)
        - direction="down": exits spread to lower prices (better short close)

        When always_split=True, orders are ALWAYS split into min_slices..max_slices
        random-sized pieces, even if they fit within L1 depth.
        """
        import random

        if total_qty <= 0 or price_step <= 0:
            return [(total_qty, base_price)]

        # Floor: each slice must satisfy BOTH min_qty AND min_notional ($5)
        notional_floor_qty = (min_notional / base_price) if base_price > 0 else 0.0
        effective_min = max(min_qty, notional_floor_qty, 1e-12)

        # How many slices can we possibly make?
        max_possible = max(1, int(total_qty / effective_min))

        # Decide number of slices
        if always_split and max_possible >= 2:
            # Always split: pick random N in [min_slices, max_slices]
            lo = max(2, min(min_slices, max_possible))
            hi = min(max_slices, max_possible, max_ticks)
            if hi < lo:
                hi = lo
            n_slices = random.randint(lo, hi)
        elif l1_depth_qty > 0:
            # Legacy: only split when exceeding L1 capacity
            capacity = l1_depth_qty * max_fraction
            if total_qty <= capacity:
                return [(total_qty, base_price)]
            n_slices = min(max_ticks, max(2, int(total_qty / capacity) + 1))
            n_slices = min(n_slices, max_possible)
        else:
            return [(total_qty, base_price)]

        if n_slices < 2:
            return [(total_qty, base_price)]

        # Generate random weights — Dirichlet-like via exponential draws
        raw_weights = [random.expovariate(1.0) for _ in range(n_slices)]
        weight_sum = sum(raw_weights)
        qtys = [(w / weight_sum) * total_qty for w in raw_weights]

        # Enforce min_qty: steal from largest slice to fix undersized ones
        for _ in range(n_slices * 2):  # convergence loop
            undersized = [i for i, q in enumerate(qtys) if q < effective_min]
            if not undersized:
                break
            largest = max(range(n_slices), key=lambda i: qtys[i])
            for i in undersized:
                deficit = effective_min - qtys[i]
                if qtys[largest] - deficit >= effective_min:
                    qtys[largest] -= deficit
                    qtys[i] = effective_min

        # If we still can't satisfy min_qty for all, merge smallest into others
        valid_qtys = [q for q in qtys if q >= effective_min]
        leftover = sum(q for q in qtys if q < effective_min)
        if leftover > 0 and valid_qtys:
            qtys = valid_qtys
            qtys[0] += leftover  # add remainder to first
            n_slices = len(qtys)

        if n_slices < 2:
            return [(total_qty, base_price)]

        # Correct rounding drift: adjust largest slice so total is exact
        drift = total_qty - sum(qtys)
        largest_idx = max(range(len(qtys)), key=lambda i: qtys[i])
        qtys[largest_idx] += drift

        # Assign prices: spread across ticks
        tick_sign = 1.0 if direction == "up" else -1.0
        slices = []
        for i, qty in enumerate(qtys):
            tick_offset = i if i < max_ticks else max_ticks - 1
            tick_price = base_price + (tick_offset * tick_sign * price_step)
            slices.append((qty, tick_price))

        # Shuffle order so placement sequence is unpredictable
        random.shuffle(slices)

        return slices

    # ─── LIMIT POST-ONLY ORDERS ───────────────────────────────

    async def fire_limit_sell(self, raw_symbol: str, qty: float, price: float) -> Optional[str]:
        """
        Fire-and-forget GTX SELL. Returns order_id immediately (~5ms).
        Fill/cancel handled asynchronously via on_order_update callback.
        Returns None if order was rejected at submission time.
        """
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None

        qty = self._round_qty(qty, info)
        price = self._round_price(price, info)

        if qty < info.min_qty:
            return None

        try:
            order = await self.exchange.create_order(
                info.symbol, 'limit', 'sell', qty, price,
                params={'timeInForce': 'GTX'},
            )
            order_id = str(order.get('id', ''))
            status = order.get('status', '')
            filled = float(order.get('filled', 0) or 0)

            # GTX filled instantly in REST response — WS will deliver the fill event.
            # Do NOT call on_order_update here to avoid double-fill.
            if status == 'closed' and filled > 0:
                return order_id

            # Rejected / expired at submission — no WS event expected
            if status in ('canceled', 'cancelled', 'expired', 'rejected'):
                if self.on_order_update:
                    self.on_order_update(order_id, 'CANCELED', None)
                return None

            # Resting on book — user stream will deliver the fill or cancel
            if status == 'open':
                return order_id

            # Partial fill at submission — WS will deliver the fill event
            if filled > 0:
                return order_id

            logger.warning(f"⚠️ {raw_symbol} fire_sell unknown status='{status}' filled={filled}")
            return None

        except ccxt_async.InvalidOrder as e:
            error_str = str(e)
            if 'would immediately match' in error_str.lower() or '-5022' in error_str:
                logger.debug(f"📝 {raw_symbol} SELL post-only rejected (would be taker)")
                return None
            logger.error(f"❌ FIRE SELL {raw_symbol} {qty}@{price} failed: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ FIRE SELL {raw_symbol} {qty}@{price} failed: {e}")
            return None

    async def amend_order(
        self, order_id: str, raw_symbol: str, side: str, qty: float, new_price: float
    ) -> Optional[str]:
        """
        Amend a resting order's price atomically via editOrder.
        Returns the (possibly new) order_id on success, None on failure.
        If the amended price would cross (be taker), returns None — caller should cancel.
        """
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None

        qty = self._round_qty(qty, info)
        new_price = self._round_price(new_price, info)

        if qty < info.min_qty:
            return None

        try:
            result = await self.exchange.edit_order(
                order_id, info.symbol, 'limit', side, qty, new_price,
                params={'timeInForce': 'GTX'},
            )
            new_id = str(result.get('id', order_id))
            status = result.get('status', '')

            if status in ('canceled', 'cancelled', 'expired', 'rejected'):
                return None

            return new_id

        except ccxt_async.InvalidOrder as e:
            error_str = str(e)
            if 'would immediately match' in error_str.lower() or '-5022' in error_str:
                logger.debug(f"📝 {raw_symbol} amend rejected (would be taker)")
                return None
            # -5027: "No need to modify the order" — order is alive, price unchanged
            if '-5027' in error_str:
                return order_id  # Order still alive, no action needed
            logger.warning(f"⚠️ Amend {order_id[:8]}… {raw_symbol} to {new_price}: {e}")
            return None
        except ccxt_async.OrderNotFound:
            logger.debug(f"📝 {raw_symbol} amend {order_id[:8]}… — order already gone")
            return None
        except Exception as e:
            logger.warning(f"⚠️ Amend {order_id[:8]}… {raw_symbol} failed: {e}")
            return None

    async def limit_sell(self, raw_symbol: str, qty: float, price: float) -> Optional[FillResult]:
        """
        Place LIMIT SELL (post-only / GTX). Blocking: waits for fill confirmation.
        Used for exits or when synchronous confirmation is needed.
        """
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None

        qty = self._round_qty(qty, info)
        price = self._round_price(price, info)

        if qty < info.min_qty:
            return None

        try:
            order = await self.exchange.create_order(
                info.symbol, 'limit', 'sell', qty, price,
                params={'timeInForce': 'GTX'},
            )
            return await self._confirm_gtx(order, raw_symbol)

        except ccxt_async.InvalidOrder as e:
            error_str = str(e)
            if 'would immediately match' in error_str.lower() or '-5022' in error_str:
                logger.debug(f"📝 {raw_symbol} SELL post-only rejected (would be taker)")
                return None
            logger.error(f"❌ LIMIT SELL {raw_symbol} {qty}@{price} failed: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ LIMIT SELL {raw_symbol} {qty}@{price} failed: {e}")
            return None

    async def limit_buy(self, raw_symbol: str, qty: float, price: float) -> Optional[FillResult]:
        """
        Place LIMIT BUY (post-only / GTX). Instant: fills in response or cancelled.
        No timeouts, no polling — fully reactive.
        """
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None

        qty = self._round_qty(qty, info)
        price = self._round_price(price, info)

        if qty < info.min_qty:
            return None

        try:
            order = await self.exchange.create_order(
                info.symbol, 'limit', 'buy', qty, price,
                params={'timeInForce': 'GTX', 'reduceOnly': True},
            )
            return await self._confirm_gtx(order, raw_symbol)

        except ccxt_async.InvalidOrder as e:
            error_str = str(e)
            if 'would immediately match' in error_str.lower() or '-5022' in error_str:
                logger.debug(f"📝 {raw_symbol} BUY post-only rejected (would be taker)")
                return None
            if '-2022' in error_str:
                logger.debug(f"📝 {raw_symbol} BUY reduceOnly rejected (no matching position)")
                return None
            logger.error(f"❌ LIMIT BUY {raw_symbol} {qty}@{price} failed: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ LIMIT BUY {raw_symbol} {qty}@{price} failed: {e}")
            return None

    # ─── MARKET ORDERS ────────────────────────────────────────

    async def market_sell(self, raw_symbol: str, qty: float) -> Optional[FillResult]:
        """Market SELL — fills in the API response. No polling needed."""
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None
        qty = self._round_qty(qty, info)
        if qty < info.min_qty:
            return None
        try:
            order = await self.exchange.create_order(
                info.symbol, 'market', 'sell', qty,
            )
            return self._parse_fill_safe(order, raw_symbol)
        except Exception as e:
            logger.error(f"❌ MARKET SELL {raw_symbol} {qty} failed: {e}")
            return None

    async def market_buy(self, raw_symbol: str, qty: float) -> Optional[FillResult]:
        """Market BUY with reduceOnly — guaranteed to never exceed short position size."""
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None
        qty = self._round_qty(qty, info)
        if qty < info.min_qty:
            return None
        try:
            order = await self.exchange.create_order(
                info.symbol, 'market', 'buy', qty,
                params={'reduceOnly': True},
            )
            return self._parse_fill_safe(order, raw_symbol)
        except ccxt_async.InvalidOrder as e:
            if '-2022' in str(e):
                logger.debug(f"📝 {raw_symbol} MARKET BUY reduceOnly rejected (no matching position)")
                return None
            logger.error(f"❌ MARKET BUY {raw_symbol} {qty} failed: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ MARKET BUY {raw_symbol} {qty} failed: {e}")
            return None

    async def ioc_buy(self, raw_symbol: str, qty: float, price: float) -> Optional[FillResult]:
        """
        IOC BUY — Immediate-Or-Cancel limit buy at specified price.
        Fills what it can at price or better, cancels any unfilled remainder.
        Used as price-capped taker exit: guaranteed no worse than `price`.
        """
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return None

        qty = self._round_qty(qty, info)
        price = self._round_price(price, info)

        if qty < info.min_qty:
            return None

        try:
            order = await self.exchange.create_order(
                info.symbol, 'limit', 'buy', qty, price,
                params={'timeInForce': 'IOC', 'reduceOnly': True},
            )
            filled = float(order.get('filled', 0) or 0)
            if filled > 0:
                return self._parse_fill(order, raw_symbol)
            # IOC expired with no fill (price moved past limit)
            logger.debug(f"📝 {raw_symbol} IOC BUY {qty}@{price} — no fill (price moved)")
            return None

        except ccxt_async.InvalidOrder as e:
            error_str = str(e)
            if '-2022' in error_str:
                logger.debug(f"📝 {raw_symbol} IOC BUY reduceOnly rejected (no position)")
                return None
            logger.error(f"❌ IOC BUY {raw_symbol} {qty}@{price} failed: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ IOC BUY {raw_symbol} {qty}@{price} failed: {e}")
            return None

    # ─── Fill confirmation — zero timeout, fully reactive ─────

    async def _confirm_gtx(self, order: dict, raw_symbol: str) -> Optional[FillResult]:
        """
        Confirm a GTX limit order — check once, then decide.
        
        GTX orders on Binance:
        - Filled immediately → status='closed', filled>0 → return fill
        - Resting on book → status='open' → fetch_order to check real state
          - If filled between create and fetch → return fill
          - If still resting → cancel + return None
        - Rejected → status='canceled'/'expired' → return None
        """
        order_id = str(order.get('id', ''))
        status = order.get('status', '')
        filled = float(order.get('filled', 0) or 0)
        ccxt_symbol = order.get('symbol', '')

        # Filled instantly → return result
        if status == 'closed' and filled > 0:
            return self._parse_fill(order, raw_symbol)

        # Rejected / expired
        if status in ('canceled', 'cancelled', 'expired', 'rejected'):
            return None

        # Resting on book → wait for user stream fill event, fallback to REST
        if status == 'open':
            # Register fill event for this order
            evt = asyncio.Event()
            self._fill_events[order_id] = evt

            try:
                # Wait for WS fill event (fast path ~5ms) with REST fallback
                try:
                    await asyncio.wait_for(evt.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    pass

                # Check if WS delivered a fill
                if order_id in self._fill_results:
                    result = self._fill_results.pop(order_id)
                    logger.info(f"⚡ {raw_symbol} GTX {order_id[:8]}… filled via user stream")
                    return result

                # Fallback: REST fetch_order
                real_order = await self.exchange.fetch_order(order_id, ccxt_symbol)
                real_status = real_order.get('status', '')
                real_filled = float(real_order.get('filled', 0) or 0)

                # Filled between create_order and fetch_order!
                if real_status == 'closed' and real_filled > 0:
                    logger.info(f"⚡ {raw_symbol} GTX {order_id[:8]}… filled after open (race caught)")
                    return self._parse_fill(real_order, raw_symbol)

                # Partial fill — take what we got, cancel the rest
                if real_filled > 0:
                    logger.info(f"⚡ {raw_symbol} GTX {order_id[:8]}… partial fill {real_filled}")
                    try:
                        await self.cancel_order(order_id, raw_symbol)
                    except Exception:
                        pass
                    return self._parse_fill(real_order, raw_symbol)

                # Still resting, no fill → cancel and move on
                logger.debug(f"⚡ {raw_symbol} GTX {order_id[:8]}… still resting — cancelling")
                try:
                    await self.cancel_order(order_id, raw_symbol)
                except Exception:
                    pass
                return None

            except Exception as e:
                # fetch_order failed — try to cancel for safety, return None
                logger.warning(f"⚠️ {raw_symbol} fetch_order failed: {e} — cancelling for safety")
                try:
                    await self.cancel_order(order_id, raw_symbol)
                except Exception:
                    pass
                return None
            finally:
                self._fill_events.pop(order_id, None)
                self._fill_results.pop(order_id, None)

        # Partial fill or unknown — trust if filled > 0
        if filled > 0:
            return self._parse_fill(order, raw_symbol)

        logger.warning(f"⚠️ {raw_symbol} order {order_id[:8]}… unknown status='{status}' filled={filled}")
        return None

    def _parse_fill_safe(self, order: dict, raw_symbol: str) -> Optional[FillResult]:
        """Parse fill from market order response. Always fills or errors."""
        filled = float(order.get('filled', 0) or 0)
        if filled > 0:
            return self._parse_fill(order, raw_symbol)
        # Market order didn't fill — shouldn't happen but handle it
        status = order.get('status', '')
        logger.warning(f"⚠️ {raw_symbol} market order status='{status}' filled=0")
        return None

    def _parse_fill(self, order: dict, raw_symbol: str) -> FillResult:
        """Parse ccxt order response into FillResult. Only called for confirmed fills."""
        fee_cost = 0.0
        is_maker = False

        # Get fee from trades array (most reliable)
        if order.get('trades'):
            fee_cost = 0.0
            maker_count = 0
            for trade in order['trades']:
                if trade.get('fee'):
                    fee_cost += float(trade['fee'].get('cost', 0) or 0)
                if trade.get('takerOrMaker') == 'maker':
                    maker_count += 1
            is_maker = maker_count > 0
        elif order.get('fee'):
            fee_cost = float(order['fee'].get('cost', 0) or 0)
        elif order.get('fees'):
            fee_cost = sum(float(f.get('cost', 0) or 0) for f in order['fees'])

        # ONLY trust 'filled', never fall back to 'amount'
        filled = float(order.get('filled', 0) or 0)
        avg_price = float(order.get('average', 0) or order.get('price', 0))
        cost = float(order.get('cost', 0) or filled * avg_price)

        # Estimate fee if exchange didn't return it
        if fee_cost == 0 and cost > 0:
            order_type = order.get('type', 'market')
            if order_type == 'limit':
                fee_cost = cost * 0.000252  # Maker estimate
                is_maker = True
            else:
                fee_cost = cost * 0.000336  # Taker estimate

        return FillResult(
            order_id=str(order.get('id', '')),
            symbol=raw_symbol,
            side=order.get('side', ''),
            qty=filled,
            avg_price=avg_price,
            cost=cost,
            fee=abs(fee_cost),
            is_maker=is_maker,
            timestamp=time.time(),
        )

    # ─── Order management ─────────────────────────────────────

    async def cancel_order(self, order_id: str, raw_symbol: str) -> bool:
        """Cancel a specific order. Returns True if cancelled successfully."""
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return False
        try:
            await self.exchange.cancel_order(order_id, info.symbol)
            self._open_orders.pop(order_id, None)
            logger.debug(f"✓ Cancelled order {order_id[:8]}… on {raw_symbol}")
            return True
        except ccxt_async.OrderNotFound:
            self._open_orders.pop(order_id, None)
            return True  # Already gone
        except Exception as e:
            logger.warning(f"Cancel order {order_id[:8]}… failed: {e}")
            return False

    async def cancel_all_symbol_orders(self, raw_symbol: str) -> int:
        """Cancel ALL open orders for a symbol. Returns count cancelled."""
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return 0
        try:
            orders = await self.exchange.fetch_open_orders(info.symbol)
            cancelled = 0
            for order in orders:
                oid = str(order.get('id', ''))
                try:
                    await self.exchange.cancel_order(oid, info.symbol)
                    self._open_orders.pop(oid, None)
                    cancelled += 1
                except Exception:
                    pass
            return cancelled
        except Exception as e:
            logger.warning(f"Cancel all orders {raw_symbol} failed: {e}")
            return 0

    async def cancel_all_tracked_orders(self) -> int:
        """Cancel ALL orders we're currently tracking. For shutdown."""
        total = 0
        for oid, info in list(self._open_orders.items()):
            sym = info['symbol']
            if await self.cancel_order(oid, sym):
                total += 1
        return total

    # ─── Position & balance queries ───────────────────────────

    async def get_balance(self) -> float:
        """Get USDT futures balance."""
        try:
            balance = await self.exchange.fetch_balance()
            usdt = balance.get('USDT', {})
            return float(usdt.get('free', 0) or 0)
        except Exception as e:
            logger.error(f"Balance fetch error: {e}")
            return 0.0

    async def get_positions(self) -> Dict[str, dict]:
        """Get all open positions."""
        try:
            positions = await self.exchange.fetch_positions()
            result = {}
            for pos in positions:
                contracts = float(pos.get('contracts', 0) or 0)
                if contracts > 0:
                    sym = pos.get('symbol', '')
                    result[sym] = {
                        'side': pos.get('side', ''),
                        'contracts': contracts,
                        'notional': abs(float(pos.get('notional', 0) or 0)),
                        'unrealizedPnl': float(pos.get('unrealizedPnl', 0) or 0),
                        'entryPrice': float(pos.get('entryPrice', 0) or 0),
                    }
            return result
        except Exception as e:
            logger.error(f"Position fetch error: {e}")
            return {}

    async def close_all_positions(self):
        """Emergency: close all open positions at market."""
        positions = await self.get_positions()
        for sym, pos in positions.items():
            side = pos['side']
            qty = pos['contracts']
            try:
                if side == 'short':
                    await self.exchange.create_order(
                        sym, 'market', 'buy', qty,
                        params={'reduceOnly': True}
                    )
                    logger.info(f"🚨 Emergency closed SHORT {sym} {qty}")
                elif side == 'long':
                    await self.exchange.create_order(
                        sym, 'market', 'sell', qty,
                        params={'reduceOnly': True}
                    )
                    logger.info(f"🚨 Emergency closed LONG {sym} {qty}")
            except Exception as e:
                logger.error(f"Emergency close {sym} failed: {e}")

    async def set_leverage(self, raw_symbol: str, leverage: int = 1):
        """Set leverage for a symbol."""
        info = await self.get_symbol_info(raw_symbol)
        if not info:
            return
        try:
            await self.exchange.set_leverage(leverage, info.symbol)
        except Exception:
            pass

    # ─── Pre-flight self test ─────────────────────────────────

    async def self_test(self) -> bool:
        """Run pre-flight checks. Returns True if all pass."""
        logger.info("\n🔬 PRE-FLIGHT CHECKS")
        logger.info("=" * 50)

        try:
            await self.load_markets()
            logger.info(f"  ✅ API connected, {len(self.exchange.markets)} markets loaded")
        except Exception as e:
            logger.error(f"  ❌ API connection failed: {e}")
            return False

        try:
            balance = await self.get_balance()
            if balance <= 0:
                logger.error(f"  ❌ Zero USDT balance: ${balance:.2f}")
                return False
            logger.info(f"  ✅ USDT balance: ${balance:.2f}")
        except Exception as e:
            logger.error(f"  ❌ Balance check failed: {e}")
            return False

        try:
            positions = await self.get_positions()
            if positions:
                logger.warning(f"  ⚠️  {len(positions)} open position(s):")
                for sym, pos in positions.items():
                    logger.warning(f"      {sym}: {pos['side']} {pos['contracts']} (uPnL: ${pos['unrealizedPnl']:.4f})")
            else:
                logger.info("  ✅ No open positions")
        except Exception as e:
            logger.error(f"  ❌ Position check failed: {e}")
            return False

        try:
            info = await self.get_symbol_info("BTCUSDT")
            if info:
                logger.info(f"  ✅ Symbol info (BTC min_qty={info.min_qty}, step={info.qty_step}, tick={info.price_step}, price_prec={info.price_precision})")
            else:
                logger.error("  ❌ Could not fetch BTCUSDT info")
                return False
        except Exception as e:
            logger.error(f"  ❌ Symbol info failed: {e}")
            return False

        logger.info("=" * 50)
        logger.info("  ✅ ALL CHECKS PASSED — ready for live trading\n")
        return True


def _read_env_file(path: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    try:
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.lower().startswith("export "):
                    line = line[7:].strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                k = key.strip()
                if not k:
                    continue
                v = value.strip().strip("'").strip('"')
                values[k] = v
    except FileNotFoundError:
        logger.error(f"No .env file found at {path}")
    return values


def _pick_first_key_value(
    file_values: Dict[str, str],
    file_values_lower: Dict[str, str],
    candidates: List[str],
) -> str:
    for key in candidates:
        if not key:
            continue
        env_val = os.environ.get(key)
        if env_val:
            return env_val.strip()
        file_val = file_values.get(key)
        if file_val:
            return str(file_val).strip()
        file_val = file_values_lower.get(key.lower())
        if file_val:
            return str(file_val).strip()
    return ""


def load_api_keys(
    env_path: str = None,
    profile: str = "",
    strict_profile: bool = False,
) -> Tuple[str, str]:
    """
    Load API keys from environment/.env with optional subaccount profile routing.

    Supported scoped key forms (profile=alice):
      - api_key.alice / secret.alice
      - api_key_alice / secret_alice
      - api_key__alice / secret__alice
      - BINANCE_API_KEY_ALICE / BINANCE_SECRET_ALICE
      - SUBACCOUNT_ALICE_API_KEY / SUBACCOUNT_ALICE_SECRET
    """
    if env_path is None:
        env_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            ".env"
        )

    file_values = _read_env_file(env_path)
    file_values_lower = {k.lower(): v for k, v in file_values.items()}

    profile_raw = str(profile or "").strip()
    profile_norm = _sanitize_scope(profile_raw).replace("-", "_").replace(".", "_")
    profile_up = profile_norm.upper()

    if profile_norm:
        scoped_api_keys = [
            f"api_key.{profile_norm}",
            f"api_key_{profile_norm}",
            f"api_key__{profile_norm}",
            f"binance_api_key_{profile_norm}",
            f"subaccount_{profile_norm}_api_key",
            f"API_KEY_{profile_up}",
            f"BINANCE_API_KEY_{profile_up}",
            f"SUBACCOUNT_{profile_up}_API_KEY",
        ]
        scoped_secret_keys = [
            f"secret.{profile_norm}",
            f"secret_{profile_norm}",
            f"secret__{profile_norm}",
            f"api_secret_{profile_norm}",
            f"binance_secret_{profile_norm}",
            f"subaccount_{profile_norm}_secret",
            f"SECRET_{profile_up}",
            f"BINANCE_SECRET_{profile_up}",
            f"BINANCE_API_SECRET_{profile_up}",
            f"SUBACCOUNT_{profile_up}_SECRET",
        ]

        api_key = _pick_first_key_value(file_values, file_values_lower, scoped_api_keys)
        secret = _pick_first_key_value(file_values, file_values_lower, scoped_secret_keys)

        if api_key and secret:
            return api_key, secret

        if strict_profile:
            logger.error(
                "No complete scoped API credentials found for profile '%s' (strict mode).",
                profile_raw,
            )
            return "", ""

        logger.warning(
            "Scoped credentials for profile '%s' not found; falling back to default keys.",
            profile_raw,
        )

    default_api_keys = ["api_key", "BINANCE_API_KEY", "API_KEY"]
    default_secret_keys = ["secret", "api_secret", "BINANCE_SECRET", "BINANCE_API_SECRET", "SECRET"]
    api_key = _pick_first_key_value(file_values, file_values_lower, default_api_keys)
    secret = _pick_first_key_value(file_values, file_values_lower, default_secret_keys)
    return api_key, secret
