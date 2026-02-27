"""
MatchingEngine — In-memory order matching for paper trading.

Maintains pending orders and checks them against L1 ticks from
MarketDataService. When an order matches, generates Binance-format
ORDER_TRADE_UPDATE events and routes them to OrderManager.on_order_update().

Fill logic:
- MARKET orders → fill immediately at best price (ask for BUY, bid for SELL)
- LIMIT BUY    → fill when ask ≤ limit_price
- LIMIT SELL   → fill when bid ≥ limit_price
- STOP_MARKET BUY  → trigger when ask ≥ stop_price, fill at ask
- STOP_MARKET SELL → trigger when bid ≤ stop_price, fill at bid
- TAKE_PROFIT_MARKET BUY  → trigger when ask ≤ stop_price, fill at ask
- TAKE_PROFIT_MARKET SELL → trigger when bid ≥ stop_price, fill at bid
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class PaperOrder:
    """Internal representation of a pending paper order."""
    order_id: int
    client_order_id: str
    symbol: str                    # Binance native format: BTCUSDT
    side: str                      # BUY / SELL
    order_type: str                # MARKET / LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET
    quantity: float
    price: Optional[float] = None  # Limit price (for LIMIT orders)
    stop_price: Optional[float] = None  # Stop/TP trigger price
    reduce_only: bool = False
    status: str = "NEW"            # NEW / FILLED / CANCELED
    filled_qty: float = 0.0
    avg_price: float = 0.0
    created_at: float = field(default_factory=time.time)
    time_in_force: str = "GTC"


class MatchingEngine:
    """
    In-memory order matching engine for paper trading.

    Orders are added via add_order() and checked against L1 prices
    on every on_tick() call. Fill/cancel events are routed to the
    OrderManager via the event_callback.
    """

    def __init__(self, event_callback: Optional[Callable] = None):
        """
        Args:
            event_callback: async fn(data: dict) called with Binance-format
                           ORDER_TRADE_UPDATE events on fill/cancel.
                           Typically OrderManager.on_order_update().
        """
        self._pending: Dict[str, PaperOrder] = {}   # client_order_id → PaperOrder
        self._next_order_id = 100000000              # Auto-incrementing exchange IDs
        self._event_callback = event_callback
        self._fill_count = 0

    def set_event_callback(self, cb: Callable) -> None:
        """Wire up the event callback (called after OrderManager is created)."""
        self._event_callback = cb

    # ── Order Management ──

    def add_order(
        self,
        client_order_id: str,
        symbol: str,
        side: str,
        order_type: str,
        quantity: float,
        price: Optional[float] = None,
        stop_price: Optional[float] = None,
        reduce_only: bool = False,
        **kwargs,
    ) -> PaperOrder:
        """
        Add a new order to the matching engine.
        Returns the PaperOrder with an assigned exchange order ID.
        """
        order_id = self._next_order_id
        self._next_order_id += 1

        order = PaperOrder(
            order_id=order_id,
            client_order_id=client_order_id,
            symbol=symbol,
            side=side,
            order_type=order_type,
            quantity=quantity,
            price=price,
            stop_price=stop_price,
            reduce_only=reduce_only,
        )

        self._pending[client_order_id] = order
        logger.info(
            "📝 Paper order added: %s %s %s qty=%.6f price=%s stop=%s (oid=%d)",
            side, symbol, order_type, quantity, price, stop_price, order_id,
        )
        return order

    def cancel_order(
        self,
        client_order_id: Optional[str] = None,
        order_id: Optional[int] = None,
    ) -> Optional[PaperOrder]:
        """Cancel a pending order. Returns the cancelled order or None."""
        target = None

        if client_order_id and client_order_id in self._pending:
            target = self._pending.pop(client_order_id)
        elif order_id:
            for coid, order in list(self._pending.items()):
                if order.order_id == order_id:
                    target = self._pending.pop(coid)
                    break

        if target:
            target.status = "CANCELED"
            logger.info(
                "✖ Paper order cancelled: %s %s (oid=%d)",
                target.side, target.symbol, target.order_id,
            )
            # Fire cancel event
            asyncio.get_event_loop().call_soon(
                asyncio.ensure_future,
                self._emit_event(target, "CANCELED"),
            )
            return target

        return None

    def cancel_all_for_symbol(self, symbol: str) -> int:
        """Cancel all pending orders for a symbol. Returns count."""
        to_cancel = [
            coid for coid, o in self._pending.items() if o.symbol == symbol
        ]
        for coid in to_cancel:
            self.cancel_order(client_order_id=coid)
        return len(to_cancel)

    def get_order(self, client_order_id: str) -> Optional[PaperOrder]:
        """Get a pending order by client order ID."""
        return self._pending.get(client_order_id)

    def get_open_orders(self, symbol: Optional[str] = None) -> List[dict]:
        """Get all open orders in Binance format, optionally filtered by symbol."""
        orders = []
        for o in self._pending.values():
            if symbol and o.symbol != symbol:
                continue
            orders.append(self._to_binance_order(o))
        return orders

    # ── Tick Processing (called on every L1 update) ──

    async def on_tick(self, symbol: str, bid: float, ask: float, mid: float) -> None:
        """
        Check all pending orders for this symbol against current prices.
        Fill any orders that match.
        """
        to_fill: List[tuple] = []  # [(client_order_id, fill_price)]

        for coid, order in list(self._pending.items()):
            if order.symbol != symbol:
                continue

            fill_price = self._check_fill(order, bid, ask)
            if fill_price is not None:
                to_fill.append((coid, fill_price))

        # Process fills outside the iteration
        for coid, fill_price in to_fill:
            order = self._pending.pop(coid, None)
            if order:
                await self._fill_order(order, fill_price)

    def _check_fill(self, order: PaperOrder, bid: float, ask: float) -> Optional[float]:
        """
        Check if an order should fill at current prices.
        Returns fill_price if should fill, None otherwise.
        """
        if order.order_type == "MARKET":
            # Market orders fill immediately
            return ask if order.side == "BUY" else bid

        elif order.order_type == "LIMIT":
            if order.side == "BUY" and ask <= order.price:
                return order.price  # Fill at limit price (price improvement)
            elif order.side == "SELL" and bid >= order.price:
                return order.price

        elif order.order_type == "STOP_MARKET":
            if order.side == "BUY" and ask >= order.stop_price:
                return ask  # Triggered — fill at market
            elif order.side == "SELL" and bid <= order.stop_price:
                return bid

        elif order.order_type == "TAKE_PROFIT_MARKET":
            if order.side == "BUY" and ask <= order.stop_price:
                return ask
            elif order.side == "SELL" and bid >= order.stop_price:
                return bid

        return None

    # ── Fill Processing ──

    async def _fill_order(self, order: PaperOrder, fill_price: float) -> None:
        """Process a fill: update order state and emit event."""
        order.status = "FILLED"
        order.filled_qty = order.quantity
        order.avg_price = fill_price
        self._fill_count += 1

        logger.info(
            "✅ Paper fill #%d: %s %s %.6f @ %.4f (oid=%d, coid=%s)",
            self._fill_count, order.side, order.symbol,
            order.quantity, fill_price, order.order_id, order.client_order_id,
        )

        # Emit NEW event first (state: placing → active)
        await self._emit_event(order, "NEW")
        # Small delay to simulate network latency
        await asyncio.sleep(0.01)
        # Then FILLED event (state: active → filled)
        await self._emit_event(order, "FILLED", fill_price=fill_price)

    async def _emit_new_event(self, order: PaperOrder) -> None:
        """Emit a NEW event for a limit order that was accepted."""
        await self._emit_event(order, "NEW")

    async def _emit_event(
        self,
        order: PaperOrder,
        status: str,
        fill_price: Optional[float] = None,
    ) -> None:
        """
        Emit a Binance-format ORDER_TRADE_UPDATE event.

        This matches the exact format produced by UserStreamService._on_order_update():
        {
            'symbol': 'BTCUSDT',
            'client_order_id': 'PMS...',
            'order_id': '123456',
            'side': 'BUY',
            'order_type': 'LIMIT',
            'status': 'NEW' | 'FILLED' | 'CANCELED',
            'orig_qty': '0.001',
            'price': '65000.0',
            'last_filled_qty': '0.001',
            'last_filled_price': '65001.50',
            'accumulated_filled_qty': '0.001',
            'avg_price': '65001.50',
        }
        """
        if not self._event_callback:
            logger.warning("No event callback set — paper fill event dropped")
            return

        is_fill = status == "FILLED"
        fp = fill_price or order.avg_price or 0.0
        fq = order.quantity if is_fill else 0.0

        data = {
            "symbol": order.symbol,
            "client_order_id": order.client_order_id,
            "order_id": str(order.order_id),
            "side": order.side,
            "order_type": order.order_type,
            "status": status,
            "orig_qty": str(order.quantity),
            "price": str(order.price or "0"),
            "last_filled_qty": str(fq),
            "last_filled_price": str(fp),
            "accumulated_filled_qty": str(order.filled_qty),
            "avg_price": str(order.avg_price),
            "time_in_force": order.time_in_force,
            "reduce_only": order.reduce_only,
        }

        try:
            await self._event_callback(data)
        except Exception as e:
            logger.error("Error in paper event callback: %s", e, exc_info=True)

    # ── Binance-Format Conversion ──

    def _to_binance_order(self, order: PaperOrder) -> dict:
        """Convert PaperOrder to Binance REST response format."""
        return {
            "orderId": order.order_id,
            "symbol": order.symbol,
            "status": order.status,
            "clientOrderId": order.client_order_id,
            "price": str(order.price or "0"),
            "avgPrice": str(order.avg_price),
            "origQty": str(order.quantity),
            "executedQty": str(order.filled_qty),
            "cumQuote": str(order.filled_qty * order.avg_price),
            "timeInForce": order.time_in_force,
            "type": order.order_type,
            "reduceOnly": order.reduce_only,
            "side": order.side,
            "stopPrice": str(order.stop_price or "0"),
            "workingType": "CONTRACT_PRICE",
            "origType": order.order_type,
            "updateTime": int(order.created_at * 1000),
        }

    def _to_binance_response(self, order: PaperOrder) -> dict:
        """Convert to REST create-order response format."""
        return {
            "orderId": order.order_id,
            "symbol": order.symbol,
            "status": order.status,
            "clientOrderId": order.client_order_id,
            "price": str(order.price or "0"),
            "avgPrice": str(order.avg_price),
            "origQty": str(order.quantity),
            "executedQty": str(order.filled_qty),
            "cumQuote": "0",
            "timeInForce": order.time_in_force,
            "type": order.order_type,
            "reduceOnly": order.reduce_only,
            "side": order.side,
            "stopPrice": str(order.stop_price or "0"),
            "updateTime": int(time.time() * 1000),
        }

    # ── Stats ──

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def fill_count(self) -> int:
        return self._fill_count

    def __repr__(self) -> str:
        return (
            f"MatchingEngine(pending={self.pending_count}, "
            f"fills={self._fill_count})"
        )
