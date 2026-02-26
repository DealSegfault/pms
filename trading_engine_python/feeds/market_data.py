"""
MarketDataService — L1 price provider wrapping existing depth handler.

Uses the existing BinanceFutures @depth@100ms handler (285 lines) to extract
best bid/ask (L1) from the orderbook. No new markPrice or bookTicker streams needed.

Architecture:
    BinanceFutures depth handler (existing)
        → process_orderbook_update()
        → OrderBook.get_best_bid() / get_best_ask()
        → MarketDataService._on_orderbook_update()
            → cache L1
            → publish to Redis (throttled)
            → fire-and-forget callbacks via asyncio.create_task()

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
L1_PUBLISH_THROTTLE_MS = 500


class MarketDataService:
    """
    Wraps existing BinanceFutures depth handler to provide L1 (best bid/ask).

    L1 = orderbook.bids[0] (best bid) and orderbook.asks[0] (best ask).
    No new streams needed — existing @depth@100ms already provides this.

    Callbacks are fired via asyncio.create_task() to avoid blocking the depth handler.
    """

    def __init__(self, redis_client: Any = None):
        self._redis = redis_client
        self._callbacks: Dict[str, List[Callable]] = {}   # symbol → [callbacks]
        self._last_l1: Dict[str, dict] = {}                # symbol → {bid, ask, mid, ts}
        self._last_publish_ts: Dict[str, float] = {}       # symbol → last Redis publish time
        self._subscribed_symbols: Set[str] = set()

    # ── Public API ──

    def subscribe(self, symbol: str, callback: Callable) -> None:
        """
        Register a callback for L1 price updates on a symbol.

        Callback signature: async def cb(symbol: str, bid: float, ask: float, mid: float)
        Callbacks are fired via asyncio.create_task() — non-blocking.
        """
        if symbol not in self._callbacks:
            self._callbacks[symbol] = []
        if callback not in self._callbacks[symbol]:
            self._callbacks[symbol].append(callback)
            self._subscribed_symbols.add(symbol)
            logger.info("Subscribed to L1 for %s (total callbacks: %d)", symbol, len(self._callbacks[symbol]))

    def unsubscribe(self, symbol: str, callback: Callable) -> None:
        """Remove a callback. Does NOT stop the depth handler (other consumers may exist)."""
        if symbol in self._callbacks:
            self._callbacks[symbol] = [cb for cb in self._callbacks[symbol] if cb is not callback]
            if not self._callbacks[symbol]:
                del self._callbacks[symbol]
                self._subscribed_symbols.discard(symbol)

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

    # ── Integration Point ──
    # Called by the existing depth handler's process_orderbook_update() flow.
    # The supervisor/main.py starts the depth handler; we hook into its output.

    async def on_orderbook_update(self, symbol: str, orderbook: Any) -> None:
        """
        Called when the depth handler processes an update.
        Extracts L1 from the orderbook object.

        Args:
            symbol: Binance format uppercase (BTCUSDT)
            orderbook: The OrderBook instance with .bids and .asks SortedDicts
        """
        try:
            best_bid_price, _ = orderbook.get_best_bid()
            best_ask_price, _ = orderbook.get_best_ask()
        except (ValueError, TypeError, IndexError):
            return  # Empty orderbook — skip

        if best_bid_price is None or best_ask_price is None:
            return

        bid = float(best_bid_price)
        ask = float(best_ask_price)
        mid = (bid + ask) / 2.0
        ts = time.time()

        # Check if L1 actually changed (avoid spamming on depth updates that don't move BBO)
        prev = self._last_l1.get(symbol)
        if prev and prev["bid"] == bid and prev["ask"] == ask:
            return  # BBO unchanged — skip

        # Update cache
        self._last_l1[symbol] = {"bid": bid, "ask": ask, "mid": mid, "ts": ts}

        # Publish to Redis (throttled)
        await self._publish_l1(symbol, bid, ask, mid, ts)

        # Fire callbacks — MUST be fire-and-forget to not block depth handler
        for cb in self._callbacks.get(symbol, []):
            asyncio.create_task(cb(symbol, bid, ask, mid))

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
            # SET with TTL + PUBLISH for subscribers
            if asyncio.iscoroutinefunction(getattr(self._redis, 'set', None)):
                await self._redis.set(key, value, ex=30)
                await self._redis.publish(f"updates:{key}", value)
            else:
                # Sync Redis client — wrap in thread
                await asyncio.to_thread(self._redis.set, key, value, ex=30)
                await asyncio.to_thread(self._redis.publish, f"updates:{key}", value)
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
