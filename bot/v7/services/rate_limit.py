#!/usr/bin/env python3
"""Async rate limiting helpers for Binance sync services."""

import asyncio
import random
import time
from dataclasses import dataclass


@dataclass
class BackoffConfig:
    """Exponential backoff policy for transient API errors."""
    base_delay_sec: float = 0.35
    max_delay_sec: float = 20.0
    jitter_sec: float = 0.15

    def delay(self, attempt: int) -> float:
        exp = self.base_delay_sec * (2 ** max(0, attempt))
        delay = min(self.max_delay_sec, exp)
        jitter = random.random() * self.jitter_sec
        return delay + jitter


class AsyncTokenBucket:
    """
    Simple async token bucket limiter.

    rate_per_sec: steady refill rate.
    burst: max token capacity.
    """

    def __init__(self, rate_per_sec: float, burst: float):
        self.rate_per_sec = max(rate_per_sec, 0.1)
        self.capacity = max(burst, 1.0)
        self.tokens = self.capacity
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = max(0.0, now - self._last)
        self._last = now
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate_per_sec)

    async def acquire(self, weight: float = 1.0) -> None:
        """Block until enough tokens are available."""
        need = max(weight, 0.0)
        while True:
            async with self._lock:
                self._refill()
                if self.tokens >= need:
                    self.tokens -= need
                    return
                deficit = need - self.tokens
                wait_for = deficit / self.rate_per_sec
            await asyncio.sleep(max(wait_for, 0.001))
