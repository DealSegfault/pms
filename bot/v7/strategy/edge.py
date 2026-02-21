"""
Edge calculation mixin — extracted from GridTrader.

Pure-computation methods for evaluating entry edge, execution costs,
and behavioral metrics that inform entry/exit decisions.
"""
import logging
from typing import Dict, Any

import numpy as np

logger = logging.getLogger(__name__)


class EdgeMixin:
    """Edge and execution cost calculations for GridTrader."""

    def _fee_floor_bps(self) -> float:
        return max((self.config.maker_fee + self.config.taker_fee) * 10000.0, 0.0)

    def _symbol_notional_cap(self) -> float:
        return max(float(self.config.max_symbol_notional), 0.0)

    def _recovery_entry_hurdle_bps(self, projected_notional: float) -> float:
        if not self.config.recovery_debt_enabled or self.recovery_debt_usd <= 0:
            return 0.0
        notion = max(float(projected_notional), 0.0)
        if notion <= 0:
            return 0.0
        target_usd = self.recovery_debt_usd * max(float(self.config.recovery_paydown_ratio), 0.0)
        hurdle = target_usd / notion * 10000.0
        return min(max(hurdle, 0.0), max(float(self.config.recovery_max_paydown_bps), 0.0))

    def _recovery_exit_hurdle_bps(self) -> float:
        return self._recovery_entry_hurdle_bps(self.total_notional)

    def _expected_exit_slippage_bps(self) -> float:
        samples = [max(float(v), 0.0) for v in self._recent_exit_slippage_bps]
        if len(samples) < 5:
            return max(float(self.config.edge_default_slippage_bps), 0.0)
        return float(np.percentile(samples, 70))

    def _edge_uncertainty_penalty_bps(self) -> float:
        samples = [float(s.get("net_bps", 0.0)) for s in self._recent_close_behaviors]
        if len(samples) < max(1, int(self.config.edge_min_samples)):
            return max(float(self.config.edge_exec_buffer_bps), 0.0)
        # Winsorize at ±30 bps to prevent single outlier from spiking std (UU#6)
        clipped = [max(-30.0, min(s, 30.0)) for s in samples]
        std = float(np.std(clipped)) if len(clipped) >= 2 else 0.0
        penalty = max(float(self.config.edge_uncertainty_z), 0.0) * std
        return min(max(penalty, 0.0), 60.0)

    def _has_sufficient_edge(
        self,
        signal_strength: float,
        spread_bps: float,
        projected_notional: float,
        context: str,
    ) -> bool:
        """
        Lower-confidence-bound edge gate.

        expected_move - expected_cost - uncertainty >= required_hurdle
        """
        tp_target = max(self._tp_target_bps(), self._dynamic_min_tp_profit_bps())
        fee_floor = self._fee_floor_bps()
        slippage = self._expected_exit_slippage_bps()
        exec_buffer = max(float(self.config.edge_exec_buffer_bps), 0.0)
        expected_cost = fee_floor + slippage + exec_buffer

        threshold_strength = max(
            (float(self.config.pump_threshold) + float(self.config.exhaust_threshold)) * 0.5,
            0.1,
        )
        signal_bonus = max(float(signal_strength) - threshold_strength, 0.0) * max(
            float(self.config.edge_signal_slope_bps), 0.0
        )
        trend_penalty = max(float(self.signals.ret_2s_bps), 0.0) * 0.2
        spread_risk = max(float(spread_bps) - max(self._median_spread_bps, 0.0), 0.0) * 0.1
        expected_edge = tp_target + signal_bonus - expected_cost - trend_penalty - spread_risk

        uncertainty = self._edge_uncertainty_penalty_bps()
        # Cap uncertainty at 75% of expected_edge — attenuate, don't annihilate (UU#6)
        if expected_edge > 0:
            uncertainty = min(uncertainty, expected_edge * 0.75)
        edge_lcb = expected_edge - uncertainty
        required = max(float(self.config.min_edge_bps), self._recovery_entry_hurdle_bps(projected_notional))
        ok = edge_lcb >= required

        self._last_edge_snapshot = {
            "context": str(context),
            "tp_target_bps": float(tp_target),
            "signal_strength": float(signal_strength),
            "signal_bonus_bps": float(signal_bonus),
            "expected_cost_bps": float(expected_cost),
            "uncertainty_bps": float(uncertainty),
            "expected_edge_bps": float(expected_edge),
            "edge_lcb_bps": float(edge_lcb),
            "required_edge_bps": float(required),
            "slippage_est_bps": float(slippage),
            "trend_penalty_bps": float(trend_penalty),
            "spread_risk_bps": float(spread_risk),
            "projected_notional": float(projected_notional),
            "recovery_debt_usd": float(self.recovery_debt_usd),
        }
        return ok

    def _duplicate_fill_ratio(self) -> float:
        if not self.config.dynamic_behavior_enabled:
            return 0.0
        samples = list(self._recent_sell_fill_gaps)
        if len(samples) < 10:
            return 0.0
        sec_cut = max(1.0, self.config.cooldown_sec)
        bps_cut = max(0.5, self._median_spread_bps * 0.2)
        dup = sum(1 for s in samples if s["gap_sec"] <= sec_cut and s["gap_bps"] <= bps_cut)
        return dup / len(samples)

    def _near_zero_close_ratio(self) -> float:
        if not self.config.dynamic_behavior_enabled:
            return 0.0
        samples = list(self._recent_close_behaviors)
        if len(samples) < 10:
            return 0.0
        near_bps = max(1.0, self._fee_floor_bps() * 0.5)
        near = sum(1 for s in samples if abs(float(s["net_bps"])) <= near_bps)
        return near / len(samples)

    def _loss_reason_pressure(self) -> float:
        if not self.config.dynamic_behavior_enabled:
            return 0.0
        samples = list(self._recent_close_behaviors)
        if len(samples) < 10:
            return 0.0
        bad = {"flow_stop", "timeout", "stop", "drawdown", "shutdown"}
        n = sum(1 for s in samples if s["reason"] in bad)
        return n / len(samples)
