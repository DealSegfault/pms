"""
TradeEventBus — Redis Stream producer/consumer for decoupled trade processing.

Architecture:
    UserStreamService (publisher)
        → XADD pms:stream:trade_events {type, client_order_id, ...}

    Consumers (each with own consumer group offset):
        OrderConsumer   → order state transitions
        RiskConsumer    → positions + margin + DB
        AlgoConsumer    → chase/scalper fill handling
        FrontendConsumer → WS event forwarding

Redis Streams guarantee:
    - Persistent (survives restarts)
    - Ordered (within a single producer)
    - At-least-once delivery (consumer groups + XACK)
    - Consumer-group-specific offsets (each downstream tracks independently)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Optional

from contracts.common import RedisKey

logger = logging.getLogger(__name__)

# Stream configuration
STREAM_KEY = RedisKey.trade_stream()
MAX_STREAM_LEN = 50_000  # Trim stream to last 50k events (~1 day at high volume)
BLOCK_MS = 2000           # XREADGROUP block timeout
BATCH_SIZE = 50           # Max events per XREADGROUP call
CLAIM_IDLE_MS = 30_000    # Claim pending events idle > 30s (dead consumer recovery)


class TradeEventBus:
    """Redis Stream-based event bus for trade events.

    Publisher side:
        bus = TradeEventBus(redis)
        await bus.publish("ORDER_FILLED", {"client_order_id": "...", ...})

    Consumer side:
        async def handler(events: list[dict]) -> None:
            for event in events:
                ...  # process

        await bus.consume("order_consumer", handler)
    """

    def __init__(
        self,
        redis_client: Any,
        *,
        stream_key: str = STREAM_KEY,
        max_stream_len: int = MAX_STREAM_LEN,
    ) -> None:
        self._redis = redis_client
        self._running = True
        self._stream_key = stream_key
        self._max_stream_len = max_stream_len

    @staticmethod
    def group_name(name: str) -> str:
        """Derive a stable consumer group name for one downstream service."""
        return f"pms:{name}"

    async def ensure_group(self, group_name: str) -> None:
        """Create the consumer group if it doesn't exist.

        Uses MKSTREAM to create the stream if needed.
        Uses '0' as start ID so new consumers see all existing events.
        """
        try:
            await self._redis.xgroup_create(
                self._stream_key, group_name, id="0", mkstream=True
            )
            logger.info("Created consumer group '%s' on stream '%s'",
                        group_name, self._stream_key)
        except Exception as e:
            # BUSYGROUP = group already exists — safe to ignore
            if "BUSYGROUP" in str(e):
                logger.debug("Consumer group '%s' already exists", group_name)
            else:
                raise

    async def publish(self, event_type: str, data: dict) -> Optional[str]:
        """Publish an event to the trade event stream.

        Args:
            event_type: Event type (ORDER_NEW, ORDER_FILLED, ORDER_CANCELLED, ACCOUNT_UPDATE)
            data: Flat dict of event data (all values should be strings for Redis)

        Returns:
            Stream event ID, or None on error.
        """
        try:
            now_ms = int(time.time() * 1000)
            source_ts = (
                data.get("source_ts")
                or data.get("intent_ts")
                or data.get("order_trade_time")
                or data.get("event_time")
                or now_ms
            )
            entry = {
                "type": event_type,
                "ts": str(now_ms),
                "ingested_ts": str(now_ms),
                "source_ts": str(source_ts),
                **{k: str(v) for k, v in data.items()},
            }
            event_id = await self._redis.xadd(
                self._stream_key, entry, maxlen=self._max_stream_len, approximate=True
            )
            return event_id
        except Exception as e:
            logger.error("Failed to publish %s event: %s", event_type, e)
            return None

    async def consume(
        self,
        consumer_name: str,
        handler: Callable,
        group_name: Optional[str] = None,
        batch_size: int = BATCH_SIZE,
    ) -> None:
        """Run a consumer loop that reads from the stream and calls handler.

        This is a long-running coroutine — run it as a task.

        Args:
            consumer_name: Unique name for this consumer (e.g., "order_consumer")
            handler: Async function(events: list[dict]) → None
            batch_size: Max events per read
        """
        group = group_name or self.group_name(consumer_name)
        await self.ensure_group(group)
        logger.debug("Consumer '%s' starting on stream '%s' group '%s'",
                     consumer_name, self._stream_key, group)

        # First: process any pending events (from previous crash/restart)
        await self._process_pending(group, consumer_name, handler, batch_size)

        # Main loop: read new events
        while self._running:
            try:
                # XREADGROUP: block until events arrive or timeout
                results = await self._redis.xreadgroup(
                    group,
                    consumer_name,
                    {self._stream_key: ">"},  # ">" = only new, undelivered events
                    count=batch_size,
                    block=BLOCK_MS,
                )

                if not results:
                    continue  # Timeout — no new events

                for stream_name, events in results:
                    if not events:
                        continue

                    # Convert to list of dicts with event_id
                    parsed = []
                    for event_id, fields in events:
                        fields["_event_id"] = event_id
                        parsed.append(fields)

                    # Process batch
                    try:
                        await handler(parsed)
                    except Exception as e:
                        logger.error(
                            "Consumer '%s' handler error on %d events: %s",
                            consumer_name, len(parsed), e,
                        )
                        # Don't ACK failed events — they'll be retried
                        continue

                    # ACK all processed events
                    event_ids = [e["_event_id"] for e in parsed]
                    await self._redis.xack(self._stream_key, group, *event_ids)

            except asyncio.CancelledError:
                logger.info("Consumer '%s' cancelled", consumer_name)
                break
            except Exception as e:
                logger.error("Consumer '%s' loop error: %s", consumer_name, e)
                await asyncio.sleep(1.0)  # Backoff before retry

        logger.info("Consumer '%s' stopped", consumer_name)

    async def _process_pending(
        self,
        group_name: str,
        consumer_name: str,
        handler: Callable,
        batch_size: int,
    ) -> None:
        """Process events that were delivered but not ACK'd (crash recovery).

        On startup, read from "0" (beginning of pending list) instead of ">"
        to pick up any events that were delivered to this consumer but not
        acknowledged before it crashed.
        """
        pending_count = 0
        last_id = "0"

        while True:
            try:
                results = await self._redis.xreadgroup(
                    group_name,
                    consumer_name,
                    {self._stream_key: last_id},
                    count=batch_size,
                    block=0,  # Don't block for pending
                )

                if not results:
                    break

                for stream_name, events in results:
                    if not events:
                        break

                    parsed = []
                    for event_id, fields in events:
                        fields["_event_id"] = event_id
                        parsed.append(fields)
                        last_id = event_id

                    try:
                        await handler(parsed)
                        event_ids = [e["_event_id"] for e in parsed]
                        await self._redis.xack(self._stream_key, group_name, *event_ids)
                        pending_count += len(parsed)
                    except Exception as e:
                        logger.error("Consumer '%s' pending recovery error: %s",
                                     consumer_name, e)
                        break
                else:
                    continue
                break  # Inner break propagates

            except Exception as e:
                logger.error("Consumer '%s' pending scan error: %s", consumer_name, e)
                break

        if pending_count:
            logger.info("Consumer '%s' recovered %d pending events",
                        consumer_name, pending_count)

    async def claim_stale(self, consumer_name: str, group_name: Optional[str] = None) -> int:
        """Claim events stuck in other dead consumers (XCLAIM).

        Call periodically to recover events from crashed consumers.
        Returns count of claimed events.
        """
        try:
            group = group_name or self.group_name(consumer_name)
            # Get pending entries idle > CLAIM_IDLE_MS
            pending = await self._redis.xpending_range(
                self._stream_key, group,
                min="-", max="+", count=100,
            )

            claimed = 0
            for entry in pending:
                idle_ms = entry.get("time_since_delivered", 0)
                if idle_ms > CLAIM_IDLE_MS:
                    event_id = entry["message_id"]
                    await self._redis.xclaim(
                        self._stream_key, group, consumer_name,
                        min_idle_time=CLAIM_IDLE_MS,
                        message_ids=[event_id],
                    )
                    claimed += 1

            return claimed
        except Exception as e:
            logger.debug("claim_stale error: %s", e)
            return 0

    async def stop(self) -> None:
        """Signal all consumer loops to stop."""
        self._running = False

    async def stream_info(self) -> dict:
        """Get stream info for monitoring."""
        try:
            info = await self._redis.xinfo_stream(self._stream_key)
            groups = await self._redis.xinfo_groups(self._stream_key)
            return {
                "length": info.get("length", 0),
                "first_entry": info.get("first-entry"),
                "last_entry": info.get("last-entry"),
                "groups": [
                    {
                        "name": g.get("name"),
                        "consumers": g.get("consumers"),
                        "pending": g.get("pending"),
                        "last_delivered": g.get("last-delivered-id"),
                    }
                    for g in groups
                ],
            }
        except Exception as e:
            logger.debug("stream_info error: %s", e)
            return {}
