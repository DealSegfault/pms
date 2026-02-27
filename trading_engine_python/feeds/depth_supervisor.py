"""
DepthSupervisor — In-process depth handler supervisor for the trading engine.

Manages per-symbol depth WebSocket streams using aiohttp (proxy-safe).
Each symbol gets its own supervised connection to Binance Futures @depth@100ms.

L1 (best bid/ask) is extracted directly from the in-process OrderBook —
no Redis roundtrip needed for algo callbacks. The orderbook is also stored
in Redis (via OrderBookRedisStore) for the frontend.

Supervisor pattern (from subscription_api.py reference):
    - Each symbol runs as a supervised asyncio.Task
    - Auto-reconnect with exponential backoff on failure
    - Dynamic subscribe/unsubscribe — add/remove symbols at runtime
    - Graceful shutdown of all streams
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from decimal import Decimal
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set

import aiohttp

logger = logging.getLogger(__name__)

BINANCE_WS_BASE = "wss://fstream.binance.com/ws"
BINANCE_REST_BASE = "https://fapi.binance.com/fapi/v1"

# ── Ensure the market_data handler code is importable ──
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MARKET_DATA_DIR = os.path.join(_BASE_DIR, "market_data")
_LOGIC_MONEY_DIR = os.path.join(os.path.dirname(_BASE_DIR), "logic-money")

for _path in [_MARKET_DATA_DIR, _LOGIC_MONEY_DIR]:
    if _path not in sys.path:
        sys.path.insert(0, _path)

from exchanges.orderbook import OrderBook


@dataclass
class _DepthSubscription:
    """Internal state for a single supervised depth stream."""
    symbol: str                          # Binance format uppercase: 1000RATSUSDT
    task: Optional[asyncio.Task] = None
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    orderbook: OrderBook = field(default_factory=OrderBook)
    l1: Optional[dict] = None            # {bid, ask, mid, ts}
    # Depth stream state
    snapshot_received: bool = False
    last_update_id: Optional[int] = None
    is_warmed_up: bool = False
    seq_mismatch_count: int = 0
    redis_store: Any = None
    _needs_reconnect: bool = False     # Set by _process_depth_update to trigger reconnect (#11)


class DepthSupervisor:
    """
    Manages in-process depth streams via aiohttp WebSocket (proxy-compatible).

    Usage:
        supervisor = DepthSupervisor()
        supervisor.subscribe("BTCUSDT", my_callback)
        # ... callback fires on every BBO change
        supervisor.unsubscribe("BTCUSDT", my_callback)
        await supervisor.shutdown()
    """

    def __init__(self):
        self._subs: Dict[str, _DepthSubscription] = {}
        self._callbacks: Dict[str, List[Callable]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _to_binance_symbol(symbol: str) -> str:
        """Convert ccxt format (BTC/USDT:USDT) to Binance format (BTCUSDT)."""
        # Strip :USDT suffix, remove /
        s = symbol.split(":")[0].replace("/", "")
        return s.upper()

    def subscribe(self, symbol: str, callback: Callable) -> None:
        """Start depth stream for symbol if needed, register callback."""
        if symbol not in self._callbacks:
            self._callbacks[symbol] = []
        if callback not in self._callbacks[symbol]:
            self._callbacks[symbol].append(callback)

        if symbol not in self._subs:
            sub = _DepthSubscription(symbol=symbol)
            sub.redis_store = self._create_redis_store()
            sub.task = asyncio.create_task(self._supervise(sub))
            self._subs[symbol] = sub
            logger.info("DepthSupervisor: starting depth stream for %s", symbol)

    def unsubscribe(self, symbol: str, callback: Callable) -> None:
        """Remove callback. Stops depth stream if no more consumers."""
        if symbol in self._callbacks:
            self._callbacks[symbol] = [cb for cb in self._callbacks[symbol] if cb is not callback]
            if not self._callbacks[symbol]:
                del self._callbacks[symbol]
                sub = self._subs.pop(symbol, None)
                if sub:
                    sub.stop_event.set()
                    if sub.task and not sub.task.done():
                        sub.task.cancel()
                    logger.info("DepthSupervisor: stopped depth stream for %s", symbol)

    def get_l1(self, symbol: str) -> Optional[dict]:
        """Get cached L1 for a symbol, or None."""
        sub = self._subs.get(symbol)
        return sub.l1 if sub else None

    async def shutdown(self) -> None:
        """Stop all depth streams gracefully."""
        logger.info("DepthSupervisor: shutting down %d streams", len(self._subs))
        for sub in self._subs.values():
            sub.stop_event.set()
            if sub.task and not sub.task.done():
                sub.task.cancel()
        tasks = [sub.task for sub in self._subs.values() if sub.task]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._subs.clear()
        self._callbacks.clear()

    # ── Redis Store (without flushdb) ──

    @staticmethod
    def _create_redis_store():
        """Create OrderBookRedisStore without flushdb()."""
        try:
            import redis as sync_redis
            from config import REDIS_HOST, REDIS_PORT, REDIS_DB
            from exchanges.reddis_store import OrderBookRedisStore

            store = object.__new__(OrderBookRedisStore)
            store.redis_client = sync_redis.StrictRedis(
                host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB
            )
            return store
        except Exception as e:
            logger.warning("Failed to create Redis store: %s — orderbook won't be stored", e)
            return None

    # ── Supervisor Loop ──

    async def _supervise(self, sub: _DepthSubscription) -> None:
        """
        Supervisor coroutine for a single depth stream.
        Uses aiohttp WebSocket (proxy-compatible) with auto-reconnect.
        """
        backoff = 1
        binance_sym = self._to_binance_symbol(sub.symbol)
        ws_symbol = binance_sym.lower()
        url = f"{BINANCE_WS_BASE}/{ws_symbol}@depth@100ms"

        while not sub.stop_event.is_set():
            session = None
            ws = None
            snapshot_task = None
            try:
                # Reset orderbook state for fresh connection
                sub.orderbook = OrderBook()
                sub.snapshot_received = False
                sub.last_update_id = None
                sub.is_warmed_up = False
                sub.seq_mismatch_count = 0
                sub._needs_reconnect = False  # Reset reconnect flag (#11)
                update_buffer = []

                session = aiohttp.ClientSession()
                logger.info("DepthSupervisor [%s]: connecting to %s", sub.symbol, url)
                ws = await session.ws_connect(url, heartbeat=20)
                logger.info("DepthSupervisor [%s]: connected", sub.symbol)
                backoff = 1

                # Fetch snapshot in parallel
                snapshot_task = asyncio.create_task(
                    self._fetch_snapshot(session, sub)
                )

                async for msg in ws:
                    if sub.stop_event.is_set():
                        break

                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)

                        if data.get("e") != "depthUpdate":
                            continue

                        if not sub.snapshot_received:
                            # Buffer until snapshot arrives
                            update_buffer.append(data)
                            if len(update_buffer) > 5000:
                                update_buffer.pop(0)
                            continue

                        self._process_depth_update(sub, data)

                        # Check reconnect flag set by _process_depth_update (#11)
                        if sub._needs_reconnect:
                            logger.info("DepthSupervisor [%s]: reconnect requested, breaking WS loop", sub.symbol)
                            break

                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        logger.warning("DepthSupervisor [%s]: WS %s", sub.symbol, msg.type)
                        break

                    # After snapshot, replay buffer once
                    if sub.snapshot_received and update_buffer:
                        for buffered in update_buffer:
                            self._process_depth_update(sub, buffered)
                        update_buffer.clear()

            except asyncio.CancelledError:
                logger.info("DepthSupervisor [%s]: cancelled", sub.symbol)
                break
            except Exception as e:
                if sub.stop_event.is_set():
                    break
                logger.warning(
                    "DepthSupervisor [%s]: %s — reconnecting in %ds",
                    sub.symbol, type(e).__name__, backoff,
                )
            finally:
                # Always cleanup — prevents "Unclosed client session" warnings
                if snapshot_task and not snapshot_task.done():
                    snapshot_task.cancel()
                if ws and not ws.closed:
                    try:
                        await ws.close()
                    except Exception:
                        pass
                if session and not session.closed:
                    try:
                        await session.close()
                    except Exception:
                        pass

            if sub.stop_event.is_set():
                break

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

        logger.info("DepthSupervisor [%s]: stopped", sub.symbol)

    async def _fetch_snapshot(self, session: aiohttp.ClientSession, sub: _DepthSubscription) -> None:
        """Fetch full orderbook snapshot from REST API."""
        binance_sym = self._to_binance_symbol(sub.symbol)
        url = f"{BINANCE_REST_BASE}/depth?symbol={binance_sym}&limit=100"
        try:
            async with session.get(url) as resp:
                snapshot = await resp.json()

            for bid in snapshot.get("bids", []):
                sub.orderbook.update("bid", Decimal(bid[0]), Decimal(bid[1]))
            for ask in snapshot.get("asks", []):
                sub.orderbook.update("ask", Decimal(ask[0]), Decimal(ask[1]))

            sub.last_update_id = snapshot["lastUpdateId"]
            sub.snapshot_received = True
            logger.info("DepthSupervisor [%s]: snapshot fetched (lastUpdateId=%d)",
                        sub.symbol, sub.last_update_id)

        except Exception as e:
            logger.error("DepthSupervisor [%s]: snapshot fetch failed: %s", sub.symbol, e)

    def _process_depth_update(self, sub: _DepthSubscription, data: dict) -> None:
        """Process an incremental depth update — same logic as BinanceFutures."""
        if not sub.snapshot_received:
            return

        # Warm up
        if sub.last_update_id is None:
            sub.last_update_id = data["u"]
            return

        # Validate sequence
        if data["pu"] != sub.last_update_id:
            if not sub.is_warmed_up:
                sub.last_update_id = data["u"]
                sub.is_warmed_up = True
                return

            sub.seq_mismatch_count += 1
            if sub.seq_mismatch_count >= 20:
                logger.error("DepthSupervisor [%s]: too many sequence mismatches, reconnecting", sub.symbol)
                sub._needs_reconnect = True  # Signal reconnect without killing supervisor (#11)
                return
            sub.last_update_id = data["u"]
            return
        else:
            if not sub.is_warmed_up:
                sub.is_warmed_up = True
            if sub.seq_mismatch_count > 0:
                sub.seq_mismatch_count = 0

        # Apply updates
        for bid in data.get("b", []):
            sub.orderbook.update("bid", Decimal(bid[0]), Decimal(bid[1]))
        for ask in data.get("a", []):
            sub.orderbook.update("ask", Decimal(ask[0]), Decimal(ask[1]))

        sub.last_update_id = data["u"]

        # Validate orderbook
        best_bid, _ = sub.orderbook.get_best_bid()
        best_ask, _ = sub.orderbook.get_best_ask()
        if best_bid and best_ask and best_bid >= best_ask:
            if (best_bid - best_ask) / best_ask > Decimal("0.005"):
                logger.error("DepthSupervisor [%s]: severely crossed book, reconnecting", sub.symbol)
                sub._needs_reconnect = True  # Signal reconnect without killing supervisor (#11)
                return
            return  # Skip mildly crossed update

        # Store in Redis (sync, non-blocking for the event loop)
        if sub.redis_store:
            try:
                sub.redis_store.store_orderbook("binance", sub.symbol.upper(), {
                    "bids": list(sub.orderbook.bids.items()),
                    "asks": list(sub.orderbook.asks.items()),
                })
            except Exception as e:
                logger.debug("Redis store failed for %s: %s", sub.symbol, e)

        # Extract and dispatch L1
        self._extract_and_dispatch_l1(sub)

    def _extract_and_dispatch_l1(self, sub: _DepthSubscription) -> None:
        """Extract BBO from OrderBook and dispatch to callbacks."""
        try:
            best_bid, _ = sub.orderbook.get_best_bid()
            best_ask, _ = sub.orderbook.get_best_ask()
        except (ValueError, TypeError, IndexError):
            return

        if best_bid is None or best_ask is None:
            return

        bid = float(best_bid)
        ask = float(best_ask)
        mid = (bid + ask) / 2.0
        ts = time.time()

        # Check if BBO actually changed
        if sub.l1 and sub.l1["bid"] == bid and sub.l1["ask"] == ask:
            return

        sub.l1 = {"bid": bid, "ask": ask, "mid": mid, "ts": ts}

        # Fire callbacks via create_task (non-blocking)
        for cb in self._callbacks.get(sub.symbol, []):
            asyncio.create_task(cb(sub.symbol, bid, ask, mid))

    @property
    def active_streams(self) -> Set[str]:
        """Set of symbols with active depth streams."""
        return set(self._subs.keys())

    def __repr__(self) -> str:
        return f"DepthSupervisor(streams={len(self._subs)}, callbacks={sum(len(v) for v in self._callbacks.values())})"
