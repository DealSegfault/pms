#!/usr/bin/env python3
"""
V7 MULTI-GRID RUNNER — Multi-pair short grid orchestrator.

Runs N GridTrader instances via a single combined Binance WebSocket.
Supports paper (default) and live (--live) modes.

Risk controls:
- Per-symbol: max_layers, circuit breaker, stop loss
- Portfolio: max_total_notional across all pairs

Lifecycle:
- Startup: sync existing positions from exchange → reconstruct grid state
- Running: poll order queue, execute via limit post-only, confirm fills
- Shutdown: cancel open orders → market close remaining → verify flat
"""
import asyncio
import json
import logging
import os
import re
import signal
import sqlite3
import sys
import time
import traceback
from collections import deque
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import redis as _redis_lib
except ImportError:
    _redis_lib = None

from bot.v7.pair_scorer import compute_pair_scores, format_score_dashboard

import websockets

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot.v7.grid_trader import GridTrader, GridConfig
from bot.v7.flow_metrics import SecondBucketFlow

# ── Extracted mixins ──
from bot.v7.orchestrator.persistence import PersistenceMixin
from bot.v7.orchestrator.telemetry import RunnerTelemetryMixin
from bot.v7.orchestrator.orders import OrderMixin

logger = logging.getLogger(__name__)

try:
    import orjson
except ImportError:
    orjson = None

BINANCE_FUTURES_STREAM = "wss://fstream.binance.com/stream"


@dataclass
class RunnerConfig:
    """Configuration for multi-grid runner."""
    top_n: int = 50
    min_change_pct: float = 3.0
    rotation_interval_sec: float = 600.0  # 0 = disabled
    symbols: Optional[List[str]] = None
    duration_sec: int = 0          # 0 = forever
    display_interval: float = 10.0
    display_enabled: bool = True
    log_dir: str = "./v7_sessions"
    session_id: str = ""
    live: bool = False
    blacklist: set = None          # Symbols to never trade (e.g. {'SIRENUSDT'})
    user_scope: str = ""           # Optional user/account namespace
    subaccount: str = ""           # Optional subaccount alias used for key routing
    account_scoped_storage: bool = True  # Isolate DB/log paths per account in live mode

    # Portfolio risk
    max_total_notional: float = 300.0  # $300 max across all pairs

    # Grid config (passed to each GridTrader)
    min_notional: float = 6.0
    max_notional: float = 30.0
    max_layers: int = 8
    max_symbol_notional: float = 0.0
    spacing_growth: float = 1.6
    size_growth: float = 1.0
    base_spacing_bps: float = 0.0
    trend_spacing_scale: float = 5.0
    vol_drift_enabled: bool = True
    candle_service_url: str = os.getenv("CANDLE_SERVICE_URL", "http://localhost:3003")
    vol_refresh_sec: float = 120.0
    vol_live_weight: float = 0.45
    vol_drift_min: float = 0.8
    vol_drift_max: float = 3.0
    vol_tail_mult: float = 2.2
    vol_tail_cooldown_sec: float = 20.0
    vol_tf_weights: Dict[str, float] = None
    vol_tf_lookbacks: Dict[str, str] = None
    min_spread_bps: float = 5.0
    max_spread_bps: float = 40.0
    pump_threshold: float = 2.0
    exhaust_threshold: float = 1.0
    tp_spread_mult: float = 1.2
    min_tp_profit_bps: float = 10.0
    tp_decay_half_life_min: float = 0.0
    tp_decay_floor: float = 0.5
    fast_tp_ti: float = -0.25
    tp_mode: str = "auto"              # auto | fast | vol — exit strategy mode

    stop_loss_bps: float = 0.0

    # Inverse grid TP
    inverse_tp_enabled: bool = True
    inverse_tp_min_layers: int = 3
    inverse_tp_max_zones: int = 5
    inverse_tp_time_cap_sec: float = 1800.0

    max_loss_bps: float = 500.0
    warmup_sec: float = 30.0
    resume_context_rewarm_sec: float = 30.0
    max_trend_bps: float = 5.0
    max_trend_30s_bps: float = 30.0
    max_buy_ratio: float = 1.0
    min_fast_tp_bps: float = -10.0
    loss_cooldown_sec: float = 8.0
    dynamic_behavior_enabled: bool = True
    behavior_lookback: int = 120
    min_edge_bps: float = 2.0
    edge_signal_slope_bps: float = 1.0
    edge_exec_buffer_bps: float = 0.3
    edge_default_slippage_bps: float = 0.5
    edge_uncertainty_z: float = 0.75
    edge_min_samples: int = 5
    waterfall_vol_threshold: float = 3.0
    waterfall_decay_sec: float = 30.0
    recovery_debt_enabled: bool = True
    recovery_paydown_ratio: float = 0.25
    recovery_max_paydown_bps: float = 25.0
    recovery_debt_cap_usd: float = 75.0
    recovery_db_path: str = "./v7_sessions/history.db"
    recovery_lookback_hours: float = 24.0
    recovery_avg_enabled: bool = True
    recovery_avg_min_unrealized_bps: float = 35.0
    recovery_avg_min_hurdle_improve_bps: float = 0.75
    recovery_avg_cooldown_sec: float = 20.0
    recovery_avg_max_adds_per_hour: int = 8
    recovery_state_sync_sec: float = 30.0
    runtime_state_enabled: bool = True
    runtime_state_sync_sec: float = 20.0
    strategy_event_logging: bool = True
    strategy_event_retention_days: float = 14.0
    strategy_event_include_payload: bool = False
    babysitter_enabled: bool = True
    adopt_orphan_positions: bool = True
    orphan_recovery_only: bool = False
    stealth_max_l1_fraction: float = 0.5
    stealth_max_ticks: int = 5
    stealth_always_split: bool = True
    stealth_min_slices: int = 2
    stealth_max_slices: int = 5

    keep_positions: bool = True    # If True, don't close positions on shutdown
    virtual_positions: Optional[List[Dict[str, Any]]] = None  # PMS virtual positions (babysitter)

    def __post_init__(self):
        if self.blacklist is None:
            self.blacklist = set()
        if self.vol_tf_weights is None:
            self.vol_tf_weights = {"1m": 0.5, "5m": 0.3, "15m": 0.2}
        if self.vol_tf_lookbacks is None:
            self.vol_tf_lookbacks = {"1m": "6h", "5m": "2d", "15m": "7d"}

