from __future__ import annotations

from typing import Optional


def to_raw_symbol(symbol: str) -> str:
    """Convert CCXT-ish symbols to Binance raw futures symbols."""
    raw = str(symbol or "").upper().strip()
    if not raw:
        return ""
    if "/" in raw:
        # BTC/USDT:USDT -> BTCUSDT
        raw = raw.replace("/USDT:USDT", "USDT").replace("/", "")
    if raw.endswith(":USDT"):
        raw = raw.replace(":USDT", "USDT")
    return raw


def side_direction(side: str) -> str:
    side_up = str(side or "").upper()
    if side_up == "SHORT":
        return "SHORT"
    return "LONG"


def opposite_direction(side: str) -> str:
    return "SHORT" if side_direction(side) == "LONG" else "LONG"


def safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except Exception:
        return default


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def valid_price(value: Optional[float]) -> bool:
    return value is not None and value > 0

