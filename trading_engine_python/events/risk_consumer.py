"""
RiskConsumer — Processes ORDER_STATE_* events → positions, margin, DB, Redis.

Reads from: pms:stream:trade_events (ORDER_STATE_FILLED, ORDER_STATE_CANCELLED, ACCOUNT_UPDATE)
Responsibilities:
    - Call risk engine on fills (position book, margin, PnL)
    - Update Redis open_orders hash (add on NEW, remove on FILLED/CANCELLED)
    - Write to DB (pending_orders table)
    - Publish order events for frontend (order_placed, order_filled, etc.)
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


class RiskConsumer:
    """Processes order state events for risk management and persistence."""

    def __init__(
        self,
        order_manager: Any,
        risk_engine: Any,
        redis_client: Any,
        db: Any,
    ) -> None:
        self._om = order_manager
        self._risk = risk_engine
        self._redis = redis_client
        self._db = db

    async def handle(self, events: list[dict]) -> None:
        """Process a batch of order state events."""
        for event in events:
            try:
                await self._process_event(event)
            except Exception as e:
                logger.error("RiskConsumer error on %s (coid=%s): %s",
                             event.get("type"), event.get("client_order_id"), e)

    async def _process_event(self, event: dict) -> None:
        event_type = event.get("type", "")
        client_order_id = event.get("client_order_id", "")

        if event_type == "ORDER_STATE_NEW":
            await self._on_new(event)

        elif event_type == "ORDER_STATE_FILLED":
            await self._on_filled(event)

        elif event_type == "ORDER_STATE_CANCELLED":
            await self._on_cancelled(event)

        elif event_type == "ORDER_STATE_PARTIAL":
            await self._on_partial(event)

        elif event_type == "ACCOUNT_UPDATE":
            await self._on_account_update(event)

    async def _on_new(self, event: dict) -> None:
        """Order confirmed active on exchange → add to Redis open_orders."""
        order = self._om.get_order(event.get("client_order_id", ""))
        if order:
            if not order.is_terminal and order.order_type != "MARKET":
                await self._om._redis_set_open_order(order)
            # Publish for frontend
            if order.order_type == "LIMIT":
                await self._om._publish_event("order_placed", order)
            if not order.is_terminal and order.order_type != "MARKET":
                await self._om._publish_event("order_active", order)

    async def _on_filled(self, event: dict) -> None:
        """Order filled → risk engine + remove from open_orders + DB."""
        order = self._om.get_order(event.get("client_order_id", ""))
        if not order:
            return

        # Remove from Redis open orders
        await self._om._redis_remove_open_order(order)

        # DB update
        await self._om._db_update_pending_order(order, "FILLED")

        # Risk engine: position + margin + PnL
        if self._risk:
            try:
                await self._risk.on_order_fill(order)
            except Exception as e:
                logger.error("Risk on_order_fill error for %s: %s",
                             order.client_order_id, e)

        # Frontend event
        await self._om._publish_event("order_filled", order)

    async def _on_cancelled(self, event: dict) -> None:
        """Order cancelled → remove from open_orders + DB."""
        order = self._om.get_order(event.get("client_order_id", ""))
        if not order:
            return

        reason = event.get("reason", "CANCELLED")
        await self._om._publish_event("order_cancelled", order, reason=reason)
        await self._om._redis_remove_open_order(order)
        await self._om._db_update_pending_order(order, "CANCELLED")

    async def _on_partial(self, event: dict) -> None:
        """Partial fill → publish event."""
        order = self._om.get_order(event.get("client_order_id", ""))
        if order:
            await self._om._publish_event("order_partial", order)

    async def _on_account_update(self, event: dict) -> None:
        """Account update from exchange → risk engine."""
        if self._risk:
            try:
                payload = event.get("payload")
                if payload:
                    account_data = json.loads(payload)
                else:
                    # Backward-compatible fallback for older stream entries.
                    raw = json.loads(event.get("data", "{}"))
                    account_data = {
                        "balances": raw.get("B", []),
                        "positions": [
                            {
                                "symbol": pos.get("s", ""),
                                "position_amount": float(pos.get("pa", 0)),
                                "entry_price": float(pos.get("ep", 0)),
                                "unrealized_pnl": float(pos.get("up", 0)),
                                "margin_type": pos.get("mt", ""),
                                "isolated_wallet": float(pos.get("iw", 0)),
                                "position_side": pos.get("ps", "BOTH"),
                            }
                            for pos in raw.get("P", [])
                        ],
                        "event_time": int(event.get("event_time", 0) or 0),
                        "transaction_time": int(event.get("transaction_time", 0) or 0),
                    }
                await self._risk.on_account_update(account_data)
            except Exception as e:
                logger.error("RiskConsumer account_update error: %s", e)
