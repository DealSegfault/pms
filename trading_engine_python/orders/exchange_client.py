"""
ExchangeClient — Async wrapper around BinanceFutures REST client.

Provides:
- Async interface via asyncio.to_thread() (BinanceFutures is synchronous)
- Rate limiting via sliding window (reused from market_maker.py)
- Retry with exponential backoff for transient errors
- Throttle mode for exchange rate limit warnings

Usage:
    client = ExchangeClient(api_key="...", api_secret="...")
    result = await client.create_market_order("BTCUSDT", "BUY", 0.001)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from typing import Optional

# Lazy import — binance package may not be installed in all environments
try:
    from binance.error import ClientError
except ImportError:
    # Define a stub so the module can be imported for testing
    class ClientError(Exception):  # type: ignore
        error_code: int = 0
        error_message: str = ""

logger = logging.getLogger(__name__)

# Binance error codes
RETRYABLE_CODES = {-1003, -1015, 429}  # Too many requests, too many orders, rate limit
FATAL_CODES = {-2019, -2022, -4003}     # Margin insufficient, reduce-only rejected, qty too small
CANCEL_IGNORABLE_CODES = {-2011, -2021}  # Unknown order (already cancelled/filled), order would trigger


class RateLimiter:
    """
    Sliding window rate limiter — reused from market_maker.py pattern.
    Async-compatible: uses asyncio.sleep to wait until a slot opens.
    """

    def __init__(self, max_requests: int = 20, window_size: float = 1.0):
        self.max_requests = max_requests
        self.window_size = window_size
        self._timestamps: deque = deque()
        self.throttle_mode = False

    async def acquire(self) -> None:
        """Wait until a request slot is available."""
        while True:
            now = time.time()

            # Remove timestamps outside the window
            while self._timestamps and self._timestamps[0] < now - self.window_size:
                self._timestamps.popleft()

            effective_max = self.max_requests // 2 if self.throttle_mode else self.max_requests

            if len(self._timestamps) < effective_max:
                self._timestamps.append(now)
                return

            # Wait for the oldest request to expire
            wait_time = self._timestamps[0] + self.window_size - now + 0.01
            await asyncio.sleep(wait_time)

    @property
    def current_rate(self) -> float:
        """Current requests per second."""
        now = time.time()
        while self._timestamps and self._timestamps[0] < now - self.window_size:
            self._timestamps.popleft()
        return len(self._timestamps) / self.window_size

    def enable_throttle(self, enabled: bool = True) -> None:
        """Enable/disable throttle mode (50% of normal rate)."""
        if enabled != self.throttle_mode:
            logger.warning(
                "%s throttle mode (rate limit pressure)",
                "Enabling" if enabled else "Disabling",
            )
        self.throttle_mode = enabled


class ExchangeClient:
    """
    Async wrapper around BinanceFutures with rate limiting and retry.

    All methods use asyncio.to_thread() since BinanceFutures is synchronous.
    Rate limiter ensures we don't exceed exchange limits.
    Retry with exponential backoff handles transient network errors.
    """

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        max_requests_per_sec: int = 20,
        max_retries: int = 3,
        base_delay: float = 0.5,
    ):
        # Lazy import to avoid circular deps and allow mocking
        from trading_engine_python.oms.exchanges.binance.binance_futures import (
            BinanceFutures,
        )

        self._client = BinanceFutures(
            api_key=api_key or os.getenv("BINANCE_API_KEY", ""),
            api_secret=api_secret or os.getenv("BINANCE_API_SECRET", ""),
        )
        self._rate_limiter = RateLimiter(
            max_requests=max_requests_per_sec, window_size=1.0
        )
        self._max_retries = max_retries
        self._base_delay = base_delay

    # ── Symbol / Side Normalization (exchange boundary) ──

    _SIDE_MAP = {"LONG": "BUY", "SHORT": "SELL", "BUY": "BUY", "SELL": "SELL"}

    @staticmethod
    def _to_binance_symbol(symbol: str) -> str:
        """Convert any format to Binance: 'RAVE/USDT:USDT' → 'RAVEUSDT'."""
        s = symbol.replace("/", "").replace(":USDT", "").upper()
        if not s.endswith("USDT"):
            s += "USDT"
        return s

    @staticmethod
    def _to_binance_side(side: str) -> str:
        """Convert LONG→BUY, SHORT→SELL. Pass through BUY/SELL."""
        mapped = ExchangeClient._SIDE_MAP.get(side.upper())
        if not mapped:
            raise ValueError(f"Invalid side: {side}")
        return mapped

    # ── Order Methods ──

    async def create_market_order(
        self, symbol: str, side: str, quantity: float, **kwargs
    ) -> dict:
        """Place a market order. Returns exchange response dict."""
        return await self._execute(
            self._client.create_market_order,
            self._to_binance_symbol(symbol), self._to_binance_side(side),
            quantity, **kwargs
        )

    async def create_limit_order(
        self, symbol: str, side: str, quantity: float, price: float, **kwargs
    ) -> dict:
        """Place a limit order (GTC). Returns exchange response dict."""
        return await self._execute(
            self._client.create_limit_order,
            self._to_binance_symbol(symbol), self._to_binance_side(side),
            quantity, price, **kwargs
        )

    async def create_stop_market_order(
        self, symbol: str, side: str, quantity: float, stop_price: float, **kwargs
    ) -> dict:
        """Place a stop market order."""
        return await self._execute(
            self._client.create_stop_market_order,
            self._to_binance_symbol(symbol), self._to_binance_side(side),
            quantity, stop_price, **kwargs,
        )

    async def create_take_profit_market_order(
        self, symbol: str, side: str, quantity: float, stop_price: float, **kwargs
    ) -> dict:
        """Place a take profit market order."""
        return await self._execute(
            self._client.create_take_profit_market_order,
            self._to_binance_symbol(symbol), self._to_binance_side(side),
            quantity, stop_price, **kwargs,
        )

    async def cancel_order(
        self,
        symbol: str,
        orderId: Optional[int] = None,
        origClientOrderId: Optional[str] = None,
    ) -> dict:
        """Cancel an order by exchange ID or client order ID.

        Gracefully handles orders that are already gone on the exchange
        (-2011 Unknown order) by returning a synthetic cancel response
        instead of raising.
        """
        try:
            return await self._execute(
                self._client.cancel_order,
                self._to_binance_symbol(symbol),
                orderId=orderId,
                origClientOrderId=origClientOrderId,
            )
        except ClientError as e:
            if e.error_code in CANCEL_IGNORABLE_CODES:
                logger.info(
                    "Cancel ignored (code=%d, order already gone): %s",
                    e.error_code, origClientOrderId or orderId,
                )
                return {"status": "CANCELED", "alreadyGone": True}
            raise

    async def cancel_all_orders(self, symbol: str) -> dict:
        """Cancel all open orders for a symbol."""
        return await self._execute(
            self._client.cancel_all_orders, self._to_binance_symbol(symbol)
        )

    async def create_batch_limit_orders(self, orders: list[dict]) -> list[dict]:
        """Place multiple limit orders in batches of 5 (Binance batch API).
        
        Each order dict should have: symbol, side, quantity, price,
        and optionally: newClientOrderId, reduceOnly.
        
        Returns list of exchange responses (same order as input).
        """
        results = []
        # Chunk into batches of 5 (Binance limit)
        for i in range(0, len(orders), 5):
            chunk = orders[i:i + 5]
            # Build Binance batch order params
            batch_params = []
            for o in chunk:
                param = {
                    "symbol": self._to_binance_symbol(o["symbol"]),
                    "side": self._to_binance_side(o["side"]),
                    "type": "LIMIT",
                    "quantity": str(o["quantity"]),
                    "price": str(o["price"]),
                    "timeInForce": "GTC",
                }
                if o.get("newClientOrderId"):
                    param["newClientOrderId"] = o["newClientOrderId"]
                if o.get("reduceOnly"):
                    param["reduceOnly"] = "true"
                batch_params.append(param)
            
            batch_result = await self._execute(
                self._client.create_batch_orders, batch_params
            )
            results.extend(batch_result)
        
        return results

    async def cancel_batch_orders(
        self, symbol: str, client_order_ids: list[str]
    ) -> list[dict]:
        """Cancel multiple orders by client order ID in batches of 5.
        
        Returns list of cancel responses.
        """
        results = []
        for i in range(0, len(client_order_ids), 5):
            chunk = client_order_ids[i:i + 5]
            batch_result = await self._execute(
                self._client.cancel_batch_orders,
                self._to_binance_symbol(symbol),
                orig_client_order_id_list=chunk,
            )
            results.extend(batch_result)
        return results

    # ── Query Methods ──

    async def get_order(self, symbol: str, orderId: Optional[int] = None) -> dict:
        """Get order status."""
        return await self._execute(
            self._client.get_order, self._to_binance_symbol(symbol), orderId=orderId
        )

    async def get_open_orders(self, symbol: Optional[str] = None) -> list:
        """Get all open orders, optionally filtered by symbol."""
        if symbol:
            return await self._execute(self._client.get_open_orders, symbol=self._to_binance_symbol(symbol))
        return await self._execute(self._client.get_open_orders)

    async def get_position_risk(self, symbol: Optional[str] = None) -> list:
        """Get position risk for a symbol or all symbols."""
        s = self._to_binance_symbol(symbol) if symbol else None
        return await self._execute(self._client.get_position_risk, symbol=s)

    async def get_balance(self) -> list:
        """Get account balance."""
        return await self._execute(self._client.get_balance)

    async def get_account_info(self) -> dict:
        """Get full account info."""
        return await self._execute(self._client.get_account_info)

    async def get_exchange_info(self) -> dict:
        """Get exchange information (symbols, filters, rate limits)."""
        return await self._execute(self._client.get_exchange_info)

    # ── Leverage / Margin ──

    async def change_leverage(self, symbol: str, leverage: int) -> dict:
        """Set leverage for a symbol."""
        return await self._execute(
            self._client.change_leverage, self._to_binance_symbol(symbol), leverage
        )

    async def change_margin_type(self, symbol: str, margin_type: str) -> dict:
        """Set margin type (ISOLATED / CROSSED)."""
        return await self._execute(
            self._client.change_margin_type, self._to_binance_symbol(symbol), margin_type
        )

    # ── Listen Key (for user stream) ──

    async def create_listen_key(self) -> str:
        """Create a listen key for user data stream."""
        result = await self._execute(self._client.new_listen_key)
        return result.get("listenKey", "")

    async def renew_listen_key(self) -> None:
        """Keepalive for the listen key (call every 30 min)."""
        await self._execute(self._client.renew_listen_key)

    # ── Internal: Rate Limit + Retry ──

    async def _execute(self, fn, *args, **kwargs) -> any:
        """Rate limit → retry → execute in thread pool."""
        await self._rate_limiter.acquire()
        return await self._with_retry(fn, *args, **kwargs)

    async def _with_retry(self, fn, *args, **kwargs) -> any:
        """
        Exponential backoff retry (from market_maker._place_order_with_latency pattern).
        Retries on transient errors, fails fast on fatal errors.
        """
        last_error = None

        for attempt in range(self._max_retries):
            try:
                return await asyncio.to_thread(fn, *args, **kwargs)

            except ClientError as e:
                last_error = e

                # Fatal — don't retry
                if e.error_code in FATAL_CODES:
                    logger.error(
                        "Fatal exchange error (code=%d): %s",
                        e.error_code, e.error_message,
                    )
                    raise

                # Retryable — backoff
                if e.error_code in RETRYABLE_CODES and attempt < self._max_retries - 1:
                    delay = self._base_delay * (2 ** attempt)
                    logger.warning(
                        "Retryable error (code=%d), attempt %d/%d, waiting %.1fs",
                        e.error_code, attempt + 1, self._max_retries, delay,
                    )
                    self._rate_limiter.enable_throttle(True)
                    await asyncio.sleep(delay)
                    continue

                # Non-retryable client error
                raise

            except (ConnectionError, TimeoutError, OSError) as e:
                last_error = e
                if attempt < self._max_retries - 1:
                    delay = self._base_delay * (2 ** attempt)
                    logger.warning(
                        "Network error (%s), attempt %d/%d, waiting %.1fs",
                        type(e).__name__, attempt + 1, self._max_retries, delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                raise

            except Exception as e:
                # Unexpected error — don't retry
                logger.error("Unexpected error in exchange call: %s", e)
                raise

        # Should never reach here, but just in case
        raise last_error  # type: ignore

    @property
    def rate_limiter(self) -> RateLimiter:
        """Expose rate limiter for external monitoring."""
        return self._rate_limiter
