"""
Trade logging and status mixin — extracted from GridTrader.

Signal snapshot capture, JSONL logging, strategy event emission,
and status dictionary generation.
"""
import logging
import time
from typing import Dict, Any

logger = logging.getLogger(__name__)


class TradeLogMixin:
    """Telemetry, logging, and status reporting for GridTrader."""

    def _signal_snapshot(self) -> dict:
        """Capture current microstructure signal state for logging."""
        s = self.signals
        snap = {
            "TI_2s": round(float(s.TI_2s), 4),
            "TI_500ms": round(float(s.TI_500ms), 4),
            "z_TI_2s": round(float(s.z_TI_2s), 3),
            "z_ret_2s": round(float(s.z_ret_2s), 3),
            "z_MD_2s": round(float(s.z_MD_2s), 3),
            "pump_score": round(float(s.pump_score), 3),
            "exhaust_score": round(float(s.exhaust_score), 3),
            "QI": round(float(s.QI), 4),
            "MD": round(float(s.MD), 6),
            "rv_1s": round(float(s.rv_1s), 4),
            "spread_bps": round(float(s.spread_bps), 2),
        }
        # Per-symbol multi-timeframe flow features (bounded 10m rolling memory).
        try:
            snap.update(s.flow_snapshot(prefix="pair_"))
        except Exception:
            pass
        # Optional global market-speed context from runner.
        if self.external_snapshot_provider:
            try:
                ext = self.external_snapshot_provider() or {}
                for key, val in ext.items():
                    if isinstance(val, (int, float)):
                        snap[str(key)] = round(float(val), 6)
            except Exception:
                pass
        return snap

    def _emit_strategy_event(self, event: Dict[str, Any]) -> None:
        if not self.event_sink:
            return
        try:
            self.event_sink(event)
        except Exception:
            pass

    def _write_entry_log(self, now: float, layer: 'GridLayer'):
        """Append entry event to JSONL log."""
        if not (self.config.log_jsonl and self.config.jsonl_path):
            return
        import json
        record = {
            "ts": now,
            "symbol": self.symbol,
            "action": "entry",
            "layer_idx": layer.layer_idx,
            "price": layer.price,
            "qty": layer.qty,
            "notional": layer.notional,
            "fee": layer.fee,
            "order_id": layer.order_id[:12] if layer.order_id else "",
            "grid_layers": len(self.layers),
            "grid_notional": self.total_notional,
            "median_spread_bps": self._median_spread_bps,
            "vol_blended_bps": self._vol_snapshot.blended_bps,
            "vol_drift_mult": self._vol_snapshot.drift_mult,
            "edge_lcb_bps": float(self._last_edge_snapshot.get("edge_lcb_bps", 0.0)),
            "edge_required_bps": float(self._last_edge_snapshot.get("required_edge_bps", self.config.min_edge_bps)),
            "edge_context": str(self._last_edge_snapshot.get("context", "")),
            "recovery_debt_usd": self.recovery_debt_usd,
            "signals": layer.entry_signals,
            "live": self.is_live,
        }
        try:
            with open(self.config.jsonl_path, "a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception:
            pass
        self._emit_strategy_event(record)

    def _write_trade_log(self, now: float, reason: str, pnl: float, pnl_bps: float, layers: int):
        """Append close event to JSONL log with entry-time + exit-time signals."""
        import json

        # Aggregate entry-time signals from layers (weighted by notional)
        entry_sigs: dict = {}
        if self.layers:
            sig_keys = set()
            for layer in self.layers:
                if isinstance(layer.entry_signals, dict):
                    sig_keys.update(layer.entry_signals.keys())
            for key in sorted(sig_keys):
                wsum = 0.0
                weight_sum = 0.0
                for layer in self.layers:
                    val = layer.entry_signals.get(key)
                    if isinstance(val, (int, float)):
                        wsum += float(val) * layer.notional
                        weight_sum += layer.notional
                if weight_sum > 0:
                    entry_sigs[key] = round(wsum / max(weight_sum, 1e-9), 6)

        exit_sigs = self._signal_snapshot()

        record = {
            "ts": now,
            "symbol": self.symbol,
            "action": "close",
            "reason": reason,
            "layers": layers,
            "avg_entry": self.avg_entry_price,
            "exit_price": self.bid,
            "total_notional": self.total_notional,
            "pnl_usd": pnl,
            "pnl_bps": pnl_bps,
            "cum_pnl_bps": self.realized_pnl_bps,
            "cum_fees_usd": self.total_fees,
            "median_spread_bps": self._median_spread_bps,
            "vol_baseline_bps": self._vol_snapshot.baseline_bps,
            "vol_live_bps": self._vol_snapshot.live_bps,
            "vol_blended_bps": self._vol_snapshot.blended_bps,
            "vol_drift_mult": self._vol_snapshot.drift_mult,
            "vol_tail_ratio": self._vol_snapshot.tail_ratio,
            "recovery_debt_usd": self.recovery_debt_usd,
            "edge_lcb_bps": float(self._last_edge_snapshot.get("edge_lcb_bps", 0.0)),
            "edge_required_bps": float(self._last_edge_snapshot.get("required_edge_bps", self.config.min_edge_bps)),
            "edge_context": str(self._last_edge_snapshot.get("context", "")),
            "entry_enabled": self._entry_enabled,
            "entry_signals": entry_sigs,
            "exit_signals": exit_sigs,
            "live": self.is_live,
        }
        try:
            with open(self.config.jsonl_path, "a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception:
            pass
        self._emit_strategy_event(record)

    def status_dict(self) -> dict:
        """Return status for display."""
        spread_bps = (self.ask - self.bid) / self.mid * 10000 if self.mid > 0 else 0

        unrealized = 0.0
        if self.layers:
            for l in self.layers:
                unrealized += (l.price - self.bid) * l.qty

        wr = self.wins / max(1, self.total_trades) * 100
        edge = self._last_edge_snapshot or {}

        return {
            "symbol": self.symbol,
            "spread_bps": spread_bps,
            "median_spread_bps": self._median_spread_bps,
            "layers": len(self.layers),
            "max_layers": self.config.max_layers,
            "dynamic_max_layers": self._dynamic_max_layers(),
            "avg_entry": self.avg_entry_price,
            "total_notional": self.total_notional,
            "unrealized_usd": unrealized,
            "unrealized_bps": (unrealized / self.total_notional * 10000) if self.total_notional > 0 else 0,
            "realized_bps": self.realized_pnl_bps,
            "realized_usd": self.realized_pnl,
            "total_fees": self.total_fees,
            "trades": self.total_trades,
            "win_rate": wr,
            "tp_target_bps": self._tp_target_bps(),
            "edge_bps": self._tp_target_bps() - self._fee_floor_bps(),
            "expected_edge_bps": float(edge.get("expected_edge_bps", 0.0)),
            "edge_lcb_bps": float(edge.get("edge_lcb_bps", 0.0)),
            "edge_required_bps": float(edge.get("required_edge_bps", self.config.min_edge_bps)),
            "edge_context": str(edge.get("context", "")),
            "entry_enabled": self._entry_enabled,
            "symbol_notional_cap": self._symbol_notional_cap(),
            "recovery_debt_usd": self.recovery_debt_usd,
            "recovery_exit_hurdle_bps": self._recovery_exit_hurdle_bps(),
            "circuit_breaker": self._circuit_breaker_ts > 0,
            "cooldown_left": max(0.0, self._cooldown_until - time.time()),
            "layer_cooldown_left": max(0.0, self._layer_cooldown_until - time.time()),
            "dynamic_entry_cooldown_sec": self._dynamic_entry_cooldown_sec(),
            "dynamic_layer_gap_bps": self._dynamic_layer_gap_bps(),
            "dynamic_min_tp_profit_bps": self._dynamic_min_tp_profit_bps(),
            "dynamic_min_fast_tp_bps": self._dynamic_min_fast_tp_bps(),
            "behavior_dup_ratio": self._duplicate_fill_ratio(),
            "behavior_near_zero_ratio": self._near_zero_close_ratio(),
            "resume_rewarm_left_sec": max(0.0, self._resume_rewarm_until - time.time()),
            "vol_baseline_bps": self._vol_snapshot.baseline_bps,
            "vol_live_bps": self._vol_snapshot.live_bps,
            "vol_drift_mult": self._vol_snapshot.drift_mult,
            "vol_tail_ratio": self._vol_snapshot.tail_ratio,
            "pending": self._pending_order or self._pending_exit,
            "live": self.is_live,
            # Capital efficiency
            "recovery_mode": self.recovery_mode,
            "recovery_velocity_bps_hr": self.recovery_velocity_bps_hr,
            "recovery_eta_hours": self.recovery_eta_hours,
            "session_rpnl": self._session_rpnl,
            "session_trades": self._session_trades,
            "recovery_adds_1h": len(self._recovery_add_events),
            "recovery_last_add_sec_ago": (time.time() - self.last_recovery_add_ts) if self.last_recovery_add_ts > 0 else 0.0,

        }
