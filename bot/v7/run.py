#!/usr/bin/env python3
"""
V7 SHORT GRID — Config-driven runner

Usage:
    python3 -m v7.run                          # Paper mode with config.yaml defaults
    python3 -m v7.run --live                   # LIVE mode
    python3 -m v7.run --live --duration 300    # Live 5-min session
    python3 -m v7.run --symbols LAUSDT         # Specific pair
    python3 -m v7.run --config my_config.yaml  # Custom config file
    python3 -m v7.run --test                   # Pre-flight test only
"""
import asyncio
import argparse
import logging
import signal
import sys
import os
import time
import yaml
from typing import Any, Dict

# Install uvloop for faster event loop scheduling (~30% faster than default)
try:
    import uvloop
    uvloop.install()
except ImportError:
    pass  # Falls back to default asyncio event loop

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot.v7.multi_grid import MultiGridRunner, RunnerConfig

DEFAULT_CONFIG = os.path.join(os.path.dirname(__file__), "config.yaml")


def _deep_get(d: Dict[str, Any], *keys, default=None):
    """Safely get nested dict values."""
    for key in keys:
        if isinstance(d, dict):
            d = d.get(key, default)
        else:
            return default
    return d if d is not None else default


def load_config_from_yaml(path: str) -> RunnerConfig:
    """Load RunnerConfig from a YAML file."""
    with open(path, "r") as f:
        raw = yaml.safe_load(f) or {}

    # Resolve env vars in candle_service_url
    candle_url = _deep_get(raw, "volatility", "candle_service_url", default="http://localhost:3003")
    if isinstance(candle_url, str) and candle_url.startswith("${"):
        # Parse ${VAR:-default}
        inner = candle_url[2:-1]
        if ":-" in inner:
            var, default_val = inner.split(":-", 1)
        else:
            var, default_val = inner, ""
        candle_url = os.getenv(var, default_val)

    # Parse blacklist
    bl_raw = _deep_get(raw, "scanner", "blacklist", default=[])
    blacklist = set(s.strip().upper() for s in bl_raw if s.strip()) if bl_raw else set()

    return RunnerConfig(
        top_n=_deep_get(raw, "scanner", "top_n", default=50),
        min_change_pct=_deep_get(raw, "scanner", "min_change_pct", default=3.0),
        rotation_interval_sec=_deep_get(raw, "scanner", "rotation_interval_sec", default=600.0),
        symbols=_deep_get(raw, "scanner", "symbols", default=None),
        duration_sec=_deep_get(raw, "session", "duration_sec", default=0),
        display_interval=_deep_get(raw, "session", "display_interval", default=10.0),
        log_dir=_deep_get(raw, "session", "log_dir", default="./v7_sessions"),
        keep_positions=_deep_get(raw, "session", "keep_positions", default=True),
        user_scope=_deep_get(raw, "session", "user_scope", default=""),
        subaccount=_deep_get(raw, "session", "subaccount", default=""),
        account_scoped_storage=_deep_get(raw, "session", "account_scoped_storage", default=True),
        max_total_notional=_deep_get(raw, "portfolio", "max_total_notional", default=300.0),
        min_notional=_deep_get(raw, "grid", "min_notional", default=6.0),
        max_notional=_deep_get(raw, "grid", "max_notional", default=30.0),
        max_layers=_deep_get(raw, "grid", "max_layers", default=8),
        max_symbol_notional=_deep_get(raw, "grid", "max_symbol_notional", default=0.0),
        spacing_growth=_deep_get(raw, "grid", "spacing_growth", default=1.6),
        size_growth=_deep_get(raw, "grid", "size_growth", default=1.0),
        base_spacing_bps=_deep_get(raw, "grid", "base_spacing_bps", default=0.0),
        trend_spacing_scale=_deep_get(raw, "grid", "trend_spacing_scale", default=5.0),
        vol_drift_enabled=_deep_get(raw, "volatility", "drift_enabled", default=True),
        candle_service_url=candle_url,
        vol_refresh_sec=_deep_get(raw, "volatility", "refresh_sec", default=120.0),
        vol_live_weight=_deep_get(raw, "volatility", "live_weight", default=0.45),
        vol_drift_min=_deep_get(raw, "volatility", "drift_min", default=0.8),
        vol_drift_max=_deep_get(raw, "volatility", "drift_max", default=3.0),
        vol_tail_mult=_deep_get(raw, "volatility", "tail_mult", default=2.2),
        vol_tail_cooldown_sec=_deep_get(raw, "volatility", "tail_cooldown_sec", default=20.0),
        vol_tf_weights=_deep_get(raw, "volatility", "tf_weights", default=None),
        vol_tf_lookbacks=_deep_get(raw, "volatility", "tf_lookbacks", default=None),
        min_spread_bps=_deep_get(raw, "signals", "min_spread_bps", default=5.0),
        max_spread_bps=_deep_get(raw, "signals", "max_spread_bps", default=40.0),
        pump_threshold=_deep_get(raw, "signals", "pump_threshold", default=2.0),
        exhaust_threshold=_deep_get(raw, "signals", "exhaust_threshold", default=1.0),
        max_trend_bps=_deep_get(raw, "signals", "max_trend_bps", default=5.0),
        max_trend_30s_bps=_deep_get(raw, "signals", "max_trend_30s_bps", default=30.0),
        max_buy_ratio=_deep_get(raw, "signals", "max_buy_ratio", default=1.0),
        warmup_sec=_deep_get(raw, "signals", "warmup_sec", default=30.0),
        resume_context_rewarm_sec=_deep_get(raw, "signals", "resume_context_rewarm_sec", default=30.0),
        tp_spread_mult=_deep_get(raw, "exit", "tp_spread_mult", default=1.2),
        min_tp_profit_bps=_deep_get(raw, "exit", "min_tp_profit_bps", default=10.0),
        tp_decay_half_life_min=_deep_get(raw, "exit", "tp_decay_half_life_min", default=0.0),
        tp_decay_floor=_deep_get(raw, "exit", "tp_decay_floor", default=0.5),
        fast_tp_ti=_deep_get(raw, "exit", "fast_tp_ti", default=-0.25),
        min_fast_tp_bps=_deep_get(raw, "exit", "min_fast_tp_bps", default=-10.0),
        stop_loss_bps=_deep_get(raw, "exit", "stop_loss_bps", default=0.0),
        inverse_tp_enabled=_deep_get(raw, "inverse_tp", "enabled", default=True),
        inverse_tp_min_layers=_deep_get(raw, "inverse_tp", "min_layers", default=3),
        inverse_tp_max_zones=_deep_get(raw, "inverse_tp", "max_zones", default=5),
        inverse_tp_time_cap_sec=_deep_get(raw, "inverse_tp", "time_cap_sec", default=1800.0),
        max_loss_bps=_deep_get(raw, "risk", "max_loss_bps", default=500.0),
        loss_cooldown_sec=_deep_get(raw, "risk", "loss_cooldown_sec", default=8.0),
        dynamic_behavior_enabled=_deep_get(raw, "dynamic", "enabled", default=True),
        behavior_lookback=_deep_get(raw, "dynamic", "behavior_lookback", default=120),
        min_edge_bps=_deep_get(raw, "edge", "min_edge_bps", default=2.0),
        edge_signal_slope_bps=_deep_get(raw, "edge", "signal_slope_bps", default=1.0),
        edge_exec_buffer_bps=_deep_get(raw, "edge", "exec_buffer_bps", default=0.3),
        edge_default_slippage_bps=_deep_get(raw, "edge", "default_slippage_bps", default=0.5),
        edge_uncertainty_z=_deep_get(raw, "edge", "uncertainty_z", default=0.75),
        edge_min_samples=_deep_get(raw, "edge", "min_samples", default=5),
        waterfall_vol_threshold=_deep_get(raw, "signals", "waterfall_vol_threshold", default=3.0),
        waterfall_decay_sec=_deep_get(raw, "signals", "waterfall_decay_sec", default=30.0),
        recovery_debt_enabled=_deep_get(raw, "recovery", "enabled", default=True),
        recovery_paydown_ratio=_deep_get(raw, "recovery", "paydown_ratio", default=0.25),
        recovery_max_paydown_bps=_deep_get(raw, "recovery", "max_paydown_bps", default=25.0),
        recovery_debt_cap_usd=_deep_get(raw, "recovery", "debt_cap_usd", default=75.0),
        recovery_db_path=_deep_get(raw, "recovery", "db_path", default="./v7_sessions/history.db"),
        recovery_lookback_hours=_deep_get(raw, "recovery", "lookback_hours", default=24.0),
        recovery_avg_enabled=_deep_get(raw, "recovery", "avg_enabled", default=True),
        recovery_avg_min_unrealized_bps=_deep_get(raw, "recovery", "avg_min_unrealized_bps", default=35.0),
        recovery_avg_min_hurdle_improve_bps=_deep_get(raw, "recovery", "avg_min_hurdle_improve_bps", default=0.75),
        recovery_avg_cooldown_sec=_deep_get(raw, "recovery", "avg_cooldown_sec", default=20.0),
        recovery_avg_max_adds_per_hour=_deep_get(raw, "recovery", "avg_max_adds_per_hour", default=8),
        recovery_state_sync_sec=_deep_get(raw, "recovery", "state_sync_sec", default=30.0),
        runtime_state_enabled=_deep_get(raw, "resilience", "runtime_state_enabled", default=True),
        runtime_state_sync_sec=_deep_get(raw, "resilience", "runtime_state_sync_sec", default=20.0),
        strategy_event_logging=_deep_get(raw, "resilience", "strategy_event_logging", default=True),
        strategy_event_retention_days=_deep_get(raw, "resilience", "strategy_event_retention_days", default=14.0),
        strategy_event_include_payload=_deep_get(raw, "resilience", "strategy_event_include_payload", default=False),
        babysitter_enabled=_deep_get(raw, "resilience", "babysitter_enabled", default=True),
        adopt_orphan_positions=_deep_get(raw, "orphans", "adopt", default=True),
        orphan_recovery_only=_deep_get(raw, "orphans", "recovery_only", default=False),

        stealth_max_l1_fraction=_deep_get(raw, "stealth", "max_l1_fraction", default=0.5),
        stealth_max_ticks=_deep_get(raw, "stealth", "max_ticks", default=5),
        stealth_always_split=_deep_get(raw, "stealth", "always_split", default=True),
        stealth_min_slices=_deep_get(raw, "stealth", "min_slices", default=2),
        stealth_max_slices=_deep_get(raw, "stealth", "max_slices", default=5),
        blacklist=blacklist,
    )