class MultiGridRunner(PersistenceMixin, RunnerTelemetryMixin, OrderMixin):
    """
    Multi-pair grid trading orchestrator.

    Paper mode: instant simulated fills
    Live mode: routes orders through BinanceExecutor with execution truth
    """

    def __init__(self, config: RunnerConfig, executor=None):
        self.config = config
        self.executor = executor
        self.user_scope = self._resolve_user_scope()
        self.config.user_scope = self.user_scope
        self._babysitter_enabled = bool(self.config.babysitter_enabled)
        self._apply_account_scoped_storage()
        self.traders: Dict[str, GridTrader] = {}
        self.start_time: float = 0.0
        self._shutting_down: bool = False
        self._orders_ready: Optional[asyncio.Event] = None
        self.session_id: str = config.session_id or time.strftime("%Y%m%d_%H%M%S")
        self.config.session_id = self.session_id
        self._recovery_debt_cache: Dict[str, float] = {}
        self._recovery_store = None
        # Fire-and-forget entry tracking: order_id -> {symbol, trader, layer_idx, ref_price, ts, last_amend_ts, amend_count}
        self._pending_entries: Dict[str, dict] = {}
        # Active entry order per symbol: symbol -> order_id (enforce one at a time)
        self._active_entry_orders: Dict[str, str] = {}
        # Resting TP orders: symbol -> {order_id, price, qty, trader, ts}
        self._resting_tp_orders: Dict[str, dict] = {}
        # Global market speed / flow context (bounded 10m memory).
        self._global_flow = SecondBucketFlow(max_window_sec=600)
        self._symbol_last_trade_ts: Dict[str, float] = {}
        self._strategy_event_buffer: Deque[Dict[str, Any]] = deque(maxlen=20000)
        self._strategy_event_seq: int = 0
        self._last_strategy_prune_ts: float = 0.0
        # Pair rotation: track WS tasks spawned for rotated-in symbols
        self._rotation_ws_tasks: List[asyncio.Task] = []
        self._history_sync_svc = None
        # Virtual position tracking: raw_symbol → {id, symbol, side, entryPrice, quantity, notional}
        self._virtual_position_ids: Dict[str, dict] = {}

        # Redis price cache (shared with JS PMS risk engine)
        self._redis = None
        self._redis_failed = False
        try:
            if _redis_lib is not None:
                redis_host = os.environ.get('REDIS_HOST', '127.0.0.1')
                redis_port = int(os.environ.get('REDIS_PORT', '6379'))
                self._redis = _redis_lib.Redis(
                    host=redis_host, port=redis_port,
                    socket_connect_timeout=2, socket_timeout=1,
                    decode_responses=True,
                )
                self._redis.ping()
                logger.info(f'[Redis] Connected for price cache ({redis_host}:{redis_port})')
        except Exception as e:
            logger.warning(f'[Redis] Price cache unavailable: {e}')
            self._redis = None
            self._redis_failed = True

    @staticmethod
    def _sanitize_scope(value: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip().lower()).strip("-._")
        if len(cleaned) > 64:
            cleaned = cleaned[:64]
        return cleaned

    def _resolve_user_scope(self) -> str:
        candidates = [
            getattr(self.config, "user_scope", ""),
            getattr(self.config, "subaccount", ""),
            getattr(self.executor, "account_scope", ""),
        ]
        for raw in candidates:
            scoped = self._sanitize_scope(raw)
            if scoped:
                return scoped
        return "default"

    @staticmethod
    def _scope_file_path(path: str, scope: str) -> str:
        raw = str(path or "").strip()
        if not raw:
            return raw
        if "{scope}" in raw:
            return raw.replace("{scope}", scope)
        root, ext = os.path.splitext(raw)
        if root.endswith(f"_{scope}") or root.endswith(f"-{scope}") or root.endswith(f".{scope}"):
            return raw
        return f"{root}_{scope}{ext}"

    @staticmethod
    def _scope_dir_path(path: str, scope: str) -> str:
        raw = str(path or "").strip()
        if not raw:
            return raw
        if "{scope}" in raw:
            return raw.replace("{scope}", scope)
        parent = os.path.dirname(raw)
        base = os.path.basename(raw.rstrip("/")) or "v7_sessions"
        if base.endswith(f"_{scope}") or base.endswith(f"-{scope}") or base.endswith(f".{scope}"):
            return raw
        return os.path.join(parent, f"{base}_{scope}") if parent else f"{base}_{scope}"

    def _apply_account_scoped_storage(self) -> None:
        """
        Prevent cross-user state bleed by default in live mode.
        Uses executor/user scope suffix unless explicitly disabled.
        """
        if not (self.config.live and self.executor and self.config.account_scoped_storage):
            return
        scoped_db = self._scope_file_path(self.config.recovery_db_path, self.user_scope)
        scoped_log_dir = self._scope_dir_path(self.config.log_dir, self.user_scope)
        self.config.recovery_db_path = scoped_db
        self.config.log_dir = scoped_log_dir

    def _notify_orders_ready(self):
        """Wake order loop immediately when any trader queues an order."""
        if self._orders_ready and not self._orders_ready.is_set():
            self._orders_ready.set()

    @staticmethod
    def _loads_json(raw: str) -> dict:
        """Fast JSON parser for WS payloads with stdlib fallback."""
        if orjson is not None:
            return orjson.loads(raw)
        return json.loads(raw)

    def _portfolio_total_notional(self) -> float:
        """Total notional across all active positions."""
        return sum(t.total_notional for t in self.traders.values())

    def _portfolio_check(self, additional_notional: float) -> bool:
        """Check if we can add more notional to the portfolio."""
        current = self._portfolio_total_notional()
        return current + additional_notional <= self.config.max_total_notional

    def _evict_symbol_activity(self, now_ts: float) -> None:
        """Keep symbol activity map bounded to avoid long-run memory growth."""
        cutoff = now_ts - 1200.0  # retain only recently-active symbols
        stale = [sym for sym, last_ts in self._symbol_last_trade_ts.items() if last_ts < cutoff]
        for sym in stale:
            self._symbol_last_trade_ts.pop(sym, None)

    def _global_flow_snapshot(self, now_ts: Optional[float] = None) -> Dict[str, float]:
        """Global market-speed context across all streamed symbols."""
        now = float(now_ts if now_ts is not None else time.time())
        self._evict_symbol_activity(now)
        snap = self._global_flow.snapshot(now, prefix="global_")

        active_1s = 0
        active_5s = 0
        active_60s = 0
        for last_ts in self._symbol_last_trade_ts.values():
            age = now - last_ts
            if age <= 1.0:
                active_1s += 1
            if age <= 5.0:
                active_5s += 1
            if age <= 60.0:
                active_60s += 1

        tps_1s = float(snap.get("global_tps_1s", 0.0))
        tps_10s = float(snap.get("global_tps_10s", 0.0))
        tps_5s = float(snap.get("global_tps_5s", 0.0))
        tps_60s = float(snap.get("global_tps_60s", 0.0))

        snap["global_active_symbols_1s"] = float(active_1s)
        snap["global_active_symbols_5s"] = float(active_5s)
        snap["global_active_symbols_60s"] = float(active_60s)
        snap["global_speed_ratio_1s_10s"] = round(tps_1s / max(tps_10s, 1e-9), 6)
        snap["global_speed_ratio_5s_60s"] = round(tps_5s / max(tps_60s, 1e-9), 6)
        return snap

    def _external_snapshot_provider(self, symbol: str):
        """Per-trader callback to attach global market context to signal snapshots."""
        sym = symbol.upper()

        def provider() -> Dict[str, float]:
            now = time.time()
            snap = self._global_flow_snapshot(now)
            last_ts = float(self._symbol_last_trade_ts.get(sym, 0.0))
            idle_sec = max(now - last_ts, 0.0) if last_ts > 0 else 9999.0
            snap["symbol_idle_sec"] = round(idle_sec, 6)
            snap["symbol_active_1s"] = 1.0 if idle_sec <= 1.0 else 0.0
            snap["symbol_active_5s"] = 1.0 if idle_sec <= 5.0 else 0.0
            return snap

        return provider


    # ─── Methods below have been extracted to orchestrator mixins ──────────
    # PersistenceMixin:     _get_recovery_store, _scoped_state_key, _recovery_state_key,
    #                       _load_persisted_recovery_state, _persist_recovery_state,
    #                       _persist_recovery_states_once, _runtime_state_key,
    #                       _load_persisted_runtime_state, _persist_runtime_state,
    #                       _persist_runtime_states_once, _persist_session_config,
    #                       _load_session_config, _estimate_layer_count,
    #                       _load_initial_recovery_debt, _seed_recovery_debt,
    #                       _seed_recovery_stats, _seed_runtime_state
    # RunnerTelemetryMixin: _extract_signal_subset, _strategy_event_sink,
    #                       _flush_strategy_events_once, _layers_match_exchange,
    #                       _display_loop, _final_summary
    # OrderMixin:           _order_loop, _on_order_update, _handle_entry_fill,
    #                       _handle_tp_fill, _schedule_tp_order, _place_tp_order,
    #                       _cancel_tp_order, _manage_resting_entries,
    #                       _manage_resting_tp_orders, _close_virtual_position,
    #                       _execute_order


    def _make_grid_config(self, symbol: str) -> GridConfig:
        """Create GridConfig for one symbol."""
        return GridConfig(
            symbol=symbol,
            min_notional=self.config.min_notional,
            max_notional=self.config.max_notional,
            max_layers=self.config.max_layers,
            max_symbol_notional=self.config.max_symbol_notional,
            spacing_growth=self.config.spacing_growth,
            size_growth=self.config.size_growth,
            base_spacing_bps=self.config.base_spacing_bps,
            trend_spacing_scale=self.config.trend_spacing_scale,
            vol_drift_enabled=self.config.vol_drift_enabled,
            candle_service_url=self.config.candle_service_url,
            vol_refresh_sec=self.config.vol_refresh_sec,
            vol_live_weight=self.config.vol_live_weight,
            vol_drift_min=self.config.vol_drift_min,
            vol_drift_max=self.config.vol_drift_max,
            vol_tail_mult=self.config.vol_tail_mult,
            vol_tail_cooldown_sec=self.config.vol_tail_cooldown_sec,
            vol_tf_weights=self.config.vol_tf_weights,
            vol_tf_lookbacks=self.config.vol_tf_lookbacks,
            min_spread_bps=self.config.min_spread_bps,
            max_spread_bps=self.config.max_spread_bps,
            pump_threshold=self.config.pump_threshold,
            exhaust_threshold=self.config.exhaust_threshold,
            tp_spread_mult=self.config.tp_spread_mult,
            min_tp_profit_bps=self.config.min_tp_profit_bps,
            tp_decay_half_life_min=self.config.tp_decay_half_life_min,
            tp_decay_floor=self.config.tp_decay_floor,
            fast_tp_ti=self.config.fast_tp_ti,
            tp_mode=getattr(self.config, 'tp_mode', 'auto'),

            stop_loss_bps=self.config.stop_loss_bps,
            max_loss_bps=self.config.max_loss_bps,
            warmup_sec=self.config.warmup_sec,
            resume_context_rewarm_sec=self.config.resume_context_rewarm_sec,
            max_trend_bps=self.config.max_trend_bps,
            max_trend_30s_bps=self.config.max_trend_30s_bps,
            max_buy_ratio=self.config.max_buy_ratio,
            min_fast_tp_bps=self.config.min_fast_tp_bps,
            loss_cooldown_sec=self.config.loss_cooldown_sec,
            dynamic_behavior_enabled=self.config.dynamic_behavior_enabled,
            behavior_lookback=self.config.behavior_lookback,
            min_edge_bps=self.config.min_edge_bps,
            edge_signal_slope_bps=self.config.edge_signal_slope_bps,
            edge_exec_buffer_bps=self.config.edge_exec_buffer_bps,
            edge_default_slippage_bps=self.config.edge_default_slippage_bps,
            edge_uncertainty_z=self.config.edge_uncertainty_z,
            edge_min_samples=self.config.edge_min_samples,
            waterfall_vol_threshold=self.config.waterfall_vol_threshold,
            waterfall_decay_sec=self.config.waterfall_decay_sec,
            recovery_debt_enabled=self.config.recovery_debt_enabled,
            recovery_paydown_ratio=self.config.recovery_paydown_ratio,
            recovery_max_paydown_bps=self.config.recovery_max_paydown_bps,
            recovery_debt_cap_usd=self.config.recovery_debt_cap_usd,
            recovery_avg_enabled=self.config.recovery_avg_enabled,
            recovery_avg_min_unrealized_bps=self.config.recovery_avg_min_unrealized_bps,
            recovery_avg_min_hurdle_improve_bps=self.config.recovery_avg_min_hurdle_improve_bps,
            recovery_avg_cooldown_sec=self.config.recovery_avg_cooldown_sec,
            recovery_avg_max_adds_per_hour=self.config.recovery_avg_max_adds_per_hour,
            stealth_max_l1_fraction=self.config.stealth_max_l1_fraction,
            stealth_max_ticks=self.config.stealth_max_ticks,
            stealth_always_split=self.config.stealth_always_split,
            stealth_min_slices=self.config.stealth_min_slices,
            stealth_max_slices=self.config.stealth_max_slices,
            inverse_tp_enabled=self.config.inverse_tp_enabled,
            inverse_tp_min_layers=self.config.inverse_tp_min_layers,
            inverse_tp_max_zones=self.config.inverse_tp_max_zones,
            inverse_tp_time_cap_sec=self.config.inverse_tp_time_cap_sec,
            live=self.config.live,
            log_jsonl=True,
            jsonl_path=os.path.join(
                self.config.log_dir,
                f"v7_{symbol}_{self.session_id}.jsonl"
            ),
        )

    async def scan_pairs(self) -> List[str]:
        """Use V5 hot scanner to find volatile pairs."""
        try:
            from v5.hot_scanner import scan_hot_symbols
            symbols = await scan_hot_symbols(
                top_n=self.config.top_n,
                min_return_pct=self.config.min_change_pct,
            )
            return [s.upper() for s in symbols if s.upper() not in self.config.blacklist]
        except Exception as e:
            logger.error(f"Scanner failed: {e}")
            return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]

    async def _pair_rotation_loop(self, stop: asyncio.Event):
        """Periodically rescan hot pairs, add new ones, drop cold flat ones."""
        interval = self.config.rotation_interval_sec
        if interval <= 0:
            return

        while not stop.is_set():
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break
            if stop.is_set() or self._shutting_down:
                break

            try:
                fresh = await self.scan_pairs()
                if not fresh:
                    continue

                current = set(self.traders.keys())
                fresh_set = set(fresh)

                # ── New symbols to add ──
                new_symbols = [s for s in fresh if s not in current]

                # ── Cold symbols to drop (only if flat) ──
                dropped = []
                for sym in list(current - fresh_set):
                    trader = self.traders.get(sym)
                    if not trader:
                        continue
                    # Never drop symbols with open positions
                    if trader.layers:
                        continue
                    # Never drop symbols with pending entries
                    if self._active_entry_orders.get(sym):
                        continue
                    # Never drop symbols with resting TPs
                    if self._resting_tp_orders.get(sym):
                        continue
                    # Never drop symbols that have traded (keep for stats)
                    if trader.total_trades > 0:
                        continue
                    # Safe to drop
                    del self.traders[sym]
                    self._symbol_last_trade_ts.pop(sym, None)
                    dropped.append(sym)

                # ── Add new symbols ──
                added = []
                for sym in new_symbols:
                    cfg = self._make_grid_config(sym)
                    trader = GridTrader(
                        cfg,
                        executor=self.executor,
                        portfolio_check=self._portfolio_check,
                        order_notify=self._notify_orders_ready,
                        external_snapshot_provider=self._external_snapshot_provider(sym),
                        event_sink=self._strategy_event_sink,
                    )
                    self._seed_recovery_debt(trader, sym)
                    self._seed_recovery_stats(trader, sym)
                    self._seed_runtime_state(trader, sym)
                    self.traders[sym] = trader
                    added.append(sym)

                    # Set leverage for live mode
                    if self.executor and self.config.live:
                        try:
                            await self.executor.set_leverage(sym, leverage=1)
                        except Exception:
                            pass

                # Spawn WS task for new batch
                if added:
                    task = asyncio.create_task(self._ws_loop(added, stop))
                    self._rotation_ws_tasks.append(task)

                if added or dropped:
                    logger.info(
                        f"📡 Rotation: +{len(added)} added, -{len(dropped)} dropped, "
                        f"{len(self.traders)} active"
                    )
                    if added:
                        logger.info(f"   ➕ {', '.join(added[:10])}{'…' if len(added) > 10 else ''}")
                    if dropped:
                        logger.info(f"   ➖ {', '.join(dropped[:10])}{'…' if len(dropped) > 10 else ''}")
                else:
                    logger.info(f"📡 Rotation: no changes, {len(self.traders)} active")

            except Exception as e:
                logger.error(f"Pair rotation error: {e}")

    def _build_ws_url(self, symbols: List[str]) -> str:
        """Combined streams: bookTicker + aggTrade for each symbol."""
        streams = []
        for sym in symbols:
            s = sym.lower()
            streams.append(f"{s}@bookTicker")
            streams.append(f"{s}@aggTrade")
        return f"{BINANCE_FUTURES_STREAM}?streams={'/'.join(streams)}"

    def _dispatch(self, raw: str):
        """Route WebSocket message to the right GridTrader."""
        try:
            msg = self._loads_json(raw)
            stream = msg.get("stream", "")
            payload = msg.get("data", msg)

            symbol_key, sep, channel = stream.partition("@")
            if not sep:
                return

            trader = self.traders.get(symbol_key.upper())
            if trader is None:
                return
            now = time.time()

            if channel == "bookTicker":
                bid = float(payload.get("b", 0))
                ask = float(payload.get("a", 0))
                bid_qty = float(payload.get("B", 0))
                ask_qty = float(payload.get("A", 0))
                ts = float(payload.get("E", now * 1000)) / 1000.0
                trader.on_book(bid, ask, bid_qty, ask_qty, ts)

                # Write mid-price to Redis (shared with JS PMS risk engine)
                if self._redis and bid > 0 and ask > 0:
                    mid = (bid + ask) / 2
                    pms_symbol = f"{symbol_key.upper().replace('USDT', '')}/USDT:USDT"
                    try:
                        self._redis.set(
                            f"pms:price:{pms_symbol}",
                            json.dumps({"mark": mid, "ts": int(now * 1000), "source": "py"}),
                            ex=30,
                        )
                    except Exception:
                        pass

            elif channel == "aggTrade":
                price = float(payload["p"])
                qty = float(payload["q"])
                is_buyer_maker = payload.get("m", False)
                ts = float(payload["E"]) / 1000.0
                self._global_flow.add(ts, qty, price, bool(is_buyer_maker))
                sym_upper = symbol_key.upper()
                self._symbol_last_trade_ts[sym_upper] = ts
                trader.on_trade(price, qty, is_buyer_maker, ts)

        except Exception:
            pass

    async def _ws_loop(self, symbols: List[str], stop: asyncio.Event):
        """WebSocket connection with auto-reconnect."""
        url = self._build_ws_url(symbols)

        while not stop.is_set():
            try:
                async with websockets.connect(
                    url, ping_interval=30, ping_timeout=30, max_size=10_000_000,
                ) as ws:
                    logger.info(f"✓ Connected to {len(symbols)} pairs")

                    async for message in ws:
                        if stop.is_set():
                            break
                        self._dispatch(message)

            except Exception as e:
                logger.error(f"WS error: {e}")
                if not stop.is_set():
                    await asyncio.sleep(3)

    # ─── Live sync: resume from existing positions ────────────

    async def _sync_live_positions(self) -> List[str]:
        """
        On startup, fetch exchange positions and reconstruct grid state.
        This allows resuming after a restart without losing track of positions.
        """
        adopted_symbols: List[str] = []
        if not self.executor:
            return adopted_symbols

        positions = await self.executor.get_positions()
        if not positions:
            logger.info("  ✅ No existing positions to sync")
            for raw_symbol, trader in self.traders.items():
                if trader.layers:
                    trader.sync_with_exchange_position(0.0, 0.0, source="startup_sync_flat")
                    self._persist_runtime_state(raw_symbol, trader)
            return adopted_symbols

        synced = 0
        for ccxt_sym, pos in positions.items():
            # Convert ccxt symbol "BASE/USDT:USDT" to raw "BASEUSDT"
            raw = ccxt_sym.replace("/USDT:USDT", "USDT").replace("/", "")
            side = str(pos.get("side", ""))
            contracts = float(pos.get("contracts", 0) or 0)
            entry_price = float(pos.get("entryPrice", 0) or 0)
            notional = abs(float(pos.get("notional", 0) or 0))

            if side != "short" or contracts <= 0 or entry_price <= 0:
                logger.warning(f"  ⚠️  {raw} is {side} — not a short, skipping")
                continue

            if raw not in self.traders:
                if not self.config.adopt_orphan_positions:
                    logger.warning(
                        f"  ⚠️  Existing position {raw} ({side} {contracts}) — not in trader set, skipping"
                    )
                    continue

                cfg = self._make_grid_config(raw)
                trader = GridTrader(
                    cfg,
                    executor=self.executor,
                    portfolio_check=self._portfolio_check,
                    order_notify=self._notify_orders_ready,
                    external_snapshot_provider=self._external_snapshot_provider(raw),
                    event_sink=self._strategy_event_sink,
                )
                if self.config.orphan_recovery_only:
                    trader.set_entry_enabled(False, source="orphan_adopt")
                self._seed_recovery_debt(trader, raw)
                self._seed_recovery_stats(trader, raw)
                self._seed_runtime_state(trader, raw)
                if self.config.orphan_recovery_only:
                    trader.set_entry_enabled(False, source="orphan_adopt_restore")
                self.traders[raw] = trader
                adopted_symbols.append(raw)
                logger.warning(
                    f"  🧩 Adopted orphan position {raw} ({contracts:.4f} short) into recovery management"
                )

            trader = self.traders[raw]

            if self._layers_match_exchange(trader, contracts, entry_price):
                synced += 1
                logger.info(
                    f"  🧠 Runtime context kept for {raw}: {len(trader.layers)}L, "
                    f"{contracts:.4f} @ {entry_price:.6f} (${notional:.2f})"
                )
            else:
                # Exchange truth wins when persisted layer stack is stale/divergent.
                # Estimate layer count from notional so inverse TP can activate correctly.
                est_layers = self._estimate_layer_count(notional)
                trader.sync_with_exchange_position(contracts, entry_price, source="startup_sync", est_layers=est_layers)
                synced += 1
                logger.info(
                    f"  🔄 Synced {raw}: {contracts:.4f} @ {entry_price:.6f} "
                    f"(${notional:.2f}, ~{est_layers}L estimated, uPnL: ${pos['unrealizedPnl']:+.4f})"
                )
            self._persist_runtime_state(raw, trader)

        # Clear stale local runtime layers that no longer exist on exchange.
        short_symbols = {
            ccxt_sym.replace("/USDT:USDT", "USDT").replace("/", "")
            for ccxt_sym, pos in positions.items()
            if str(pos.get("side", "")) == "short"
            and float(pos.get("contracts", 0) or 0) > 0
            and float(pos.get("entryPrice", 0) or 0) > 0
        }
        for raw_symbol, trader in self.traders.items():
            if raw_symbol not in short_symbols and trader.layers:
                trader.sync_with_exchange_position(0.0, 0.0, source="startup_sync_flat")
                self._persist_runtime_state(raw_symbol, trader)

        if synced > 0:
            logger.info(f"  ✅ Synced {synced} existing position(s) into grid state")
        return adopted_symbols

    def _sync_virtual_positions(self) -> List[str]:
        """
        Adopt PMS virtual positions into the runner's trader map.
        These are positions tracked by the PMS (Node.js) that don't exist on
        the real exchange — the babysitter monitors them for TP and closes
        them via the PMS REST API.
        Returns list of newly adopted raw symbols.
        """
        vps = getattr(self.config, 'virtual_positions', None) or []
        if not vps:
            return []

        adopted: List[str] = []
        # Initialize _virtual_position_ids if not already done (e.g., in __init__)
        if not hasattr(self, '_virtual_position_ids'):
            self._virtual_position_ids = {}

        for vp in vps:
            if not isinstance(vp, dict):
                continue
            pms_symbol = str(vp.get('symbol', '')).strip()
            side = str(vp.get('side', '')).upper()
            entry_price = float(vp.get('entryPrice', 0) or 0)
            quantity = float(vp.get('quantity', 0) or 0)
            notional = float(vp.get('notional', 0) or 0)
            vp_id = str(vp.get('id', ''))

            if not pms_symbol or entry_price <= 0 or quantity <= 0:
                continue

            # Convert PMS symbol (BTC/USDT:USDT) to raw (BTCUSDT)
            raw = pms_symbol.replace('/USDT:USDT', 'USDT').replace('/', '')

            # Skip if a real exchange position already occupies this symbol
            if raw in self.traders and self.traders[raw].layers:
                logger.info(f"  ⏭️ {raw} already has live layers — skipping virtual adoption")
                self._virtual_position_ids[raw] = vp
                continue

            # Create GridTrader for this virtual position
            if raw not in self.traders:
                cfg = self._make_grid_config(raw)
                trader = GridTrader(
                    cfg,
                    executor=self.executor,
                    portfolio_check=self._portfolio_check,
                    order_notify=self._notify_orders_ready,
                    external_snapshot_provider=self._external_snapshot_provider(raw),
                    event_sink=self._strategy_event_sink,
                )
                # Disable entries — babysitter is exit-only
                trader.set_entry_enabled(False, source="virtual_adopt")
                self._seed_recovery_debt(trader, raw)
                self._seed_recovery_stats(trader, raw)
                self._seed_runtime_state(trader, raw)
                self.traders[raw] = trader

            trader = self.traders[raw]

            # Inject position state so TP signals can evaluate against it
            est_layers = self._estimate_layer_count(notional)
            trader.sync_with_exchange_position(
                quantity,
                entry_price,
                source="virtual_pms",
                est_layers=est_layers,
            )

            # Track for PMS close callback
            self._virtual_position_ids[raw] = vp
            adopted.append(raw)
            logger.info(
                f"  🌐 Adopted virtual {raw}: {quantity:.6f} @ {entry_price:.6f} "
                f"(${notional:.2f}, ~{est_layers}L, id={vp_id[:8]}…)"
            )

        if adopted:
            logger.info(f"  ✅ Adopted {len(adopted)} virtual position(s) from PMS")
        return adopted

    def _position_snapshot_for(self, positions: Dict[str, dict], raw_symbol: str) -> Tuple[float, float]:
        """Return (short_qty, entry_price) for a tracked raw symbol from exchange positions."""
        if not self.executor:
            return 0.0, 0.0
        ccxt_sym = self.executor._to_ccxt_symbol(raw_symbol)
        pos = positions.get(ccxt_sym)
        if not pos:
            return 0.0, 0.0
        side = str(pos.get("side", ""))
        qty = float(pos.get("contracts", 0) or 0)
        entry = float(pos.get("entryPrice", 0) or 0)
        if side != "short" or qty <= 0 or entry <= 0:
            return 0.0, 0.0
        return qty, entry

    async def _sync_trader_from_exchange(self, trader: GridTrader, raw_symbol: str, source: str):
        """Force one trader to match exchange truth for that symbol."""
        if not self.executor:
            return
        positions = await self.executor.get_positions()
        qty, entry = self._position_snapshot_for(positions, raw_symbol)
        trader.sync_with_exchange_position(qty, entry, source=source)
        self._persist_runtime_state(raw_symbol, trader)

    def set_babysitter_enabled(self, enabled: bool, source: str = "manual") -> None:
        self._babysitter_enabled = bool(enabled)
        self.config.babysitter_enabled = self._babysitter_enabled
        mode = "enabled" if self._babysitter_enabled else "disabled"
        logger.info("🧯 Babysitter %s (%s)", mode, source)

    async def _reconcile_positions_once(self):
        """Periodic truth sync: if local state diverges from exchange, adopt exchange state."""
        if not self.executor or self._shutting_down or not self._babysitter_enabled:
            return

        positions = await self.executor.get_positions()
        for raw_symbol, trader in self.traders.items():
            # Skip symbols with in-flight orders to avoid reconciling transient states.
            if trader._pending_order or trader._pending_exit:
                continue

            ex_qty, ex_entry = self._position_snapshot_for(positions, raw_symbol)
            local_qty = trader.total_qty if trader.layers else 0.0

            qty_tol = max(1e-6, 0.02 * max(local_qty, ex_qty))
            qty_mismatch = abs(local_qty - ex_qty) > qty_tol

            entry_mismatch = False
            if ex_qty > 0 and trader.layers and trader.avg_entry_price > 0:
                entry_mismatch = abs(trader.avg_entry_price - ex_entry) / ex_entry > 0.01

            if not qty_mismatch and not entry_mismatch:
                continue

            if ex_qty <= 0 < local_qty:
                logger.warning(
                    f"🔍 Reconcile {raw_symbol}: local has {local_qty:.6f}, exchange flat -> clearing local grid"
                )
            elif ex_qty > 0 and local_qty <= 0:
                logger.warning(
                    f"🔍 Reconcile {raw_symbol}: exchange has {ex_qty:.6f} @ {ex_entry:.6f}, local flat -> adopting"
                )
            else:
                logger.warning(
                    f"🔍 Reconcile {raw_symbol}: qty local={local_qty:.6f} vs exchange={ex_qty:.6f} "
                    f"(entry exchange {ex_entry:.6f}) -> adopting"
                )

            trader.sync_with_exchange_position(ex_qty, ex_entry, source="reconcile")
            self._persist_runtime_state(raw_symbol, trader)

    async def _reconcile_loop(self, stop: asyncio.Event):
        """Run periodic reconciliation while live trading."""
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass

            if stop.is_set() or self._shutting_down:
                break
            if not self._babysitter_enabled:
                continue

            try:
                await self._reconcile_positions_once()
            except Exception as e:
                logger.warning(f"Position reconcile failed: {e}")


    async def _recovery_state_loop(self, stop: asyncio.Event):
        """Periodic persistence loop for recovery/runtime state and strategy events."""
        recovery_interval = max(float(self.config.recovery_state_sync_sec), 5.0) if self.config.recovery_state_sync_sec > 0 else 0.0
        runtime_interval = max(float(self.config.runtime_state_sync_sec), 5.0) if self.config.runtime_state_enabled else 0.0
        event_interval = 5.0 if self.config.strategy_event_logging else 0.0
        intervals = [x for x in (recovery_interval, runtime_interval, event_interval) if x > 0]
        interval = min(intervals) if intervals else 10.0

        last_recovery_sync = 0.0
        last_runtime_sync = 0.0
        last_event_flush = 0.0

        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
            if stop.is_set() or self._shutting_down:
                break
            now = time.time()
            if recovery_interval > 0 and (now - last_recovery_sync) >= recovery_interval:
                self._persist_recovery_states_once()
                last_recovery_sync = now
            if runtime_interval > 0 and (now - last_runtime_sync) >= runtime_interval:
                self._persist_runtime_states_once()
                last_runtime_sync = now
            if event_interval > 0 and (now - last_event_flush) >= event_interval:
                self._flush_strategy_events_once()
                last_event_flush = now


    # ─── Live order execution ─────────────────────────────────


    # ─── Methods below have been extracted to orchestrator mixins ──────────
    # PersistenceMixin:     _get_recovery_store, _scoped_state_key, _recovery_state_key,
    #                       _load_persisted_recovery_state, _persist_recovery_state,
    #                       _persist_recovery_states_once, _runtime_state_key,
    #                       _load_persisted_runtime_state, _persist_runtime_state,
    #                       _persist_runtime_states_once, _persist_session_config,
    #                       _load_session_config, _estimate_layer_count,
    #                       _load_initial_recovery_debt, _seed_recovery_debt,
    #                       _seed_recovery_stats, _seed_runtime_state
    # RunnerTelemetryMixin: _extract_signal_subset, _strategy_event_sink,
    #                       _flush_strategy_events_once, _layers_match_exchange,
    #                       _display_loop, _final_summary
    # OrderMixin:           _order_loop, _on_order_update, _handle_entry_fill,
    #                       _handle_tp_fill, _schedule_tp_order, _place_tp_order,
    #                       _cancel_tp_order, _manage_resting_entries,
    #                       _manage_resting_tp_orders, _close_virtual_position,
    #                       _execute_order


    # ─── Graceful shutdown ────────────────────────────────────

    async def _graceful_shutdown(self):
        """
        Proper shutdown sequence:
        1. Stop accepting new orders
        2. Cancel all open/pending limit orders
        3. Wait for stragglers
        4. Close ALL exchange positions for tracked symbols
        5. Verify flat (re-close any orphans from race conditions)
        """
        self._shutting_down = True
        logger.info("\n🧹 SHUTDOWN SEQUENCE:")

        # Step 0: Cancel all fire-and-forget pending entries
        if self._pending_entries:
            logger.info(f"  0️⃣  Cancelling {len(self._pending_entries)} pending fire-and-forget entry/entries")
            for oid, entry in list(self._pending_entries.items()):
                sym = entry['symbol']
                try:
                    await self.executor.cancel_order(oid, sym)
                    logger.info(f"     ✗ {sym} cancelled entry {oid[:8]}…")
                except Exception:
                    pass
                entry['trader']._pending_order = False
            self._pending_entries.clear()
            self._active_entry_orders.clear()

        # Cancel all resting TP orders
        if self._resting_tp_orders:
            logger.info(f"  0️⃣  Cancelling {len(self._resting_tp_orders)} resting TP order(s)")
            for sym, tp in list(self._resting_tp_orders.items()):
                if tp.get('order_id'):
                    try:
                        await self.executor.cancel_order(tp['order_id'], sym)
                        logger.info(f"     ✗ {sym} cancelled TP {tp['order_id'][:8]}…")
                    except Exception:
                        pass
            self._resting_tp_orders.clear()

        # Step 1: Cancel all tracked open orders
        cancelled = await self.executor.cancel_all_tracked_orders()
        if cancelled:
            logger.info(f"  1️⃣  Cancelled {cancelled} tracked open order(s)")

        # Cancel all orders on each symbol (belt + suspenders)
        for sym in self.traders:
            n = await self.executor.cancel_all_symbol_orders(sym)
            if n:
                logger.info(f"     + Cancelled {n} resting order(s) on {sym}")

        # No waiting for stragglers — exit immediately

        # If keep_positions is set, skip closing — just leave them on exchange
        if self.config.keep_positions:
            positions = await self.executor.get_positions()
            tracked_syms = {}
            for sym in self.traders:
                tracked_syms[self.executor._to_ccxt_symbol(sym)] = sym
            open_pos = {tracked_syms[s]: p for s, p in positions.items()
                        if s in tracked_syms and p['contracts'] > 0}
            if open_pos:
                logger.info(f"  🔒 Keeping {len(open_pos)} position(s) open (--keep-positions):")
                for sym, pos in open_pos.items():
                    logger.info(f"     {sym}: {pos['contracts']} contracts, "
                                f"side={pos['side']}, uPnL=${pos['unrealizedPnl']:+.4f}")
            else:
                logger.info("  ✅ No open positions to keep.")
            return

        # Step 3: Close ALL exchange positions for our symbols (not just grid state)
        closed = 0
        positions = await self.executor.get_positions()
        tracked_syms = {}
        for sym in self.traders:
            tracked_syms[self.executor._to_ccxt_symbol(sym)] = sym

        for ccxt_sym, pos in positions.items():
            if ccxt_sym not in tracked_syms:
                continue
            raw_sym = tracked_syms[ccxt_sym]
            # Skip blacklisted symbols — let them be
            if raw_sym in self.config.blacklist:
                logger.info(f"  🚫 Skipping blacklisted {raw_sym} ({pos['contracts']} contracts)")
                continue
            contracts = pos['contracts']
            if contracts > 0 and pos['side'] == 'short':
                logger.info(f"  3️⃣  Closing {raw_sym} ({contracts} contracts, uPnL: ${pos['unrealizedPnl']:+.4f})")
                fill = await self.executor.market_buy(raw_sym, contracts)
                if fill:
                    trader = self.traders.get(raw_sym)
                    if trader and trader.layers:
                        trader.on_buy_fill(fill.avg_price, fill.qty, fill.order_id, fill.fee, "shutdown")
                    closed += 1
                else:
                    logger.error(f"     ❌ Failed to close {raw_sym} — MANUAL INTERVENTION NEEDED")

        # Step 4: Re-verify — close any orphans from race conditions
        logger.info("  4️⃣  Verifying positions...")
        positions = await self.executor.get_positions()
        remaining = {s: p for s, p in positions.items() if s in tracked_syms}
        if remaining:
            logger.warning(f"  ⚠️  {len(remaining)} orphan(s) — closing:")
            for sym, pos in remaining.items():
                raw = tracked_syms[sym]
                logger.warning(f"     Closing {raw}: {pos['contracts']}")
                await self.executor.market_buy(raw, pos['contracts'])
            # Final check
            positions = await self.executor.get_positions()
            remaining = {s: p for s, p in positions.items() if s in tracked_syms}

        if not remaining:
            logger.info(f"  ✅ All tracked positions flat. Closed {closed} position(s).")
        else:
            logger.error(f"  ❌ {len(remaining)} position(s) STILL OPEN after shutdown!")

    # ─── Dashboard ────────────────────────────────────────────


    # ─── Methods below have been extracted to orchestrator mixins ──────────
    # PersistenceMixin:     _get_recovery_store, _scoped_state_key, _recovery_state_key,
    #                       _load_persisted_recovery_state, _persist_recovery_state,
    #                       _persist_recovery_states_once, _runtime_state_key,
    #                       _load_persisted_runtime_state, _persist_runtime_state,
    #                       _persist_runtime_states_once, _persist_session_config,
    #                       _load_session_config, _estimate_layer_count,
    #                       _load_initial_recovery_debt, _seed_recovery_debt,
    #                       _seed_recovery_stats, _seed_runtime_state
    # RunnerTelemetryMixin: _extract_signal_subset, _strategy_event_sink,
    #                       _flush_strategy_events_once, _layers_match_exchange,
    #                       _display_loop, _final_summary
    # OrderMixin:           _order_loop, _on_order_update, _handle_entry_fill,
    #                       _handle_tp_fill, _schedule_tp_order, _place_tp_order,
    #                       _cancel_tp_order, _manage_resting_entries,
    #                       _manage_resting_tp_orders, _close_virtual_position,
    #                       _execute_order


    async def run(self, stop: asyncio.Event):
        """Main entry point."""
        self.start_time = time.time()

        # Get symbols
        if self.config.symbols:
            symbols = self.config.symbols
        else:
            symbols = await self.scan_pairs()

        if not symbols:
            logger.error("No symbols found!")
            return

        # Filter out blacklisted symbols
        if self.config.blacklist:
            before = len(symbols)
            symbols = [s for s in symbols if s not in self.config.blacklist]
            if len(symbols) < before:
                logger.info(f"  🚫 Blacklist removed {before - len(symbols)} symbol(s): {self.config.blacklist}")

        # Create log dir
        os.makedirs(self.config.log_dir, exist_ok=True)

        # In live mode: set leverage 1x for all symbols
        if self.executor and self.config.live:
            logger.info("Setting leverage 1x for all symbols...")
            for sym in symbols:
                await self.executor.set_leverage(sym, leverage=1)

        # Spawn traders
        mode_str = "📡 LIVE" if self.config.live else "📝 PAPER"
        logger.info(f"\n🚀 Starting {len(symbols)} grid traders ({mode_str})...")
        logger.info(f"  Scope: {self.user_scope}")
        logger.info(f"  Portfolio cap: ${self.config.max_total_notional:.0f}")
        logger.info(f"  Per symbol: max {self.config.max_layers}L × ${self.config.min_notional:.0f} = ${self.config.max_layers * self.config.min_notional:.0f}")
        logger.info(f"  Babysitter: {'ON' if self._babysitter_enabled else 'OFF'}")
        if self.config.live:
            logger.info(f"  Recovery DB: {self.config.recovery_db_path}")
        for sym in symbols:
            cfg = self._make_grid_config(sym)
            trader = GridTrader(
                cfg,
                executor=self.executor,
                portfolio_check=self._portfolio_check,
                order_notify=self._notify_orders_ready,
                external_snapshot_provider=self._external_snapshot_provider(sym),
                event_sink=self._strategy_event_sink,
            )
            self._seed_recovery_debt(trader, sym)
            self._seed_recovery_stats(trader, sym)
            self._seed_runtime_state(trader, sym)
            self.traders[sym] = trader
            logger.info(f"  ✓ {sym}")

        # Persist session config for layer estimation on future restarts
        self._persist_session_config()
        logger.info(f"  💾 Session config saved (min=${self.config.min_notional:.0f}, max=${self.config.max_notional:.0f}, growth={self.config.size_growth}×)")

        # Live: sync existing exchange positions into grid state
        if self.executor and self.config.live:
            logger.info("\n🔄 Syncing existing positions...")
            adopted = await self._sync_live_positions()
            if adopted:
                for sym in adopted:
                    if sym not in symbols:
                        symbols.append(sym)
                    await self.executor.set_leverage(sym, leverage=1)
                logger.info(f"  🧩 Added {len(adopted)} orphan symbol(s) to live streams: {adopted}")

        # Adopt PMS virtual positions (babysitter mode)
        vp_adopted = self._sync_virtual_positions()
        if vp_adopted:
            for sym in vp_adopted:
                if sym not in symbols:
                    symbols.append(sym)
            logger.info(f"  🌐 Added {len(vp_adopted)} virtual symbol(s) to live streams: {vp_adopted}")

        # WS + tasks
        self._orders_ready = asyncio.Event()

        chunk_size = 100
        chunks = [symbols[i:i+chunk_size] for i in range(0, len(symbols), chunk_size)]

        tasks = []
        for chunk in chunks:
            tasks.append(asyncio.create_task(self._ws_loop(chunk, stop)))
        tasks.append(asyncio.create_task(self._display_loop(stop)))

        if self.config.live and self.executor:
            tasks.append(asyncio.create_task(self._order_loop(stop)))
            tasks.append(asyncio.create_task(self._reconcile_loop(stop)))
            tasks.append(asyncio.create_task(self._manage_resting_entries(stop)))
            tasks.append(asyncio.create_task(self._manage_resting_tp_orders(stop)))

            if (
                self.config.recovery_state_sync_sec > 0
                or self.config.runtime_state_enabled
                or self.config.strategy_event_logging
            ):
                tasks.append(asyncio.create_task(self._recovery_state_loop(stop)))
            # Register fire-and-forget fill callback
            self.executor.on_order_update = self._on_order_update
            # Start user data stream for real-time fill detection
            await self.executor.start_user_stream(stop)
            # History DB: backfill + live sync (auto-updates on every fill)
            tasks.append(asyncio.create_task(self._history_sync_task(symbols, stop)))
        elif (
            self.config.recovery_state_sync_sec > 0
            or self.config.runtime_state_enabled
            or self.config.strategy_event_logging
        ):
            tasks.append(asyncio.create_task(self._recovery_state_loop(stop)))

        # ── Bridge API: expose real-time status to the Node.js platform ──
        # Skip when running under babysitter — it already runs its own bridge on the same port.
        self.stop_event = stop  # Allow bridge /control endpoint to trigger shutdown
        if not self.config.babysit_only:
            try:
                from bot.v7.bridge_api import start_bridge_server
                tasks.append(asyncio.create_task(start_bridge_server(self)))
                logger.info("🌉 Bridge API task queued")
            except ImportError as e:
                logger.warning(f"Bridge API not available (missing deps?): {e}")
            except Exception as e:
                logger.warning(f"Bridge API failed to start: {e}")
        else:
            logger.info("🌉 Bridge API skipped (babysitter mode — bridge runs in parent)")

        # Pair rotation: rescan hot pairs periodically (only when using scanner, not fixed --symbols)
        if self.config.rotation_interval_sec > 0 and not self.config.symbols:
            tasks.append(asyncio.create_task(self._pair_rotation_loop(stop)))

        if self.config.duration_sec > 0:
            async def auto_stop():
                await asyncio.sleep(self.config.duration_sec)
                logger.info(f"\n⏰ Duration {self.config.duration_sec}s reached")
                stop.set()
            tasks.append(asyncio.create_task(auto_stop()))

        await stop.wait()

        # Graceful shutdown
        if self.config.live and self.executor:
            await self._graceful_shutdown()

        self._persist_recovery_states_once()
        self._persist_runtime_states_once()
        self._flush_strategy_events_once()

        for t in tasks:
            t.cancel()
        for t in self._rotation_ws_tasks:
            t.cancel()
        await asyncio.gather(*tasks, *self._rotation_ws_tasks, return_exceptions=True)

        if self._recovery_store is not None:
            try:
                self._recovery_store.close()
            except Exception:
                pass
            self._recovery_store = None

        # Clean up history sync service
        if self._history_sync_svc is not None:
            try:
                await self._history_sync_svc.close()
            except Exception:
                pass
            self._history_sync_svc = None

        self._final_summary()

    async def _history_sync_task(self, symbols: list, stop: asyncio.Event):
        """Background task: backfill + live sync trades into history.db."""
        try:
            from bot.v7.services.history_sync import BinanceHistorySyncService, SyncConfig
        except ImportError as e:
            logger.warning(f"📦 History sync unavailable (missing deps): {e}")
            return

        svc = None
        try:
            api_key = ""
            secret = ""
            if self.executor and hasattr(self.executor, "get_api_credentials"):
                try:
                    api_key, secret = self.executor.get_api_credentials()
                except Exception:
                    api_key, secret = "", ""

            if not api_key or not secret:
                logger.warning("📦 History sync skipped: no executor-bound API keys")
                return

            db_path = str(self.config.recovery_db_path or "").strip()
            if not db_path:
                logger.warning("📦 History sync skipped: empty recovery_db_path")
                return

            cfg = SyncConfig(
                db_path=db_path,
                default_backfill_days=7,
                poll_interval_sec=5.0,
                account_scope=self.user_scope,
            )
            svc = BinanceHistorySyncService(api_key, secret, config=cfg)
            self._history_sync_svc = svc

            await svc.initialize()

            # Backfill recent history (non-blocking, ~10s)
            raw_symbols = [s.replace("/", "").replace(":USDT", "") for s in symbols]
            logger.info(f"📦 History sync: backfilling 7d for {len(raw_symbols)} symbols...")
            try:
                result = await svc.backfill(symbols=raw_symbols, days=7)
                total_orders = sum(v.get("orders", 0) for v in result.values())
                total_trades = sum(v.get("trades", 0) for v in result.values())
                logger.info(f"📦 History backfill done: {total_orders} orders, {total_trades} trades")
            except Exception as e:
                logger.warning(f"📦 History backfill error (non-fatal): {e}")

            # Start live sync (runs until stop)
            logger.info("📦 History live sync started")
            await svc.run_live_sync(symbols=raw_symbols, stop_event=stop)
            logger.info("📦 History live sync stopped")

        except asyncio.CancelledError:
            logger.info("📦 History sync cancelled")
        except Exception as e:
            logger.warning(f"📦 History sync error: {e}\n{traceback.format_exc()}")
        finally:
            # Always clean up websocket/keepalive to avoid "Task was destroyed" warning
            if svc is not None:
                try:
                    await svc.close()
                except Exception:
                    pass


    # ─── Methods below have been extracted to orchestrator mixins ──────────
    # PersistenceMixin:     _get_recovery_store, _scoped_state_key, _recovery_state_key,
    #                       _load_persisted_recovery_state, _persist_recovery_state,
    #                       _persist_recovery_states_once, _runtime_state_key,
    #                       _load_persisted_runtime_state, _persist_runtime_state,
    #                       _persist_runtime_states_once, _persist_session_config,
    #                       _load_session_config, _estimate_layer_count,
    #                       _load_initial_recovery_debt, _seed_recovery_debt,
    #                       _seed_recovery_stats, _seed_runtime_state
    # RunnerTelemetryMixin: _extract_signal_subset, _strategy_event_sink,
    #                       _flush_strategy_events_once, _layers_match_exchange,
    #                       _display_loop, _final_summary
    # OrderMixin:           _order_loop, _on_order_update, _handle_entry_fill,
    #                       _handle_tp_fill, _schedule_tp_order, _place_tp_order,
    #                       _cancel_tp_order, _manage_resting_entries,
    #                       _manage_resting_tp_orders, _close_virtual_position,
    #                       _execute_order

