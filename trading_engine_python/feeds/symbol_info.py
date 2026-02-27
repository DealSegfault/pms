"""
SymbolInfoCache — Fetches and caches Binance exchange info for order rounding.

Loaded once on startup via `await cache.load(exchange_client)`.
Used by OrderManager to round price/quantity to valid precision before
sending to exchange. This single integration point fixes ALL order types
(market, limit, scale, chase, scalper, twap, trail stop).

Binance filters parsed:
- PRICE_FILTER  → tickSize (price precision)
- LOT_SIZE      → stepSize, minQty, maxQty (limit order qty precision)
- MARKET_LOT_SIZE → stepSize (market order qty precision)
- MIN_NOTIONAL  → notional (minimum order value)
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def _step_to_precision(step: float) -> int:
    """Convert step size (e.g. 0.001) to number of decimal places (3)."""
    if step <= 0 or step >= 1:
        return 0
    return max(0, int(round(-math.log10(step))))


def _truncate(value: float, precision: int) -> float:
    """Truncate (floor) a float to N decimal places. Never rounds up."""
    if precision <= 0:
        return float(int(value))
    factor = 10 ** precision
    return math.floor(value * factor) / factor


@dataclass
class SymbolSpec:
    """Parsed filter data for a single symbol."""
    symbol: str
    tick_size: float = 0.01
    step_size: float = 0.001         # LOT_SIZE stepSize (for limit orders)
    market_step_size: float = 0.001  # MARKET_LOT_SIZE stepSize (for market orders)
    min_qty: float = 0.001
    max_qty: float = 9999999.0
    min_notional: float = 5.0
    price_precision: int = 2
    qty_precision: int = 3
    market_qty_precision: int = 3


class SymbolInfoCache:
    """
    Fetches and caches Binance USDT-M futures exchange info.

    Usage:
        cache = SymbolInfoCache()
        await cache.load(exchange_client)

        price = cache.round_price("BTCUSDT", 65432.123456)
        qty   = cache.round_quantity("BTCUSDT", 0.001234, is_market=True)
    """

    def __init__(self):
        self._specs: Dict[str, SymbolSpec] = {}

    @staticmethod
    def _norm_key(symbol: str) -> str:
        """Normalize any symbol format to Binance key: RAVE/USDT:USDT → RAVEUSDT."""
        s = symbol.replace("/", "").replace(":USDT", "").upper()
        if not s.endswith("USDT"):
            s += "USDT"
        return s

    async def load(self, exchange_client: Any) -> int:
        """
        Fetch exchange info and parse filters for all symbols.
        Returns number of symbols loaded.
        """
        try:
            info = await exchange_client.get_exchange_info()
            symbols = info.get("symbols", [])

            for s in symbols:
                sym = s.get("symbol", "")
                if not sym or s.get("contractType") != "PERPETUAL":
                    continue
                if s.get("status") != "TRADING":
                    continue

                spec = SymbolSpec(symbol=sym)

                for f in s.get("filters", []):
                    ft = f.get("filterType", "")

                    if ft == "PRICE_FILTER":
                        spec.tick_size = float(f.get("tickSize", 0.01))
                        spec.price_precision = _step_to_precision(spec.tick_size)

                    elif ft == "LOT_SIZE":
                        spec.step_size = float(f.get("stepSize", 0.001))
                        spec.min_qty = float(f.get("minQty", 0.001))
                        spec.max_qty = float(f.get("maxQty", 9999999))
                        spec.qty_precision = _step_to_precision(spec.step_size)

                    elif ft == "MARKET_LOT_SIZE":
                        spec.market_step_size = float(f.get("stepSize", 0.001))
                        spec.market_qty_precision = _step_to_precision(spec.market_step_size)

                    elif ft == "MIN_NOTIONAL":
                        spec.min_notional = float(f.get("notional", 5.0))

                self._specs[sym] = spec

            logger.info("Loaded %d symbol specs from exchange info", len(self._specs))
            return len(self._specs)

        except Exception as e:
            logger.error("Failed to load exchange info: %s", e)
            return 0

    def get(self, symbol: str) -> Optional[SymbolSpec]:
        """Get spec for a symbol, or None if unknown."""
        return self._specs.get(self._norm_key(symbol))

    def round_price(self, symbol: str, price: float) -> float:
        """Round price to valid tick size precision (truncate down)."""
        spec = self._specs.get(self._norm_key(symbol))
        if not spec:
            return price
        return _truncate(price, spec.price_precision)

    def round_quantity(self, symbol: str, qty: float, is_market: bool = False) -> float:
        """Round quantity to valid step size precision (truncate down)."""
        spec = self._specs.get(self._norm_key(symbol))
        if not spec:
            return qty
        precision = spec.market_qty_precision if is_market else spec.qty_precision
        result = _truncate(qty, precision)
        result = max(spec.min_qty, min(result, spec.max_qty))
        return result

    def get_min_notional(self, symbol: str) -> float:
        """Get minimum notional for a symbol."""
        spec = self._specs.get(self._norm_key(symbol))
        return spec.min_notional if spec else 5.0

    def __len__(self) -> int:
        return len(self._specs)

    def __contains__(self, symbol: str) -> bool:
        return self._norm_key(symbol) in self._specs

    def __repr__(self) -> str:
        return f"SymbolInfoCache({len(self._specs)} symbols)"
