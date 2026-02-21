# How To Explain V7 On A Whiteboard (Current Version)

Use this sequence to explain the strategy as it is implemented now.

## 1. Draw The Core Idea (30s)

Draw a short-lived pump followed by mean reversion.

```text
price
  ^
  |        /\
  |       /  \
  |  /\  /    \__
  |_/  \/        \____
  +------------------------>
       sell into pump   buy back lower
```

Script:
- "We short exhaustion during micro-pumps and close on reversion."

## 2. Draw The Two Entry Gauges (1-2 min)

```text
[PUMP SCORE]    [EXHAUST SCORE]
   > 2.0            > 1.0
```

Explain inputs:
- Pump uses z-scored return, TI, and MD.
- Exhaust uses falling micro-flow signals (`-dTI`, `-dQI`) plus `MD < 0`.

Mention hard guards:
- Spread gate
- 2s and 30s trend guards
- buy-ratio guard
- waterfall guard

## 3. Draw The Exponential Layer Ladder (2-3 min)

```text
L4  ------------------------
L3  --------------
L2  --------
L1  ----
L0  -- entry
```

Key line:
- "Gaps grow geometrically and also scale with volatility drift."

Then add sizing note:
- "Layer size scales up with depth, but capped by max per-layer notional."

## 4. Draw Exit Stack (3 min)

Use four boxes:

1. Resting TP (maker)
- GTX reduce-only TP order is kept on book and amended.

2. Signal TP / Fast TP
- TP from price move vs spread target.
- Fast TP from flow flip (`TI_500ms`).

3. Inverse TP (for 3+ layers)
- Switch to zone-based partial closes using mirrored spacing.

4. Execution ladder
- maker limit -> IOC -> market fallback.

## 5. Draw Recovery Debt Overlay (1-2 min)

```text
losses add debt -> wins pay debt down
higher debt -> higher required exit hurdle
```

Explain:
- Recovery debt can raise required edge for adds and required executable profit for exits.
- Averaging is gated by drawdown depth, cooldown, hourly add cap, and hurdle improvement.

## 6. Draw Runtime Resilience Ring (1 min)

```text
[bridge control]
[reconcile babysitter]
[runtime state restore + rewarm]
[orphan position adoption]
[state persistence]
```

Script:
- "The strategy can restart and recover state without losing position context."

## 7. 30-Second Close

"V7 is a short-only microstructure grid: it fades pump exhaustion, scales layers exponentially with volatility-aware spacing, and exits using a hybrid stack (resting TP, signal TP/fast TP, inverse TP), with debt-aware and runtime-safe controls around every step."

## Optional Visual Assets In This Folder

- `01_exponential_grid.png`
- `02_tp_strategies.png`
- `03_signal_engine.png`
- `04_trade_lifecycle.png`
- `05_edge_model.png`
