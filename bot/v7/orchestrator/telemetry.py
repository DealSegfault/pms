"""
Runner telemetry mixin — extracted from MultiGridRunner.

Strategy event sink, signal extraction, layer matching,
dashboard display, and final summary.
"""
import logging
import time
from typing import Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from bot.v7.grid_trader import GridTrader

logger = logging.getLogger(__name__)


class RunnerTelemetryMixin:
    """Telemetry, event buffering, and display for MultiGridRunner."""

    @staticmethod
    def _extract_signal_subset(payload: Dict[str, Any]) -> Dict[str, float]:
        keep = ("pump_score", "exhaust_score", "TI_2s", "TI_500ms", "spread_bps", "rv_1s", "z_ret_2s", "z_TI_2s", "z_MD_2s")
        out: Dict[str, float] = {}
        for key in keep:
            val = payload.get(key)
            if isinstance(val, (int, float)):
                out[key] = float(val)
        return out

    def _strategy_event_sink(self, raw_event: Dict[str, Any]) -> None:
        if not self.config.strategy_event_logging:
            return
        if not isinstance(raw_event, dict):
            return
        self._strategy_event_seq += 1

        symbol = str(raw_event.get("symbol") or "").upper()
        action = str(raw_event.get("action") or "").lower()
        ts = float(raw_event.get("ts", time.time()) or time.time())
        event_ms = int(ts * 1000.0)

        entry_sigs = raw_event.get("signals")
        close_entry_sigs = raw_event.get("entry_signals")
        close_exit_sigs = raw_event.get("exit_signals")
        payload: Dict[str, Any] = {}
        if isinstance(entry_sigs, dict):
            payload["entry"] = self._extract_signal_subset(entry_sigs)
        if isinstance(close_entry_sigs, dict):
            payload["entry_wavg"] = self._extract_signal_subset(close_entry_sigs)
        if isinstance(close_exit_sigs, dict):
            payload["exit"] = self._extract_signal_subset(close_exit_sigs)
        spread_bps = raw_event.get("spread_bps")
        if spread_bps is None and isinstance(entry_sigs, dict):
            spread_bps = entry_sigs.get("spread_bps")
        if spread_bps is None and isinstance(close_exit_sigs, dict):
            spread_bps = close_exit_sigs.get("spread_bps")

        compact = {
            "event_id": (
                f"{self.user_scope}|{symbol}|{action}|{event_ms}|"
                f"{self.session_id}|{self._strategy_event_seq}"
            ),
            "symbol": symbol,
            "action": action,
            "reason": str(raw_event.get("reason") or ""),
            "layer_idx": int(raw_event.get("layer_idx", 0) or 0),
            "layers": int(raw_event.get("layers", raw_event.get("grid_layers", 0)) or 0),
            "qty": float(raw_event.get("qty", 0.0) or 0.0),
            "price": float(raw_event.get("price", raw_event.get("exit_price", 0.0)) or 0.0),
            "notional": float(raw_event.get("notional", raw_event.get("total_notional", 0.0)) or 0.0),
            "pnl_bps": float(raw_event.get("pnl_bps", 0.0) or 0.0),
            "pnl_usd": float(raw_event.get("pnl_usd", 0.0) or 0.0),
            "spread_bps": float(spread_bps or 0.0),
            "median_spread_bps": float(raw_event.get("median_spread_bps", 0.0) or 0.0),
            "vol_blended_bps": float(raw_event.get("vol_blended_bps", 0.0) or 0.0),
            "vol_drift_mult": float(raw_event.get("vol_drift_mult", 0.0) or 0.0),
            "edge_lcb_bps": float(raw_event.get("edge_lcb_bps", 0.0) or 0.0),
            "edge_required_bps": float(raw_event.get("edge_required_bps", 0.0) or 0.0),
            "recovery_debt_usd": float(raw_event.get("recovery_debt_usd", 0.0) or 0.0),
            "event_ts": ts,
            "event_time_ms": event_ms,
        }
        if self.config.strategy_event_include_payload and payload:
            compact["payload"] = payload
        self._strategy_event_buffer.append(compact)

    def _flush_strategy_events_once(self) -> None:
        if not self.config.strategy_event_logging or not self._strategy_event_buffer:
            return
        store = self._get_recovery_store()
        if store is None:
            return
        events = list(self._strategy_event_buffer)
        self._strategy_event_buffer.clear()
        try:
            store.upsert_strategy_events(events)
        except Exception as e:
            logger.debug(f"Strategy-event flush failed: {e}")
            for ev in reversed(events):
                self._strategy_event_buffer.appendleft(ev)
            return
        now = time.time()
        if now - self._last_strategy_prune_ts > 3600.0:
            self._last_strategy_prune_ts = now
            try:
                store.prune_strategy_events(self.config.strategy_event_retention_days)
            except Exception:
                pass

    @staticmethod
    def _layers_match_exchange(trader: 'GridTrader', ex_qty: float, ex_entry: float) -> bool:
        if ex_qty <= 0 or ex_entry <= 0 or not trader.layers:
            return False
        local_qty = float(trader.total_qty)
        if local_qty <= 0:
            return False
        qty_tol = max(1e-8, 0.01 * max(local_qty, ex_qty))
        if abs(local_qty - ex_qty) > qty_tol:
            return False
        local_entry = float(trader.avg_entry_price)
        if local_entry <= 0:
            return False
        rel = abs(local_entry - ex_entry) / ex_entry
        return rel <= 0.0025

    async def _display_loop(self, stop):
        """Print dashboard every N seconds."""
        import asyncio
        try:
            from bot.v7.scorer import compute_pair_scores, format_score_dashboard
        except ImportError:
            compute_pair_scores = None
            format_score_dashboard = None

        if not getattr(self.config, 'display_enabled', True):
            return
        while not stop.is_set():
            await asyncio.sleep(self.config.display_interval)
            now = time.time()
            elapsed = now - self.start_time

            total_trades = 0
            total_pnl_bps = 0.0
            total_pnl_usd = 0.0
            total_fees = 0.0
            total_wins = 0
            active_grids = 0
            portfolio_notional = 0.0

            lines = []
            for sym in sorted(self.traders):
                t = self.traders[sym]
                s = t.status_dict()
                total_trades += s["trades"]
                total_pnl_bps += s["realized_bps"]
                total_pnl_usd += s.get("realized_usd", 0)
                total_fees += s.get("total_fees", 0)
                total_wins += t.wins
                portfolio_notional += s["total_notional"]
                interesting = (
                    s["layers"] > 0 or s["trades"] > 0 or
                    self.config.min_spread_bps <= s["spread_bps"] <= self.config.max_spread_bps
                )
                if s["layers"] > 0:
                    active_grids += 1
                if interesting:
                    in_regime = self.config.min_spread_bps <= s["spread_bps"] <= self.config.max_spread_bps
                    dot = "🟢" if in_regime else "⚪"
                    pending = "⏳" if s.get("pending") else ""
                    grid_str = f"L{s['layers']}/{s['max_layers']} ${s['total_notional']:.0f}" if s["layers"] > 0 else "flat"
                    if s["layers"] > 0:
                        unr_usd = s.get("unrealized_usd", 0)
                        unr = f"unr={s['unrealized_bps']:+.1f}bp ${unr_usd:+.4f}"
                    else:
                        unr = ""
                    cb = " 🛑CB" if s["circuit_breaker"] else ""
                    wr = f"WR {s['win_rate']:.0f}%" if s["trades"] > 0 else ""
                    mode = "📡" if s.get("live") else "📝"
                    rmode = s.get("recovery_mode", "flat")
                    rmode_icon = "🟢" if rmode == "active" else ("⏳" if rmode == "passive" else "  ")
                    eta = s.get("recovery_eta_hours", 0.0)
                    if s["layers"] > 0 and eta != float('inf') and eta > 0:
                        eta_str = f"eta={eta:.0f}h"
                    elif s["layers"] > 0 and eta == float('inf'):
                        eta_str = "eta=∞"
                    else:
                        eta_str = ""
                    lines.append(
                        f"  {dot}{mode}{pending} {sym:<14s} spr={s['spread_bps']:>5.1f} | "
                        f"med={s['median_spread_bps']:>5.1f} | "
                        f"grid={grid_str:<16s} {unr:<24s} | "
                        f"rPnL={s['realized_bps']:>+7.1f}bp ${s.get('realized_usd', 0):>+.4f} | "
                        f"T={s['trades']:>2} {wr}{cb} {rmode_icon}{eta_str}"
                    )

            win_pct = total_wins / max(1, total_trades) * 100
            mode_str = "📡 LIVE" if self.config.live else "📝 PAPER"
            cap_pct = portfolio_notional / self.config.max_total_notional * 100
            header = (
                f"\n{'═'*105}\n"
                f"  {mode_str} [{elapsed:.0f}s] {len(self.traders)}p | "
                f"{active_grids} grids | "
                f"portfolio ${portfolio_notional:.0f}/${self.config.max_total_notional:.0f} ({cap_pct:.0f}%) | "
                f"{total_trades}T WR {win_pct:.0f}% | "
                f"PnL {total_pnl_bps:+.1f}bp ${total_pnl_usd:+.4f} | "
                f"fees ${total_fees:.4f}\n"
                f"{'═'*105}"
            )
            logger.info(header)
            for line in lines:
                logger.info(line)

            if elapsed > 300 and hasattr(self, 'session_id') and compute_pair_scores:
                score_now = time.time()
                if not hasattr(self, '_score_cache_ts') or score_now - self._score_cache_ts > 30:
                    try:
                        self._score_cache = compute_pair_scores(
                            self.config.log_dir, self.session_id, lookback_sec=3600
                        )
                        self._score_cache_ts = score_now
                    except Exception as e:
                        logger.debug(f"Scorer error: {e}")
                        self._score_cache = {}
                        self._score_cache_ts = score_now
                if hasattr(self, '_score_cache') and self._score_cache:
                    score_lines = format_score_dashboard(self._score_cache, top_n=15)
                    logger.info(f"\n{'─'*105}")
                    logger.info("  📊 PAIR SCORES (last 1h)")
                    for sl in score_lines:
                        logger.info(sl)

    def _final_summary(self):
        """Print end-of-session summary."""
        elapsed = time.time() - self.start_time
        total_trades = sum(t.total_trades for t in self.traders.values())
        total_wins = sum(t.wins for t in self.traders.values())
        total_pnl_bps = sum(t.realized_pnl_bps for t in self.traders.values())
        total_pnl_usd = sum(t.realized_pnl for t in self.traders.values())
        total_fees = sum(t.total_fees for t in self.traders.values())
        traded = [(s, t) for s, t in self.traders.items() if t.total_trades > 0]
        mode_str = "📡 LIVE" if self.config.live else "📝 PAPER"

        logger.info(f"\n{'═'*105}")
        logger.info(f"  V7 FINAL SUMMARY ({mode_str}) — {elapsed:.0f}s")
        logger.info(f"{'═'*105}")
        logger.info(f"  Pairs: {len(self.traders)} scanned, {len(traded)} traded")
        logger.info(f"  Trades: {total_trades} (WR {total_wins/max(1,total_trades)*100:.1f}%)")
        logger.info(f"  PnL: {total_pnl_bps:+.1f} bps (${total_pnl_usd:+.4f})")
        logger.info(f"  Fees: ${total_fees:.4f}")
        logger.info(f"  Config: grid max {self.config.max_layers}L × ${self.config.min_notional:.0f}, "
                    f"spacing ×{self.config.spacing_growth}, "
                    f"TP {self.config.tp_spread_mult}×spread, "
                    f"cap ${self.config.max_total_notional:.0f}")

        if traded:
            logger.info(f"\n  Per-symbol:")
            for sym, t in sorted(traded, key=lambda x: x[1].realized_pnl_bps, reverse=True):
                wr = t.wins / max(1, t.total_trades) * 100
                logger.info(
                    f"    {sym:<14s}: {t.total_trades:>3} trades | "
                    f"WR {wr:>4.0f}% | "
                    f"PnL {t.realized_pnl_bps:>+8.1f} bp "
                    f"${t.realized_pnl:>+.4f} | "
                    f"fees ${t.total_fees:.4f}"
                )
        logger.info(f"{'═'*105}")
