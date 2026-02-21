"""
Persistence mixin — extracted from MultiGridRunner.

Handles recovery store lifecycle, scoped state keys, recovery/runtime
state load/persist, session config, layer estimation, recovery debt
seeding, and runtime state restoration.
"""
import logging
import os
import sqlite3
import time
from typing import Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from bot.v7.grid_trader import GridTrader

logger = logging.getLogger(__name__)


class PersistenceMixin:
    """Recovery/runtime state persistence for MultiGridRunner."""

    def _get_recovery_store(self):
        """Lazy init history store used for persistent recovery state."""
        if self._recovery_store is not None:
            existing = self._recovery_store
            if all(hasattr(existing, attr) for attr in ("get_state", "set_state")):
                return existing
            logger.warning(
                "Recovery store object is invalid (%s); disabling persisted recovery/runtime state",
                type(existing).__name__,
            )
            self._recovery_store = None
            return None
        db_path = str(self.config.recovery_db_path or "").strip()
        if not db_path:
            return None
        try:
            from bot.v7.services.storage import HistoryStore
            store = HistoryStore(db_path)
            if not all(hasattr(store, attr) for attr in ("get_state", "set_state")):
                logger.warning(
                    "Recovery store backend missing required methods; disabling persistence"
                )
                self._recovery_store = None
                return None
            self._recovery_store = store
        except Exception as e:
            logger.warning(f"Recovery store init failed: {e}")
            self._recovery_store = None
        return self._recovery_store

    def _scoped_state_key(self, key: str) -> str:
        return f"{self.user_scope}:{key}"

    def _recovery_state_key(self, raw_symbol: str) -> str:
        return self._scoped_state_key(f"recovery_state:{str(raw_symbol).upper()}")

    def _load_persisted_recovery_state(self, raw_symbol: str) -> Dict[str, Any]:
        store = self._get_recovery_store()
        if store is None:
            return {}
        key = self._recovery_state_key(raw_symbol)
        state = store.get_state(key, default={})
        return state if isinstance(state, dict) else {}

    def _persist_recovery_state(self, raw_symbol: str, trader: 'GridTrader') -> None:
        store = self._get_recovery_store()
        if store is None:
            return
        key = self._recovery_state_key(raw_symbol)
        try:
            store.set_state(key, trader.export_recovery_state())
        except Exception as e:
            logger.debug(f"Persist recovery state failed for {raw_symbol}: {e}")

    def _persist_recovery_states_once(self) -> None:
        for sym, trader in list(self.traders.items()):
            try:
                self._persist_recovery_state(sym, trader)
            except Exception:
                pass

    def _runtime_state_key(self, raw_symbol: str) -> str:
        return self._scoped_state_key(f"runtime_state:{str(raw_symbol).upper()}")

    def _load_persisted_runtime_state(self, raw_symbol: str) -> Dict[str, Any]:
        if not self.config.runtime_state_enabled:
            return {}
        store = self._get_recovery_store()
        if store is None:
            return {}
        key = self._runtime_state_key(raw_symbol)
        state = store.get_state(key, default={})
        return state if isinstance(state, dict) else {}

    def _persist_runtime_state(self, raw_symbol: str, trader: 'GridTrader') -> None:
        if not self.config.runtime_state_enabled:
            return
        store = self._get_recovery_store()
        if store is None:
            return
        key = self._runtime_state_key(raw_symbol)
        try:
            store.set_state(key, trader.export_runtime_state())
        except Exception as e:
            logger.debug(f"Persist runtime state failed for {raw_symbol}: {e}")

    def _persist_runtime_states_once(self) -> None:
        if not self.config.runtime_state_enabled:
            return
        for sym, trader in list(self.traders.items()):
            try:
                self._persist_runtime_state(sym, trader)
            except Exception:
                pass

    def _persist_session_config(self) -> None:
        """Save grid sizing config so layer count can be estimated on restart."""
        store = self._get_recovery_store()
        if store is None:
            return
        try:
            store.set_state(self._scoped_state_key("session_config"), {
                "min_notional": float(self.config.min_notional),
                "max_notional": float(self.config.max_notional),
                "size_growth": float(self.config.size_growth),
                "max_layers": int(self.config.max_layers),
                "updated_ts": time.time(),
            })
        except Exception as e:
            logger.debug(f"Persist session config failed: {e}")

    def _load_session_config(self) -> dict:
        """Load previously saved grid sizing config."""
        store = self._get_recovery_store()
        if store is None:
            return {}
        return store.get_state(self._scoped_state_key("session_config"), default={}) or {}

    def _estimate_layer_count(self, notional: float) -> int:
        """Estimate how many layers produced this total notional using saved or current config."""
        saved = self._load_session_config()
        min_n = float(saved.get("min_notional", self.config.min_notional))
        max_n = float(saved.get("max_notional", self.config.max_notional))
        growth = float(saved.get("size_growth", self.config.size_growth))
        max_layers = int(saved.get("max_layers", self.config.max_layers))

        if min_n <= 0:
            return 1

        total = 0.0
        layers = 0
        while total < notional * 0.95:  # 95% tolerance for fees/rounding
            layer_n = min(min_n * (growth ** layers), max_n)
            total += layer_n
            layers += 1
            if layers >= max_layers:
                break
        return max(layers, 1)

    def _load_initial_recovery_debt(self, raw_symbol: str) -> float:
        """Load net realized-loss debt from history DB for recent lookback window."""
        symbol = str(raw_symbol).upper()
        if symbol in self._recovery_debt_cache:
            return self._recovery_debt_cache[symbol]

        if not self.config.recovery_debt_enabled:
            self._recovery_debt_cache[symbol] = 0.0
            return 0.0

        db_path = str(self.config.recovery_db_path or "").strip()
        if not db_path or not os.path.exists(db_path):
            self._recovery_debt_cache[symbol] = 0.0
            return 0.0

        lookback_hours = max(float(self.config.recovery_lookback_hours), 0.0)
        if lookback_hours <= 0:
            self._recovery_debt_cache[symbol] = 0.0
            return 0.0

        cutoff_ms = int((time.time() - lookback_hours * 3600.0) * 1000.0)
        debt = 0.0
        try:
            with sqlite3.connect(db_path, timeout=2.0) as conn:
                row = conn.execute(
                    """
                    SELECT COALESCE(SUM(realized_pnl), 0.0) AS net_pnl
                    FROM trades
                    WHERE symbol = ? AND timestamp_ms >= ?
                    """,
                    (symbol, cutoff_ms),
                ).fetchone()
                net = float(row[0]) if row and row[0] is not None else 0.0
                debt = max(-net, 0.0)
        except Exception:
            debt = 0.0

        cap = max(float(self.config.recovery_debt_cap_usd), 0.0)
        if cap > 0:
            debt = min(debt, cap)
        self._recovery_debt_cache[symbol] = debt
        return debt

    def _seed_recovery_debt(self, trader: 'GridTrader', raw_symbol: str) -> None:
        debt = self._load_initial_recovery_debt(raw_symbol)
        if debt > 0:
            trader.set_recovery_debt(debt, source=f"history_{self.config.recovery_lookback_hours:.0f}h")

    def _seed_recovery_stats(self, trader: 'GridTrader', raw_symbol: str) -> None:
        """Inject historical recovery velocity from DB."""
        db_path = str(self.config.recovery_db_path or "").strip()
        if db_path and os.path.exists(db_path):
            try:
                store = self._get_recovery_store()
                if store:
                    stats = store.get_symbol_recovery_stats(
                        raw_symbol, lookback_hours=max(self.config.recovery_lookback_hours, 168.0)
                    )
                    if stats["trade_count"] > 0:
                        first_ms = stats["first_trade_ms"]
                        adoption_ts = first_ms / 1000.0 if first_ms > 0 else 0.0
                        trader.set_recovery_stats(
                            rpnl_per_hour=stats["rpnl_per_hour"],
                            trade_count=stats["trade_count"],
                            adoption_ts=adoption_ts,
                        )
            except Exception:
                pass  # Non-critical — velocity will compute from session data

        # Overlay persisted per-symbol state (adoption_ts/session counters/etc.)
        try:
            state = self._load_persisted_recovery_state(raw_symbol)
            if state:
                trader.set_recovery_state(state, source="sync_state")
        except Exception:
            pass

    def _seed_runtime_state(self, trader: 'GridTrader', raw_symbol: str) -> None:
        """Restore persisted per-symbol runtime context (exact layer stack, pacing state)."""
        if not self.config.runtime_state_enabled:
            return
        try:
            state = self._load_persisted_runtime_state(raw_symbol)
            if state:
                trader.restore_runtime_state(state, source="runtime_state")
        except Exception as e:
            logger.debug(f"Runtime state restore failed for {raw_symbol}: {e}")
