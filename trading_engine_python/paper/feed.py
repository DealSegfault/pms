"""
PaperUserStream — Replaces UserStreamService in paper trading mode.

Instead of connecting to Binance WebSocket, this service:
1. Subscribes to MarketDataService L1 ticks for all symbols with pending orders
2. Routes ticks to MatchingEngine.on_tick() to check for fills
3. MatchingEngine fires ORDER_TRADE_UPDATE events → OrderManager.on_order_update()

Same interface as UserStreamService: start(), stop(), set_risk_engine().
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional, Set

logger = logging.getLogger(__name__)


class PaperUserStream:
    """
    Simulated user data stream for paper trading.

    Replaces UserStreamService — no WebSocket, no listen key.
    Drives the MatchingEngine from L1 price ticks.
    """

    def __init__(
        self,
        order_manager: Any,
        risk_engine: Any = None,
        matching_engine: Any = None,
        market_data: Any = None,
    ):
        self._order_manager = order_manager
        self._risk_engine = risk_engine
        self._matching = matching_engine
        self._market_data = market_data
        self._running = False
        self._subscribed_symbols: Set[str] = set()

        # Wire matching engine events → OrderManager
        if self._matching:
            self._matching.set_event_callback(self._on_order_event)

    def set_risk_engine(self, risk_engine: Any) -> None:
        """Wire up risk engine after creation."""
        self._risk_engine = risk_engine

    async def start(self) -> None:
        """
        Start the paper user stream.

        Subscribes a global tick handler to MarketDataService that
        forwards ALL L1 ticks to the matching engine.
        """
        self._running = True
        logger.info("🧻 PaperUserStream started — monitoring price ticks for order matching")

        # Run the tick router as a background task
        try:
            while self._running:
                # Re-subscribe to any new symbols that have pending orders
                await self._sync_subscriptions()
                await asyncio.sleep(1.0)  # Check for new symbols every second
        except asyncio.CancelledError:
            logger.info("PaperUserStream cancelled")

    async def stop(self) -> None:
        """Graceful shutdown."""
        self._running = False
        # Unsubscribe from all symbols
        if self._market_data:
            for symbol in list(self._subscribed_symbols):
                self._market_data.unsubscribe(symbol, self._on_l1_tick)
                self._subscribed_symbols.discard(symbol)
        logger.info("PaperUserStream stopped")

    async def _sync_subscriptions(self) -> None:
        """
        Ensure we're subscribed to L1 ticks for all symbols with pending orders.
        Also subscribes to symbols tracked by MarketDataService (algos subscribe
        to symbols when they start, so we piggyback on those subscriptions).
        """
        if not self._matching or not self._market_data:
            return

        # Get symbols with pending orders
        needed_symbols = set()
        for order in self._matching._pending.values():
            # Convert Binance symbol to ccxt for MarketDataService
            needed_symbols.add(self._binance_to_ccxt(order.symbol))

        # Also include any already-subscribed MarketData symbols
        # (algos may have subscribed before orders were placed)
        for sym in self._market_data.subscribed_symbols:
            needed_symbols.add(sym)

        # Subscribe to new symbols
        for symbol in needed_symbols:
            if symbol not in self._subscribed_symbols:
                self._market_data.subscribe(symbol, self._on_l1_tick)
                self._subscribed_symbols.add(symbol)
                logger.debug("PaperUserStream subscribed to L1 for %s", symbol)

    async def _on_l1_tick(self, symbol: str, bid: float, ask: float, mid: float) -> None:
        """
        L1 tick handler — routes to matching engine.
        Symbol comes in ccxt format from MarketDataService, convert to Binance.
        """
        if not self._matching:
            return

        binance_symbol = self._ccxt_to_binance(symbol)
        await self._matching.on_tick(binance_symbol, bid, ask, mid)

    async def _on_order_event(self, data: dict) -> None:
        """
        Receive ORDER_TRADE_UPDATE events from MatchingEngine
        and route to OrderManager.on_order_update().

        This is the same path as real UserStreamService._on_order_update().
        """
        try:
            await self._order_manager.on_order_update(data)
        except Exception as e:
            logger.error("Error routing paper order event: %s", e, exc_info=True)

    # ── Symbol Conversion ──

    @staticmethod
    def _binance_to_ccxt(symbol: str) -> str:
        """Convert BTCUSDT → BTC/USDT:USDT (ccxt format for MarketDataService)."""
        if "/" in symbol:
            return symbol  # Already ccxt
        # Strip USDT suffix, add ccxt format
        base = symbol.replace("USDT", "")
        return f"{base}/USDT:USDT"

    @staticmethod
    def _ccxt_to_binance(symbol: str) -> str:
        """Convert BTC/USDT:USDT → BTCUSDT (Binance native)."""
        return symbol.replace("/", "").replace(":USDT", "").upper()

    def __repr__(self) -> str:
        return (
            f"PaperUserStream(running={self._running}, "
            f"subscriptions={len(self._subscribed_symbols)})"
        )
