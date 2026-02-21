# Exponential Grid - Current Behavior

This document describes how spacing/sizing is implemented now in `grid_trader.py`.

## Core Spacing Model

For layer `n` (where first add after entry is `n=1`):

```text
base_spacing_bps =
  if config.base_spacing_bps > 0:
      config.base_spacing_bps
  else:
      max(median_spread_bps, blended_vol_bps, 5.0)

effective_growth = clamp(spacing_growth * drift_mult, 1.05, 8.0)
required_spacing = base_spacing_bps * effective_growth^(n-1)
required_spacing = max(required_spacing, dynamic_layer_gap_bps)
```

If `trend_spacing_scale > 0`, an extra trend multiplier is applied. In the current default config, `trend_spacing_scale=0`, so this extra multiplier is disabled.

## Layer Sizing

Base layer size is spread-scaled first, then depth-scaled:

```text
base_notional = spread_scaled(min_notional -> max_notional)
layer_notional = min(base_notional * size_growth^depth, max_notional)
```

Default config values:
- `min_notional=50`
- `max_notional=80`
- `size_growth=1.5`

## Averaging Gate Sequence (What Must Pass)

A new layer is blocked unless all checks pass:

1. Runtime and pacing checks
- Not in rewarm window
- No pending order
- Below dynamic max layers
- Circuit/cooldown allows trading
- Layer cooldown elapsed
- Entry cooldown elapsed

2. Price geometry checks
- Price rise from average entry >= required spacing
- Spread >= dynamic averaging minimum spread
- Burst guard: new layer not too close to last fill

3. Risk and quality checks
- Per-symbol notional cap
- Recovery averaging guard
- LCB edge gate (marginal edge)
- Portfolio cap

Only after all gates pass is a new sell queued.

## Recovery Averaging Guard (Important)

Averaging requires:
- Minimum unrealized loss depth (`recovery_avg_min_unrealized_bps`, default 35)
- Cooldown between adds (`recovery_avg_cooldown_sec`, default 20s)
- Hourly add cap (`recovery_avg_max_adds_per_hour`, default 8)
- Hurdle improvement check (skip when debt is negligible)

This is why deep averaging is controlled, not unconditional.

## Dynamic Behavior Adapters

When enabled (`dynamic.enabled: true`), the grid adapts from recent behavior:

- `dynamic_entry_cooldown_sec`
  - Increases when duplicate fills and near-zero closes are high
  - Can escalate further in falling-knife patterns

- `dynamic_layer_gap_bps`
  - Widens layer-gap requirements when duplicate fills are frequent

- `dynamic_max_layers`
  - If deep closes (3+ layers) underperform, cap can tighten to 2 or 3 layers

- `dynamic_min_tp_profit_bps` / `dynamic_min_fast_tp_bps`
  - Exit thresholds are adjusted from recent close quality and fee floor

## Volatility And Tail Controls

- Drift multiplier (`drift_mult`) stretches/compresses spacing.
- Heavy-tail detection triggers temporary layer cooldown.
- Waterfall score (30s drawdown normalized by vol with decay) can block fresh entries.

## Inverse TP Uses Mirrored Grid Geometry

When inverse TP activates (default: positions with >=3 layers), TP zones are generated from the same geometry:

```text
zone_i_bps = base_spacing_bps * effective_growth^i
zones capped at inverse_tp_max_zones (default 5)
```

This mirrors entry spacing for staged unwinds.

## Practical Implication

The current grid is exponential, volatility-aware, and behavior-aware. It is designed to add risk only when spacing, quality, and recovery constraints agree, not just when price moves.
