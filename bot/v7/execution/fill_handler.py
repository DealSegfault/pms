"""
Fill handler mixin — extracted from GridTrader.

Handles live fill callbacks (sell/buy/external close), order queuing,
close recording, and behavioral tracking.
"""
import logging
import time
from typing import Optional, List, Tuple

logger = logging.getLogger(__name__)


class FillHandlerMixin:
    """Fill handling and order queue for GridTrader."""

    def on_sell_fill(self, fill_price: float, fill_qty: float, order_id: str, fee: float, layer_idx: int):
        """Called by orchestrator when SELL order fills (live mode)."""
        # Import GridLayer here to avoid circular imports at module level
        from bot.v7.grid_trader import GridLayer

        now = time.time()
        notional = fill_price * fill_qty

        max_layers_now = self._dynamic_max_layers()
        # Adaptive cap: reject if runtime behavior says depth is too risky.
        if len(self.layers) >= max_layers_now:
            logger.warning(
                f"⚠️ {self.symbol} REJECTING fill — already at max {max_layers_now} layers. "
                f"Will need to close this extra position."
            )
            self._pending_order = False
            return fill_qty  # Return qty to orchestrator for immediate close

        cap = self._symbol_notional_cap()
        if cap > 0 and (self.total_notional + notional) > cap:
            logger.warning(
                f"⚠️ {self.symbol} REJECTING fill — projected ${self.total_notional + notional:.2f} "
                f"> symbol cap ${cap:.2f}. Will close this excess position."
            )
            self._pending_order = False
            return fill_qty

        snap = self._signal_snapshot()
        layer = GridLayer(
            price=fill_price, qty=fill_qty, notional=notional,
            entry_ts=now, layer_idx=layer_idx, order_id=order_id, fee=fee,
            entry_signals=snap,
        )
        self.layers.append(layer)
        self._update_avg()
        self._register_sell_fill_event(fill_price, now)
        if layer_idx > 0:
            self._record_recovery_add_event(now)
        self.total_fees += fee
        self._write_entry_log(now, layer)

        # *** UNBLOCK — ready for next order ***
        self._pending_order = False

        logger.info(
            f"🔴 {self.symbol} FILL SHORT L{layer_idx} @ {fill_price:.6f} | "
            f"${notional:.2f} | fee ${fee:.4f} | id={order_id[:8]}… | "
            f"grid: {len(self.layers)}L/${self.total_notional:.0f} "
            f"(max {max_layers_now}L)"
        )
        return None  # No excess qty

    def on_buy_fill(
        self,
        fill_price: float,
        fill_qty: float,
        order_id: str,
        fee: float,
        reason: str,
        decision_ask: Optional[float] = None,
        partial_tp: bool = False,
        inverse_tp_zone: int = -1,
    ):
        """Called by orchestrator when BUY order fills (close position, live mode)."""
        now = time.time()

        # ── Inverse TP partial close ──
        if partial_tp and self._inverse_tp_active:
            # Determine which layers this fill covers
            n_zones = len(self._inverse_tp_zones)
            n_layers = len(self.layers)
            zone_idx = inverse_tp_zone if inverse_tp_zone >= 0 else self._inverse_tp_next_idx - 1

            remaining_zones = max(1, n_zones - zone_idx)
            layers_per_zone = max(1, n_layers // remaining_zones)
            close_layers = self.layers[:layers_per_zone]
            close_notional = sum(l.notional for l in close_layers)

            # Calculate PnL for the closed layers
            actual_pnl = sum((l.price - fill_price) * l.qty for l in close_layers)
            total_entry_fees = sum(l.fee for l in close_layers)
            actual_net = actual_pnl - total_entry_fees - fee
            actual_bps = (actual_net / close_notional * 10000) if close_notional > 0 else 0

            logger.info(
                f"🟢 {self.symbol} INVERSE TP FILL zone {zone_idx} | "
                f"{len(close_layers)}L @ {fill_price:.6f} | "
                f"PnL {actual_bps:+.1f}bps (${actual_net:+.4f}) | "
                f"id={order_id[:8]}…"
            )

            self.total_fees += fee
            self._apply_partial_close(close_layers, fill_price, actual_net, actual_bps, now, zone_idx)
            return

        # ── Standard full close ──
        n_layers = len(self.layers)

        # Calculate actual PnL using fill price
        actual_pnl = 0.0
        for layer in self.layers:
            actual_pnl += (layer.price - fill_price) * layer.qty

        total_entry_fees = sum(l.fee for l in self.layers)
        actual_net = actual_pnl - total_entry_fees - fee
        actual_bps = (actual_net / self.total_notional * 10000) if self.total_notional > 0 else 0

        emoji = "💰" if actual_net > 0 else "❌"
        logger.info(
            f"{emoji} {self.symbol} FILL CLOSE {n_layers}L @ {fill_price:.6f} | "
            f"avg_entry {self.avg_entry_price:.6f} | "
            f"PnL {actual_bps:+.1f}bps (${actual_net:+.4f}) | "
            f"fees ${total_entry_fees + fee:.4f} | "
            f"reason={reason} | id={order_id[:8]}…"
        )

        self.total_fees += fee
        ask_ref = float(decision_ask or 0.0)
        if ask_ref <= 0:
            ask_ref = float(self.ask or 0.0)
        if ask_ref > 0:
            slippage_bps = (fill_price - ask_ref) / ask_ref * 10000.0
            self._recent_exit_slippage_bps.append(float(slippage_bps))
        self._record_close(actual_net, actual_bps, now, reason, n_layers)
        self._reset_grid()

    def on_external_close_fill(self, fill_price: float, fee: float, reason: str = "external") -> Tuple[float, float]:
        """
        Record a close that was executed outside normal buy-flow orchestration.
        Returns (net_usd, net_bps).
        """
        now = time.time()
        if not self.layers or self.total_notional <= 0:
            return 0.0, 0.0

        n_layers = len(self.layers)
        gross = sum((layer.price - fill_price) * layer.qty for layer in self.layers)
        total_entry_fees = sum(l.fee for l in self.layers)
        net = gross - total_entry_fees - float(fee)
        bps = net / self.total_notional * 10000.0
        self.total_fees += float(fee)
        self._record_close(net, bps, now, reason, n_layers)
        self._reset_grid()
        return net, bps

    def drain_orders(self) -> List[dict]:
        """Pop all pending orders (called by orchestrator)."""
        orders = self._order_queue.copy()
        self._order_queue.clear()
        return orders

    def _enqueue_order(self, order: dict) -> None:
        """Queue an order for the orchestrator to execute."""
        self._order_queue.append(order)
        if self.order_notify:
            try:
                self.order_notify()
            except Exception:
                pass

    def _record_close(self, net_pnl: float, net_pnl_bps: float, now: float, reason: str, n_layers: int):
        """Record trade result and check circuit breaker."""
        close_notional = max(float(self.total_notional), 0.0)
        self.realized_pnl += net_pnl
        self.realized_pnl_bps += net_pnl_bps
        self.total_trades += 1
        self._session_rpnl += net_pnl
        self._session_trades += 1
        self._session_closed_notional += close_notional
        if net_pnl > 0:
            self.wins += 1

        # Track close prices for falling-knife detection
        close_price = self.bid if self.bid > 0 else self.mid
        if close_price > 0:
            self._recent_close_prices.append(close_price)

        if self.realized_pnl_bps < -self.config.max_loss_bps:
            if self._circuit_breaker_ts == 0:
                logger.warning(
                    f"🛑 {self.symbol} CIRCUIT BREAKER: "
                    f"cumulative {self.realized_pnl_bps:.1f}bps > -{self.config.max_loss_bps}bps"
                )
                self._circuit_breaker_ts = now

        self._update_recovery_debt(net_pnl)
        self._register_close_behavior(net_pnl, net_pnl_bps, reason, n_layers, self.total_notional)

        # Escalating cooldown — prevents churn (close→reopen→close loops)
        # Schedule: 8s → 30s → 90s → 300s
        # Reset on profitable TP — regime is favorable, don't block entries
        if net_pnl > 0 and reason in ("tp", "fast_tp"):
            self._trade_count_for_cooldown = 0
        else:
            self._trade_count_for_cooldown += 1
        cooldown_schedule = [8, 30, 90, 300]
        idx = min(max(self._trade_count_for_cooldown - 1, 0), len(cooldown_schedule) - 1)
        cooldown = cooldown_schedule[idx]
        if net_pnl < 0 and reason in ("stop", "drawdown"):
            cooldown *= 1.5  # Extra penalty for panic exits
        self._cooldown_until = max(self._cooldown_until, now + cooldown)

        if self.config.log_jsonl and self.config.jsonl_path:
            self._write_trade_log(now, reason, net_pnl, net_pnl_bps, n_layers)

    def _register_sell_fill_event(self, price: float, ts: float):
        if self.last_entry_ts > 0 and self.last_entry_price > 0:
            gap_sec = max(ts - self.last_entry_ts, 0.0)
            gap_bps = abs(price - self.last_entry_price) / self.last_entry_price * 10000
            self._recent_sell_fill_gaps.append({"gap_sec": gap_sec, "gap_bps": gap_bps})
        self.last_entry_ts = ts
        self.last_entry_price = price

    def _register_close_behavior(self, net_pnl: float, net_pnl_bps: float, reason: str, n_layers: int, notional: float):
        self._recent_close_behaviors.append(
            {
                "net_usd": float(net_pnl),
                "net_bps": float(net_pnl_bps),
                "reason": str(reason),
                "layers": int(n_layers),
                "notional": float(notional),
            }
        )

    def estimate_close_pnl(self, close_price: Optional[float] = None) -> Tuple[float, float]:
        """
        Estimate executable net PnL at a given close price.
        Returns (net_usd, net_bps).
        """
        px = float(close_price if close_price is not None else self.ask)
        if not self.layers or self.total_notional <= 0 or px <= 0:
            return 0.0, 0.0
        unrealized = sum((l.price - px) * l.qty for l in self.layers)
        total_entry_fees = sum(l.fee if l.fee > 0 else l.notional * self.config.maker_fee for l in self.layers)
        total_exit_fees = px * self.total_qty * self.config.taker_fee
        net = unrealized - total_entry_fees - total_exit_fees
        return net, net / self.total_notional * 10000

    def _unrealized_pnl_bps(self) -> float:
        """Current unrealized PnL in bps across all layers."""
        return self.estimate_close_pnl(self.bid)[1]
