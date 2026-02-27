"""
state — Redis-persisted state DTOs.

These define what Python writes to Redis SET/HSET for JS to read via HGETALL.
The JS algos.js route handlers map these shapes to REST responses.

Key convention: JSON keys in camelCase, matching the JS consumer expectations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .common import ts_ms, ts_s_to_ms


# ══════════════════════════════════════════════════════════════
# Chase State
# ══════════════════════════════════════════════════════════════

@dataclass
class ChaseRedisState:
    """Persisted to pms:chase:{chaseId} and pms:active_chase:{subAccountId}."""
    chase_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""                    # ccxt format (e.g. STEEM/USDT:USDT)
    side: str = ""                      # BUY / SELL
    quantity: float = 0.0
    leverage: int = 1
    stalk_mode: str = "maintain"
    stalk_offset_pct: float = 0.0
    max_distance_pct: float = 2.0
    status: str = "ACTIVE"
    reprice_count: int = 0
    started_at: int = 0                 # ms (always!)
    current_order_price: Optional[float] = None
    size_usd: float = 0.0
    reduce_only: bool = False
    parent_scalper_id: Optional[str] = None
    layer_idx: Optional[int] = None
    paused: bool = False
    retry_at: Optional[int] = None      # ms

    def to_dict(self) -> dict:
        d = {
            "chaseId": self.chase_id,
            "subAccountId": self.sub_account_id,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": self.quantity,
            "leverage": self.leverage,
            "stalkMode": self.stalk_mode,
            "stalkOffsetPct": self.stalk_offset_pct,
            "maxDistancePct": self.max_distance_pct,
            "status": self.status,
            "repriceCount": self.reprice_count,
            "startedAt": self.started_at,
            "currentOrderPrice": self.current_order_price,
            "sizeUsd": self.size_usd,
            "reduceOnly": self.reduce_only,
        }
        if self.parent_scalper_id:
            d["parentScalperId"] = self.parent_scalper_id
        if self.layer_idx is not None:
            d["layerIdx"] = self.layer_idx
        if self.paused:
            d["paused"] = True
        if self.retry_at:
            d["retryAt"] = self.retry_at
        return d


# ══════════════════════════════════════════════════════════════
# Scalper State
# ══════════════════════════════════════════════════════════════

@dataclass
class ScalperSlotSnapshot:
    """One slot in a scalper state snapshot."""
    layer_idx: int = 0
    side: str = ""
    qty: float = 0.0
    offset_pct: float = 0.0
    active: bool = False
    paused: bool = False
    retry_at: Optional[int] = None
    retry_count: int = 0
    fills: int = 0

    def to_dict(self) -> dict:
        return {
            "layerIdx": self.layer_idx,
            "side": self.side,
            "qty": self.qty,
            "offsetPct": self.offset_pct,
            "active": self.active,
            "paused": self.paused,
            "retryAt": self.retry_at,
            "retryCount": self.retry_count,
            "fills": self.fills,
        }


@dataclass
class ScalperRedisState:
    """Persisted to pms:scalper:{scalperId} and pms:active_scalper:{subAccountId}."""
    scalper_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    start_side: str = "LONG"
    child_count: int = 1
    status: str = "ACTIVE"
    fill_count: int = 0
    long_offset_pct: float = 0.3
    short_offset_pct: float = 0.3
    long_size_usd: float = 0.0
    short_size_usd: float = 0.0
    neutral_mode: bool = False
    leverage: int = 1
    skew: int = 0
    long_max_price: Optional[float] = None
    short_min_price: Optional[float] = None
    min_fill_spread_pct: float = 0.0
    fill_decay_half_life_ms: float = 30000
    min_refill_delay_ms: float = 0
    allow_loss: bool = True
    started_at: int = 0                 # ms (always!)
    reduce_only_armed: bool = False

    def to_dict(self) -> dict:
        return {
            "scalperId": self.scalper_id,
            "subAccountId": self.sub_account_id,
            "symbol": self.symbol,
            "startSide": self.start_side,
            "childCount": self.child_count,
            "status": self.status,
            "totalFillCount": self.fill_count,
            "longOffsetPct": self.long_offset_pct,
            "shortOffsetPct": self.short_offset_pct,
            "longSizeUsd": self.long_size_usd,
            "shortSizeUsd": self.short_size_usd,
            "neutralMode": self.neutral_mode,
            "leverage": self.leverage,
            "skew": self.skew,
            "longMaxPrice": self.long_max_price,
            "shortMinPrice": self.short_min_price,
            "minFillSpreadPct": self.min_fill_spread_pct,
            "fillDecayHalfLifeMs": self.fill_decay_half_life_ms,
            "minRefillDelayMs": self.min_refill_delay_ms,
            "allowLoss": self.allow_loss,
            "startedAt": self.started_at,
        }


# ══════════════════════════════════════════════════════════════
# TWAP State
# ══════════════════════════════════════════════════════════════

@dataclass
class TWAPRedisState:
    """Persisted to pms:twap:{twapId} and pms:active_twap:{subAccountId}."""
    twap_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    total_quantity: float = 0.0
    num_lots: int = 0
    interval_seconds: float = 60.0
    leverage: int = 1
    filled_lots: int = 0
    filled_quantity: float = 0.0
    status: str = "ACTIVE"
    started_at: int = 0
    basket_id: Optional[str] = None
    lot_sizes: List[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {
            "twapId": self.twap_id,
            "subAccountId": self.sub_account_id,
            "symbol": self.symbol,
            "side": self.side,
            "totalQuantity": self.total_quantity,
            "numLots": self.num_lots,
            "intervalSeconds": self.interval_seconds,
            "leverage": self.leverage,
            "filledLots": self.filled_lots,
            "filledQuantity": self.filled_quantity,
            "status": self.status,
            "startedAt": self.started_at,
        }
        if self.basket_id:
            d["basketId"] = self.basket_id
        if self.lot_sizes:
            d["lotSizes"] = self.lot_sizes
        return d


@dataclass
class TWAPBasketRedisState:
    """Persisted to pms:twap_basket:{basketId}."""
    basket_id: str = ""
    sub_account_id: str = ""
    basket_name: str = ""
    twap_ids: List[str] = field(default_factory=list)
    total_lots: int = 0
    filled_lots: int = 0
    status: str = "ACTIVE"
    started_at: int = 0

    def to_dict(self) -> dict:
        return {
            "twapBasketId": self.basket_id,
            "subAccountId": self.sub_account_id,
            "basketName": self.basket_name,
            "twapIds": self.twap_ids,
            "totalLots": self.total_lots,
            "filledLots": self.filled_lots,
            "status": self.status,
            "startedAt": self.started_at,
        }


# ══════════════════════════════════════════════════════════════
# Trail Stop State
# ══════════════════════════════════════════════════════════════

@dataclass
class TrailStopRedisState:
    """Persisted to pms:trail_stop:{trailStopId} and pms:active_trail_stop:{subAccountId}."""
    trail_stop_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""                      # LONG / SHORT (position side)
    quantity: float = 0.0
    callback_pct: float = 1.0           # Standardized name (was trailPct)
    activation_price: Optional[float] = None
    extreme_price: float = 0.0
    trigger_price: float = 0.0
    activated: bool = False
    status: str = "ACTIVE"
    position_id: Optional[str] = None
    started_at: int = 0

    def to_dict(self) -> dict:
        return {
            "trailStopId": self.trail_stop_id,
            "subAccountId": self.sub_account_id,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": self.quantity,
            "callbackPct": self.callback_pct,
            "activationPrice": self.activation_price,
            "extremePrice": self.extreme_price,
            "triggerPrice": self.trigger_price,
            "activated": self.activated,
            "status": self.status,
            "positionId": self.position_id,
            "startedAt": self.started_at,
        }


# ══════════════════════════════════════════════════════════════
# Risk Snapshot
# ══════════════════════════════════════════════════════════════

@dataclass
class PositionSnapshot:
    """One position in a risk snapshot."""
    position_id: str = ""
    symbol: str = ""
    side: str = ""
    entry_price: float = 0.0
    quantity: float = 0.0
    notional: float = 0.0
    margin: float = 0.0
    leverage: int = 1
    liquidation_price: float = 0.0
    unrealized_pnl: float = 0.0
    pnl_percent: float = 0.0
    mark_price: float = 0.0
    opened_at: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.position_id,
            "symbol": self.symbol,
            "side": self.side,
            "entryPrice": self.entry_price,
            "quantity": self.quantity,
            "notional": self.notional,
            "margin": self.margin,
            "leverage": self.leverage,
            "liquidationPrice": self.liquidation_price,
            "unrealizedPnl": self.unrealized_pnl,
            "pnlPercent": self.pnl_percent,
            "markPrice": self.mark_price,
            "openedAt": self.opened_at,
        }


@dataclass
class OpenOrderSnapshot:
    """One open order in a risk snapshot."""
    client_order_id: str = ""
    exchange_order_id: Optional[str] = None
    symbol: str = ""
    side: str = ""
    order_type: str = "LIMIT"
    price: Optional[float] = None
    quantity: float = 0.0
    filled_qty: float = 0.0
    origin: str = "MANUAL"
    leverage: int = 1
    reduce_only: bool = False
    state: str = "active"
    created_at: float = 0.0

    def to_dict(self) -> dict:
        return {
            "clientOrderId": self.client_order_id,
            "exchangeOrderId": self.exchange_order_id,
            "symbol": self.symbol,
            "side": self.side,
            "orderType": self.order_type,
            "price": self.price,
            "quantity": self.quantity,
            "filledQty": self.filled_qty,
            "origin": self.origin,
            "leverage": self.leverage,
            "reduceOnly": self.reduce_only,
            "state": self.state,
            "createdAt": self.created_at,
        }


@dataclass
class RiskSnapshot:
    """Full account risk snapshot — persisted to pms:risk:{subAccountId}."""
    balance: float = 0.0
    equity: float = 0.0
    margin_used: float = 0.0
    available_margin: float = 0.0
    positions: List[PositionSnapshot] = field(default_factory=list)
    open_orders: List[OpenOrderSnapshot] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "balance": self.balance,
            "equity": self.equity,
            "marginUsed": self.margin_used,
            "availableMargin": self.available_margin,
            "positions": [p.to_dict() for p in self.positions],
            "openOrders": [o.to_dict() for o in self.open_orders],
        }
