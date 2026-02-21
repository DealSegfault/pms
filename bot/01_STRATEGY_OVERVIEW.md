# V7 Short Grid Strategy - Current Overview

This document reflects the current implementation in:
- `v7/run.py`
- `v7/multi_grid.py`
- `v7/grid_trader.py`
- `v7/signals.py`
- `v7/exchange.py`
- `v7/config.yaml`

## One-Sentence Summary

V7 runs a short-only, multi-symbol microstructure grid that sells pump exhaustion, adds layers at volatility-aware geometric spacing, and exits through a hybrid TP stack (resting maker TP, signal TP/fast TP, and inverse grid TP for deeper positions).

## What It Trades

- Market: Binance USDT-M perpetual futures
- Direction: short only
- Universe: scanner-selected hot symbols (default top 50), plus blacklist and optional fixed symbols
- Time horizon: sub-second to minutes

## What Changed Since Earlier V7 Docs

- Inverse grid TP was added for 3+ layer positions.
- Runtime state persistence/restore was added (layer stack, spread/vol context, pacing state).
- Orphan position adoption is enabled (active management by default).
- A bridge API was added for status/events/control.
- A babysitter reconcile loop now keeps local grid state aligned with exchange truth.
- Entry and TP execution now use stealth slicing and active order management loops.

## Runtime Architecture

1. Market data plane
- Combined Binance websocket streams (`bookTicker` + `aggTrade`) for all active symbols.
- Per-symbol signal engine computes TI/QI/MD, pump/exhaust, realized vol.

2. Strategy plane
- One `GridTrader` per symbol.
- Entry, averaging, exit, inverse TP, edge gating, and recovery-debt logic run per symbol.

3. Execution plane
- Entries: fire-and-forget GTX limit sells (post-only), with amend/reap handling.
- Exits: smart 3-step close path (maker limit -> IOC -> market).
- Persistent resting TP orders (GTX reduce-only) are maintained and amended.

4. State plane
- SQLite history store (`history.db`) for orders/trades/events/state.
- Per-symbol recovery state and runtime state persisted on cadence.
- Strategy events buffered and flushed to DB.

5. Control plane
- Embedded FastAPI bridge server for `/health`, `/status`, `/events`, `/config`, `/control`, and websocket stream.

## Trade Lifecycle (Current)

1. Detect
- Entry requires warm signals, calibrated spread context, risk/cooldown clearance, and microstructure trigger.

2. Enter
- Queue short entry at ask as GTX post-only.
- In live mode, order is tracked and amended; stale/invalid orders are canceled.

3. Average
- Add layers only when spacing, spread, recovery, edge, symbol cap, and portfolio cap gates all pass.

4. Manage exits
- Maintain resting TP order at current `tp_price`.
- Also evaluate signal exits (`tp` / `fast_tp`) and optional stop-loss.

5. Inverse TP mode (multi-layer)
- On TP signal with enough layers, switch from one-shot close to zone-based partial closes.

6. Close
- Exit path uses maker-first, then IOC, then market as fallback.
- Partial fill safety sweeps remaining size when needed.

7. Persist and reconcile
- Runtime/recovery state is persisted.
- Babysitter reconcile loop corrects local/exchange drift.

## Default Risk And Control Settings (`config.yaml`)

| Area | Default | Purpose |
|------|---------|---------|
| Portfolio cap | `$2000` total notional | Global exposure ceiling |
| Layer sizing | `$50 -> $80`, `size_growth=1.5` | Scale deeper entries with cap |
| Layer depth | `max_layers=32` | Hard per-symbol grid depth cap |
| Spacing growth | `2.0` | Exponential spacing between adds |
| Spread gate | `7..40 bps` | Avoid fee-trap tight spreads and chaotic wide spreads |
| Trend guards | `2s <= 12 bps`, `abs(30s) <= 30 bps` | Avoid entering into unstable trend regimes |
| Waterfall gate | `drawdown/vol <= 3.0` | Skip waterfall-like contexts |
| TP baseline | `1.2x spread`, floor `10 bps` | Core profit target |
| TP decay | `half-life 30m`, floor `50%` | Tighten stale positions |
| Inverse TP | enabled, `min_layers=3`, `max_zones=5`, `time_cap=1800s` | Zone-based unwind for deeper grids |
| Recovery debt | enabled, ratio `0.25`, cap `$75`, max hurdle `25 bps` | Loss-paydown-aware profit requirements |
| Circuit breaker | `max_loss_bps=500`, loss cooldown `8s` | Symbol-level risk brake |
| Runtime persistence | enabled, sync `20s` | Crash-safe restart continuity |
| Strategy event logging | enabled, retention `14d` | Telemetry for analysis and UI |
| Babysitter reconcile | enabled | Exchange-truth state correction |
| Orphans | `adopt=true`, `recovery_only=false` | Active management of pre-existing positions |

## Key Files

| File | Role |
|------|------|
| `v7/run.py` | CLI, config load, session bootstrap |
| `v7/multi_grid.py` | Orchestration, websocket routing, live order loops, reconciliation |
| `v7/grid_trader.py` | Per-symbol entry/averaging/exit/inverse-TP/recovery logic |
| `v7/signals.py` | Microstructure signal math |
| `v7/volatility_regime.py` | Multi-TF baseline + live vol drift model |
| `v7/exchange.py` | Binance execution adapter, user stream, stealth slicing |
| `v7/bridge_api.py` | Embedded control/status API |
| `v7/services/storage.py` | Persistent state + strategy event storage |
| `v7/services/history_sync.py` | Trade/order backfill + live history sync |
