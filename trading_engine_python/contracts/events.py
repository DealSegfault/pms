"""
events — Typed event DTOs for Redis PUB/SUB payloads.

Each event dataclass:
  - Has a `to_dict()` producing the exact JSON shape published to Redis
  - Documents every field the frontend/JS consumers expect
  - Uses ts_ms() for all timestamps (milliseconds)

Event channel: pms:events:{event_type}
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .common import EventType, StreamEventType, normalize_symbol, ts_ms, ts_s_to_ms


# ══════════════════════════════════════════════════════════════
# Stream Lifecycle Events (Redis Stream, internal)
# ══════════════════════════════════════════════════════════════

@dataclass
class LifecycleStreamEventBase:
    """Base payload for canonical lifecycle stream events."""

    client_order_id: str = ""
    exchange_order_id: Optional[str] = None
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    order_type: str = "LIMIT"
    quantity: float = 0.0
    price: Optional[float] = None
    reduce_only: bool = False
    origin: str = "MANUAL"
    parent_id: Optional[str] = None
    order_role: str = "UNKNOWN"
    strategy_session_id: Optional[str] = None
    parent_strategy_session_id: Optional[str] = None
    root_strategy_session_id: Optional[str] = None
    replaces_client_order_id: Optional[str] = None
    execution_scope: str = "SUB_ACCOUNT"
    source_ts: int = 0

    def _base_stream_dict(self) -> dict:
        return {
            "client_order_id": self.client_order_id,
            "exchange_order_id": self.exchange_order_id or "",
            "sub_account_id": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "order_type": self.order_type,
            "quantity": self.quantity,
            "price": "" if self.price is None else self.price,
            "reduce_only": self.reduce_only,
            "origin": self.origin,
            "parent_id": self.parent_id or "",
            "order_role": self.order_role,
            "strategy_session_id": self.strategy_session_id or "",
            "parent_strategy_session_id": self.parent_strategy_session_id or "",
            "root_strategy_session_id": self.root_strategy_session_id or "",
            "replaces_client_order_id": self.replaces_client_order_id or "",
            "execution_scope": self.execution_scope,
            "source_ts": self.source_ts or ts_ms(),
        }

    @classmethod
    def from_order_state(
        cls,
        order: Any,
        *,
        source_ts: Optional[int] = None,
    ) -> "LifecycleStreamEventBase":
        return cls(
            client_order_id=order.client_order_id,
            exchange_order_id=order.exchange_order_id,
            sub_account_id=order.sub_account_id,
            symbol=order.symbol,
            side=order.side,
            order_type=order.order_type,
            quantity=order.quantity,
            price=order.price,
            reduce_only=order.reduce_only,
            origin=order.origin,
            parent_id=order.parent_id,
            order_role=getattr(order, "order_role", "UNKNOWN"),
            strategy_session_id=getattr(order, "strategy_session_id", None),
            parent_strategy_session_id=getattr(order, "parent_strategy_session_id", None),
            root_strategy_session_id=getattr(order, "root_strategy_session_id", None),
            replaces_client_order_id=getattr(order, "replaces_client_order_id", None),
            source_ts=source_ts or ts_ms(),
        )


@dataclass
class OrderIntentStreamEvent(LifecycleStreamEventBase):
    """Submit-time lifecycle event published before venue submission."""

    routing_prefix: str = ""
    intent_ts: int = 0
    decision_bid: Optional[float] = None
    decision_ask: Optional[float] = None
    decision_mid: Optional[float] = None
    decision_spread_bps: Optional[float] = None

    def to_stream_dict(self) -> dict:
        return {
            "type": StreamEventType.ORDER_INTENT,
            **self._base_stream_dict(),
            "routing_prefix": self.routing_prefix,
            "intent_ts": self.intent_ts or self.source_ts or ts_ms(),
            "decision_bid": "" if self.decision_bid is None else self.decision_bid,
            "decision_ask": "" if self.decision_ask is None else self.decision_ask,
            "decision_mid": "" if self.decision_mid is None else self.decision_mid,
            "decision_spread_bps": "" if self.decision_spread_bps is None else self.decision_spread_bps,
        }


@dataclass
class OrderRejectedStreamEvent(LifecycleStreamEventBase):
    """Terminal lifecycle event for submission-time rejection/failure."""

    error: str = ""
    reason: str = ""
    status: str = "REJECTED"
    rejected_ts: int = 0

    def to_stream_dict(self) -> dict:
        return {
            "type": StreamEventType.ORDER_REJECTED,
            **self._base_stream_dict(),
            "error": self.error,
            "reason": self.reason or self.error,
            "status": self.status,
            "rejected_ts": self.rejected_ts or self.source_ts or ts_ms(),
        }


@dataclass
class ScalperRuntimeSnapshotStreamEvent:
    """Dedicated runtime checkpoint event published to pms:stream:algo_runtime."""

    strategy_session_id: str
    sub_account_id: str
    strategy_type: str = "SCALPER"
    checkpoint_seq: int = 0
    checkpoint_reason: str = "HEARTBEAT"
    status: str = "ACTIVE"
    snapshot_json: str = "{}"
    source_ts: int = 0

    def to_stream_dict(self) -> dict:
        return {
            "type": StreamEventType.SCALPER_RUNTIME_SNAPSHOT,
            "strategy_session_id": self.strategy_session_id,
            "sub_account_id": self.sub_account_id,
            "strategy_type": self.strategy_type,
            "checkpoint_seq": self.checkpoint_seq,
            "checkpoint_reason": self.checkpoint_reason,
            "status": self.status,
            "snapshot_json": self.snapshot_json,
            "source_ts": self.source_ts or ts_ms(),
        }


# ══════════════════════════════════════════════════════════════
# Order Events (from OrderManager)
# ══════════════════════════════════════════════════════════════

@dataclass
class OrderEventBase:
    """Base for all order lifecycle events."""
    client_order_id: str = ""
    exchange_order_id: Optional[str] = None
    sub_account_id: str = ""
    symbol: str = ""                    # Binance-native: BTCUSDT
    side: str = ""                      # BUY / SELL
    order_type: str = "LIMIT"           # LIMIT / MARKET
    quantity: float = 0.0
    price: Optional[float] = None
    reduce_only: bool = False
    state: str = ""
    filled_qty: float = 0.0
    avg_fill_price: float = 0.0
    last_fill_price: float = 0.0
    last_fill_qty: float = 0.0
    origin: str = "MANUAL"
    parent_id: Optional[str] = None
    order_role: str = "UNKNOWN"
    strategy_session_id: Optional[str] = None
    parent_strategy_session_id: Optional[str] = None
    root_strategy_session_id: Optional[str] = None
    replaces_client_order_id: Optional[str] = None
    leverage: int = 1
    created_at: float = 0.0            # seconds (Python internal)
    updated_at: float = 0.0

    def _base_dict(self) -> dict:
        return {
            "clientOrderId": self.client_order_id,
            "exchangeOrderId": self.exchange_order_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "price": self.price,
            "reduceOnly": self.reduce_only,
            "state": self.state,
            "filledQty": self.filled_qty,
            "avgFillPrice": self.avg_fill_price,
            "lastFillPrice": self.last_fill_price,
            "lastFillQty": self.last_fill_qty,
            "origin": self.origin,
            "parentId": self.parent_id,
            "orderRole": self.order_role,
            "strategySessionId": self.strategy_session_id,
            "parentStrategySessionId": self.parent_strategy_session_id,
            "rootStrategySessionId": self.root_strategy_session_id,
            "replacesClientOrderId": self.replaces_client_order_id,
            "leverage": self.leverage,
            "createdAt": ts_s_to_ms(self.created_at),
            "updatedAt": ts_s_to_ms(self.updated_at),
        }

    @classmethod
    def from_order_state(cls, order: Any) -> "OrderEventBase":
        """Build from an OrderState instance."""
        return cls(
            client_order_id=order.client_order_id,
            exchange_order_id=order.exchange_order_id,
            sub_account_id=order.sub_account_id,
            symbol=order.symbol,
            side=order.side,
            order_type=order.order_type,
            quantity=order.quantity,
            price=order.price,
            reduce_only=order.reduce_only,
            state=order.state,
            filled_qty=order.filled_qty,
            avg_fill_price=order.avg_fill_price,
            last_fill_price=order.last_fill_price,
            last_fill_qty=order.last_fill_qty,
            origin=order.origin,
            parent_id=order.parent_id,
            order_role=getattr(order, "order_role", "UNKNOWN"),
            strategy_session_id=getattr(order, "strategy_session_id", None),
            parent_strategy_session_id=getattr(order, "parent_strategy_session_id", None),
            root_strategy_session_id=getattr(order, "root_strategy_session_id", None),
            replaces_client_order_id=getattr(order, "replaces_client_order_id", None),
            leverage=order.leverage,
            created_at=order.created_at,
            updated_at=order.updated_at,
        )


@dataclass
class OrderPlacedEvent(OrderEventBase):
    """Published when a limit order is placed on exchange."""
    seq: int = 0
    # Optional scale/TWAP metadata
    scale_index: Optional[int] = None
    scale_total: Optional[int] = None
    twap_lot: Optional[int] = None
    twap_total: Optional[int] = None

    def to_dict(self) -> dict:
        d = {
            "seq": self.seq,
            "type": EventType.ORDER_PLACED,
            **self._base_dict(),
            "timestamp": ts_ms(),
        }
        if self.scale_index is not None:
            d["scaleIndex"] = self.scale_index
            d["scaleTotal"] = self.scale_total
        if self.twap_lot is not None:
            d["twapLot"] = self.twap_lot
            d["twapTotal"] = self.twap_total
        return d


@dataclass
class OrderActiveEvent(OrderEventBase):
    """Published when exchange confirms a limit order is on the book."""
    seq: int = 0

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "type": EventType.ORDER_ACTIVE,
            **self._base_dict(),
            "timestamp": ts_ms(),
        }


@dataclass
class OrderFilledEvent(OrderEventBase):
    """Published when an order fills (fully)."""
    seq: int = 0
    account: dict = field(default_factory=dict)
    suppress_toast: bool = False

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "type": EventType.ORDER_FILLED,
            **self._base_dict(),
            "account": self.account,
            "suppressToast": self.suppress_toast,
            "timestamp": ts_ms(),
        }


@dataclass
class OrderCancelledEvent(OrderEventBase):
    """Published when an order is cancelled."""
    seq: int = 0
    reason: str = ""
    account: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "type": EventType.ORDER_CANCELLED,
            **self._base_dict(),
            "reason": self.reason,
            "account": self.account,
            "timestamp": ts_ms(),
        }


@dataclass
class OrderFailedEvent(OrderEventBase):
    """Published when an order fails to place."""
    seq: int = 0
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "type": EventType.ORDER_FAILED,
            **self._base_dict(),
            "error": self.error,
            "timestamp": ts_ms(),
        }


# ══════════════════════════════════════════════════════════════
# Chase Events
# ══════════════════════════════════════════════════════════════

@dataclass
class ChaseProgressEvent:
    """Published on every reprice — frontend updates chart line + order row."""
    chase_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""                    # Binance-native
    side: str = ""                      # BUY / SELL
    quantity: float = 0.0
    reprice_count: int = 0
    status: str = "ACTIVE"
    stalk_offset_pct: float = 0.0
    stalk_offset_ticks: Optional[int] = None
    initial_price: float = 0.0
    current_order_price: Optional[float] = None
    parent_scalper_id: Optional[str] = None
    # Live bid/ask for frontend chart
    bid: float = 0.0
    ask: float = 0.0

    def to_dict(self) -> dict:
        d = {
            "type": EventType.CHASE_PROGRESS,
            "chaseId": self.chase_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "quantity": self.quantity,
            "repriceCount": self.reprice_count,
            "status": self.status,
            "stalkOffsetPct": self.stalk_offset_pct,
            "initialPrice": self.initial_price,
            "currentOrderPrice": self.current_order_price,
            "bid": self.bid,
            "ask": self.ask,
            "timestamp": ts_ms(),
        }
        if self.stalk_offset_ticks is not None:
            d["stalkOffsetTicks"] = self.stalk_offset_ticks
        if self.parent_scalper_id:
            d["parentScalperId"] = self.parent_scalper_id
        return d


@dataclass
class ChaseFilledEvent:
    """Published when a chase order fills."""
    chase_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    quantity: float = 0.0
    fill_price: float = 0.0
    reprice_count: int = 0
    parent_scalper_id: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "type": EventType.CHASE_FILLED,
            "chaseId": self.chase_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "quantity": self.quantity,
            "fillPrice": self.fill_price,
            "repriceCount": self.reprice_count,
            "status": "FILLED",
            "timestamp": ts_ms(),
        }
        if self.parent_scalper_id:
            d["parentScalperId"] = self.parent_scalper_id
        return d


@dataclass
class ChaseCancelledEvent:
    """Published when a chase is cancelled (user or auto)."""
    chase_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    reason: str = ""
    reprice_count: int = 0
    parent_scalper_id: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "type": EventType.CHASE_CANCELLED,
            "chaseId": self.chase_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "reason": self.reason,
            "repriceCount": self.reprice_count,
            "status": "CANCELLED",
            "timestamp": ts_ms(),
        }
        if self.parent_scalper_id:
            d["parentScalperId"] = self.parent_scalper_id
        return d


# ══════════════════════════════════════════════════════════════
# Scalper Events
# ══════════════════════════════════════════════════════════════

@dataclass
class ScalperSlotInfo:
    """Per-slot state for scalper_progress events."""
    layer_idx: int = 0
    offset_pct: float = 0.0
    offset_ticks: Optional[int] = None
    qty: float = 0.0
    active: bool = False
    paused: bool = False
    retry_at: Optional[int] = None      # ms for JS
    retry_count: int = 0
    pause_reason: Optional[str] = None
    fills: int = 0

    def to_dict(self) -> dict:
        data = {
            "layerIdx": self.layer_idx,
            "offsetPct": self.offset_pct,
            "qty": self.qty,
            "active": self.active,
            "paused": self.paused,
            "retryAt": self.retry_at,
            "retryCount": self.retry_count,
            "pauseReason": self.pause_reason,
            "fills": self.fills,
        }
        if self.offset_ticks is not None:
            data["offsetTicks"] = self.offset_ticks
        return data


@dataclass
class ScalperProgressEvent:
    """Published on fill/restart/pause — frontend updates parent row + slot badges."""
    scalper_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    start_side: str = "LONG"
    status: str = "ACTIVE"
    fill_count: int = 0
    long_max_price: Optional[float] = None
    short_min_price: Optional[float] = None
    neutral_mode: bool = False
    long_slots: List[ScalperSlotInfo] = field(default_factory=list)
    short_slots: List[ScalperSlotInfo] = field(default_factory=list)
    started_at: int = 0                 # ms

    def to_dict(self) -> dict:
        return {
            "type": EventType.SCALPER_PROGRESS,
            "scalperId": self.scalper_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "startSide": self.start_side,
            "status": self.status,
            "totalFillCount": self.fill_count,
            "longMaxPrice": self.long_max_price,
            "shortMinPrice": self.short_min_price,
            "neutralMode": self.neutral_mode,
            "longSlots": [s.to_dict() for s in self.long_slots],
            "shortSlots": [s.to_dict() for s in self.short_slots],
            "startedAt": self.started_at,
            "timestamp": ts_ms(),
        }


@dataclass
class ScalperFilledEvent:
    """Published when a scalper child chase fills."""
    scalper_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    layer_idx: int = 0
    fill_price: float = 0.0
    fill_qty: float = 0.0
    fill_count: int = 0

    def to_dict(self) -> dict:
        return {
            "type": EventType.SCALPER_FILLED,
            "scalperId": self.scalper_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "layerIdx": self.layer_idx,
            "fillPrice": self.fill_price,
            "fillQty": self.fill_qty,
            "totalFillCount": self.fill_count,
            "status": "ACTIVE",
            "timestamp": ts_ms(),
        }


@dataclass
class ScalperCancelledEvent:
    """Published when a scalper is stopped."""
    scalper_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    fill_count: int = 0

    def to_dict(self) -> dict:
        return {
            "type": EventType.SCALPER_CANCELLED,
            "scalperId": self.scalper_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "totalFillCount": self.fill_count,
            "status": "CANCELLED",
            "timestamp": ts_ms(),
        }


@dataclass
class StrategySampleEvent:
    """Published on live strategy sampling for active session charting."""
    strategy_session_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    status: str = "ACTIVE"
    sampled_at: int = 0
    net_pnl: float = 0.0
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0
    open_qty: float = 0.0
    open_notional: float = 0.0
    fill_count: int = 0
    close_count: int = 0
    win_count: int = 0
    loss_count: int = 0
    long_active_slots: int = 0
    short_active_slots: int = 0
    long_paused_slots: int = 0
    short_paused_slots: int = 0
    long_retrying_slots: int = 0
    short_retrying_slots: int = 0

    def to_dict(self) -> dict:
        return {
            "type": EventType.STRATEGY_SAMPLE,
            "strategySessionId": self.strategy_session_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "status": self.status,
            "sampledAt": self.sampled_at or ts_ms(),
            "netPnl": self.net_pnl,
            "realizedPnl": self.realized_pnl,
            "unrealizedPnl": self.unrealized_pnl,
            "openQty": self.open_qty,
            "openNotional": self.open_notional,
            "fillCount": self.fill_count,
            "closeCount": self.close_count,
            "winCount": self.win_count,
            "lossCount": self.loss_count,
            "longActiveSlots": self.long_active_slots,
            "shortActiveSlots": self.short_active_slots,
            "longPausedSlots": self.long_paused_slots,
            "shortPausedSlots": self.short_paused_slots,
            "longRetryingSlots": self.long_retrying_slots,
            "shortRetryingSlots": self.short_retrying_slots,
            "timestamp": ts_ms(),
        }


# ══════════════════════════════════════════════════════════════
# TWAP Events
# ══════════════════════════════════════════════════════════════

@dataclass
class TWAPProgressEvent:
    """Published on each lot fill."""
    twap_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    filled_quantity: float = 0.0
    total_quantity: float = 0.0
    status: str = "ACTIVE"

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_PROGRESS,
            "twapId": self.twap_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "filledQuantity": self.filled_quantity,
            "totalQuantity": self.total_quantity,
            "status": self.status,
            "timestamp": ts_ms(),
        }


@dataclass
class TWAPCompletedEvent:
    """Published when all TWAP lots are filled."""
    twap_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    filled_quantity: float = 0.0
    total_quantity: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_COMPLETED,
            "twapId": self.twap_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "filledQuantity": self.filled_quantity,
            "totalQuantity": self.total_quantity,
            "status": "COMPLETED",
            "timestamp": ts_ms(),
        }


@dataclass
class TWAPCancelledEvent:
    """Published when a TWAP is cancelled."""
    twap_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    filled_quantity: float = 0.0
    total_quantity: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_CANCELLED,
            "twapId": self.twap_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "filledQuantity": self.filled_quantity,
            "totalQuantity": self.total_quantity,
            "status": "CANCELLED",
            "timestamp": ts_ms(),
        }


# ── TWAP Basket ──

@dataclass
class TWAPBasketLegInfo:
    """One leg in a basket event."""
    symbol: str = ""
    side: str = ""
    filled_size: float = 0.0
    total_size: float = 0.0

    def to_dict(self) -> dict:
        return {
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "filledSize": self.filled_size,
            "totalSize": self.total_size,
        }


@dataclass
class TWAPBasketProgressEvent:
    """Published on basket-level lot fill."""
    twap_basket_id: str = ""
    basket_name: str = ""
    sub_account_id: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    legs: List[TWAPBasketLegInfo] = field(default_factory=list)
    status: str = "ACTIVE"

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_BASKET_PROGRESS,
            "twapBasketId": self.twap_basket_id,
            "basketName": self.basket_name,
            "subAccountId": self.sub_account_id,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "legs": [leg.to_dict() for leg in self.legs],
            "status": self.status,
            "timestamp": ts_ms(),
        }


@dataclass
class TWAPBasketCompletedEvent:
    """Published when all legs complete."""
    twap_basket_id: str = ""
    basket_name: str = ""
    sub_account_id: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    legs: List[TWAPBasketLegInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_BASKET_COMPLETED,
            "twapBasketId": self.twap_basket_id,
            "basketName": self.basket_name,
            "subAccountId": self.sub_account_id,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "legs": [leg.to_dict() for leg in self.legs],
            "status": "COMPLETED",
            "timestamp": ts_ms(),
        }


@dataclass
class TWAPBasketCancelledEvent:
    """Published when a basket is cancelled."""
    twap_basket_id: str = ""
    basket_name: str = ""
    sub_account_id: str = ""
    filled_lots: int = 0
    total_lots: int = 0
    legs: List[TWAPBasketLegInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "type": EventType.TWAP_BASKET_CANCELLED,
            "twapBasketId": self.twap_basket_id,
            "basketName": self.basket_name,
            "subAccountId": self.sub_account_id,
            "filledLots": self.filled_lots,
            "totalLots": self.total_lots,
            "legs": [leg.to_dict() for leg in self.legs],
            "status": "CANCELLED",
            "timestamp": ts_ms(),
        }


# ══════════════════════════════════════════════════════════════
# Trail Stop Events
# ══════════════════════════════════════════════════════════════

@dataclass
class TrailStopProgressEvent:
    """Published on extreme price update (~1/sec throttled)."""
    trail_stop_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""                      # LONG / SHORT (position side)
    callback_pct: float = 0.0
    extreme_price: float = 0.0
    trigger_price: float = 0.0
    activated: bool = False
    position_id: Optional[str] = None
    quantity: float = 0.0
    status: str = "ACTIVE"

    def to_dict(self) -> dict:
        return {
            "type": EventType.TRAIL_STOP_PROGRESS,
            "trailStopId": self.trail_stop_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "callbackPct": self.callback_pct,
            "extremePrice": self.extreme_price,
            "triggerPrice": self.trigger_price,
            "activated": self.activated,
            "positionId": self.position_id,
            "quantity": self.quantity,
            "status": self.status,
            "timestamp": ts_ms(),
        }


@dataclass
class TrailStopTriggeredEvent:
    """Published when trail stop triggers market close."""
    trail_stop_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    callback_pct: float = 0.0
    extreme_price: float = 0.0
    triggered_price: float = 0.0
    position_id: Optional[str] = None
    quantity: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": EventType.TRAIL_STOP_TRIGGERED,
            "trailStopId": self.trail_stop_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "callbackPct": self.callback_pct,
            "extremePrice": self.extreme_price,
            "triggeredPrice": self.triggered_price,
            "positionId": self.position_id,
            "quantity": self.quantity,
            "status": "TRIGGERED",
            "timestamp": ts_ms(),
        }


@dataclass
class TrailStopCancelledEvent:
    """Published when trail stop is cancelled."""
    trail_stop_id: str = ""
    sub_account_id: str = ""
    symbol: str = ""
    side: str = ""
    callback_pct: float = 0.0
    position_id: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "type": EventType.TRAIL_STOP_CANCELLED,
            "trailStopId": self.trail_stop_id,
            "subAccountId": self.sub_account_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "callbackPct": self.callback_pct,
            "positionId": self.position_id,
            "status": "CANCELLED",
            "timestamp": ts_ms(),
        }


# ══════════════════════════════════════════════════════════════
# Position / Margin Events (from RiskEngine)
# ══════════════════════════════════════════════════════════════

@dataclass
class PositionUpdatedEvent:
    """Published when a new position is opened or an existing one is modified."""
    sub_account_id: str = ""
    position_id: str = ""
    symbol: str = ""
    side: str = ""                      # LONG / SHORT
    entry_price: float = 0.0
    quantity: float = 0.0
    notional: float = 0.0
    margin: float = 0.0
    leverage: int = 1
    liquidation_price: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": EventType.POSITION_UPDATED,
            "subAccountId": self.sub_account_id,
            "positionId": self.position_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "entryPrice": self.entry_price,
            "quantity": self.quantity,
            "notional": self.notional,
            "margin": self.margin,
            "leverage": self.leverage,
            "liquidationPrice": self.liquidation_price,
            "timestamp": ts_ms(),
        }


@dataclass
class PositionClosedEvent:
    """Published when a position is fully closed."""
    sub_account_id: str = ""
    position_id: str = ""
    symbol: str = ""
    side: str = ""
    realized_pnl: float = 0.0
    close_price: float = 0.0
    stale_cleanup: bool = False
    origin_type: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "type": EventType.POSITION_CLOSED,
            "subAccountId": self.sub_account_id,
            "positionId": self.position_id,
            "symbol": normalize_symbol(self.symbol) if self.symbol else "",
            "side": self.side,
            "realizedPnl": self.realized_pnl,
            "closePrice": self.close_price,
            "timestamp": ts_ms(),
        }
        if self.stale_cleanup:
            d["staleCleanup"] = True
        if self.origin_type:
            d["originType"] = self.origin_type
        if self.reason:
            d["reason"] = self.reason
        return d


@dataclass
class PositionReducedEvent:
    """Published when a position is partially closed."""
    sub_account_id: str = ""
    position_id: str = ""
    symbol: str = ""
    closed_qty: float = 0.0
    remaining_qty: float = 0.0
    realized_pnl: float = 0.0
    origin_type: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "type": EventType.POSITION_REDUCED,
            "subAccountId": self.sub_account_id,
            "positionId": self.position_id,
            "symbol": self.symbol,
            "closedQty": self.closed_qty,
            "remainingQty": self.remaining_qty,
            "realizedPnl": self.realized_pnl,
            "timestamp": ts_ms(),
        }
        if self.origin_type:
            d["originType"] = self.origin_type
        if self.reason:
            d["reason"] = self.reason
        return d


@dataclass
class MarginUpdateEvent:
    """Published after fills/closes — full account snapshot for frontend."""
    sub_account_id: str = ""
    balance: float = 0.0
    equity: float = 0.0
    margin_used: float = 0.0
    available_margin: float = 0.0
    positions: List[dict] = field(default_factory=list)
    open_orders: List[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        snapshot = {
            "balance": self.balance,
            "equity": self.equity,
            "marginUsed": self.margin_used,
            "availableMargin": self.available_margin,
            "positions": self.positions,
            "openOrders": self.open_orders,
        }
        return {
            "type": EventType.MARGIN_UPDATE,
            "subAccountId": self.sub_account_id,
            "update": snapshot,
            **snapshot,
            "timestamp": ts_ms(),
        }


@dataclass
class PnlUpdateEvent:
    """Published on price ticks for live PnL updates."""
    sub_account_id: str = ""
    position_id: str = ""
    symbol: str = ""
    side: str = ""
    entry_price: float = 0.0
    quantity: float = 0.0
    mark_price: float = 0.0
    liquidation_price: float = 0.0
    unrealized_pnl: float = 0.0

    def to_dict(self) -> dict:
        return {
            "type": EventType.PNL_UPDATE,
            "subAccountId": self.sub_account_id,
            "positionId": self.position_id,
            "symbol": self.symbol,
            "side": self.side,
            "entryPrice": self.entry_price,
            "quantity": self.quantity,
            "markPrice": self.mark_price,
            "liquidationPrice": self.liquidation_price,
            "unrealizedPnl": self.unrealized_pnl,
            "timestamp": ts_ms(),
        }
