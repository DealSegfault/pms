#!/usr/bin/env python3
"""
V7 GRID TRADER — Per-symbol short grid strategy.

Sells into pumps at geometrically-spaced levels.
Buys back (takes profit) when price mean-reverts.

Supports both paper (instant fills) and live (exchange orders).
"""
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, List, Deque, Callable, Any, Dict, Tuple

import numpy as np

from bot.v7.signals import MicroSignals
from bot.v7.volatility_regime import MultiTFVolatilityCalibrator, VolatilitySnapshot

# ── Extracted mixins ──
from bot.v7.strategy.edge import EdgeMixin
from bot.v7.strategy.dynamics import DynamicsMixin
from bot.v7.state.recovery import RecoveryMixin
from bot.v7.execution.fill_handler import FillHandlerMixin
from bot.v7.telemetry.trade_log import TradeLogMixin

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

@dataclass
class GridConfig:
    """Configuration for one grid trader instance."""
    symbol: str = "LAUSDT"

    # Fee structure (user's actual Binance rates)
    maker_fee: float = 0.000252    # 0.0252%
    taker_fee: float = 0.000336    # 0.0336%

    # Grid sizing
    min_notional: float = 6.0      # $6 minimum per layer
    max_notional: float = 30.0     # Max per layer (vol-sized)
    max_layers: int = 8            # Runtime behavior adapter can tighten this when needed
    spacing_growth: float = 1.6    # Geometric growth between layers
    size_growth: float = 1.0       # Notional multiplier per layer depth (WM uses 2.5-2.8)
    base_spacing_bps: float = 0.0  # Auto-calibrated from spread if 0
    trend_spacing_scale: float = 5.0  # 2s-ret scale for spacing boost (0=off)

    # Volatility drift calibration (MTF OHLCV + live micro-vol)
    vol_drift_enabled: bool = True
    candle_service_url: str = "http://localhost:3003"
    vol_refresh_sec: float = 120.0
    vol_live_weight: float = 0.45
    vol_drift_min: float = 0.8
    vol_drift_max: float = 3.0
    vol_tail_mult: float = 2.2
    vol_tail_cooldown_sec: float = 20.0
    vol_tf_weights: Dict[str, float] = field(
        default_factory=lambda: {"1m": 0.5, "5m": 0.3, "15m": 0.2}
    )
    vol_tf_lookbacks: Dict[str, str] = field(
        default_factory=lambda: {"1m": "6h", "5m": "2d", "15m": "7d"}
    )

    # Entry filters
    min_spread_bps: float = 5.0    # Don't enter if spread too tight
    max_spread_bps: float = 40.0   # Don't enter if spread too wide
    cooldown_sec: float = 2.0      # Base min gap between entries (adapter can increase)
    warmup_sec: float = 30.0       # Collect spread data before trading
    resume_context_rewarm_sec: float = 30.0  # Recompute spread/vol context after runtime-state restore

    # Signal thresholds
    pump_threshold: float = 2.0    # Pump score must exceed this
    exhaust_threshold: float = 1.0 # Exhaust score must exceed this

    # Exit targets
    tp_spread_mult: float = 1.2    # TP = -mult × spread_bps from entry (raised from 0.6)
    min_tp_profit_bps: float = 10.0  # Absolute floor: TP never fires below this price move
    tp_decay_half_life_min: float = 0.0  # TP decays over this many minutes (0=off)
    tp_decay_floor: float = 0.5    # TP never decays below this fraction of original
    tp_vol_capture_ratio: float = 0.15  # Fraction of live vol to use as TP target (0=off)
    tp_vol_scale_cap: float = 50.0      # Max vol-scaled TP in bps (safety cap)
    tp_mode: str = "auto"               # auto | fast | vol — exit strategy mode
    fast_tp_ti: float = -0.25      # TI_500ms threshold for fast TP

    stop_loss_bps: float = 0.0     # DISABLED — hold DD, average down
    max_trend_bps: float = 5.0     # Trend guard: skip entry if 2s return > this
    max_trend_30s_bps: float = 30.0  # 30s trend guard: skip if 30s return < -this (waterfall)
    max_buy_ratio: float = 1.0     # Trade-side delta: skip short if buy% > this (1.0=off)
    min_fast_tp_bps: float = -10.0 # Min profit for fast_tp exit (raised from -5, clears fee floor)
    min_edge_bps: float = 2.0     # Min net edge (TP - fees) required for entry
    max_symbol_notional: float = 0.0  # Hard per-symbol notional cap (0 = disabled)

    # Inverse grid TP — multi-layer positions exit at mirrored entry spacing
    inverse_tp_enabled: bool = True       # Master switch
    inverse_tp_min_layers: int = 3        # Activate when position has >= this many layers
    inverse_tp_max_zones: int = 5         # Max TP zones (caps deep targets for high layer counts)
    inverse_tp_time_cap_sec: float = 1800.0  # 30min hard time cap from first partial TP

    # Waterfall protection — vol-relative drawdown penalty with decay
    waterfall_vol_threshold: float = 3.0  # Skip entry if 30s drawdown > N × vol (in vol units)
    waterfall_decay_sec: float = 30.0     # Exponential decay half-life for waterfall score

    # Edge model / execution uncertainty
    edge_signal_slope_bps: float = 1.0       # Bonus bps per signal-strength unit above threshold
    edge_exec_buffer_bps: float = 0.3        # Extra execution buffer (maker GTX = ~0 slippage on entry)
    edge_default_slippage_bps: float = 0.5   # Fallback exit slippage estimate when no samples
    edge_uncertainty_z: float = 0.75         # LCB multiplier for recent PnL volatility
    edge_min_samples: int = 5                # Samples required before full uncertainty model

    # Recovery accounting: realized losses become debt that raises profit-taking thresholds
    recovery_debt_enabled: bool = True
    recovery_paydown_ratio: float = 0.25     # Portion of outstanding debt to recover per profitable close
    recovery_max_paydown_bps: float = 25.0   # Cap debt paydown requirement per close
    recovery_debt_cap_usd: float = 75.0      # Hard cap to avoid pathological debt targets
    recovery_avg_enabled: bool = True         # Enable dedicated averaging guardrail for recovery
    recovery_avg_min_unrealized_bps: float = 35.0     # Only average when position is meaningfully underwater
    recovery_avg_min_hurdle_improve_bps: float = 0.75  # Min debt-hurdle improvement required per add
    recovery_avg_cooldown_sec: float = 20.0            # Min time between recovery adds
    recovery_avg_max_adds_per_hour: int = 8            # Burst cap for recovery adds

    # Stealth order spreading
    stealth_max_l1_fraction: float = 0.5    # Max fraction of L1 depth per tick level
    stealth_max_ticks: int = 5              # Max ticks to spread across
    stealth_always_split: bool = True       # Always split into random pieces (anti-front-running)
    stealth_min_slices: int = 2             # Min random pieces per order
    stealth_max_slices: int = 5             # Max random pieces per order

    # Risk
    max_loss_bps: float = 500.0    # Per-symbol circuit breaker (wide)
    circuit_pause_sec: float = 120.0
    loss_cooldown_sec: float = 8.0 # Pause re-entry after a losing close
    dynamic_behavior_enabled: bool = True
    behavior_lookback: int = 120

    # Mode
    live: bool = False             # True = send real orders

    # Logging
    log_jsonl: bool = True
    jsonl_path: str = ""