def main():
    parser = argparse.ArgumentParser(
        description="V7 Short Grid Trader — config-driven",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
All settings live in config.yaml (edit once, run forever).
CLI overrides are for session-specific changes only.

Examples:
  python3 -m v7.run                          # Paper with config.yaml
  python3 -m v7.run --live                   # LIVE mode
  python3 -m v7.run --live --duration 300    # Live 5 min session
  python3 -m v7.run --symbols LAUSDT         # Specific pair
  python3 -m v7.run --config my.yaml         # Custom config file
  python3 -m v7.run --test                   # Pre-flight only
        """,
    )

    # Only session-level overrides as CLI args
    parser.add_argument("--config", type=str, default=DEFAULT_CONFIG,
                        help=f"Path to YAML config file (default: {DEFAULT_CONFIG})")
    parser.add_argument("--live", action="store_true", help="⚠️  LIVE mode — real orders, real money")
    parser.add_argument("--test", action="store_true", help="Pre-flight test only (check API, balance)")
    parser.add_argument("--duration", type=int, default=None, help="Duration in seconds (overrides config)")
    parser.add_argument("--symbols", type=str, default=None, help="Comma-separated symbols (overrides config)")
    parser.add_argument("--pairs", type=int, default=None, help="Number of pairs to scan (overrides config)")
    parser.add_argument("--subaccount", type=str, default=None, help="Scoped credential profile / subaccount alias")
    parser.add_argument("--user-scope", type=str, default=None, help="User/account namespace for storage + bridge")
    parser.add_argument("--disable-babysitter", action="store_true", help="Disable reconciliation babysitter loop")
    parser.add_argument(
        "--global-storage",
        action="store_true",
        help="Disable account-scoped DB/log path suffixing (not recommended for multi-user setups)",
    )
    parser.set_defaults(adaptive=True)
    parser.add_argument("--adaptive", dest="adaptive", action="store_true", help="Auto-tune (default: on)")
    parser.add_argument("--no-adaptive", dest="adaptive", action="store_false", help="Disable auto-tuning")
    parser.add_argument("--adaptive-lookback", type=int, default=5, help="Adaptive session lookback")
    parser.add_argument(
        "--adaptive-state",
        type=str,
        default="./v7_sessions/v7_adaptive_state.json",
        help="Path to adaptive state report file",
    )

    args = parser.parse_args()

    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-20s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("ccxt").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)

    # ─── Load config ──────────────────────────────────────────

    config_path = args.config
    if not os.path.exists(config_path):
        print(f"❌ Config file not found: {config_path}")
        sys.exit(1)

    config = load_config_from_yaml(config_path)
    print(f"  📋 Loaded config from {config_path}")

    # Apply CLI overrides
    session_id = time.strftime("%Y%m%d_%H%M%S")
    config.session_id = session_id
    config.live = args.live

    if args.duration is not None:
        config.duration_sec = args.duration
    if args.symbols:
        config.symbols = [s.strip().upper() for s in args.symbols.split(",")]
    if args.pairs is not None:
        config.top_n = args.pairs
    if args.subaccount is not None:
        config.subaccount = args.subaccount.strip()
    if args.user_scope is not None:
        config.user_scope = args.user_scope.strip()
    if args.disable_babysitter:
        config.babysitter_enabled = False
    if args.global_storage:
        config.account_scoped_storage = False

    # ─── Pre-flight test ──────────────────────────────────────

    executor = None
    if args.test or args.live:
        from bot.v7.exchange import BinanceExecutor, load_api_keys

        credential_profile = (config.subaccount or config.user_scope or "").strip()
        api_key, secret = load_api_keys(
            profile=credential_profile,
            strict_profile=bool(credential_profile),
        )
        if not api_key or not secret:
            scope_label = f" profile '{credential_profile}'" if credential_profile else ""
            print(f"❌ API keys missing for{scope_label}. Configure .env credentials and retry.")
            sys.exit(1)

        executor = BinanceExecutor(
            api_key,
            secret,
            account_scope=(config.user_scope or config.subaccount or ""),
        )

    if args.test:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(executor.test_connection())
            print("✅ Pre-flight test passed")
        except Exception as e:
            print(f"❌ Pre-flight test failed: {e}")
        finally:
            loop.run_until_complete(executor.close())
            loop.close()
        return

    # ─── Adaptive ─────────────────────────────────────────────

    adaptive_plan = None
    if args.adaptive:
        try:
            from bot.v7.adaptive import apply_adaptive_plan, build_adaptive_plan

            adaptive_plan = build_adaptive_plan(
                config,
                lookback_sessions=max(1, int(args.adaptive_lookback)),
                live_only=args.live,
                exclude_session_id=config.session_id,
            )
            apply_adaptive_plan(config, adaptive_plan)
        except Exception as e:
            print(f"  ⚠️  Adaptive plan failed: {e}")

    # Banner
    mode_str = "📡 LIVE" if args.live else "📝 PAPER"
    print(f"""
╔══════════════════════════════════════════════════╗
║         V7 SHORT GRID TRADER  {mode_str:<8s}         ║
║  Config-driven • One file to rule them all       ║
╚══════════════════════════════════════════════════╝

  Config:    {config_path}
  Scope:     {(config.user_scope or config.subaccount or 'default')}
  Pairs:     {config.symbols or f'top {config.top_n} by 24h return'}
  Session:   {config.session_id}
  Grid:      max {config.max_layers} layers, ${config.min_notional:.0f} base, ×{config.spacing_growth} spacing, ×{config.size_growth} size/layer
  Portfolio: ${config.max_total_notional:.0f} max total
  TP:        {config.tp_spread_mult}× median spread
  Spread:    {config.min_spread_bps:.1f}..{config.max_spread_bps:.1f} bps
  Edge:      min {config.min_edge_bps}bp, buffer {config.edge_exec_buffer_bps}bp, z={config.edge_uncertainty_z}
  Recovery:  debt ratio {config.recovery_paydown_ratio:.2f}, cap ${config.recovery_debt_cap_usd:.0f}
  Recovery+: avg {'ON' if config.recovery_avg_enabled else 'OFF'}, cd {config.recovery_avg_cooldown_sec:.0f}s, sync {config.recovery_state_sync_sec:.0f}s
  Resilience: runtime {'ON' if config.runtime_state_enabled else 'OFF'} ({config.runtime_state_sync_sec:.0f}s), events {'ON' if config.strategy_event_logging else 'OFF'} ({config.strategy_event_retention_days:.0f}d)
  Babysitter:{'ON' if config.babysitter_enabled else 'OFF'}
  Scoped DB: {'ON' if config.account_scoped_storage else 'OFF'}

  Orphans:   {'adopt + active' if config.adopt_orphan_positions and not config.orphan_recovery_only else 'adopt + recovery-only' if config.adopt_orphan_positions else 'ignore'}
  Dynamic:   {'ON' if config.dynamic_behavior_enabled else 'OFF'}
  Adaptive:  {'ON' if args.adaptive else 'OFF'}
  Duration:  {'forever' if config.duration_sec == 0 else f'{config.duration_sec}s'}
  Rotation:  {'every ' + str(int(config.rotation_interval_sec)) + 's' if config.rotation_interval_sec > 0 and not config.symbols else 'disabled (fixed symbols)' if config.symbols else 'disabled'}
  Shutdown:  {'keep positions open' if config.keep_positions else 'close all positions'}
  Ctrl+C to stop
""")

    if adaptive_plan:
        print(
            f"Adaptive mode: {adaptive_plan.mode} | sessions={adaptive_plan.sessions_used} "
            f"trades={adaptive_plan.trades_used} | capEV={adaptive_plan.summary.get('cap_bps', 0.0):+.2f}bps"
        )
        if adaptive_plan.overrides:
            print(f"Adaptive overrides: {adaptive_plan.overrides}")
        if adaptive_plan.auto_blacklist:
            print(f"Adaptive blacklist: {', '.join(adaptive_plan.auto_blacklist)}")
        for note in adaptive_plan.notes:
            print(f"Adaptive note: {note}")

    # ─── Run ──────────────────────────────────────────────────

    stop_event = asyncio.Event()
    loop = asyncio.new_event_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    # For live mode, recreate executor in the new loop
    if args.live:
        from bot.v7.exchange import BinanceExecutor, load_api_keys
        credential_profile = (config.subaccount or config.user_scope or "").strip()
        api_key, secret = load_api_keys(
            profile=credential_profile,
            strict_profile=bool(credential_profile),
        )
        if not api_key or not secret:
            scope_label = f" profile '{credential_profile}'" if credential_profile else ""
            print(f"❌ API keys missing for{scope_label}. Configure .env credentials and retry.")
            sys.exit(1)
        executor = BinanceExecutor(
            api_key,
            secret,
            account_scope=(config.user_scope or config.subaccount or ""),
        )

    runner = MultiGridRunner(config, executor=executor)

    try:
        loop.run_until_complete(runner.run(stop_event))
    except KeyboardInterrupt:
        stop_event.set()
    finally:
        if args.adaptive and adaptive_plan is not None:
            try:
                from bot.v7.adaptive import summarize_session, update_adaptive_state

                session_summary = summarize_session(config.log_dir, config.session_id, live_only=args.live)
                update_adaptive_state(args.adaptive_state, config.session_id, adaptive_plan, session_summary)
            except Exception as e:
                print(f"Adaptive state update failed: {e}")
        # Close the aiohttp session
        if executor:
            loop.run_until_complete(executor.close())
        loop.close()


if __name__ == "__main__":
    main()
