# Exit And TP Strategies - Current V7

Current exits are a hybrid of resting maker TP, signal-based exits, and inverse grid unwinds.

## Exit Stack Overview

V7 can close positions via:
- Resting TP order fills (GTX reduce-only)
- Signal-triggered `tp` or `fast_tp`
- Inverse TP partial closes for deep positions
- Optional stop-loss (disabled by default)

In live mode, final execution always goes through the smart close ladder.

## 1. Resting TP (Maker-First Path)

After entry fills, runner schedules a resting TP buy order.

TP quote source:
- `GridTrader.tp_price`
- If inverse TP is inactive: price from `_tp_target_bps()`
- If inverse TP is active: price for next inverse zone

Base TP target logic (`_tp_target_bps`):

```text
spread_tp = median_spread_bps * tp_spread_mult
vol_tp    = min(live_vol_bps * tp_vol_capture_ratio, tp_vol_scale_cap)
target    = max(spread_tp, vol_tp)

if decay enabled:
  target *= decay(age, half_life, floor)
```

Current config defaults use:
- `tp_spread_mult=1.2`
- `min_tp_profit_bps=10` (via signal path floor)
- decay half-life `30m`, floor `0.5`

## 2. Signal TP And Fast TP

Signal engine checks exit continuously:

```text
tp trigger:
  ret_from_entry <= -max(tp_spread_mult * current_spread_bps, min_tp_profit_bps)

fast_tp trigger:
  TI_500ms < fast_tp_ti
  and ret_from_entry <= min_fast_tp_bps
```

Defaults:
- `fast_tp_ti=-0.25`
- `min_fast_tp_bps=-10`

Additional runtime guards in live execution:
- Re-check executable PnL right before sending close.
- Skip stale fast TP signals if too old.

## 3. Inverse Grid TP (Deep Position Unwind)

If TP signal fires and position has enough layers (`inverse_tp_min_layers`, default 3), V7 can switch to inverse mode.

Behavior:
- Build TP zones from mirrored grid spacing.
- Close portions of position zone by zone (FIFO layers first).
- Advance to next zone after each partial close.
- Hard time cap forces full close if inverse mode runs too long (`inverse_tp_time_cap_sec`, default 1800s).

This avoids one-shot flattening for large multi-layer stacks.

## 4. Recovery Hurdle On Exit

For `tp`/`fast_tp`, close requires executable profit to clear recovery hurdle:

```text
min_exec_bps = max(recovery_exit_hurdle_bps, fast_tp_min_buffer_if_applicable)
```

Recovery hurdle is derived from:
- current recovery debt
- paydown ratio
- current notional
- capped by `recovery_max_paydown_bps`

So profitable exits can be held for larger paydown when debt is elevated.

## 5. Live Close Execution Ladder

When an active close is sent (`buy` action), executor attempts:

1. Maker limit buy (`GTX`) near bid (if not panic-close reason)
2. IOC limit buy at ask (price-capped taker)
3. Market buy fallback

Safety handling:
- If non-intentional partial fill, sweep remaining size at market.
- If still incomplete, force sync from exchange truth.

## 6. Stop Loss

Stop-loss logic exists but is disabled by default (`stop_loss_bps=0`).
When enabled, it closes if net PnL bps is below configured threshold.

## Practical Summary

Current V7 exits are not a single TP rule. They are a layered system that combines:
- passive maker capture (resting TP),
- active signal exits,
- staged inverse unwinds for deeper grids,
- debt-aware minimum executable profit,
- and a robust execution fallback ladder.
