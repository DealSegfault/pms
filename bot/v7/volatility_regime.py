#!/usr/bin/env python3
"""Volatility regime calibration for v7 grid layering."""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from bot.v7.candles_client import CandleServiceClient, CandleServiceError

logger = logging.getLogger(__name__)


@dataclass
class VolatilitySnapshot:
    baseline_bps: float = 0.0
    live_bps: float = 0.0
    blended_bps: float = 0.0
    drift_mult: float = 1.0
    tail_ratio: float = 1.0
    heavy_tail: bool = False
    last_refresh_ts: float = 0.0
    source: str = "live_only"


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def _compute_vol_bps_from_close(frame: Any) -> float:
    """
    Compute volatility in bps from candle closes.

    Returns std(log returns) * 10_000.
    """
    if frame is None:
        return 0.0
    try:
        closes = frame["close"]
    except Exception:
        return 0.0

    try:
        vals = [float(x) for x in closes.tolist()]
    except Exception:
        try:
            vals = [float(x) for x in closes]
        except Exception:
            return 0.0

    rets = []
    prev = None
    for px in vals:
        if prev is not None and prev > 0 and px > 0:
            rets.append(math.log(px / prev))
        prev = px
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) * (r - mean) for r in rets) / len(rets)
    return max(0.0, math.sqrt(var) * 10000.0)


class MultiTFVolatilityCalibrator:
    """
    Async-safe via background thread: updates historical vol from multi-TF candles.

    Main thread calls `update(live_vol_bps, now)` frequently.
    A background worker refreshes MTF baseline on schedule.
    """

    def __init__(
        self,
        symbol: str,
        *,
        enabled: bool = True,
        candle_service_url: str = "http://localhost:3003",
        exchange: str = "binance",
        tf_weights: Optional[Dict[str, float]] = None,
        tf_lookbacks: Optional[Dict[str, str]] = None,
        refresh_sec: float = 120.0,
        live_weight: float = 0.45,
        drift_min: float = 0.8,
        drift_max: float = 3.0,
        tail_mult: float = 2.2,
        live_ema_alpha: float = 0.25,
    ):
        self.symbol = symbol.upper()
        self.exchange = exchange
        self.refresh_sec = max(refresh_sec, 15.0)
        self.live_weight = _clamp(live_weight, 0.0, 1.0)
        self.drift_min = max(0.1, drift_min)
        self.drift_max = max(self.drift_min, drift_max)
        self.tail_mult = max(1.0, tail_mult)
        self.live_ema_alpha = _clamp(live_ema_alpha, 0.01, 1.0)

        default_weights = {"1m": 0.5, "5m": 0.3, "15m": 0.2}
        self.tf_weights = self._normalize_weights(tf_weights or default_weights)
        self.tf_lookbacks = tf_lookbacks or {"1m": "6h", "5m": "2d", "15m": "7d"}

        self._lock = threading.Lock()
        self._last_refresh_ts = 0.0
        self._baseline_bps = 0.0
        self._tf_vol_bps: Dict[str, float] = {}
        self._live_vol_ema_bps = 0.0
        self._worker: Optional[threading.Thread] = None

        self._client = None
        self._client_error_type = Exception
        self.enabled = bool(enabled)
        if self.enabled:
            try:
                self._client = CandleServiceClient(base_url=candle_service_url)
                self._client_error_type = CandleServiceError
            except Exception as e:
                logger.warning("Vol calibrator disabled: failed creating candles client (%s)", e)
                self.enabled = False

    @staticmethod
    def _normalize_weights(raw: Dict[str, float]) -> Dict[str, float]:
        clean: Dict[str, float] = {}
        for tf, w in raw.items():
            try:
                wf = float(w)
            except Exception:
                continue
            if wf > 0:
                clean[str(tf)] = wf
        total = sum(clean.values())
        if total <= 0:
            return {"1m": 1.0}
        return {tf: w / total for tf, w in clean.items()}

    def _maybe_start_refresh(self, now: float) -> None:
        if not self.enabled or self._client is None:
            return
        if self._worker is not None and self._worker.is_alive():
            return
        if self._last_refresh_ts > 0 and (now - self._last_refresh_ts) < self.refresh_sec:
            return
        self._worker = threading.Thread(target=self._refresh_worker, name=f"v7-vol-{self.symbol}", daemon=True)
        self._worker.start()

    def _refresh_worker(self) -> None:
        tf_vols: Dict[str, float] = {}
        now = time.time()
        for tf, weight in self.tf_weights.items():
            if weight <= 0:
                continue
            lookback = self.tf_lookbacks.get(tf)
            try:
                kwargs: Dict[str, Any] = {
                    "exchange": self.exchange,
                    "pair": self.symbol,
                    "timeframe": tf,
                }
                if lookback:
                    kwargs["length"] = lookback
                frame = self._client.fetch_candles(**kwargs)
                vol_bps = _compute_vol_bps_from_close(frame)
                if vol_bps > 0:
                    tf_vols[tf] = vol_bps
            except self._client_error_type as e:  # type: ignore[misc]
                logger.debug("Vol calibrator candle fetch failed for %s %s: %s", self.symbol, tf, e)
            except Exception as e:
                logger.debug("Vol calibrator unexpected fetch error for %s %s: %s", self.symbol, tf, e)

        if not tf_vols:
            with self._lock:
                self._last_refresh_ts = now
            return

        # Reweight only on available TFs.
        total_w = sum(self.tf_weights.get(tf, 0.0) for tf in tf_vols.keys())
        if total_w <= 0:
            baseline = sum(tf_vols.values()) / len(tf_vols)
        else:
            baseline = sum(tf_vols[tf] * (self.tf_weights.get(tf, 0.0) / total_w) for tf in tf_vols.keys())

        with self._lock:
            self._tf_vol_bps = tf_vols
            self._baseline_bps = max(0.0, baseline)
            self._last_refresh_ts = now

    def update(self, live_vol_bps: float, now: Optional[float] = None) -> VolatilitySnapshot:
        now = now if now is not None else time.time()
        lv = max(float(live_vol_bps), 0.0)
        if lv > 0:
            with self._lock:
                if self._live_vol_ema_bps <= 0:
                    self._live_vol_ema_bps = lv
                else:
                    self._live_vol_ema_bps += self.live_ema_alpha * (lv - self._live_vol_ema_bps)

        self._maybe_start_refresh(now)

        with self._lock:
            baseline_bps = float(self._baseline_bps)
            live_bps = float(self._live_vol_ema_bps)
            last_refresh = float(self._last_refresh_ts)

        if baseline_bps <= 0:
            baseline_bps = max(live_bps, 8.0)
        if live_bps <= 0:
            live_bps = baseline_bps

        blended_bps = (1.0 - self.live_weight) * baseline_bps + self.live_weight * live_bps
        drift_mult = _clamp(blended_bps / max(baseline_bps, 1e-9), self.drift_min, self.drift_max)
        tail_ratio = max(live_bps, blended_bps) / max(baseline_bps, 1e-9)
        heavy_tail = tail_ratio >= self.tail_mult

        source = "mtf+live" if self.enabled and self._baseline_bps > 0 else "live_only"
        return VolatilitySnapshot(
            baseline_bps=baseline_bps,
            live_bps=live_bps,
            blended_bps=blended_bps,
            drift_mult=drift_mult,
            tail_ratio=tail_ratio,
            heavy_tail=heavy_tail,
            last_refresh_ts=last_refresh,
            source=source,
        )
