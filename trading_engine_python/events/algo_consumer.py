"""
AlgoConsumer — Processes ORDER_STATE_* events → algo engine fill/cancel handling.

Reads from: pms:stream:trade_events (ORDER_STATE_FILLED, ORDER_STATE_CANCELLED)
Responsibilities:
    - Route fills to the correct algo engine (chase → scalper)
    - Handle chase fills (transition state, notify scalper)
    - Handle scalper slot restarts (no more lambda callbacks)
    - Handle chase cancels (re-arm or delegate to scalper)

This consumer REPLACES:
    - order.on_fill / order.on_cancel lambda callbacks
    - chase._on_fill / chase._on_cancel
    - scalper._on_child_fill / _on_child_cancel via ensure_future
"""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)


class AlgoConsumer:
    """Routes order state events to algo engines for fill/cancel processing.

    Event routing:
        ORDER_STATE_FILLED  + origin=CHASE → chase.on_fill_event → scalper
        ORDER_STATE_CANCELLED + origin=CHASE → chase.on_cancel_event → scalper
    """

    def __init__(
        self,
        chase_engine: Any,
        scalper_engine: Any,
        twap_engine: Any,
        trail_stop_engine: Any,
    ) -> None:
        self._chase = chase_engine
        self._scalper = scalper_engine
        self._twap = twap_engine
        self._trail_stop = trail_stop_engine

    async def handle(self, events: list[dict]) -> None:
        """Process a batch of order state events."""
        for event in events:
            try:
                await self._process_event(event)
            except Exception as e:
                logger.error("AlgoConsumer error on %s (coid=%s, parent=%s): %s",
                             event.get("type"), event.get("client_order_id"),
                             event.get("parent_id"), e)

    async def _process_event(self, event: dict) -> None:
        event_type = event.get("type", "")
        origin = event.get("origin", "")
        parent_id = event.get("parent_id", "")

        # Only process events from algo-managed orders
        if origin not in ("CHASE", "SCALPER", "TWAP", "TRAIL_STOP"):
            return

        if event_type == "ORDER_STATE_FILLED":
            await self._on_filled(event, origin, parent_id)
        elif event_type == "ORDER_STATE_CANCELLED":
            await self._on_cancelled(event, origin, parent_id)
        elif event_type == "ORDER_STATE_PARTIAL":
            await self._on_partial(event, origin, parent_id)

    async def _on_filled(self, event: dict, origin: str, parent_id: str) -> None:
        """Route fill event to the appropriate algo engine."""
        if origin == "CHASE":
            # Find the chase state
            chase_state = self._chase._active.get(parent_id)
            if chase_state:
                await self._chase.on_fill_event(chase_state, event)
            else:
                logger.debug("AlgoConsumer: chase %s not in _active (already cleaned up)", parent_id)

        elif origin == "TWAP":
            if hasattr(self._twap, "on_fill_event"):
                await self._twap.on_fill_event(event)

        elif origin == "TRAIL_STOP":
            if hasattr(self._trail_stop, "on_fill_event"):
                await self._trail_stop.on_fill_event(event)

    async def _on_cancelled(self, event: dict, origin: str, parent_id: str) -> None:
        """Route cancel event to the appropriate algo engine."""
        if origin == "CHASE":
            chase_state = self._chase._active.get(parent_id)
            if chase_state:
                reason = event.get("reason", "CANCELLED")
                await self._chase.on_cancel_event(chase_state, event, reason)
            else:
                logger.debug("AlgoConsumer: chase %s not in _active for cancel", parent_id)

    async def _on_partial(self, event: dict, origin: str, parent_id: str) -> None:
        """Route partial fill to the appropriate algo engine."""
        if origin == "CHASE":
            chase_state = self._chase._active.get(parent_id)
            if chase_state and hasattr(chase_state, "on_partial"):
                pass  # Chase doesn't currently handle partials specially
