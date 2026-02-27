"""
MarketDataService — L1 price provider via in-process DepthSupervisor.

Delegates to DepthSupervisor to dynamically start/stop BinanceFutures depth
handlers per-symbol. L1 (best bid/ask) is extracted directly from the in-process
OrderBook — no Redis roundtrip for algo callbacks.

Architecture:
    MarketDataService.subscribe(symbol, callback)
        → DepthSupervisor.subscribe(symbol, _on_l1)
            → BinanceFutures handler (in-process, supervised)
                → WebSocket @depth@100ms
                → OrderBook.get_best_bid() / get_best_ask()
                → _on_l1(symbol, bid, ask, mid)
                    → cache L1
                    → publish pms:price:{SYMBOL} to Redis (throttled)
                    → fire algo callbacks via asyncio.create_task()

Callbacks are used by:
    - ChaseEngine  (reprice on L1 change)
    - ScalperEngine (spread evaluation)
    - RiskEngine   (margin/liquidation calc)
    - TrailStop    (trigger evaluation)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Minimum interval between Redis L1 publishes per symbol (ms)
L1_PUBLISH_THROTTLE_MS = 0   # No throttle — fire on every depth tick


class MarketDataService:
    """
    L1 price feed powered by in-process depth handlers via DepthSupervisor.

    On first subscribe for a symbol, the supervisor starts a BinanceFutures
    depth WebSocket. L1 is extracted directly from the OrderBook and dispatched
    to algo callbacks.
    """

    def __init__(self, redis_client: Any = None, depth_supervisor: Any = None):
        self._redis = redis_client
        self._depth = depth_supervisor                     # DepthSupervisor instance
        self._callbacks: Dict[str, List[Callable]] = {}    # symbol → [callbacks]
        self._last_l1: Dict[str, dict] = {}                # symbol → {bid, ask, mid, ts}
        self._last_publish_ts: Dict[str, float] = {}       # symbol → last Redis publish time
        self._subscribed_symbols: Set[str] = set()
        self._depth_handlers: Dict[str, Callable] = {}     # symbol → stored handler ref (#10)

    # ── Public API ──

    def subscribe(self, symbol: str, callback: Callable) -> None:
        """
        Register a callback for L1 price updates on a symbol.

        Callback signature: async def cb(symbol: str, bid: float, ask: float, mid: float)
        Callbacks are fired via asyncio.create_task() — non-blocking.

        Automatically starts a depth stream for the symbol if not running.
        Symbol should be in ccxt format (e.g., 'BTC/USDT:USDT').
        """
        # Guard: warn if symbol looks like Binance native format (no '/')
        if "/" not in symbol and symbol != "":
            logger.warning(
                "MarketData.subscribe() received non-ccxt symbol '%s' — "
                "this will cause get_l1() mismatches. Use ccxt format (e.g., 'BTC/USDT:USDT').",
                symbol,
            )

        is_new_symbol = symbol not in self._callbacks
        if is_new_symbol:
            self._callbacks[symbol] = []
        if callback not in self._callbacks[symbol]:
            self._callbacks[symbol].append(callback)
            self._subscribed_symbols.add(symbol)
            logger.info("Subscribed to L1 for %s (total callbacks: %d)", symbol, len(self._callbacks[symbol]))

        # Start depth stream via supervisor
        if is_new_symbol and self._depth:
            handler = self._make_l1_handler(symbol)
            self._depth_handlers[symbol] = handler  # Store ref for unsubscribe (#10)
            self._depth.subscribe(symbol, handler)

    def unsubscribe(self, symbol: str, callback: Callable) -> None:
        """Remove a callback. Stops depth stream if no more consumers."""
        if symbol in self._callbacks:
            self._callbacks[symbol] = [cb for cb in self._callbacks[symbol] if cb is not callback]
            if not self._callbacks[symbol]:
                del self._callbacks[symbol]
                self._subscribed_symbols.discard(symbol)
                # Stop depth stream — use stored handler ref (#10)
                if self._depth:
                    handler = self._depth_handlers.pop(symbol, None)
                    if handler:
                        self._depth.unsubscribe(symbol, handler)

    def get_l1(self, symbol: str) -> Optional[dict]:
        """
        Get latest cached L1 for a symbol.
        Returns: {bid, ask, mid, ts} or None if no data yet.
        """
        return self._last_l1.get(symbol)

    def get_mid_price(self, symbol: str) -> Optional[float]:
        """Get mid price for a symbol, or None if no data."""
        l1 = self._last_l1.get(symbol)
        return l1["mid"] if l1 else None

    def get_bid_ask(self, symbol: str) -> Optional[tuple]:
        """Get (bid, ask) tuple for a symbol, or None if no data."""
        l1 = self._last_l1.get(symbol)
        return (l1["bid"], l1["ask"]) if l1 else None

    @property
    def subscribed_symbols(self) -> Set[str]:
        """Set of symbols currently subscribed to."""
        return self._subscribed_symbols.copy()

    # ── L1 Handler (receives from DepthSupervisor) ──

    def _make_l1_handler(self, symbol: str):
        """Create a bound L1 handler for the DepthSupervisor callback."""
        async def handler(_sym: str, bid: float, ask: float, mid: float):
            await self._on_l1(symbol, bid, ask, mid)
        # Tag the handler so we can find it for unsubscribe
        handler._mds_symbol = symbol
        return handler

    async def _on_l1(self, symbol: str, bid: float, ask: float, mid: float) -> None:
        """Handle L1 update from DepthSupervisor — cache + publish + dispatch."""
        ts = time.time()

        # Check if BBO actually changed
        prev = self._last_l1.get(symbol)
        if prev and prev["bid"] == bid and prev["ask"] == ask:
            return

        # Update cache
        self._last_l1[symbol] = {"bid": bid, "ask": ask, "mid": mid, "ts": ts}

        # Publish pms:price to Redis (throttled)
        await self._publish_l1(symbol, bid, ask, mid, ts)

        # Fire algo callbacks
        for cb in self._callbacks.get(symbol, []):
            asyncio.create_task(cb(symbol, bid, ask, mid))

    # ── Direct Integration Point (fallback for in-process depth handler) ──

    async def on_orderbook_update(self, symbol: str, orderbook: Any) -> None:
        """
        Called when an in-process depth handler processes an update.
        Extracts L1 from the orderbook object.

        Args:
            symbol: Binance format uppercase (BTCUSDT)
            orderbook: The OrderBook instance with .bids and .asks SortedDicts
        """
        try:
            best_bid_price, _ = orderbook.get_best_bid()
            best_ask_price, _ = orderbook.get_best_ask()
        except (ValueError, TypeError, IndexError):
            return

        if best_bid_price is None or best_ask_price is None:
            return

        bid = float(best_bid_price)
        ask = float(best_ask_price)
        mid = (bid + ask) / 2.0

        await self._on_l1(symbol, bid, ask, mid)

    # ── Redis Publishing ──

    async def _publish_l1(
        self, symbol: str, bid: float, ask: float, mid: float, ts: float
    ) -> None:
        """
        Publish L1 to Redis with throttling (500ms per symbol).
        Key: pms:price:BTCUSDT (Binance native format)
        TTL: 30 seconds
        """
        if not self._redis:
            return

        now_ms = ts * 1000
        last = self._last_publish_ts.get(symbol, 0) * 1000
        if (now_ms - last) < L1_PUBLISH_THROTTLE_MS:
            return  # Throttled

        self._last_publish_ts[symbol] = ts

        key = f"pms:price:{symbol}"
        value = json.dumps({
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "ts": int(now_ms),
            "source": "l1",
        })

        try:
            # Always try await first — redis.asyncio bound methods aren't
            # detected by asyncio.iscoroutinefunction, so we test the result.
            result = self._redis.set(key, value, ex=30)
            if asyncio.iscoroutine(result):
                await result
                pub = self._redis.publish(f"updates:{key}", value)
                if asyncio.iscoroutine(pub):
                    await pub
            else:
                # Sync Redis — already executed
                self._redis.publish(f"updates:{key}", value)
        except Exception as e:
            logger.error("Failed to publish L1 for %s: %s", symbol, e)

    # ── Stats ──

    def __repr__(self) -> str:
        return (
            f"MarketDataService("
            f"symbols={len(self._subscribed_symbols)}, "
            f"cached_l1={len(self._last_l1)}, "
            f"callbacks={sum(len(v) for v in self._callbacks.values())})"
        )
