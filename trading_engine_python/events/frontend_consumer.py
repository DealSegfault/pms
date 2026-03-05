"""
FrontendConsumer — Forwards normalized order-state events to frontend via Redis PubSub.

Reads from: pms:stream:trade_events (all event types)
Responsibilities:
    - Publish order-state events to pms:events:{type}
    - Preserve the existing JS/frontend WS contract
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)
EVENT_MAP = {
    "ORDER_STATE_NEW": "order_active",
    "ORDER_STATE_PARTIAL": "order_partial",
    "ORDER_STATE_FILLED": "order_filled",
    "ORDER_STATE_CANCELLED": "order_cancelled",
    "ORDER_STATE_REJECTED": "order_failed",
}


class FrontendConsumer:
    """Forwards trade events to frontend via Redis PubSub."""

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def handle(self, events: list[dict]) -> None:
        """Forward events to frontend PubSub channel."""
        for event in events:
            try:
                event_type = event.get("type", "")
                mapped = EVENT_MAP.get(event_type)
                if mapped:
                    await self._publish(mapped, event)
            except Exception as e:
                logger.debug("FrontendConsumer publish error: %s", e)

    async def _publish(self, event_type: str, event: dict) -> None:
        """Publish event to Redis PubSub for frontend WebSocket."""
        from contracts.common import RedisKey

        # Strip internal fields
        clean = {k: v for k, v in event.items() if not k.startswith("_")}
        await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(clean))
