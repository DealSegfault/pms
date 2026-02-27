"""
commands — Typed command DTOs for Redis queue payloads.

Each command dataclass:
  - Has a `from_raw(raw: dict)` that validates and normalizes the incoming dict
  - Handles side/symbol normalization via contracts.common
  - Documents every field the Python handler expects

This replaces scattered cmd["field"] access with self-documenting typed access.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional

from .common import normalize_side, normalize_symbol


# ── Base ─────────────────────────────────────────────────────

@dataclass
class BaseCommand:
    """All commands include a requestId and subAccountId."""
    request_id: str = ""
    sub_account_id: str = ""

    @classmethod
    def _extract_base(cls, raw: dict) -> dict:
        return {
            "request_id": raw.get("requestId", "unknown"),
            "sub_account_id": raw.get("subAccountId", ""),
        }


# ── Order Commands ───────────────────────────────────────────

@dataclass
class TradeCommand(BaseCommand):
    """Market order command — pms:cmd:trade"""
    symbol: str = ""
    side: str = ""         # BUY/SELL (normalized)
    quantity: float = 0.0
    leverage: int = 1
    reduce_only: bool = False

    @classmethod
    def from_raw(cls, raw: dict) -> "TradeCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            quantity=float(raw["quantity"]),
            leverage=int(raw.get("leverage", 1)),
            reduce_only=bool(raw.get("reduceOnly", False)),
        )


@dataclass
class LimitCommand(BaseCommand):
    """Limit order command — pms:cmd:limit"""
    symbol: str = ""
    side: str = ""
    quantity: float = 0.0
    price: float = 0.0
    leverage: int = 1
    reduce_only: bool = False

    @classmethod
    def from_raw(cls, raw: dict) -> "LimitCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            quantity=float(raw["quantity"]),
            price=float(raw["price"]),
            leverage=int(raw.get("leverage", 1)),
            reduce_only=bool(raw.get("reduceOnly", False)),
        )


@dataclass
class ScaleLevelSpec:
    """One level in a scale order."""
    price: float = 0.0
    quantity: float = 0.0


@dataclass
class ScaleCommand(BaseCommand):
    """Scale/grid order command — pms:cmd:scale"""
    symbol: str = ""
    side: str = ""
    leverage: int = 1
    levels: List[ScaleLevelSpec] = field(default_factory=list)

    @classmethod
    def from_raw(cls, raw: dict) -> "ScaleCommand":
        base = cls._extract_base(raw)
        levels = [
            ScaleLevelSpec(
                price=float(lv["price"]),
                quantity=float(lv["quantity"]),
            )
            for lv in raw.get("levels", [])
        ]
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            leverage=int(raw.get("leverage", 1)),
            levels=levels,
        )


@dataclass
class CloseCommand(BaseCommand):
    """Close position command — pms:cmd:close"""
    symbol: str = ""
    side: str = ""
    quantity: float = 0.0

    @classmethod
    def from_raw(cls, raw: dict) -> "CloseCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            quantity=float(raw["quantity"]),
        )


@dataclass
class CancelCommand(BaseCommand):
    """Cancel single order command — pms:cmd:cancel"""
    client_order_id: str = ""

    @classmethod
    def from_raw(cls, raw: dict) -> "CancelCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            client_order_id=raw.get("clientOrderId", ""),
        )


@dataclass
class CancelAllCommand(BaseCommand):
    """Cancel all orders command — pms:cmd:cancel_all"""
    symbol: Optional[str] = None

    @classmethod
    def from_raw(cls, raw: dict) -> "CancelAllCommand":
        base = cls._extract_base(raw)
        symbol = raw.get("symbol")
        return cls(
            **base,
            symbol=symbol if symbol else None,
        )


# ── Algo Commands ────────────────────────────────────────────

@dataclass
class ChaseCommand(BaseCommand):
    """Start chase order command — pms:cmd:chase"""
    symbol: str = ""
    side: str = ""         # BUY/SELL (normalized)
    quantity: float = 0.0
    leverage: int = 1
    stalk_offset_pct: float = 0.0
    stalk_mode: str = "none"
    max_distance_pct: float = 2.0
    reduce_only: bool = False
    # Optional: parent scalper linkage
    parent_scalper_id: Optional[str] = None
    layer_idx: Optional[int] = None

    @classmethod
    def from_raw(cls, raw: dict) -> "ChaseCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            quantity=float(raw.get("quantity", 0)),
            leverage=int(raw.get("leverage", 1)),
            stalk_offset_pct=float(raw.get("stalkOffsetPct", 0)),
            stalk_mode=raw.get("stalkMode", "none"),
            max_distance_pct=float(raw.get("maxDistancePct", 2.0)),
            reduce_only=bool(raw.get("reduceOnly", False)),
            parent_scalper_id=raw.get("parentScalperId"),
            layer_idx=raw.get("layerIdx"),
        )


@dataclass
class ScalperCommand(BaseCommand):
    """Start scalper command — pms:cmd:scalper"""
    symbol: str = ""
    start_side: str = "LONG"
    leverage: int = 1
    child_count: int = 1
    skew: int = 0
    long_offset_pct: float = 0.3
    short_offset_pct: float = 0.3
    long_size_usd: float = 0.0
    short_size_usd: float = 0.0
    neutral_mode: bool = False
    long_max_price: Optional[float] = None
    short_min_price: Optional[float] = None
    min_fill_spread_pct: float = 0.0
    fill_decay_half_life_ms: float = 30000
    min_refill_delay_ms: float = 0
    allow_loss: bool = True

    @classmethod
    def from_raw(cls, raw: dict) -> "ScalperCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            start_side=raw.get("startSide", "LONG").upper(),
            leverage=int(raw.get("leverage", 1)),
            child_count=int(raw.get("childCount", 1)),
            skew=int(raw.get("skew", 0)),
            long_offset_pct=float(raw.get("longOffsetPct", 0.3)),
            short_offset_pct=float(raw.get("shortOffsetPct", 0.3)),
            long_size_usd=float(raw.get("longSizeUsd", 0)),
            short_size_usd=float(raw.get("shortSizeUsd", 0)),
            neutral_mode=bool(raw.get("neutralMode", False)),
            long_max_price=float(raw["longMaxPrice"]) if raw.get("longMaxPrice") else None,
            short_min_price=float(raw["shortMinPrice"]) if raw.get("shortMinPrice") else None,
            min_fill_spread_pct=float(raw.get("minFillSpreadPct", 0)),
            fill_decay_half_life_ms=float(raw.get("fillDecayHalfLifeMs", 30000)),
            min_refill_delay_ms=float(raw.get("minRefillDelayMs", 0)),
            allow_loss=bool(raw.get("allowLoss", True)),
        )


@dataclass
class TWAPCommand(BaseCommand):
    """Start TWAP command — pms:cmd:twap"""
    symbol: str = ""
    side: str = ""
    quantity: float = 0.0       # In coin units (direct)
    size_usdt: float = 0.0      # In USD (auto-converts)
    num_lots: int = 5
    interval_seconds: float = 60.0
    leverage: int = 1
    jitter_pct: float = 30.0
    irregular: bool = False

    @classmethod
    def from_raw(cls, raw: dict) -> "TWAPCommand":
        base = cls._extract_base(raw)
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            side=normalize_side(raw["side"]),
            quantity=float(raw.get("quantity", 0)),
            size_usdt=float(raw.get("sizeUsdt", 0)),
            num_lots=int(raw.get("numLots", raw.get("lots", 5))),
            interval_seconds=float(raw.get("intervalSeconds", raw.get("interval", 60))),
            leverage=int(raw.get("leverage", 1)),
            jitter_pct=float(raw.get("jitterPct", 30)),
            irregular=bool(raw.get("irregular", False)),
        )


@dataclass
class TWAPBasketLegSpec:
    """One leg in a TWAP basket."""
    symbol: str = ""
    side: str = ""
    quantity: float = 0.0
    size_usdt: float = 0.0


@dataclass
class TWAPBasketCommand(BaseCommand):
    """Start TWAP basket command — pms:cmd:twap_basket"""
    basket_name: str = ""
    num_lots: int = 5
    interval_seconds: float = 60.0
    leverage: int = 1
    legs: List[TWAPBasketLegSpec] = field(default_factory=list)

    @classmethod
    def from_raw(cls, raw: dict) -> "TWAPBasketCommand":
        base = cls._extract_base(raw)
        legs = [
            TWAPBasketLegSpec(
                symbol=leg.get("symbol", ""),
                side=normalize_side(leg["side"]),
                quantity=float(leg.get("quantity", 0)),
                size_usdt=float(leg.get("sizeUsdt", 0)),
            )
            for leg in raw.get("legs", [])
        ]
        return cls(
            **base,
            basket_name=raw.get("basketName", "Unnamed"),
            num_lots=int(raw.get("numLots", 5)),
            interval_seconds=float(raw.get("intervalSeconds", 60)),
            leverage=int(raw.get("leverage", 1)),
            legs=legs,
        )


@dataclass
class TrailStopCommand(BaseCommand):
    """Start trail stop command — pms:cmd:trail_stop"""
    symbol: str = ""
    position_side: str = ""       # LONG/SHORT
    quantity: float = 0.0
    callback_pct: float = 1.0
    activation_price: Optional[float] = None
    position_id: Optional[str] = None

    @classmethod
    def from_raw(cls, raw: dict) -> "TrailStopCommand":
        base = cls._extract_base(raw)
        # Accept callbackPct or trailPct
        callback_pct = float(
            raw.get("callbackPct", raw.get("trailPct", 1.0))
        )
        return cls(
            **base,
            symbol=raw.get("symbol", ""),
            position_side=raw.get("positionSide", raw.get("side", "LONG")).upper(),
            quantity=float(raw.get("quantity", 0)),
            callback_pct=callback_pct,
            activation_price=float(raw["activationPrice"]) if raw.get("activationPrice") else None,
            position_id=raw.get("positionId"),
        )
