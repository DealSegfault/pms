"""
common — Shared normalization, timestamps, and event type constants.

This is the SINGLE source of truth for side/symbol normalization.
All engines must import from here — no inline copies.
"""

from __future__ import annotations

import time
from typing import Optional


# ── Side Normalization ───────────────────────────────────────

_SIDE_MAP = {
    "LONG": "BUY", "SHORT": "SELL",
    "BUY": "BUY", "SELL": "SELL",
    "long": "BUY", "short": "SELL",
    "buy": "BUY", "sell": "SELL",
}


def normalize_side(side: str) -> str:
    """LONG→BUY, SHORT→SELL. Pass through BUY/SELL unchanged.

    Raises ValueError for unknown sides.
    """
    mapped = _SIDE_MAP.get(side)
    if mapped is None:
        mapped = _SIDE_MAP.get(side.upper())
    if mapped is None:
        raise ValueError(f"Invalid side: {side!r}")
    return mapped


def position_side_from_order(order_side: str) -> str:
    """BUY→LONG, SELL→SHORT."""
    return "LONG" if order_side == "BUY" else "SHORT"


def close_side_from_position(position_side: str) -> str:
    """LONG→SELL, SHORT→BUY."""
    return "SELL" if position_side == "LONG" else "BUY"


# ── Symbol Normalization ─────────────────────────────────────

def normalize_symbol(symbol: str) -> str:
    """Convert any symbol format to Binance-native — ONLY for exchange boundary.

    Internal code should use ccxt format (DOGE/USDT:USDT).
    Use this ONLY when calling Binance REST/WS APIs.

    'DOGE/USDT:USDT' → 'DOGEUSDT'
    'DOGE/USDT'      → 'DOGEUSDT'
    'DOGEUSDT'       → 'DOGEUSDT'
    """
    s = symbol.replace("/", "").replace(":USDT", "").upper()
    if not s.endswith("USDT"):
        s += "USDT"
    return s


def to_ccxt_symbol(binance_symbol: str) -> str:
    """Convert Binance-native to ccxt format for display.

    'DOGEUSDT' → 'DOGE/USDT:USDT'
    """
    base = binance_symbol.replace("USDT", "")
    return f"{base}/USDT:USDT"


def to_slash_symbol(binance_symbol: str) -> str:
    """Convert Binance-native to slash format for display.

    'DOGEUSDT' → 'DOGE/USDT'
    """
    base = binance_symbol.replace("USDT", "")
    return f"{base}/USDT"


# ── Timestamps ───────────────────────────────────────────────

def ts_ms() -> int:
    """Current timestamp in milliseconds (JS-compatible)."""
    return int(time.time() * 1000)


def ts_s_to_ms(ts_seconds: float) -> int:
    """Convert Python time.time() seconds to milliseconds."""
    return int(ts_seconds * 1000)


# ── Event Type Constants ─────────────────────────────────────

class EventType:
    """All Redis PUB/SUB event type names.

    Channel format: pms:events:{event_type}
    """

    # Order lifecycle
    ORDER_PLACED = "order_placed"
    ORDER_ACTIVE = "order_active"
    ORDER_FILLED = "order_filled"
    ORDER_CANCELLED = "order_cancelled"
    ORDER_FAILED = "order_failed"
    ORDER_PARTIAL = "order_partial"

    # Chase algo
    CHASE_PROGRESS = "chase_progress"
    CHASE_FILLED = "chase_filled"
    CHASE_CANCELLED = "chase_cancelled"

    # Scalper algo
    SCALPER_PROGRESS = "scalper_progress"
    SCALPER_FILLED = "scalper_filled"
    SCALPER_CANCELLED = "scalper_cancelled"

    # TWAP algo
    TWAP_PROGRESS = "twap_progress"
    TWAP_COMPLETED = "twap_completed"
    TWAP_CANCELLED = "twap_cancelled"

    # TWAP basket
    TWAP_BASKET_PROGRESS = "twap_basket_progress"
    TWAP_BASKET_COMPLETED = "twap_basket_completed"
    TWAP_BASKET_CANCELLED = "twap_basket_cancelled"

    # Trail stop
    TRAIL_STOP_PROGRESS = "trail_stop_progress"
    TRAIL_STOP_TRIGGERED = "trail_stop_triggered"
    TRAIL_STOP_CANCELLED = "trail_stop_cancelled"

    # Position lifecycle
    POSITION_UPDATED = "position_updated"
    POSITION_CLOSED = "position_closed"
    POSITION_REDUCED = "position_reduced"

    # Account
    MARGIN_UPDATE = "margin_update"
    PNL_UPDATE = "pnl_update"

    # Liquidation
    FULL_LIQUIDATION = "full_liquidation"
    ADL_TRIGGERED = "adl_triggered"
    MARGIN_WARNING = "margin_warning"


