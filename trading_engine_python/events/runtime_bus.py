"""
AlgoRuntimeBus — Redis Stream producer/consumer for algo runtime checkpoints.

This stream is independent from the canonical trade lifecycle stream so dense
runtime checkpoints do not pollute lifecycle truth or compete with its trim
budget.
"""

from __future__ import annotations

from .event_bus import TradeEventBus
from contracts.common import RedisKey


class AlgoRuntimeBus(TradeEventBus):
    def __init__(self, redis_client):
        super().__init__(
            redis_client,
            stream_key=RedisKey.algo_runtime_stream(),
            max_stream_len=20_000,
        )
