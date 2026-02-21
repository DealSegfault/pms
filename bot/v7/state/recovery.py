"""
Recovery and state management mixin — extracted from GridTrader.

Handles recovery debt tracking, session stats, position sync,
runtime state export/restore, and context rewarm.
"""
import logging
import time
from collections import deque
from typing import Dict, Any, List, Optional

from bot.v7.volatility_regime import VolatilitySnapshot

logger = logging.getLogger(__name__)


class RecoveryMixin:
    """Recovery state, position sync, and runtime persistence for GridTrader."""

    def _update_recovery_debt(self, net_pnl: float) -> None:
        if not self.config.recovery_debt_enabled:
            return
        if net_pnl < 0:
            self.recovery_debt_usd += abs(net_pnl)
        elif net_pnl > 0 and self.recovery_debt_usd > 0:
            self.recovery_debt_usd = max(self.recovery_debt_usd - net_pnl, 0.0)

        cap = max(float(self.config.recovery_debt_cap_usd), 0.0)
        if cap > 0:
            self.recovery_debt_usd = min(self.recovery_debt_usd, cap)

    def set_recovery_stats(self, rpnl_per_hour: float, trade_count: int, adoption_ts: float = 0.0) -> None:
        """Inject historical recovery velocity from DB at startup."""
        self._hist_rpnl_per_hour = float(rpnl_per_hour)
        self._hist_trade_count = int(trade_count)
        if adoption_ts > 0:
            self.adoption_ts = float(adoption_ts)

    def set_recovery_state(self, state: Dict[str, Any], source: str = "state_db") -> None:
        """Hydrate persistent recovery state across sessions."""
        if not state:
            return
        adoption_ts = float(state.get("adoption_ts", 0.0) or 0.0)
        if adoption_ts > 0:
            self.adoption_ts = adoption_ts
        self._session_rpnl = float(state.get("session_rpnl", self._session_rpnl) or self._session_rpnl)
        self._session_trades = int(state.get("session_trades", self._session_trades) or self._session_trades)
        self._session_closed_notional = float(
            state.get("session_closed_notional", self._session_closed_notional) or self._session_closed_notional
        )
        self.last_recovery_add_ts = float(
            state.get("last_recovery_add_ts", self.last_recovery_add_ts) or self.last_recovery_add_ts
        )
        add_events = state.get("recovery_add_events", []) or []
        for ts in add_events:
            tsv = float(ts or 0.0)
            if tsv > 0:
                self._recovery_add_events.append(tsv)
        logger.info(f"🧠 {self.symbol} recovery state restored ({source})")

    def export_recovery_state(self) -> Dict[str, Any]:
        """Snapshot persistent recovery state."""
        now = time.time()
        self._evict_recovery_add_events(now)
        return {
            "adoption_ts": float(self.adoption_ts),
            "session_rpnl": float(self._session_rpnl),
            "session_trades": int(self._session_trades),
            "session_closed_notional": float(self._session_closed_notional),
            "last_recovery_add_ts": float(self.last_recovery_add_ts),
            "recovery_add_events": [float(ts) for ts in self._recovery_add_events],

            "updated_ts": float(now),
        }

    def _evict_recovery_add_events(self, now: float) -> None:
        cutoff = now - 3600.0
        while self._recovery_add_events and self._recovery_add_events[0] < cutoff:
            self._recovery_add_events.popleft()

    def _record_recovery_add_event(self, now: float) -> None:
        self._evict_recovery_add_events(now)
        self._recovery_add_events.append(now)
        self.last_recovery_add_ts = now

    def _recovery_average_allowed(
        self,
        now: float,
        projected_notional: float,
        context: str,
    ) -> bool:
        """Guardrail for averaging: require drawdown, pacing, and debt-hurdle improvement."""
        if not self.config.recovery_avg_enabled:
            return True

        unrealized_bps = self._unrealized_bps()
        min_loss = max(float(self.config.recovery_avg_min_unrealized_bps), 0.0)
        if unrealized_bps > -min_loss:
            self._last_recovery_avg_snapshot = {
                "context": str(context),
                "ok": 0.0,
                "reason": "drawdown_too_small",
                "unrealized_bps": float(unrealized_bps),
                "required_loss_bps": float(min_loss),
            }
            return False

        cooldown = max(float(self.config.recovery_avg_cooldown_sec), 0.0)
        if cooldown > 0 and self.last_recovery_add_ts > 0 and (now - self.last_recovery_add_ts) < cooldown:
            self._last_recovery_avg_snapshot = {
                "context": str(context),
                "ok": 0.0,
                "reason": "cooldown",
                "cooldown_left_sec": float(cooldown - (now - self.last_recovery_add_ts)),
            }
            return False

        self._evict_recovery_add_events(now)
        max_adds = max(int(self.config.recovery_avg_max_adds_per_hour), 0)
        if max_adds > 0 and len(self._recovery_add_events) >= max_adds:
            self._last_recovery_avg_snapshot = {
                "context": str(context),
                "ok": 0.0,
                "reason": "hourly_limit",
                "adds_1h": float(len(self._recovery_add_events)),
                "adds_1h_max": float(max_adds),
            }
            return False

        cur_hurdle = self._recovery_entry_hurdle_bps(self.total_notional)
        next_hurdle = self._recovery_entry_hurdle_bps(projected_notional)
        improve = cur_hurdle - next_hurdle
        min_improve = max(float(self.config.recovery_avg_min_hurdle_improve_bps), 0.0)
        # Skip hurdle check when debt is negligible ($0.10): the math breaks down
        # for tiny debts — hurdle improvements are sub-0.01bp and can never reach
        # the 0.75bp threshold, permanently blocking averaging even at -200bp+ unrealized.
        if self.recovery_debt_usd > 0.10 and improve < min_improve:
            self._last_recovery_avg_snapshot = {
                "context": str(context),
                "ok": 0.0,
                "reason": "hurdle_improve_too_small",
                "hurdle_now_bps": float(cur_hurdle),
                "hurdle_next_bps": float(next_hurdle),
                "hurdle_improve_bps": float(improve),
                "hurdle_improve_min_bps": float(min_improve),
            }
            return False

        self._last_recovery_avg_snapshot = {
            "context": str(context),
            "ok": 1.0,
            "reason": "ok",
            "hurdle_now_bps": float(cur_hurdle),
            "hurdle_next_bps": float(next_hurdle),
            "hurdle_improve_bps": float(improve),
            "adds_1h": float(len(self._recovery_add_events)),
            "unrealized_bps": float(unrealized_bps),
        }
        return True

    @property
    def recovery_velocity_bps_hr(self) -> float:
        """Blended recovery velocity: session rPnL rate + historical rate."""
        session_hours = max((time.time() - self.start_ts) / 3600.0, 0.01)
        if self._session_trades > 0:
            avg_closed_notional = self._session_closed_notional / max(float(self._session_trades), 1.0)
        else:
            avg_closed_notional = self.total_notional
        notion_ref = max(float(avg_closed_notional), float(self.config.min_notional), 0.01)
        session_rate = self._session_rpnl / notion_ref * 10000.0 / session_hours
        if self._hist_trade_count > 0 and self._session_trades > 0:
            return (session_rate + self._hist_rpnl_per_hour) * 0.5
        elif self._hist_trade_count > 0:
            return self._hist_rpnl_per_hour
        return session_rate

    @property
    def recovery_mode(self) -> str:
        """Classify position into recovery mode."""
        if not self.layers:
            return "flat"
        vel = self.recovery_velocity_bps_hr
        can_trade = self._median_spread_bps >= self.config.min_spread_bps
        if can_trade and vel > 0:
            return "active"
        return "passive"

    @property
    def recovery_eta_hours(self) -> float:
        """Estimated hours until unrealized loss is recovered. Returns inf if velocity <= 0."""
        if not self.layers:
            return 0.0
        unrealized_bps = abs(self._unrealized_bps())
        vel = self.recovery_velocity_bps_hr
        if vel <= 0:
            return float('inf')
        return unrealized_bps / vel

    def _unrealized_bps(self) -> float:
        """Unrealized PnL in basis points (negative = losing)."""
        if not self.layers or self.total_notional <= 0 or self.bid <= 0:
            return 0.0
        unrealized_usd = sum((l.price - self.bid) * l.qty for l in self.layers)
        return unrealized_usd / self.total_notional * 10000.0

    def set_recovery_debt(self, debt_usd: float, source: str = "manual") -> None:
        debt = max(float(debt_usd), 0.0)
        cap = max(float(self.config.recovery_debt_cap_usd), 0.0)
        if cap > 0:
            debt = min(debt, cap)
        self.recovery_debt_usd = debt
        if debt > 0:
            logger.warning(f"🧾 {self.symbol} recovery debt set to ${debt:.4f} ({source})")

    def set_entry_enabled(self, enabled: bool, source: str = "manual") -> None:
        self._entry_enabled = bool(enabled)
        mode = "enabled" if self._entry_enabled else "disabled"
        logger.info(f"🔧 {self.symbol} fresh-entry mode {mode} ({source})")

    def sync_with_exchange_position(self, qty: float, entry_price: float, source: str = "reconcile", est_layers: int = 0):
        """
        Replace local grid state with exchange truth.

        qty <= 0 means flat: clear local state.
        qty > 0 means active short: rebuild as layers.
        est_layers > 1: split into N synthetic layers (preserves layer count for inverse TP).
        est_layers <= 1 or 0: single aggregated layer (legacy fallback).
        """
        # Import GridLayer here to avoid circular imports at module level
        from bot.v7.grid_trader import GridLayer

        qty = max(float(qty), 0.0)
        entry_price = max(float(entry_price), 0.0)

        if qty <= 0 or entry_price <= 0:
            if self.layers:
                logger.warning(f"🔄 {self.symbol} sync[{source}] -> flat (clearing local {len(self.layers)}L)")
            self._reset_grid()
            return

        notional = qty * entry_price
        n_layers = max(int(est_layers), 1)

        if n_layers > 1:
            # Split into estimated layers for correct inverse TP activation
            per_qty = qty / n_layers
            per_notional = notional / n_layers
            self.layers = [
                GridLayer(
                    price=entry_price,
                    qty=per_qty,
                    notional=per_notional,
                    entry_ts=time.time(),
                    layer_idx=i,
                    order_id=f"{source}_sync",
                    fee=per_notional * self.config.maker_fee,
                )
                for i in range(n_layers)
            ]
        else:
            est_entry_fee = notional * self.config.maker_fee
            self.layers = [
                GridLayer(
                    price=entry_price,
                    qty=qty,
                    notional=notional,
                    entry_ts=time.time(),
                    layer_idx=0,
                    order_id=f"{source}_sync",
                    fee=est_entry_fee,
                )
            ]
        self._update_avg()
        self._pending_order = False
        self._pending_exit = False
        self.last_entry_ts = time.time()
        self.last_entry_price = entry_price
        self.signals.reset_entry_tracking()
        logger.warning(
            f"🔄 {self.symbol} sync[{source}] -> {qty:.6f} @ {entry_price:.6f} "
            f"(${notional:.2f}, {n_layers} {'estimated' if n_layers > 1 else 'aggregated'} layer{'s' if n_layers != 1 else ''})"
        )

    def _reset_grid(self):
        """Clear grid state."""
        self.layers.clear()
        self.avg_entry_price = 0.0
        self.total_qty = 0.0
        self.total_notional = 0.0
        self._pending_order = False
        self._pending_exit = False
        self.last_entry_price = 0.0
        self.signals.reset_entry_tracking()
        # Clear inverse TP state
        self._inverse_tp_active = False
        self._inverse_tp_zones = []
        self._inverse_tp_next_idx = 0
        self._inverse_tp_start_ts = 0.0
        self._inverse_tp_layers_at_start = 0
        self._inverse_tp_avg_entry = 0.0

    def _update_avg(self):
        """Recalculate average entry price and totals."""
        if not self.layers:
            self.avg_entry_price = 0.0
            self.total_qty = 0.0
            self.total_notional = 0.0
            return

        self.total_qty = sum(l.qty for l in self.layers)
        self.total_notional = sum(l.notional for l in self.layers)
        self.avg_entry_price = self.total_notional / self.total_qty if self.total_qty > 0 else 0.0

    def arm_context_rewarm(
        self,
        now: Optional[float] = None,
        sec: Optional[float] = None,
        *,
        reset_spread: bool = True,
        reset_vol: bool = True,
    ) -> None:
        """
        Force a short rewarm window after restart/restore.

        This prevents stale spread/vol context from triggering immediate entries.
        """
        now_ts = float(now if now is not None else time.time())
        rewarm_sec = max(float(self.config.resume_context_rewarm_sec if sec is None else sec), 0.0)

        if reset_spread:
            self._spread_history.clear()
            self._median_spread_bps = 0.0
            self._last_spread_calc_ts = 0.0
        if reset_vol:
            self._vol_snapshot = VolatilitySnapshot()

        if rewarm_sec > 0:
            self._resume_rewarm_until = max(self._resume_rewarm_until, now_ts + rewarm_sec)

    def export_runtime_state(self) -> Dict[str, Any]:
        """Snapshot full per-symbol runtime context for crash-safe restore."""
        now = time.time()
        spread_hist = [float(x) for x in list(self._spread_history)[-240:]]
        layers = []
        for layer in self.layers:
            layers.append(
                {
                    "price": float(layer.price),
                    "qty": float(layer.qty),
                    "notional": float(layer.notional),
                    "entry_ts": float(layer.entry_ts),
                    "layer_idx": int(layer.layer_idx),
                    "order_id": str(layer.order_id or ""),
                    "fee": float(layer.fee),
                    "entry_signals": dict(layer.entry_signals or {}),
                }
            )
        return {
            "version": 1,
            "symbol": self.symbol,
            "updated_ts": float(now),
            "entry_enabled": bool(self._entry_enabled),
            "last_entry_ts": float(self.last_entry_ts),
            "last_entry_price": float(self.last_entry_price),
            "cooldown_until": float(self._cooldown_until),
            "layer_cooldown_until": float(self._layer_cooldown_until),
            "layers": layers,
            "spread_history_bps": spread_hist,
            "median_spread_bps": float(self._median_spread_bps),
            "vol_snapshot": {
                "baseline_bps": float(self._vol_snapshot.baseline_bps),
                "live_bps": float(self._vol_snapshot.live_bps),
                "blended_bps": float(self._vol_snapshot.blended_bps),
                "drift_mult": float(self._vol_snapshot.drift_mult),
                "tail_ratio": float(self._vol_snapshot.tail_ratio),
                "heavy_tail": bool(self._vol_snapshot.heavy_tail),
                "last_refresh_ts": float(self._vol_snapshot.last_refresh_ts),
                "source": str(self._vol_snapshot.source),
            },
            "recovery_debt_usd": float(self.recovery_debt_usd),
            "session_rpnl": float(self._session_rpnl),
            "session_trades": int(self._session_trades),
            "session_closed_notional": float(self._session_closed_notional),
        }

    def restore_runtime_state(self, state: Dict[str, Any], source: str = "runtime_state") -> bool:
        """
        Restore runtime context from persisted snapshot.

        Returns True if at least one layer was restored.
        """
        # Import GridLayer here to avoid circular imports at module level
        from bot.v7.grid_trader import GridLayer

        if not isinstance(state, dict):
            return False
        symbol = str(state.get("symbol") or "").upper()
        if symbol and symbol != self.symbol.upper():
            return False

        restored_layers: List = []
        for raw in state.get("layers", []) or []:
            if not isinstance(raw, dict):
                continue
            price = float(raw.get("price", 0.0) or 0.0)
            qty = float(raw.get("qty", 0.0) or 0.0)
            if price <= 0 or qty <= 0:
                continue
            notional = float(raw.get("notional", price * qty) or (price * qty))
            restored_layers.append(
                GridLayer(
                    price=price,
                    qty=qty,
                    notional=notional,
                    entry_ts=float(raw.get("entry_ts", time.time()) or time.time()),
                    layer_idx=int(raw.get("layer_idx", len(restored_layers))),
                    order_id=str(raw.get("order_id", "")),
                    fee=float(raw.get("fee", 0.0) or 0.0),
                    entry_signals=dict(raw.get("entry_signals", {}) or {}),
                )
            )

        self.layers = restored_layers
        self._update_avg()
        self._entry_enabled = bool(state.get("entry_enabled", self._entry_enabled))
        self.last_entry_ts = float(state.get("last_entry_ts", self.last_entry_ts) or self.last_entry_ts)
        self.last_entry_price = float(state.get("last_entry_price", self.last_entry_price) or self.last_entry_price)
        self._cooldown_until = float(state.get("cooldown_until", self._cooldown_until) or self._cooldown_until)
        self._layer_cooldown_until = float(
            state.get("layer_cooldown_until", self._layer_cooldown_until) or self._layer_cooldown_until
        )
        self.recovery_debt_usd = float(state.get("recovery_debt_usd", self.recovery_debt_usd) or self.recovery_debt_usd)
        self._session_rpnl = float(state.get("session_rpnl", self._session_rpnl) or self._session_rpnl)
        self._session_trades = int(state.get("session_trades", self._session_trades) or self._session_trades)
        self._session_closed_notional = float(
            state.get("session_closed_notional", self._session_closed_notional) or self._session_closed_notional
        )

        # Always clear pending flags on restore; in-flight orders are reconciled from exchange truth.
        self._pending_order = False
        self._pending_exit = False
        self._last_runtime_restore_ts = time.time()

        # Force local spread/vol rebuild before allowing new entries/averaging.
        self.arm_context_rewarm(now=self._last_runtime_restore_ts, reset_spread=True, reset_vol=True)

        logger.info(
            f"🧠 {self.symbol} runtime state restored ({source}): "
            f"{len(self.layers)} layer(s), notional ${self.total_notional:.2f}"
        )
        return len(self.layers) > 0