# ── Redis Key Prefixes ───────────────────────────────────────

class RedisKey:
    """All Redis key patterns used across the system."""

    # Command queues (JS → Python via LPUSH/BLPOP)
    CMD_TRADE = "pms:cmd:trade"
    CMD_LIMIT = "pms:cmd:limit"
    CMD_SCALE = "pms:cmd:scale"
    CMD_CLOSE = "pms:cmd:close"
    CMD_CLOSE_ALL = "pms:cmd:close_all"
    CMD_CANCEL = "pms:cmd:cancel"
    CMD_CANCEL_ALL = "pms:cmd:cancel_all"
    CMD_BASKET = "pms:cmd:basket"
    CMD_CHASE = "pms:cmd:chase"
    CMD_CHASE_CANCEL = "pms:cmd:chase_cancel"
    CMD_SCALPER = "pms:cmd:scalper"
    CMD_SCALPER_CANCEL = "pms:cmd:scalper_cancel"
    CMD_TWAP = "pms:cmd:twap"
    CMD_TWAP_CANCEL = "pms:cmd:twap_cancel"
    CMD_TWAP_BASKET = "pms:cmd:twap_basket"
    CMD_TWAP_BASKET_CANCEL = "pms:cmd:twap_basket_cancel"
    CMD_TRAIL_STOP = "pms:cmd:trail_stop"
    CMD_TRAIL_STOP_CANCEL = "pms:cmd:trail_stop_cancel"
    CMD_VALIDATE = "pms:cmd:validate"

    # Result keys (Python → JS via SET/GET)
    @staticmethod
    def result(request_id: str) -> str:
        return f"pms:result:{request_id}"

    # Algo state (Python → Redis SET)
    @staticmethod
    def chase(chase_id: str) -> str:
        return f"pms:chase:{chase_id}"

    @staticmethod
    def active_chase(sub_account_id: str) -> str:
        return f"pms:active_chase:{sub_account_id}"

    @staticmethod
    def scalper(scalper_id: str) -> str:
        return f"pms:scalper:{scalper_id}"

    @staticmethod
    def active_scalper(sub_account_id: str) -> str:
        return f"pms:active_scalper:{sub_account_id}"

    @staticmethod
    def twap(twap_id: str) -> str:
        return f"pms:twap:{twap_id}"

    @staticmethod
    def active_twap(sub_account_id: str) -> str:
        return f"pms:active_twap:{sub_account_id}"

    @staticmethod
    def twap_basket(basket_id: str) -> str:
        return f"pms:twap_basket:{basket_id}"

    @staticmethod
    def active_twap_basket(sub_account_id: str) -> str:
        return f"pms:active_twap_basket:{sub_account_id}"

    @staticmethod
    def trail_stop(ts_id: str) -> str:
        return f"pms:trail_stop:{ts_id}"

    @staticmethod
    def active_trail_stop(sub_account_id: str) -> str:
        return f"pms:active_trail_stop:{sub_account_id}"

    # Risk / price / order
    @staticmethod
    def risk(sub_account_id: str) -> str:
        return f"pms:risk:{sub_account_id}"

    @staticmethod
    def price(symbol: str) -> str:
        return f"pms:price:{symbol}"

    @staticmethod
    def order(exchange_order_id: str) -> str:
        return f"pms:order:{exchange_order_id}"

    @staticmethod
    def open_orders(sub_account_id: str) -> str:
        return f"pms:open_orders:{sub_account_id}"

    # Event channels (Python → JS via PUBLISH)
    @staticmethod
    def event_channel(event_type: str) -> str:
        return f"pms:events:{event_type}"
