"""
OrderManager — Central order state machine.

EVERY order (market, limit, chase reprice, scalper layer, TWAP lot, etc.)
goes through this class. Algo engines NEVER call the exchange directly.

State transitions:
- place_*()         → idle → placing (sends REST request)
- on_order_update() → placing → active (feed: NEW)
- on_order_update() → active → filled (feed: FILLED)  → calls on_fill callback
- cancel_order()    → active → cancelling (sends cancel REST)
- on_order_update() → cancelling → cancelled (feed: CANCELED) → calls on_cancel callback

Key insight from market_maker.py:
- REST responses do NOT drive state — they only move idle → placing
- Feed events drive ALL transitions: placing → active, active → filled
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from .state import OrderState, generate_client_order_id, TERMINAL_STATES
from .tracker import OrderTracker
from .exchange_client import ExchangeClient

logger = logging.getLogger(__name__)

# Map order_type shorthand to client order ID prefix
_TYPE_PREFIX = {
    "MARKET": "MKT",
    "LIMIT": "LMT",
    "STOP_MARKET": "STP",
    "TAKE_PROFIT_MARKET": "TPM",
}


class OrderManager:
    """
    Central order state machine.

    EVERY order goes through this class. Algo engines delegate all
    exchange interactions here and register callbacks for state transitions.
    """

    def __init__(
        self,
        exchange_client: ExchangeClient,
        redis_client: Any = None,
        risk_engine: Any = None,
    ):
        self._exchange = exchange_client
        self._redis = redis_client
        self._risk = risk_engine  # Set later via set_risk_engine() (Step 7)
        self._tracker = OrderTracker()
        self._seq: int = 0  # Monotonic event sequence number

    def set_risk_engine(self, risk_engine: Any) -> None:
        """Wire up the risk engine after it's created (Step 7)."""
        self._risk = risk_engine

    @property
    def tracker(self) -> OrderTracker:
        """Expose tracker for external queries."""
        return self._tracker

    def _next_seq(self) -> int:
        """Monotonic sequence number for event ordering."""
        self._seq += 1
        return self._seq

    # ── Public API: Place Orders ──

    async def place_market_order(
        self,
        sub_account_id: str,
        symbol: str,
        side: str,
        quantity: float,
        leverage: int = 1,
        origin: str = "MANUAL",
        parent_id: Optional[str] = None,
        on_fill: Optional[Callable] = None,
        on_cancel: Optional[Callable] = None,
        reduce_only: bool = False,
        **kwargs,
    ) -> OrderState:
        """
        Place a market order and track it.

        Args:
            symbol: Binance format (BTCUSDT)
            side: BUY or SELL

        Returns: OrderState (state="placing", fills arrive async via feed)
        """
        order = OrderState(
            client_order_id=generate_client_order_id(sub_account_id, "MKT"),
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            order_type="MARKET",
            quantity=quantity,
            leverage=leverage,
            origin=origin,
            parent_id=parent_id,
            on_fill=on_fill,
            on_cancel=on_cancel,
            reduce_only=reduce_only,
        )

        order.transition("placing")
        self._tracker.register(order)

        try:
            result = await self._exchange.create_market_order(
                symbol,
                side,
                quantity,
                newClientOrderId=order.client_order_id,
                reduceOnly="true" if reduce_only else None,
                **kwargs,
            )
            # Map exchange ID for feed routing
            eid = str(result.get("orderId", ""))
            if eid:
                self._tracker.update_exchange_id(order.client_order_id, eid)
            # DON'T set state to "active" — wait for feed confirmation

        except Exception as e:
            order.transition("failed")
            logger.error("Market order failed: %s %s %s — %s", symbol, side, quantity, e)
            await self._publish_event("order_failed", order, error=str(e))

        return order

    async def place_limit_order(
        self,
        sub_account_id: str,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        leverage: int = 1,
        origin: str = "MANUAL",
        parent_id: Optional[str] = None,
        on_fill: Optional[Callable] = None,
        on_cancel: Optional[Callable] = None,
        on_partial: Optional[Callable] = None,
        reduce_only: bool = False,
        **kwargs,
    ) -> OrderState:
        """Place a limit order (GTC) and track it."""
        order = OrderState(
            client_order_id=generate_client_order_id(sub_account_id, "LMT"),
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            order_type="LIMIT",
            quantity=quantity,
            price=price,
            leverage=leverage,
            origin=origin,
            parent_id=parent_id,
            on_fill=on_fill,
            on_cancel=on_cancel,
            on_partial=on_partial,
            reduce_only=reduce_only,
        )

        order.transition("placing")
        self._tracker.register(order)

        try:
            result = await self._exchange.create_limit_order(
                symbol,
                side,
                quantity,
                price,
                newClientOrderId=order.client_order_id,
                reduceOnly="true" if reduce_only else None,
                **kwargs,
            )
            eid = str(result.get("orderId", ""))
            if eid:
                self._tracker.update_exchange_id(order.client_order_id, eid)

        except Exception as e:
            order.transition("failed")
            logger.error("Limit order failed: %s %s %s@%s — %s", symbol, side, quantity, price, e)
            await self._publish_event("order_failed", order, error=str(e))

        return order

    async def cancel_order(self, client_order_id: str) -> bool:
        """
        Cancel an order. Sets state to 'cancelling'.
        Actual confirmation comes from the feed.
        Returns True if cancel request was sent.
        """
        order = self._tracker.lookup(client_order_id=client_order_id)
        if not order:
            logger.warning("cancel_order: unknown order %s", client_order_id)
            return False

        if not order.transition("cancelling"):
            logger.warning(
                "cancel_order: can't cancel order in state=%s (coid=%s)",
                order.state, client_order_id,
            )
            return False

        try:
            await self._exchange.cancel_order(
                order.symbol,
                origClientOrderId=order.client_order_id,
            )
        except Exception as e:
            # Don't revert state — feed will confirm actual state
            logger.warning("Cancel request failed (feed will resolve): %s — %s", client_order_id, e)

        return True

    async def cancel_all_orders_for_symbol(self, symbol: str) -> int:
        """Cancel all tracked active orders for a symbol. Returns count."""
        active = self._tracker.get_active_by_symbol(symbol)
        count = 0
        for order in active:
            if await self.cancel_order(order.client_order_id):
                count += 1
        return count

    async def replace_order(
        self,
        client_order_id: str,
        new_price: float,
        new_quantity: Optional[float] = None,
    ) -> Optional[OrderState]:
        """
        Cancel-and-replace pattern (from market_maker update_quotes).
        1. Cancel existing order
        2. Place new order with same params but new price
        3. Link new order to same parent/callbacks
        Returns the new OrderState, or None if original not found.
        """
        old = self._tracker.lookup(client_order_id=client_order_id)
        if not old:
            return None

        # Cancel the old order (feed will confirm)
        await self.cancel_order(client_order_id)

        # Place new order with same metadata
        return await self.place_limit_order(
            sub_account_id=old.sub_account_id,
            symbol=old.symbol,
            side=old.side,
            quantity=new_quantity or old.quantity,
            price=new_price,
            leverage=old.leverage,
            origin=old.origin,
            parent_id=old.parent_id,
            on_fill=old.on_fill,
            on_cancel=old.on_cancel,
            on_partial=old.on_partial,
            reduce_only=old.reduce_only,
        )

    # ── Feed Event Handler (called by UserStreamService) ──

    async def on_order_update(self, data: dict) -> None:
        """
        Called by UserStreamService on ORDER_TRADE_UPDATE / TRADE_LITE.

        Expected data format (from binance_wss.py map_order_data_ws):
        {
            'symbol': 'BTCUSDT',
            'client_order_id': 'PMS...',
            'order_id': '123456',
            'side': 'BUY',
            'order_type': 'LIMIT',
            'order_status': 'NEW',  # NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED
            'price': '65000.00',
            'orig_qty': '0.001',
            'last_filled_qty': '0.001',
            'last_filled_price': '65001.50',
            'accumulated_filled_qty': '0.001',
            'avg_price': '65001.50',
        }
        """
        exchange_order_id = str(data.get("order_id", ""))
        client_order_id = data.get("client_order_id", "")
        status = data.get("order_status", "")

        # Skip orders that aren't ours (not PMS-prefixed)
        if client_order_id and not client_order_id.startswith("PMS"):
            return

        # Look up the order
        order = self._tracker.lookup(
            exchange_order_id=exchange_order_id,
            client_order_id=client_order_id,
        )
        if not order:
            logger.debug(
                "on_order_update: unknown order (coid=%s, eid=%s, status=%s) — not ours",
                client_order_id, exchange_order_id, status,
            )
            return

        old_state = order.state

        # ── Process status ──

        if status == "NEW":
            if not order.exchange_order_id and exchange_order_id:
                self._tracker.update_exchange_id(order.client_order_id, exchange_order_id)
            order.transition("active")
            await self._publish_event("order_active", order)

        elif status == "PARTIALLY_FILLED":
            fill_price = float(data.get("last_filled_price", 0))
            fill_qty = float(data.get("last_filled_qty", 0))
            order.apply_fill(fill_price, fill_qty)

            if order.on_partial:
                try:
                    await order.on_partial(order)
                except Exception as e:
                    logger.error("on_partial callback error: %s", e)

            await self._publish_event("order_partial", order)

        elif status == "FILLED":
            fill_price = float(data.get("last_filled_price", 0))
            fill_qty = float(data.get("last_filled_qty", 0))
            avg_price = float(data.get("avg_price", 0))

            order.apply_fill(fill_price, fill_qty)
            if avg_price > 0:
                order.avg_fill_price = avg_price

            order.transition("filled")

            # Call risk engine if available
            if self._risk:
                try:
                    await self._risk.on_order_fill(order)
                except Exception as e:
                    logger.error("Risk engine on_order_fill error: %s", e)

            # Call algo callback
            if order.on_fill:
                try:
                    await order.on_fill(order)
                except Exception as e:
                    logger.error("on_fill callback error: %s", e)

            await self._publish_event("order_filled", order)

        elif status in ("CANCELED", "CANCELLED", "EXPIRED", "REJECTED"):
            new_state = "cancelled" if status != "EXPIRED" else "expired"
            order.transition(new_state)

            if order.on_cancel:
                try:
                    await order.on_cancel(order, status)
                except Exception as e:
                    logger.error("on_cancel callback error: %s", e)

            await self._publish_event("order_cancelled", order, reason=status)

        if order.state != old_state:
            logger.info(
                "Order %s: %s → %s (%s %s %s)",
                order.client_order_id, old_state, order.state,
                order.symbol, order.side, order.origin,
            )

    # ── Query API ──

    def get_order(self, client_order_id: str) -> Optional[OrderState]:
        """Get an order by client order ID."""
        return self._tracker.lookup(client_order_id=client_order_id)

    def get_active_orders(
        self,
        sub_account_id: Optional[str] = None,
        symbol: Optional[str] = None,
    ) -> List[OrderState]:
        """Get active orders, optionally filtered by sub-account or symbol."""
        if sub_account_id:
            return self._tracker.get_by_sub_account(sub_account_id, active_only=True)
        if symbol:
            return self._tracker.get_active_by_symbol(symbol)
        return [o for o in self._tracker._by_client_id.values() if o.is_active]

    def get_orders_by_parent(self, parent_id: str) -> List[OrderState]:
        """Get all orders for a parent algo (chase, scalper, etc.)."""
        return self._tracker.get_by_parent(parent_id)

    # ── Redis Event Publishing ──

    async def _publish_event(self, event_type: str, order: OrderState, **extra) -> None:
        """
        Publish order event to Redis PUB/SUB for JS to forward to frontend.

        KEY DESIGN: Events carry full account state (balance, positions, margin)
        so frontend can update locally without refetching /margin endpoint.
        Frontend only fetches /margin on page refresh (cold start).
        """
        # Get account snapshot for idempotent frontend update
        account_state = {}
        if self._risk and event_type in (
            "order_filled", "order_cancelled", "position_closed", "position_reduced"
        ):
            try:
                account_state = self._risk.get_account_snapshot(order.sub_account_id)
            except Exception as e:
                logger.error("Failed to get account snapshot: %s", e)

        payload = {
            "seq": self._next_seq(),
            "type": event_type,
            **order.to_event_dict(),
            "account": account_state,
            "timestamp": time.time(),
            **extra,
        }

        channel = f"pms:events:{event_type}"

        if self._redis:
            try:
                await self._redis.publish(channel, json.dumps(payload))
            except Exception as e:
                logger.error("Failed to publish event %s: %s", event_type, e)
        else:
            logger.debug("No Redis client — skipping publish: %s", event_type)

    # ── Housekeeping ──

    async def cleanup(self) -> int:
        """Clean up terminal orders older than 5 minutes. Call periodically."""
        return self._tracker.cleanup_terminal()

    def __repr__(self) -> str:
        return f"OrderManager(tracker={self._tracker!r})"
