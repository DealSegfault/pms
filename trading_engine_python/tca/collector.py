"""
TCACollector — independent stream consumer for lifecycle/TCA persistence.

Reads canonical lifecycle events from the trade stream and materializes the
dedicated TCA tables without mutating OMS or risk state.
"""

from __future__ import annotations

import logging
from typing import Any

from contracts.common import StreamEventType

logger = logging.getLogger(__name__)


CANONICAL_LIFECYCLE_TYPES = {
    StreamEventType.ORDER_INTENT,
    "ORDER_STATE_NEW",
    "ORDER_STATE_PARTIAL",
    "ORDER_STATE_FILLED",
    "ORDER_STATE_CANCELLED",
    "ORDER_STATE_REJECTED",
}


class TCACollector:
    """Persist canonical lifecycle rows from an independent consumer group."""

    def __init__(self, lifecycle_store: Any) -> None:
        self._store = lifecycle_store

    async def handle(self, events: list[dict]) -> None:
        processed = 0
        for event in events:
            event_type = event.get("type", "")
            if event_type not in CANONICAL_LIFECYCLE_TYPES:
                continue
            await self._store.record(event)
            processed += 1

        if processed:
            logger.debug("TCACollector persisted %d lifecycle event(s)", processed)

