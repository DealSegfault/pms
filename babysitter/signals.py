from __future__ import annotations

import math
import statistics
import time
from collections import defaultdict, deque
from typing import DefaultDict, Deque, Tuple

from .models import SignalSnapshot
from .utils import clamp, safe_float


class SignalModel:
    """
    Lightweight long/short signal model from short-horizon mark-price history.

    Outputs:
      - direction bias (LONG/SHORT/NEUTRAL)
      - momentum on 30s and 120s windows (bps)
      - realized volatility proxy over 60s (bps stdev)
    """

    def __init__(self, max_points: int = 900):
        self._max_points = max_points
        self._history: DefaultDict[str, Deque[Tuple[float, float]]] = defaultdict(
            lambda: deque(maxlen=self._max_points)
        )

    def update_price(self, raw_symbol: str, price: float, ts: float | None = None) -> None:
        raw = str(raw_symbol or "").upper().strip()
        p = safe_float(price, 0.0)
        if not raw or p <= 0:
            return
        self._history[raw].append((ts or time.time(), p))

    def snapshot(self, raw_symbol: str, now: float | None = None) -> SignalSnapshot:
        raw = str(raw_symbol or "").upper().strip()
        series = self._history.get(raw)
        if not series:
            return SignalSnapshot(
                bias="NEUTRAL",
                momentum_bps_30s=0.0,
                momentum_bps_120s=0.0,
                vol_bps_60s=0.0,
                edge_bps=0.0,
            )

        t_now = now or time.time()
        current = series[-1][1]

        m30 = self._momentum_bps(series, current, t_now, window_sec=30.0)
        m120 = self._momentum_bps(series, current, t_now, window_sec=120.0)
        vol60 = self._vol_bps(series, t_now, window_sec=60.0)

        bias = "NEUTRAL"
        if m30 >= 12 and m120 >= 20:
            bias = "LONG"
        elif m30 <= -12 and m120 <= -20:
            bias = "SHORT"

        edge = clamp((0.60 * m30) + (0.40 * m120), -200.0, 200.0)

        return SignalSnapshot(
            bias=bias,
            momentum_bps_30s=m30,
            momentum_bps_120s=m120,
            vol_bps_60s=vol60,
            edge_bps=edge,
        )

    def _momentum_bps(
        self,
        series: Deque[Tuple[float, float]],
        current_price: float,
        now: float,
        window_sec: float,
    ) -> float:
        target_ts = now - window_sec
        ref_price = None
        # Find nearest point at or before target timestamp.
        for ts, price in reversed(series):
            if ts <= target_ts:
                ref_price = price
                break
        if ref_price is None:
            ref_price = series[0][1]
        if ref_price <= 0:
            return 0.0
        return ((current_price / ref_price) - 1.0) * 10_000.0

    def _vol_bps(self, series: Deque[Tuple[float, float]], now: float, window_sec: float) -> float:
        cutoff = now - window_sec
        prices = [price for ts, price in series if ts >= cutoff and price > 0]
        if len(prices) < 3:
            return 0.0

        rets = []
        prev = prices[0]
        for price in prices[1:]:
            if price > 0 and prev > 0:
                rets.append(math.log(price / prev) * 10_000.0)
            prev = price

        if len(rets) < 2:
            return 0.0
        return clamp(statistics.pstdev(rets), 0.0, 1_000.0)

