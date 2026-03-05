"""
OrderConsumer — Processes raw trade events → order state transitions.

Reads from: pms:stream:trade_events (raw exchange events)
Publishes to: pms:stream:order_state (processed state changes)

Replaces the monolithic OrderManager.on_order_update() read path.
OrderManager keeps place/cancel/replace (write path).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

from contracts.common import StreamEventType
from orders.state import OrderState

logger = logging.getLogger(__name__)


class OrderConsumer:
    """Processes raw trade events into order state transitions.

    Responsibilities:
        - Look up OrderState in tracker
        - Apply state transitions (NEW → active, FILLED → filled, etc.)
        - Apply fill data (price, qty, avg_price)
        - Publish processed ORDER_STATE_* events downstream
        - Handle bot orders (PMS-tagged but untracked)

    Does NOT:
        - Touch Redis open_orders (that's RiskConsumer)
        - Write to DB (that's RiskConsumer)
        - Call algo callbacks (that's AlgoConsumer)
    """

    def __init__(
        self,
        tracker: Any,
        event_bus: Any,
        order_manager: Any,
    ) -> None:
        self._tracker = tracker
        self._bus = event_bus
        self._om = order_manager  # For _create_bot_order_from_feed
        self._processed_fills: dict[str, float] = {}  # Dedup: coid → timestamp

    async def handle(self, events: list[dict]) -> None:
        """Process a batch of raw trade events."""
        for event in events:
            try:
                await self._process_event(event)
            except Exception as e:
                logger.error("OrderConsumer error on event %s: %s",
                             event.get("client_order_id", "?"), e)

    async def _process_event(self, event: dict) -> None:
        """Process a single raw trade event."""
        event_type = event.get("type", "")

        # Only handle order events
        if event_type not in (
            StreamEventType.ORDER_INTENT,
            StreamEventType.ORDER_NEW,
            StreamEventType.ORDER_FILLED,
            StreamEventType.ORDER_PARTIALLY_FILLED,
            StreamEventType.ORDER_CANCELLED,
            StreamEventType.ORDER_EXPIRED,
            StreamEventType.ORDER_REJECTED,
            StreamEventType.TRADE_LITE,
        ):
            return

        client_order_id = event.get("client_order_id", "")
        exchange_order_id = event.get("exchange_order_id", "")
        status = event.get("status", "")

        # Skip non-PMS orders
        if client_order_id and not client_order_id.startswith("PMS"):
            return

        if event_type == StreamEventType.ORDER_INTENT:
            await self._on_intent(event)
            return

        # Look up order in tracker
        order = self._tracker.lookup(
            exchange_order_id=exchange_order_id,
            client_order_id=client_order_id,
        )

        if not order:
            # Bot order: PMS-tagged but not tracked — create ad-hoc OrderState
            order = await self._om._create_bot_order_from_feed(self._build_om_data(event))
            if not order:
                return

        # Process based on status
        if event_type == StreamEventType.ORDER_REJECTED or status == "REJECTED":
            await self._on_rejected(order, event)
        elif status == "NEW":
            await self._on_new(order, event)
        elif status == "PARTIALLY_FILLED":
            await self._on_partial(order, event)
        elif status == "FILLED":
            await self._on_filled(order, event)
        elif status in ("CANCELED", "CANCELLED", "EXPIRED", "REJECTED"):
            await self._on_cancelled(order, event, status)

    async def _on_intent(self, event: dict) -> None:
        """Register a placeholder order from submit-time intent."""
        client_order_id = event.get("client_order_id", "")
        if not client_order_id:
            return

        existing = self._tracker.lookup(client_order_id=client_order_id)
        if existing:
            return

        sub_account_id = event.get("sub_account_id", "")
        if not sub_account_id:
            return

        order = OrderState(
            client_order_id=client_order_id,
            sub_account_id=sub_account_id,
            exchange_order_id=event.get("exchange_order_id") or None,
            symbol=event.get("symbol", ""),
            side=event.get("side", ""),
            order_type=event.get("order_type", "LIMIT"),
            quantity=self._to_float(event.get("quantity")),
            price=self._to_optional_float(event.get("price")),
            state="placing",
            origin=event.get("origin", "BOT"),
            parent_id=event.get("parent_id") or None,
            reduce_only=self._to_bool(event.get("reduce_only")),
            leverage=int(self._to_float(event.get("leverage"), 1.0)),
            created_at=self._to_float(event.get("intent_ts"), time.time() * 1000.0) / 1000.0,
            updated_at=self._to_float(event.get("intent_ts"), time.time() * 1000.0) / 1000.0,
        )

        self._tracker.register(order)

    async def _on_rejected(self, order: Any, event: dict) -> None:
        """Handle submission-time rejection/failure."""
        if order.state == "failed":
            logger.debug("OrderConsumer: duplicate REJECTED for %s", order.client_order_id)
            return
        if not order.transition("failed"):
            logger.warning(
                "OrderConsumer: rejecting REJECTED for %s in state=%s",
                order.client_order_id,
                order.state,
            )
            return

        await self._bus.publish("ORDER_STATE_REJECTED", {
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id or "",
            "symbol": order.symbol,
            "side": order.side,
            "order_type": order.order_type,
            "price": str(order.price or 0),
            "quantity": str(order.quantity),
            "origin": order.origin,
            "parent_id": order.parent_id or "",
            "sub_account_id": order.sub_account_id,
            "reduce_only": str(order.reduce_only),
            "error": event.get("error", event.get("reason", "REJECTED")),
        })

    async def _on_new(self, order: Any, event: dict) -> None:
        """Handle NEW status."""
        exchange_order_id = event.get("exchange_order_id", "")
        if not order.exchange_order_id and exchange_order_id:
            self._tracker.update_exchange_id(order.client_order_id, exchange_order_id)

        if order.is_terminal:
            logger.info(
                "OrderConsumer: ignoring late NEW for terminal order %s (state=%s)",
                order.client_order_id,
                order.state,
            )
            return
        if order.state == "active":
            logger.debug("OrderConsumer: duplicate NEW for active order %s", order.client_order_id)
            return
        if not order.transition("active"):
            logger.warning(
                "OrderConsumer: rejecting NEW for %s in state=%s",
                order.client_order_id,
                order.state,
            )
            return

        await self._bus.publish("ORDER_STATE_NEW", {
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id or "",
            "symbol": order.symbol,
            "side": order.side,
            "order_type": order.order_type,
            "price": str(order.price),
            "quantity": str(order.quantity),
            "origin": order.origin,
            "parent_id": order.parent_id or "",
            "sub_account_id": order.sub_account_id,
            "reduce_only": str(order.reduce_only),
        })

    async def _on_partial(self, order: Any, event: dict) -> None:
        """Handle PARTIALLY_FILLED status."""
        fill_price = float(event.get("fill_price", 0))
        fill_qty = float(event.get("fill_qty", 0))
        order.apply_fill(fill_price, fill_qty)

        await self._bus.publish("ORDER_STATE_PARTIAL", {
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id or "",
            "symbol": order.symbol,
            "side": order.side,
            "fill_price": str(fill_price),
            "fill_qty": str(fill_qty),
            "filled_qty": str(order.filled_qty),
            "origin": order.origin,
            "parent_id": order.parent_id or "",
            "sub_account_id": order.sub_account_id,
        })

    async def _on_filled(self, order: Any, event: dict) -> None:
        """Handle FILLED status."""
        # Dedup: reject if already processed
        coid = order.client_order_id
        if not order.transition("filled"):
            logger.debug("OrderConsumer: %s already terminal, skipping duplicate FILLED", coid)
            return

        fill_price = float(event.get("fill_price", 0))
        fill_qty = float(event.get("fill_qty", 0))
        avg_price = float(event.get("avg_price", 0))

        order.apply_fill(fill_price, fill_qty)
        if avg_price > 0:
            order.avg_fill_price = avg_price

        # Track for dedup
        self._processed_fills[coid] = time.time()
        # Evict old entries
        if len(self._processed_fills) > 5000:
            cutoff = time.time() - 300
            self._processed_fills = {
                k: v for k, v in self._processed_fills.items() if v > cutoff
            }

        await self._bus.publish("ORDER_STATE_FILLED", {
            "client_order_id": coid,
            "exchange_order_id": order.exchange_order_id or "",
            "symbol": order.symbol,
            "side": order.side,
            "order_type": order.order_type,
            "fill_price": str(fill_price),
            "fill_qty": str(fill_qty),
            "avg_price": str(avg_price or order.avg_fill_price),
            "quantity": str(order.quantity),
            "origin": order.origin,
            "parent_id": order.parent_id or "",
            "sub_account_id": order.sub_account_id,
            "reduce_only": str(order.reduce_only),
            "leverage": str(getattr(order, "leverage", 1)),
        })

    async def _on_cancelled(self, order: Any, event: dict, status: str) -> None:
        """Handle CANCELED/EXPIRED/REJECTED status."""
        new_state = "cancelled" if status != "EXPIRED" else "expired"
        order.transition(new_state)

        await self._bus.publish("ORDER_STATE_CANCELLED", {
            "client_order_id": order.client_order_id,
            "exchange_order_id": order.exchange_order_id or "",
            "symbol": order.symbol,
            "side": order.side,
            "reason": status,
            "origin": order.origin,
            "parent_id": order.parent_id or "",
            "sub_account_id": order.sub_account_id,
        })

    @staticmethod
    def _build_om_data(event: dict) -> dict:
        """Convert stream event back to OrderManager data format (for bot order creation)."""
        return {
            "order_id": event.get("exchange_order_id", ""),
            "client_order_id": event.get("client_order_id", ""),
            "symbol": event.get("symbol", ""),
            "side": event.get("side", ""),
            "order_type": event.get("order_type", ""),
            "order_status": event.get("status", ""),
            "orig_qty": event.get("quantity", "0"),
            "price": event.get("price", "0"),
            "last_filled_qty": event.get("fill_qty", "0"),
            "last_filled_price": event.get("fill_price", "0"),
            "accumulated_filled_qty": event.get("accumulated_filled_qty", "0"),
            "avg_price": event.get("avg_price", "0"),
            "reduce_only": event.get("reduce_only", False),
            "parent_id": event.get("parent_id", ""),
            "origin": event.get("origin", "BOT"),
            "sub_account_id": event.get("sub_account_id", ""),
        }

    @staticmethod
    def _to_bool(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ("1", "true", "yes")

    @staticmethod
    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @classmethod
    def _to_optional_float(cls, value: Any) -> Optional[float]:
        if value in (None, "", "None"):
            return None
        return cls._to_float(value)
