"""
Dynamic parameter adjustment mixin — extracted from GridTrader.

Methods that adapt trading parameters based on recent behavior,
volatility regime, and position state.
"""
import logging
import math
import time
from typing import Dict, Any

logger = logging.getLogger(__name__)


class DynamicsMixin:
    """Dynamic parameter tuning for GridTrader."""

    def _spread_scaled_notional(self, spread_bps: float) -> float:
        """Scale position size by spread width: wider spread = bigger size.

        Linear interpolation from min_notional at min_spread to max_notional
        at 3× min_spread. Captures more edge on wide-spread opportunities.
        """
        lo = max(self.config.min_spread_bps, 1.0)
        hi = lo * 3.0  # Full scale at 3× minimum spread
        t = max(0.0, min((spread_bps - lo) / max(hi - lo, 1.0), 1.0))
        return self.config.min_notional + t * (self.config.max_notional - self.config.min_notional)

    def _dynamic_entry_cooldown_sec(self) -> float:
        base = max(self.config.cooldown_sec, 0.1)
        if not self.config.dynamic_behavior_enabled:
            return base
        dup = self._duplicate_fill_ratio()
        near_zero = self._near_zero_close_ratio()
        vol = max(self._vol_snapshot.drift_mult, 0.5)
        mult = 1.0 + (dup * 3.0 + near_zero * 2.0) / vol
        # Falling-knife escalation: if recent closes form a declining pattern,
        # increase cooldown to avoid catching falling knives
        mult *= self._falling_knife_cooldown_mult()
        return min(max(base * mult, base), base * 8.0)

    def _falling_knife_cooldown_mult(self) -> float:
        """Escalate cooldown if recent closes form a declining pattern."""
        prices = list(self._recent_close_prices)
        if len(prices) < 2:
            return 1.0
        declining = sum(1 for i in range(1, len(prices)) if prices[i] < prices[i - 1])
        ratio = declining / (len(prices) - 1)  # 0..1
        if ratio > 0.6:  # >60% of recent closes are lower than previous
            return 1.0 + ratio * 4.0  # Up to 5x cooldown
        return 1.0

    def _averaging_min_spread(self, spread_bps: float) -> float:
        """Spread requirement for averaging, reduced when deeply underwater.
        Two-phase curve:
        - Phase 1 (0 to threshold): full min_spread_bps required
        - Phase 2 (threshold+): quadratic relief, drops to floor of 0.15× at -500bp+
        This lets tight-spread pairs like VVVUSDT (3.7bp) average when underwater."""
        base = self.config.min_spread_bps
        unr_bps = abs(self._unrealized_bps())
        threshold = self.config.recovery_avg_min_unrealized_bps  # 35bp default

        if unr_bps < threshold:
            return base  # No relief yet

        # Past threshold: quadratic ease from 1.0 → 0.15 over threshold..500bp
        depth_past = unr_bps - threshold
        max_depth = 500.0 - threshold
        t = min(depth_past / max_depth, 1.0)  # 0..1 normalized
        # Quadratic: drops faster at first, then levels off
        relief_factor = max(0.15, 1.0 - 0.85 * (t ** 0.3))
        return base * relief_factor

    def _waterfall_score(self) -> float:
        """Drawdown from 30s high, in vol units, with exponential decay.
        Returns a score > 0. Higher = more waterfall-like."""
        if not self._price_30s_high or self.mid <= 0:
            return 0.0
        # Rolling 30s max price
        high = max(p for _, p in self._price_30s_high)
        if high <= 0:
            return 0.0
        drawdown_bps = (high - self.mid) / high * 10000
        if drawdown_bps <= 0:
            return 0.0
        # Age penalty: how long ago was the peak?
        now = time.time()
        peak_age = max(now - self._waterfall_peak_ts, 0.0)
        decay_hl = max(self.config.waterfall_decay_sec, 1.0)
        decay = math.exp(-peak_age * math.log(2) / decay_hl)
        # Normalize by volatility
        vol = max(self._vol_snapshot.blended_bps, 1.0)
        return (drawdown_bps / vol) * decay

    def _dynamic_layer_gap_bps(self) -> float:
        base = max(self.config.min_spread_bps, self._median_spread_bps, self._fee_floor_bps() * 0.5)
        if not self.config.dynamic_behavior_enabled:
            return base
        dup = self._duplicate_fill_ratio()
        return max(base * (1.0 + 2.0 * dup), base)

    def _dynamic_min_tp_profit_bps(self) -> float:
        base = max(self.config.min_tp_profit_bps, 0.0)
        fee = self._fee_floor_bps()
        if not self.config.dynamic_behavior_enabled:
            return max(base, fee * 1.1)
        near_zero = self._near_zero_close_ratio()
        loss = self._loss_reason_pressure()
        target = max(base, fee * (1.1 + near_zero))
        return target * (1.0 + 0.5 * loss)

    def _dynamic_min_fast_tp_bps(self) -> float:
        base = float(self.config.min_fast_tp_bps)
        if not self.config.dynamic_behavior_enabled:
            return base
        fee = self._fee_floor_bps()
        near_zero = self._near_zero_close_ratio()
        adjust = fee * (0.3 + near_zero)
        return min(base - adjust, -1.0)

    def _dynamic_max_layers(self) -> int:
        base = max(int(self.config.max_layers), 1)
        if not self.config.dynamic_behavior_enabled:
            return base
        samples = [s for s in self._recent_close_behaviors if int(s.get("layers", 0)) >= 3]
        if len(samples) < 8:
            return base
        avg_deep_bps = sum(float(s["net_bps"]) for s in samples) / len(samples)
        fee = self._fee_floor_bps()
        if avg_deep_bps < 0:
            return min(base, 2)
        if avg_deep_bps < fee:
            return min(base, 3)
        return base

    def _effective_tp_mode(self) -> str:
        """Resolve tp_mode, applying auto-switching based on position size."""
        mode = getattr(self.config, 'tp_mode', 'auto')
        if mode == 'auto':
            return 'vol' if self.total_notional > 50.0 else 'fast'
        return mode

    def _base_spacing_bps(self) -> float:
        """Get base spacing — vol-aware blend of spread + OHLCV/micro volatility.

        Uses the higher of:
          - Median spread (microstructure liquidity)
          - Blended volatility (OHLCV baseline + live realized vol)
        This ensures high-vol coins get appropriately wider spacing even
        when their spread is tight, and calm coins stay tight.
        """
        if self.config.base_spacing_bps > 0:
            return self.config.base_spacing_bps

        spread = self._median_spread_bps if self._median_spread_bps > 0 else 0.0
        vol = self._vol_snapshot.blended_bps if self._vol_snapshot.blended_bps > 0 else 0.0

        # Use the dominant signal: whichever is larger drives the grid width
        base = max(spread, vol, 5.0)
        return base

    def _effective_spacing_growth(self) -> float:
        """Geometric spacing growth adjusted by volatility drift."""
        growth = self.config.spacing_growth * self._vol_snapshot.drift_mult
        return min(max(growth, 1.05), 8.0)

    def _tp_target_bps(self) -> float:
        """Calculate TP target in bps, with vol-scaling and optional time-decay."""
        if self._median_spread_bps > 0:
            spread_tp = self._median_spread_bps * self.config.tp_spread_mult
        else:
            spread_tp = 5.0

        # Vol-scaled TP: during vol shocks, scale TP with live vol
        vol_tp = 0.0
        if self.config.tp_vol_capture_ratio > 0 and self._vol_snapshot.live_bps > 0:
            vol_tp = min(
                self._vol_snapshot.live_bps * self.config.tp_vol_capture_ratio,
                self.config.tp_vol_scale_cap,
            )

        target = max(spread_tp, vol_tp)

        # Time-decay: tighten TP as position ages (Guéant et al.)
        half_life = self.config.tp_decay_half_life_min
        if half_life > 0 and self.layers:
            oldest_ts = min(l.entry_ts for l in self.layers)
            age_min = (time.time() - oldest_ts) / 60.0
            # Linear decay: 1.0 at age=0, floor at age=half_life
            decay = max(self.config.tp_decay_floor,
                        1.0 - age_min * (1.0 - self.config.tp_decay_floor) / half_life)
            target *= decay

        return target

    def _update_vol_regime(self, now: float) -> None:
        """Update blended volatility regime from live + weighted MTF OHLCV."""
        live_vol_bps = self.signals.rv_1s * 10000.0
        self._vol_snapshot = self._vol_calibrator.update(live_vol_bps, now)

        # Heavy-tail gate: pause adding layers for a dynamic cooldown window.
        if self.layers and self._vol_snapshot.heavy_tail and self.config.vol_tail_cooldown_sec > 0:
            scale = self._vol_snapshot.tail_ratio / max(self.config.vol_tail_mult, 1.0)
            scale = min(max(scale, 1.0), 3.0)
            cool = self.config.vol_tail_cooldown_sec * scale
            self._layer_cooldown_until = max(self._layer_cooldown_until, now + cool)
            if now - self._last_tail_log_ts > 5.0:
                logger.warning(
                    f"🌪️ {self.symbol} heavy-tail detected: ratio={self._vol_snapshot.tail_ratio:.2f} "
                    f"(baseline={self._vol_snapshot.baseline_bps:.1f}bps, live={self._vol_snapshot.live_bps:.1f}bps) "
                    f"-> layer cooldown {cool:.1f}s"
                )
                self._last_tail_log_ts = now

    def _can_trade(self, now: float) -> bool:
        """Check circuit breaker."""
        if self._cooldown_until > 0:
            if now < self._cooldown_until:
                return False
            self._cooldown_until = 0.0

        if self._circuit_breaker_ts > 0:
            if now - self._circuit_breaker_ts < self.config.circuit_pause_sec:
                return False
            else:
                logger.info(f"🔄 {self.symbol} circuit breaker reset")
                self._circuit_breaker_ts = 0
                if self.realized_pnl_bps < -self.config.max_loss_bps:
                    self._circuit_breaker_ts = now
                    return False
        return True
