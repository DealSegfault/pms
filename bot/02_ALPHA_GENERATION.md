# Alpha Generation - Current Implementation

This is the code-aligned alpha stack for current V7.

## 1. Microstructure Entry Alpha (Primary)

V7 enters only when both a pump regime and an exhaustion regime are present.

Core features from `signals.py`:
- `TI`: trade imbalance (2s, 500ms, 300ms)
- `QI`: quote imbalance from L1 book
- `MD`: microprice displacement
- `rv_1s`: rolling realized volatility

Composite scores:

```text
pump_score    = 0.4*z(ret_2s) + 0.8*z(TI_2s) + 0.6*z(MD)
exhaust_score = z(-dTI_300ms) + z(-dQI) + 1[MD < 0]
```

Entry preconditions:
- Warm signal state
- Spread in range (`min_spread_bps..max_spread_bps`)
- `pump_score > pump_threshold`
- `exhaust_score > exhaust_threshold`
- 2s trend guard (`ret_2s <= max_trend_bps`)
- 30s trend guard (`abs(ret_30s) <= max_trend_30s_bps`)
- Buy-ratio guard (`buy_ratio <= max_buy_ratio` when enabled)

## 2. Spread And Liquidity Alpha

- Hard spread gate blocks low-edge and unstable regimes.
- Base notional is spread-scaled:

```text
base_notional = lerp(min_notional, max_notional,
                     spread_position from min_spread to 3*min_spread)
```

- Wider spreads can justify larger notional (bounded by `max_notional`).

## 3. Volatility Regime Alpha

From `volatility_regime.py` and `grid_trader.py`:
- Baseline volatility from weighted candle TFs (`1m/5m/15m`).
- Live volatility from 1s realized vol EMA.
- Blended volatility drives drift multiplier and spacing.

```text
blended_bps = (1-live_weight)*baseline + live_weight*live
drift_mult  = clamp(blended / baseline, drift_min, drift_max)
```

Heavy-tail logic:
- `tail_ratio = max(live, blended) / baseline`
- If `tail_ratio >= tail_mult`, layer-adding cooldown is extended.

## 4. Grid Geometry Alpha

Spacing and sizing are adaptive, not static:

```text
base_spacing = max(median_spread_bps, blended_vol_bps, 5.0)
effective_growth = clamp(spacing_growth * drift_mult, 1.05, 8.0)
required_spacing_n = base_spacing * (effective_growth^(n-1))
```

Layer notional:

```text
layer_notional_n = min(base_notional * size_growth^n, max_notional)
```

Additional dynamic modifiers (when enabled):
- Adaptive entry cooldown (dup fills, near-zero closes, falling-knife pattern)
- Adaptive minimum layer gap
- Adaptive max layers based on deep-close performance
- Spread-relief curve for averaging when deeply underwater

## 5. Execution Alpha

Execution is intentionally layered:

Entries:
- GTX post-only limit sells (`fire_limit_sell`)
- Resting entries are amended/reaped if stale or signal-invalid
- Stealth order slicing randomizes piece size and tick placement

Exits:
- Resting TP orders are maintained as GTX reduce-only buys
- Active close path: maker-first, then IOC, then market fallback
- Partial-close safety sweep for non-intentional partials

This structure reduces fee drag while preserving fill certainty.

## 6. Edge Gate Alpha (LCB)

Every new entry/add must pass the edge gate in `grid_trader._has_sufficient_edge`.

```text
expected_cost = fee_floor + slippage_est + exec_buffer
signal_bonus  = max(signal_strength - threshold_strength, 0) * signal_slope
expected_edge = tp_target + signal_bonus - expected_cost - trend_penalty - spread_risk
edge_lcb      = expected_edge - uncertainty_penalty
required      = max(min_edge_bps, recovery_entry_hurdle_bps)
pass if edge_lcb >= required
```

Notes:
- Uncertainty uses recent close-behavior volatility with winsorization.
- Uncertainty is capped relative to positive expected edge.
- Recovery debt can raise required edge via entry hurdle.

## 7. Recovery-Integrated Alpha

Recovery debt is not only an exit concern; it also shapes entries/adds:
- Debt ledger increments on losses and decrements on wins.
- Entry/averaging required edge can be raised by recovery hurdle.
- Averaging is gated by drawdown, cooldown, hourly cap, and hurdle-improvement checks.

This prevents low-quality averaging while still allowing debt-aware recovery behavior.

## Summary

V7 alpha comes from combining:
- Microstructure timing
- Spread-aware sizing
- Volatility-adaptive grid geometry
- Execution quality control
- LCB edge gating
- Recovery-aware entry/exit hurdles

No single component carries the strategy alone; the edge is compositional.
