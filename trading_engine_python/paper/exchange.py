"""
PaperExchangeClient — Drop-in replacement for ExchangeClient in paper mode.

Same method signatures as ExchangeClient so OrderManager, algo engines,
and all other consumers see zero difference.

Design:
- Order methods (create_*, cancel_*) → delegate to MatchingEngine
- Query methods (get_balance, get_position_risk) → delegate to PaperWallet
- Exchange info (get_exchange_info) → proxied to REAL Binance (needed for SymbolInfoCache)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

logger = logging.getLogger(__name__)


class PaperExchangeClient:
    """
    Async exchange client for paper trading — same interface as ExchangeClient.

    All order methods go through the MatchingEngine (no real exchange calls).
    get_exchange_info() is proxied to real Binance for SymbolInfoCache to work.
    """

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        max_requests_per_sec: int = 20,
        max_retries: int = 3,
        base_delay: float = 0.5,
    ):
        from trading_engine_python.paper.wallet import PaperWallet
        from trading_engine_python.paper.matching import MatchingEngine

        self._wallet = PaperWallet()
        self._matching = MatchingEngine()

        # Real client — ONLY used for get_exchange_info() (symbol specs)
        self._real_client = None
        self._api_key = api_key or os.getenv("BINANCE_API_KEY", "")
        self._api_secret = api_secret or os.getenv("BINANCE_API_SECRET", "")

        # Fake rate limiter for compatibility
        self._rate_limiter = _FakeRateLimiter()

        logger.info("PaperExchangeClient created (wallet: %s)", self._wallet)

    @property
    def matching_engine(self):
        """Expose matching engine for PaperUserStream to wire up."""
        return self._matching

    @property
    def wallet(self):
        """Expose wallet for external queries."""
        return self._wallet

    # ── Symbol / Side Normalization (copied from ExchangeClient — exchange boundary) ──

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
        mapped = PaperExchangeClient._SIDE_MAP.get(side.upper())
        if not mapped:
            raise ValueError(f"Invalid side: {side}")
        return mapped

    # ── Order Methods ──

    async def create_market_order(
        self, symbol: str, side: str, quantity: float, **kwargs
    ) -> dict:
        """Place a simulated market order — filled on next tick."""
        sym = self._to_binance_symbol(symbol)
        s = self._to_binance_side(side)
        coid = kwargs.get("newClientOrderId", f"PAPER_MKT_{int(time.time()*1000)}")
        reduce_only = kwargs.get("reduceOnly", False)

        order = self._matching.add_order(
            client_order_id=coid,
            symbol=sym,
            side=s,
            order_type="MARKET",
            quantity=quantity,
            reduce_only=reduce_only,
        )
        return self._matching._to_binance_response(order)

    async def create_limit_order(
        self, symbol: str, side: str, quantity: float, price: float, **kwargs
    ) -> dict:
        """Place a simulated limit order — fills when price crosses."""
        sym = self._to_binance_symbol(symbol)
        s = self._to_binance_side(side)
        coid = kwargs.get("newClientOrderId", f"PAPER_LMT_{int(time.time()*1000)}")
        reduce_only = kwargs.get("reduceOnly", False)

        order = self._matching.add_order(
            client_order_id=coid,
            symbol=sym,
            side=s,
            order_type="LIMIT",
            quantity=quantity,
            price=price,
            reduce_only=reduce_only,
        )

        # Schedule NEW event emission (simulates exchange acceptance)
        asyncio.get_event_loop().call_soon(
            asyncio.ensure_future,
            self._matching._emit_new_event(order),
        )

        return self._matching._to_binance_response(order)

    async def create_stop_market_order(
        self, symbol: str, side: str, quantity: float, stop_price: float, **kwargs
    ) -> dict:
        """Place a simulated stop market order."""
        sym = self._to_binance_symbol(symbol)
        s = self._to_binance_side(side)
        coid = kwargs.get("newClientOrderId", f"PAPER_STP_{int(time.time()*1000)}")
        reduce_only = kwargs.get("reduceOnly", False)

        order = self._matching.add_order(
            client_order_id=coid,
            symbol=sym,
            side=s,
            order_type="STOP_MARKET",
            quantity=quantity,
            stop_price=stop_price,
            reduce_only=reduce_only,
        )
        return self._matching._to_binance_response(order)

    async def create_take_profit_market_order(
        self, symbol: str, side: str, quantity: float, stop_price: float, **kwargs
    ) -> dict:
        """Place a simulated take profit market order."""
        sym = self._to_binance_symbol(symbol)
        s = self._to_binance_side(side)
        coid = kwargs.get("newClientOrderId", f"PAPER_TPM_{int(time.time()*1000)}")
        reduce_only = kwargs.get("reduceOnly", False)

        order = self._matching.add_order(
            client_order_id=coid,
            symbol=sym,
            side=s,
            order_type="TAKE_PROFIT_MARKET",
            quantity=quantity,
            stop_price=stop_price,
            reduce_only=reduce_only,
        )
        return self._matching._to_binance_response(order)

    async def cancel_order(
        self,
        symbol: str,
        orderId: Optional[int] = None,
        origClientOrderId: Optional[str] = None,
    ) -> dict:
        """Cancel a paper order."""
        order = self._matching.cancel_order(
            client_order_id=origClientOrderId,
            order_id=orderId,
        )
        if order:
            return self._matching._to_binance_response(order)
        # Order not found — return synthetic response (like real exchange)
        return {"status": "CANCELED", "alreadyGone": True}

    async def cancel_all_orders(self, symbol: str) -> dict:
        """Cancel all paper orders for a symbol."""
        sym = self._to_binance_symbol(symbol)
        count = self._matching.cancel_all_for_symbol(sym)
        return {"code": 200, "msg": f"Cancelled {count} orders"}

    async def create_batch_limit_orders(self, orders: list[dict]) -> list[dict]:
        """Place multiple limit orders."""
        results = []
        for o in orders:
            result = await self.create_limit_order(
                symbol=o["symbol"],
                side=o["side"],
                quantity=float(o["quantity"]),
                price=float(o["price"]),
                newClientOrderId=o.get("newClientOrderId"),
                reduceOnly=o.get("reduceOnly", False),
            )
            results.append(result)
        return results

    async def cancel_batch_orders(
        self, symbol: str, client_order_ids: list[str]
    ) -> list[dict]:
        """Cancel multiple orders by client order ID."""
        results = []
        for coid in client_order_ids:
            result = await self.cancel_order(symbol, origClientOrderId=coid)
            results.append(result)
        return results

    # ── Query Methods ──

    async def get_order(self, symbol: str, orderId: Optional[int] = None) -> dict:
        """Get order status."""
        # Check pending orders
        for o in self._matching._pending.values():
            if o.order_id == orderId:
                return self._matching._to_binance_order(o)
        return {"orderId": orderId, "status": "UNKNOWN"}

    async def get_open_orders(self, symbol: Optional[str] = None) -> list:
        """Get all open paper orders."""
        sym = self._to_binance_symbol(symbol) if symbol else None
        return self._matching.get_open_orders(sym)

    async def get_position_risk(self, symbol: Optional[str] = None) -> list:
        """Get position risk from virtual wallet."""
        sym = self._to_binance_symbol(symbol) if symbol else None
        return self._wallet.get_position_risk_response(sym)

    async def get_balance(self) -> list:
        """Get virtual balance."""
        return self._wallet.get_balance_response()

    async def get_account_info(self) -> dict:
        """Get virtual account info."""
        return self._wallet.get_account_info_response()

    async def get_exchange_info(self) -> dict:
        """
        Fetch REAL exchange info from Binance.
        SymbolInfoCache needs real filter data (tick sizes, step sizes).
        """
        if not self._real_client:
            from trading_engine_python.oms.exchanges.binance.binance_futures import (
                BinanceFutures,
            )
            self._real_client = BinanceFutures(
                api_key=self._api_key,
                api_secret=self._api_secret,
            )

        return await asyncio.to_thread(self._real_client.get_exchange_info)

    # ── Leverage / Margin ──

    async def change_leverage(self, symbol: str, leverage: int) -> dict:
        """Set leverage in virtual wallet."""
        sym = self._to_binance_symbol(symbol)
        return self._wallet.set_leverage(sym, leverage)

    async def change_margin_type(self, symbol: str, margin_type: str) -> dict:
        """Set margin type in virtual wallet."""
        sym = self._to_binance_symbol(symbol)
        return self._wallet.set_margin_type(sym, margin_type)

    # ── Listen Key (no-op for paper) ──

    async def create_listen_key(self) -> str:
        return "paper_listen_key"

    async def renew_listen_key(self) -> None:
        pass

    # ── Compatibility ──

    @property
    def rate_limiter(self):
        """Expose fake rate limiter for monitoring compatibility."""
        return self._rate_limiter


class _FakeRateLimiter:
    """Stub rate limiter for paper mode — no actual throttling."""
    throttle_mode = False

    async def acquire(self):
        pass

    @property
    def current_rate(self):
        return 0.0

    def enable_throttle(self, enabled=True):
        self.throttle_mode = enabled