# ═══════════════════════════════════════════════════════════════
# GRID LAYER
# ═══════════════════════════════════════════════════════════════

@dataclass
class GridLayer:
    """One short entry in the grid."""
    price: float           # Entry price (fill price if live)
    qty: float             # Position size (in base asset)
    notional: float        # $ value at entry
    entry_ts: float        # When entered
    layer_idx: int         # 0-based layer index
    order_id: str = ""     # Exchange order ID (live mode)
    fee: float = 0.0       # Actual fee paid (live mode)
    entry_signals: dict = field(default_factory=dict)  # Signal snapshot at entry time


# ═══════════════════════════════════════════════════════════════
# GRID TRADER
# ═══════════════════════════════════════════════════════════════

class GridTrader(EdgeMixin, DynamicsMixin, RecoveryMixin, FillHandlerMixin, TradeLogMixin):
    """
    Per-symbol short grid trader.

    Strategy:
    1. ENTRY: Sell at ask when spread + conditions met
    2. AVERAGING: If price rises, add more shorts at geometric distances
    3. EXIT: Buy back all layers when unrealized PnL > TP target
    4. STOP: Circuit breaker if cumulative loss > threshold

    In live mode, calls executor functions for real order placement.
    One order at a time — _pending_order blocks until fill received.
    """

    def __init__(
        self,
        config: GridConfig,
        executor=None,
        portfolio_check=None,
        order_notify: Optional[Callable[[], None]] = None,
        external_snapshot_provider: Optional[Callable[[], Dict[str, float]]] = None,
        event_sink: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.config = config
        self.symbol = config.symbol
        self.symbol_key = config.symbol.lower()
        self.executor = executor
        # Callback: portfolio_check() -> bool (True = allowed to add notional)
        self.portfolio_check = portfolio_check
        # Callback: order_notify() -> wake orchestrator immediately when order queued
        self.order_notify = order_notify
        # Optional callback: enrich signal snapshot with global/runner metrics.
        self.external_snapshot_provider = external_snapshot_provider
        # Optional callback: emit compact strategy events for DB persistence.
        self.event_sink = event_sink

        # ── Microstructure signals ──
        self.signals = MicroSignals()

        # Book state
        self.bid: float = 0.0
        self.ask: float = 0.0
        self.bid_qty: float = 0.0
        self.ask_qty: float = 0.0
        self.mid: float = 0.0
        self.last_book_ts: float = 0.0

        # Rolling min L1 depth (1-minute window) for stealth sizing
        self.min_bid_qty_1m: float = 0.0
        self.min_ask_qty_1m: float = 0.0
        self._bid_qty_samples: Deque[tuple] = deque(maxlen=600)  # (ts, qty)
        self._ask_qty_samples: Deque[tuple] = deque(maxlen=600)

        # Spread tracking for calibration
        self._spread_history: Deque[float] = deque(maxlen=500)
        self._median_spread_bps: float = 0.0
        self._last_spread_calc_ts: float = 0.0
        self._layer_cooldown_until: float = 0.0
        self._last_tail_log_ts: float = 0.0

        # Volatility regime: weighted OHLCV TF baseline + live micro-vol.
        self._vol_calibrator = MultiTFVolatilityCalibrator(
            self.symbol,
            enabled=self.config.vol_drift_enabled,
            candle_service_url=self.config.candle_service_url,
            tf_weights=self.config.vol_tf_weights,
            tf_lookbacks=self.config.vol_tf_lookbacks,
            refresh_sec=self.config.vol_refresh_sec,
            live_weight=self.config.vol_live_weight,
            drift_min=self.config.vol_drift_min,
            drift_max=self.config.vol_drift_max,
            tail_mult=self.config.vol_tail_mult,
        )
        self._vol_snapshot = VolatilitySnapshot()

        # Grid state
        self.layers: List[GridLayer] = []
        self.avg_entry_price: float = 0.0
        self.total_qty: float = 0.0
        self.total_notional: float = 0.0

        # Tracking
        self.start_ts: float = time.time()
        self.realized_pnl: float = 0.0  # Cumulative $
        self.realized_pnl_bps: float = 0.0
        self.total_trades: int = 0       # Completed round-trips
        self.wins: int = 0
        self.total_fees: float = 0.0     # Cumulative fees $
        self.last_entry_ts: float = 0.0
        self.last_entry_price: float = 0.0  # Price dedup
        self._circuit_breaker_ts: float = 0.0
        self._cooldown_until: float = 0.0
        self._trade_count_for_cooldown: int = 0  # Escalating cooldown counter
        hist_n = max(20, int(self.config.behavior_lookback))
        self._recent_sell_fill_gaps: Deque[dict] = deque(maxlen=hist_n)
        self._recent_close_behaviors: Deque[dict] = deque(maxlen=hist_n)
        self._recent_exit_slippage_bps: Deque[float] = deque(maxlen=hist_n)
        self._recent_close_prices: Deque[float] = deque(maxlen=5)  # For falling-knife detection
        self._last_edge_snapshot: Dict[str, Any] = {}
        self._last_recovery_avg_snapshot: Dict[str, Any] = {}

        # Waterfall tracking: rolling 30s high price for drawdown
        self._price_30s_high: Deque[Tuple[float, float]] = deque(maxlen=300)  # (ts, price)
        self._waterfall_peak_ts: float = 0.0
        self.recovery_debt_usd: float = 0.0
        self._entry_enabled: bool = True

        # Capital efficiency tracking
        self.adoption_ts: float = time.time()    # When position was first adopted/entered
        self._session_rpnl: float = 0.0          # Realized PnL this session for this symbol
        self._session_trades: int = 0            # Trade count this session
        self._session_closed_notional: float = 0.0   # Sum of notionals from closed trades this session
        self._hist_rpnl_per_hour: float = 0.0    # Historical rPnL/hr from DB (set externally)
        self._hist_trade_count: int = 0           # Historical trade count (set externally)
        self.last_recovery_add_ts: float = 0.0
        self._recovery_add_events: Deque[float] = deque(maxlen=64)
        self._resume_rewarm_until: float = 0.0
        self._last_runtime_restore_ts: float = 0.0

        # Inverse grid TP state
        self._inverse_tp_active: bool = False
        self._inverse_tp_zones: List[float] = []       # bps targets [15, 30, 60, 120, 240]
        self._inverse_tp_next_idx: int = 0              # next zone index to close at
        self._inverse_tp_start_ts: float = 0.0          # when first partial TP fired
        self._inverse_tp_layers_at_start: int = 0       # original layer count
        self._inverse_tp_avg_entry: float = 0.0         # avg entry when inverse TP activated

        # Live mode: ONE order at a time
        self._pending_order: bool = False
        self._pending_order_ts: float = 0.0   # Timestamp for timeout safety (UU#8)
        self._pending_exit: bool = False
        self._order_queue: List[dict] = []

        # JSONL log
        self._log_file = None
        if config.log_jsonl and config.jsonl_path:
            import os
            os.makedirs(os.path.dirname(config.jsonl_path) or ".", exist_ok=True)

    @property
    def is_live(self) -> bool:
        return self.config.live and self.executor is not None

    # ─── Book updates ─────────────────────────────────────────

    def on_book(self, bid: float, ask: float, bid_qty: float, ask_qty: float, ts: float):
        """Process L1 book update. Main event loop driver."""
        self.bid = bid
        self.ask = ask
        self.bid_qty = bid_qty
        self.ask_qty = ask_qty
        self.mid = (bid + ask) / 2 if bid > 0 and ask > 0 else 0
        self.last_book_ts = ts

        # Track rolling min L1 depth (1-minute window)
        now_mono = ts
        if bid_qty > 0:
            self._bid_qty_samples.append((now_mono, bid_qty))
        if ask_qty > 0:
            self._ask_qty_samples.append((now_mono, ask_qty))
        cutoff = now_mono - 60.0
        # Evict old samples
        while self._bid_qty_samples and self._bid_qty_samples[0][0] < cutoff:
            self._bid_qty_samples.popleft()
        while self._ask_qty_samples and self._ask_qty_samples[0][0] < cutoff:
            self._ask_qty_samples.popleft()
        self.min_bid_qty_1m = min((s[1] for s in self._bid_qty_samples), default=bid_qty) if self._bid_qty_samples else bid_qty
        self.min_ask_qty_1m = min((s[1] for s in self._ask_qty_samples), default=ask_qty) if self._ask_qty_samples else ask_qty
        now = time.time()

        if self.mid <= 0:
            return

        # Track rolling 30s high for waterfall detection
        self._price_30s_high.append((ts, self.mid))
        cutoff_30 = ts - 30.0
        while self._price_30s_high and self._price_30s_high[0][0] < cutoff_30:
            self._price_30s_high.popleft()
        # Update peak timestamp (when was the highest price in the 30s window?)
        if self._price_30s_high:
            max_price = 0.0
            max_ts = ts
            for t, p in self._price_30s_high:
                if p > max_price:
                    max_price = p
                    max_ts = t
            self._waterfall_peak_ts = max_ts

        # ── Feed signals ──
        self.signals.on_book(bid, ask, bid_qty, ask_qty, ts)
        self._update_vol_regime(now)

        # Track spread
        spread_bps = (ask - bid) / self.mid * 10000
        self._spread_history.append(spread_bps)

        # Recalculate median spread every 2s
        if now - self._last_spread_calc_ts > 2.0 and len(self._spread_history) > 10:
            self._median_spread_bps = float(np.median(list(self._spread_history)))
            self._last_spread_calc_ts = now

        # *** CRITICAL: block ALL logic while order is pending ***
        # Timeout safety: if pending for >10s with no fill/cancel, auto-reset (UU#8)
        if self._pending_order and hasattr(self, '_pending_order_ts') and self._pending_order_ts > 0:
            if now - self._pending_order_ts > 10.0:
                logger.warning(f"⚠️ {self.symbol} pending_order timeout (>10s) — auto-resetting")
                self._pending_order = False
                self._pending_order_ts = 0.0
        if self._pending_order or self._pending_exit:
            return

        # Main logic
        if self.layers:
            self._check_exit(now, spread_bps)
        elif len(self.layers) == 0:
            self._check_entry(now, spread_bps)

        # Check averaging (add more layers) — adaptive cap
        if self.layers and len(self.layers) < self._dynamic_max_layers():
            if not self._pending_order:
                self._check_averaging(now, spread_bps)

    def on_trade(self, price: float, qty: float, is_buyer_maker: bool, ts: float = 0.0):
        """Process aggTrade event — feeds microstructure signals."""
        if ts <= 0:
            ts = time.time()
        self.signals.on_trade(price, qty, is_buyer_maker, ts)

    # _enqueue_order is inherited from FillHandlerMixin

    # ─── Persistent quoting helpers ─────────────────────────────

    def signal_still_valid(self) -> bool:
        """Check if the entry signal that triggered our resting order is still active.
        Used by orchestrator to decide whether to keep or reap a resting entry."""
        if not self.signals.is_warm:
            return False
        if self.signals.pump_score <= 1.0:
            return False
        ret_2s = self.signals._get_ret_2s()
        if ret_2s > self.config.max_trend_bps:
            return False
        return True

    @property
    def tp_price(self) -> float:
        """Calculate the current optimal TP buy price for a resting TP order.
        Returns 0 if no position or no valid bid."""
        if not self.layers or not self.bid:
            return 0.0
        # When inverse TP is active, rest at the NEXT zone target
        if self._inverse_tp_active and self._inverse_tp_next_idx < len(self._inverse_tp_zones):
            zone_bps = self._inverse_tp_zones[self._inverse_tp_next_idx]
            tp = self._inverse_tp_avg_entry * (1.0 - zone_bps / 10000.0)
            return tp
        tp_bps = self._tp_target_bps()
        # For a short: TP buy at avg_entry * (1 - tp_bps/10000)
        tp = self.avg_entry_price * (1.0 - tp_bps / 10000.0)
        return tp

    # ─── Entry logic ──────────────────────────────────────────

    def _check_entry(self, now: float, spread_bps: float):
        """Check if conditions met for initial short entry (signal-based)."""
        if not self._entry_enabled:
            return
        if now < self._resume_rewarm_until:
            return

        # Already have layers or pending
        if self.layers or self._pending_order:
            return

        # Warmup
        elapsed = now - self.start_ts
        if elapsed < self.config.warmup_sec:
            return

        # Circuit breaker
        if not self._can_trade(now):
            return

        # Median spread must be calibrated
        if self._median_spread_bps <= 0:
            return

        # Adaptive cooldown: reacts to churn and near-zero close pressure.
        if now - self.last_entry_ts < self._dynamic_entry_cooldown_sec():
            return

        # ── Waterfall guard: skip entry if vol-relative drawdown is too large ──
        wf_score = self._waterfall_score()
        if wf_score > self.config.waterfall_vol_threshold:
            return

        # ── Microstructure signal check ──
        sig = self.signals.entry_signal(
            pump_thresh=self.config.pump_threshold,
            exhaust_thresh=self.config.exhaust_threshold,
            min_spread=self.config.min_spread_bps,
            max_spread=self.config.max_spread_bps,
            max_trend_bps=self.config.max_trend_bps,
            max_trend_30s_bps=self.config.max_trend_30s_bps,
            max_buy_ratio=self.config.max_buy_ratio,
        )
        if not sig.should_enter:
            return

        # ── Vol-normalized sizing, scaled by spread width ──
        spread_scale = self._spread_scaled_notional(spread_bps)
        notional = self.signals.position_size(
            base_notional=spread_scale,
            min_notional=self.config.min_notional,
            max_notional=self.config.max_notional,
        )

        # Entry: sell at ask
        price = self.ask
        qty = notional / price
        actual_notional = price * qty

        # Per-symbol cap check
        cap = self._symbol_notional_cap()
        if cap > 0 and actual_notional > cap:
            return

        # Cost-aware expected-edge gate (LCB): only enter when estimated edge clears safety hurdle.
        if not self._has_sufficient_edge(
            signal_strength=float(sig.signal_strength),
            spread_bps=float(spread_bps),
            projected_notional=float(actual_notional),
            context="entry",
        ):
            return

        # Portfolio-level cap check using projected notional
        if self.portfolio_check and not self.portfolio_check(actual_notional):
            return

        tp_target = self._tp_target_bps()

        if self.is_live:
            # *** BLOCK immediately — one order at a time ***
            self._pending_order = True
            self._pending_order_ts = time.time()
            self._enqueue_order({
                "action": "sell",
                "symbol": self.symbol,
                "qty": qty,
                "layer_idx": 0,
                "ref_price": price,
                "spread_bps": spread_bps,
                "tp_target": tp_target,
                "pump": sig.pump,
                "exhaust": sig.exhaust,
            })
        else:
            # Paper trade: instant fill
            snap = self._signal_snapshot()
            layer = GridLayer(
                price=price, qty=qty, notional=actual_notional,
                entry_ts=now, layer_idx=0, entry_signals=snap,
            )
            self.layers.append(layer)
            self._update_avg()
            self._register_sell_fill_event(price, now)
            self._write_entry_log(now, layer)

            logger.info(
                f"🔴 {self.symbol} SHORT L0 @ {price:.6f} | "
                f"${actual_notional:.2f} | pump={sig.pump:.1f} exh={sig.exhaust:.1f} | "
                f"TP target {tp_target:.1f}bps"
            )

    # ─── Averaging logic ──────────────────────────────────────

    def _check_averaging(self, now: float, spread_bps: float):
        """Add another short layer if price has risen enough."""
        if not self.layers:
            return

        # ── Diagnostic: throttled logging of averaging gate status ──
        avg_diag_key = "_avg_diag_last_ts"
        last_diag = getattr(self, avg_diag_key, 0.0)
        should_diag = (now - last_diag) >= 10.0  # Log every 10s per symbol
        block_reason = None  # Track the blocking gate for diagnostics

        if now < self._resume_rewarm_until:
            block_reason = "rewarm"
        elif self._pending_order:
            block_reason = "pending_order"
        elif len(self.layers) >= self._dynamic_max_layers():
            block_reason = f"max_layers({len(self.layers)}/{self._dynamic_max_layers()})"
        elif not self._can_trade(now):
            block_reason = "circuit_breaker"
        elif now < self._layer_cooldown_until:
            block_reason = f"layer_cd({self._layer_cooldown_until - now:.0f}s)"
        elif now - self.last_entry_ts < self._dynamic_entry_cooldown_sec():
            block_reason = f"entry_cd({self._dynamic_entry_cooldown_sec() - (now - self.last_entry_ts):.0f}s)"
        else:
            # Calculate spacing
            n = len(self.layers)
            base_spacing = self._base_spacing_bps()
            eff_growth = self._effective_spacing_growth()
            required_spacing = base_spacing * (eff_growth ** (n - 1))
            required_spacing = max(required_spacing, self._dynamic_layer_gap_bps())
            price_rise_bps = (self.ask - self.avg_entry_price) / self.avg_entry_price * 10000

            if self.config.trend_spacing_scale > 0 and price_rise_bps > 0:
                trend_mult = 1.0 + price_rise_bps / self.config.trend_spacing_scale
                required_spacing *= trend_mult

            if price_rise_bps < required_spacing:
                block_reason = f"spacing(rise={price_rise_bps:.0f}bp<req={required_spacing:.0f}bp)"
            elif spread_bps < self._averaging_min_spread(spread_bps):
                avg_min = self._averaging_min_spread(spread_bps)
                block_reason = f"spread({spread_bps:.1f}<{avg_min:.1f})"
            elif self.last_entry_price > 0:
                price_diff_bps = abs(self.ask - self.last_entry_price) / self.last_entry_price * 10000
                if price_diff_bps < self._dynamic_layer_gap_bps():
                    block_reason = f"burst_guard({price_diff_bps:.0f}<{self._dynamic_layer_gap_bps():.0f}bp)"

        # If we have a block reason from the fast checks, log and return
        if block_reason:
            if should_diag:
                setattr(self, avg_diag_key, now)
                logger.info(
                    f"🔍 {self.symbol} L{len(self.layers)} avg-gate: ✗ {block_reason} | "
                    f"unr={self._unrealized_bps():.0f}bp spr={spread_bps:.1f}"
                )
            return

        # ── Passed fast gates — now check slow gates ──
        n = len(self.layers)
        base_spacing = self._base_spacing_bps()
        eff_growth = self._effective_spacing_growth()
        required_spacing = base_spacing * (eff_growth ** (n - 1))
        required_spacing = max(required_spacing, self._dynamic_layer_gap_bps())
        price_rise_bps = (self.ask - self.avg_entry_price) / self.avg_entry_price * 10000

        if self.config.trend_spacing_scale > 0 and price_rise_bps > 0:
            trend_mult = 1.0 + price_rise_bps / self.config.trend_spacing_scale
            required_spacing *= trend_mult

        # Entry: sell at ask
        price = self.ask
        base_notional = self._spread_scaled_notional(spread_bps)
        layer_notional = base_notional * (self.config.size_growth ** len(self.layers))
        layer_notional = min(layer_notional, self.config.max_notional)
        qty = layer_notional / price
        notional = price * qty
        projected_notional = self.total_notional + notional

        # Hard per-symbol notional cap
        cap = self._symbol_notional_cap()
        if cap > 0 and projected_notional > cap:
            if should_diag:
                setattr(self, avg_diag_key, now)
                logger.info(f"🔍 {self.symbol} L{n} avg-gate: ✗ notional_cap(${projected_notional:.0f}>${cap:.0f})")
            return

        if not self._recovery_average_allowed(
            now=now,
            projected_notional=float(projected_notional),
            context="average",
        ):
            if should_diag:
                setattr(self, avg_diag_key, now)
                snap = self._last_recovery_avg_snapshot
                logger.info(
                    f"🔍 {self.symbol} L{n} avg-gate: ✗ recovery({snap.get('reason','?')}) | "
                    f"unr={self._unrealized_bps():.0f}bp"
                )
            return

        # Marginal edge gate
        signal_strength = max((self.signals.pump_score + self.signals.exhaust_score) * 0.5, 0.0)
        if not self._has_sufficient_edge(
            signal_strength=float(signal_strength),
            spread_bps=float(spread_bps),
            projected_notional=float(projected_notional),
            context="average",
        ):
            if should_diag:
                setattr(self, avg_diag_key, now)
                snap = self._last_edge_snapshot
                logger.info(
                    f"🔍 {self.symbol} L{n} avg-gate: ✗ edge(lcb={snap.get('edge_lcb_bps',0):.1f}<req={snap.get('required_edge_bps',0):.1f}bp)"
                )
            return

        # Portfolio-level cap check
        if self.portfolio_check and not self.portfolio_check(notional):
            if should_diag:
                setattr(self, avg_diag_key, now)
                logger.info(f"🔍 {self.symbol} L{n} avg-gate: ✗ portfolio_cap")
            return

        # ── ALL GATES PASSED — fire layer ──
        logger.info(
            f"🔍 {self.symbol} L{n} avg-gate: ✓ ALL PASSED | "
            f"rise={price_rise_bps:.0f}bp req={required_spacing:.0f}bp spr={spread_bps:.1f}"
        )

        if self.is_live:
            # *** BLOCK immediately ***
            self._pending_order = True
            self._pending_order_ts = time.time()
            self._enqueue_order({
                "action": "sell",
                "symbol": self.symbol,
                "qty": qty,
                "layer_idx": n,
                "ref_price": price,
                "spacing": required_spacing,
                "drift_mult": self._vol_snapshot.drift_mult,
            })
        else:
            # Paper trade
            snap = self._signal_snapshot()
            layer = GridLayer(
                price=price, qty=qty, notional=notional,
                entry_ts=now, layer_idx=n, entry_signals=snap,
            )
            self.layers.append(layer)
            self._update_avg()
            self._register_sell_fill_event(price, now)
            self._record_recovery_add_event(now)
            self._write_entry_log(now, layer)

            logger.info(
                f"🔴 {self.symbol} SHORT L{n} @ {price:.6f} | "
                f"${notional:.2f} | spacing {required_spacing:.1f}bps "
                f"(growth {eff_growth:.2f}, drift {self._vol_snapshot.drift_mult:.2f}) | "
                f"avg {self.avg_entry_price:.6f} ({len(self.layers)} layers, "
                f"${self.total_notional:.2f})"
            )

    # ─── Exit logic ───────────────────────────────────────────

    def _check_exit(self, now: float, spread_bps: float):
        """Check if we should close all layers (flow-based + TP)."""
        if not self.layers:
            return
        if self._pending_exit:
            return
        if self._pending_order:
            return

        # ── 0. Inverse grid TP: check partial close levels ──
        if self._inverse_tp_active:
            self._check_inverse_tp(now, spread_bps)
            return

        net_pnl, net_pnl_bps = self.estimate_close_pnl(self.ask)

        # ── 1. Signal-based exit (TP / fast_tp) ──
        exit_sig = self.signals.exit_signal(
            entry_price=self.avg_entry_price,
            total_notional=self.total_notional,
            tp_spread_mult=self.config.tp_spread_mult,
            fast_tp_ti=self.config.fast_tp_ti,
            min_fast_tp_bps=self._dynamic_min_fast_tp_bps(),
            min_tp_profit_bps=self._dynamic_min_tp_profit_bps(),
        )
        if exit_sig.should_exit:
            # In vol mode, suppress fast_tp exits (wait for wider vol-based TP)
            if exit_sig.reason == "fast_tp" and self._effective_tp_mode() == "vol":
                return  # Skip — vol mode wants wider targets
            min_exec_bps = 0.0
            if exit_sig.reason == "fast_tp":
                # Avoid tiny "wins" that vanish in 1-2s before execution.
                min_exec_bps = max(1.0, self._fee_floor_bps() * 0.2)
            if exit_sig.reason in ("tp", "fast_tp"):
                # Recovery ledger: require enough profit to also repay part of accumulated realized losses.
                min_exec_bps = max(min_exec_bps, self._recovery_exit_hurdle_bps())
            # Strict executable PnL gate: TP-style exits must be non-negative at ask.
            if exit_sig.reason in ("tp", "fast_tp") and net_pnl_bps < min_exec_bps:
                return

            # ── Transition to inverse grid TP for multi-layer positions ──
            if (self.config.inverse_tp_enabled
                    and exit_sig.reason == "tp"
                    and len(self.layers) >= self.config.inverse_tp_min_layers):
                self._activate_inverse_tp(now)
                return

            self._close_all(
                now,
                exit_sig.reason,
                net_pnl,
                net_pnl_bps,
                min_net_bps=min_exec_bps,
            )
            return

        # ── 2. Stop loss (only if enabled, bps > 0) ──
        if self.config.stop_loss_bps > 0 and net_pnl_bps < -self.config.stop_loss_bps:
            self._close_all(now, "stop", net_pnl, net_pnl_bps)
            return

    # ─── Inverse Grid TP ──────────────────────────────────────

    def _compute_inverse_tp_zones(self) -> List[float]:
        """Compute inverse TP zone targets in bps below avg_entry.
        Mirrors the entry grid spacing downward. Capped at max_zones."""
        base = self._base_spacing_bps()
        growth = self._effective_spacing_growth()
        n_zones = min(len(self.layers), self.config.inverse_tp_max_zones)
        zones = []
        for i in range(n_zones):
            zones.append(base * (growth ** i))
        return zones

    def _activate_inverse_tp(self, now: float):
        """Transition from normal TP to inverse grid TP mode."""
        zones = self._compute_inverse_tp_zones()
        self._inverse_tp_active = True
        self._inverse_tp_zones = zones
        self._inverse_tp_next_idx = 0
        self._inverse_tp_start_ts = now
        self._inverse_tp_layers_at_start = len(self.layers)
        self._inverse_tp_avg_entry = self.avg_entry_price

        zones_str = ", ".join(f"{z:.0f}" for z in zones)
        logger.info(
            f"🟡 {self.symbol} INVERSE TP ACTIVATED | "
            f"{len(self.layers)}L → {len(zones)} zones [{zones_str}]bps | "
            f"avg_entry={self.avg_entry_price:.6f}"
        )
        # Immediately check if first zone is already reached
        self._check_inverse_tp(now, 0.0)

    def _check_inverse_tp(self, now: float, spread_bps: float):
        """Check if price has reached the next inverse TP zone target."""
        if not self.layers or self._pending_order:
            return

        # Time cap: close everything if we've been in inverse TP mode too long
        elapsed = now - self._inverse_tp_start_ts
        if elapsed > self.config.inverse_tp_time_cap_sec:
            net_pnl, net_pnl_bps = self.estimate_close_pnl(self.ask)
            logger.info(
                f"⏰ {self.symbol} INVERSE TP TIME CAP ({elapsed:.0f}s) | "
                f"closing remaining {len(self.layers)}L"
            )
            self._inverse_tp_active = False
            self._close_all(now, "inverse_tp_timeout", net_pnl, net_pnl_bps)
            return

        # All zones exhausted — should already be flat, but safety check
        if self._inverse_tp_next_idx >= len(self._inverse_tp_zones):
            if self.layers:
                net_pnl, net_pnl_bps = self.estimate_close_pnl(self.ask)
                self._inverse_tp_active = False
                self._close_all(now, "inverse_tp_final", net_pnl, net_pnl_bps)
            return

        # Check if price has dropped to the next TP zone
        zone_bps = self._inverse_tp_zones[self._inverse_tp_next_idx]
        tp_price = self._inverse_tp_avg_entry * (1.0 - zone_bps / 10000.0)

        # For shorts: closing (buying) at tp_price. Current bid must be <= tp_price.
        if self.bid > 0 and self.bid <= tp_price:
            self._close_partial(now, self._inverse_tp_next_idx, zone_bps)

    def _close_partial(self, now: float, zone_idx: int, zone_bps: float):
        """Close a fraction of the position at an inverse TP zone."""
        n_zones = len(self._inverse_tp_zones)
        n_layers = len(self.layers)

        # Determine how many layers to close at this zone
        if zone_idx == n_zones - 1:
            # Last zone: close everything remaining
            close_layers = list(self.layers)
        else:
            # Distribute layers across remaining zones
            remaining_zones = n_zones - zone_idx
            layers_per_zone = max(1, n_layers // remaining_zones)
            # Close the OLDEST layers first (FIFO: first in, first out)
            close_layers = self.layers[:layers_per_zone]

        close_qty = sum(l.qty for l in close_layers)
        close_notional = sum(l.notional for l in close_layers)

        if close_qty <= 0:
            return

        # Calculate PnL for the partial close
        close_price = self.bid
        gross_pnl = sum((l.price - close_price) * l.qty for l in close_layers)
        entry_fees = sum(l.fee if l.fee > 0 else l.notional * self.config.maker_fee for l in close_layers)
        exit_fees = close_price * close_qty * self.config.taker_fee
        net_pnl = gross_pnl - entry_fees - exit_fees
        net_pnl_bps = (net_pnl / close_notional * 10000) if close_notional > 0 else 0.0

        logger.info(
            f"🟢 {self.symbol} INVERSE TP CLOSE zone {zone_idx}/{n_zones} ({zone_bps:.0f}bps) | "
            f"closing {len(close_layers)}L/{n_layers}L qty={close_qty:.6f} | "
            f"PnL {net_pnl_bps:+.1f}bps (${net_pnl:+.4f})"
        )

        if self.is_live:
            self._pending_order = True
            self._pending_order_ts = time.time()
            is_final = (zone_idx == n_zones - 1) or (len(close_layers) == n_layers)
            self._enqueue_order({
                "action": "buy",
                "symbol": self.symbol,
                "qty": close_qty,
                "reason": "inverse_tp",
                "n_layers": len(close_layers),
                "est_pnl_bps": net_pnl_bps,
                "est_pnl_usd": net_pnl,
                "bid": self.bid,
                "ask": self.ask,
                "signal_ts": now,
                "min_net_bps": 0.0,
                "partial_tp": not is_final,
                "inverse_tp_zone": zone_idx,
            })
        else:
            # Paper trade: instant fill
            self._apply_partial_close(close_layers, close_price, net_pnl, net_pnl_bps, now, zone_idx)

    def _apply_partial_close(self, close_layers: List['GridLayer'], fill_price: float,
                             net_pnl: float, net_pnl_bps: float, now: float, zone_idx: int):
        """Apply a partial close: remove layers, update state, advance zone."""
        close_notional = sum(l.notional for l in close_layers)

        # Record partial PnL
        self.realized_pnl += net_pnl
        self.realized_pnl_bps += net_pnl_bps * (close_notional / max(self.total_notional, 1e-10))
        self._session_rpnl += net_pnl
        self._session_closed_notional += close_notional
        if net_pnl > 0:
            self.wins += 1
        self.total_trades += 1
        self._session_trades += 1

        # Remove the closed layers
        for layer in close_layers:
            if layer in self.layers:
                self.layers.remove(layer)

        # Advance to next zone
        self._inverse_tp_next_idx = zone_idx + 1

        # Update averages for remaining position
        self._update_avg()

        # If all layers closed, reset fully
        if not self.layers:
            logger.info(
                f"💰 {self.symbol} INVERSE TP COMPLETE | "
                f"{self._inverse_tp_layers_at_start}L fully unwound across "
                f"{zone_idx + 1} zones"
            )
            self._inverse_tp_active = False
            self._pending_order = False
            self._pending_exit = False
            self.last_entry_price = 0.0
            self.signals.reset_entry_tracking()
        else:
            logger.info(
                f"📊 {self.symbol} INVERSE TP: {len(self.layers)}L remaining | "
                f"avg_entry={self.avg_entry_price:.6f} ${self.total_notional:.2f} | "
                f"next zone={self._inverse_tp_next_idx}/{len(self._inverse_tp_zones)}"
            )
            self._pending_order = False

        # Emit strategy event
        self._update_recovery_debt(net_pnl)
        if self.config.log_jsonl and self.config.jsonl_path:
            self._write_trade_log(now, "inverse_tp", net_pnl, net_pnl_bps,
                                  self._inverse_tp_layers_at_start)

    def _close_all(self, now: float, reason: str, net_pnl: float, net_pnl_bps: float, min_net_bps: float = 0.0):
        """Close all layers."""
        n_layers = len(self.layers)
        exit_price = self.bid

        if self.is_live:
            # *** BLOCK immediately ***
            self._pending_exit = True
            self._pending_order = True  # Also block new entries
            self._pending_order_ts = time.time()
            self._enqueue_order({
                "action": "buy",
                "symbol": self.symbol,
                "qty": self.total_qty,
                "reason": reason,
                "n_layers": n_layers,
                "est_pnl_bps": net_pnl_bps,
                "est_pnl_usd": net_pnl,
                "bid": self.bid,
                "ask": self.ask,
                "signal_ts": now,
                "min_net_bps": float(min_net_bps),
            })
        else:
            # Paper trade: instant fill
            emoji = "💰" if net_pnl > 0 else "❌"
            logger.info(
                f"{emoji} {self.symbol} CLOSE {n_layers}L @ {exit_price:.6f} | "
                f"avg_entry {self.avg_entry_price:.6f} | "
                f"PnL {net_pnl_bps:+.1f}bps (${net_pnl:+.4f}) | "
                f"reason={reason}"
            )

            self._record_close(net_pnl, net_pnl_bps, now, reason, n_layers)
            self._reset_grid()

    # ─── Methods below have been extracted to mixins ──────────
    # EdgeMixin:        _fee_floor_bps, _symbol_notional_cap, _recovery_entry_hurdle_bps,
    #                   _recovery_exit_hurdle_bps, _expected_exit_slippage_bps,
    #                   _edge_uncertainty_penalty_bps, _has_sufficient_edge,
    #                   _duplicate_fill_ratio, _near_zero_close_ratio, _loss_reason_pressure
    # DynamicsMixin:    _spread_scaled_notional, _dynamic_entry_cooldown_sec,
    #                   _falling_knife_cooldown_mult, _averaging_min_spread,
    #                   _waterfall_score, _dynamic_layer_gap_bps, _dynamic_min_tp_profit_bps,
    #                   _dynamic_min_fast_tp_bps, _dynamic_max_layers, _effective_tp_mode,
    #                   _base_spacing_bps, _effective_spacing_growth, _tp_target_bps,
    #                   _update_vol_regime, _can_trade
    # RecoveryMixin:    _update_recovery_debt, set_recovery_stats, set_recovery_state,
    #                   export_recovery_state, _evict_recovery_add_events,
    #                   _record_recovery_add_event, _recovery_average_allowed,
    #                   recovery_velocity_bps_hr, recovery_mode, recovery_eta_hours,
    #                   _unrealized_bps, set_recovery_debt, set_entry_enabled,
    #                   sync_with_exchange_position, _reset_grid, _update_avg,
    #                   arm_context_rewarm, export_runtime_state, restore_runtime_state
    # FillHandlerMixin: on_sell_fill, on_buy_fill, on_external_close_fill,
    #                   drain_orders, _enqueue_order, _record_close,
    #                   _register_sell_fill_event, _register_close_behavior,
    #                   estimate_close_pnl, _unrealized_pnl_bps
    # TradeLogMixin:    _signal_snapshot, _emit_strategy_event,
    #                   _write_entry_log, _write_trade_log, status_dict
