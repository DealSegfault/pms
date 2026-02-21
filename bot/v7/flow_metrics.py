#!/usr/bin/env python3
"""
Bounded-memory multi-timeframe flow metrics.

Tracks per-second trade aggregates and serves rolling-window metrics with O(1)
update cost and bounded memory footprint.
"""

import time
from collections import deque
from typing import Deque, Dict, Iterable, List, Optional, Tuple

# Rolling windows requested for signal weighting / analysis.
WINDOW_SPECS: Tuple[Tuple[int, str], ...] = (
    (1, "1s"),
    (5, "5s"),
    (10, "10s"),
    (30, "30s"),
    (60, "60s"),
    (300, "5m"),
    (600, "10m"),
)


class SecondBucketFlow:
    """
    Rolling per-second flow aggregator.

    Bucket schema: [sec_ts, buy_qty, sell_qty, trade_count, notional]
    Memory bound: max_window_sec + small slack.
    """

    __slots__ = ("_max_window_sec", "_buckets")

    def __init__(self, max_window_sec: int = 600):
        self._max_window_sec = max(int(max_window_sec), 1)
        self._buckets: Deque[List[float]] = deque()

    def add(self, ts: float, qty: float, price: float, is_sell: bool) -> None:
        """Add one trade event."""
        sec = int(ts)
        if sec <= 0:
            return
        qty_v = max(float(qty), 0.0)
        px_v = max(float(price), 0.0)
        if qty_v <= 0.0 or px_v <= 0.0:
            return

        self._evict(sec)
        bucket = self._ensure_bucket(sec)
        if bucket is None:
            return

        if is_sell:
            bucket[2] += qty_v
        else:
            bucket[1] += qty_v
        bucket[3] += 1.0
        bucket[4] += qty_v * px_v

    def _ensure_bucket(self, sec: int) -> Optional[List[float]]:
        if not self._buckets:
            b = [float(sec), 0.0, 0.0, 0.0, 0.0]
            self._buckets.append(b)
            return b

        last_sec = int(self._buckets[-1][0])
        if sec > last_sec:
            b = [float(sec), 0.0, 0.0, 0.0, 0.0]
            self._buckets.append(b)
            return b
        if sec == last_sec:
            return self._buckets[-1]

        # Out-of-order trade. Search recent buckets; otherwise drop stale update.
        for b in reversed(self._buckets):
            b_sec = int(b[0])
            if b_sec == sec:
                return b
            if b_sec < sec:
                break
        return None

    def _evict(self, now_sec: int) -> None:
        cutoff = now_sec - self._max_window_sec - 1
        while self._buckets and int(self._buckets[0][0]) < cutoff:
            self._buckets.popleft()

    def _window_totals(self, now_sec: int, window_sec: int) -> Tuple[float, float, float, float]:
        cutoff = now_sec - int(window_sec) + 1
        buy = 0.0
        sell = 0.0
        trades = 0.0
        notional = 0.0
        for sec, b, s, n_trades, n_notional in reversed(self._buckets):
            if int(sec) < cutoff:
                break
            buy += b
            sell += s
            trades += n_trades
            notional += n_notional
        return buy, sell, trades, notional

    def snapshot(
        self,
        now_ts: Optional[float] = None,
        prefix: str = "",
        windows: Iterable[Tuple[int, str]] = WINDOW_SPECS,
    ) -> Dict[str, float]:
        """
        Return flat metrics for each window.

        Keys per window:
          - {prefix}tw_<label>   : trade weight (total aggressive qty in window)
          - {prefix}tps_<label>  : trades per second
          - {prefix}nps_<label>  : notional per second
          - {prefix}ti_<label>   : signed imbalance in [-1, +1]
          - {prefix}lsr_<label>  : long/short ratio (buy_qty / sell_qty)
        """
        now_sec = int(now_ts if now_ts is not None else time.time())
        self._evict(now_sec)
        out: Dict[str, float] = {}
        for win_sec, label in windows:
            buy, sell, trades, notional = self._window_totals(now_sec, int(win_sec))
            total = buy + sell
            ti = (buy - sell) / total if total > 1e-12 else 0.0
            if sell > 1e-12:
                lsr = buy / sell
            elif buy > 0:
                lsr = 999.0
            else:
                lsr = 1.0

            denom = max(float(win_sec), 1.0)
            out[f"{prefix}tw_{label}"] = round(total, 6)
            out[f"{prefix}tps_{label}"] = round(trades / denom, 6)
            out[f"{prefix}nps_{label}"] = round(notional / denom, 6)
            out[f"{prefix}ti_{label}"] = round(ti, 6)
            out[f"{prefix}lsr_{label}"] = round(lsr, 6)
        return out
