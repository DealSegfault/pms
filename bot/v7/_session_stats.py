#!/usr/bin/env python3
"""V7 Session Stats — last N hours from history DB + strategy events."""
import sqlite3
import time
import json
import math
import os

HOURS = 10
DB = os.path.join(os.path.dirname(__file__), "..", "v7_sessions", "history.db")

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
db.row_factory = sqlite3.Row

now = time.time()
cutoff_ts = now - HOURS * 3600
cutoff_ms = int(cutoff_ts * 1000)

# ─── 1. Strategy Events (closes) ───────────────────────────
closes = db.execute("""
    SELECT symbol, action, reason, layers, pnl_bps, pnl_usd, notional,
           recovery_debt_usd, spread_bps, vol_blended_bps, event_ts
    FROM strategy_events
    WHERE action = 'close' AND event_ts >= ?
    ORDER BY event_ts ASC
""", (cutoff_ts,)).fetchall()

entries = db.execute("""
    SELECT symbol, layers, notional, event_ts
    FROM strategy_events
    WHERE action = 'entry' AND event_ts >= ?
    ORDER BY event_ts ASC
""", (cutoff_ts,)).fetchall()

# ─── 2. Raw trades from exchange ───────────────────────────
trades = db.execute("""
    SELECT symbol, side, price, qty, cost, fee_cost, realized_pnl, timestamp_ms
    FROM trades
    WHERE timestamp_ms >= ?
    ORDER BY timestamp_ms ASC
""", (cutoff_ms,)).fetchall()

print(f"{'='*70}")
print(f"  V7 SESSION STATS — Last {HOURS}h")
print(f"  Period: {time.strftime('%m-%d %H:%M', time.localtime(cutoff_ts))} → {time.strftime('%m-%d %H:%M', time.localtime(now))}")
print(f"{'='*70}")

# ─── TRADE SUMMARY ─────────────────────────────────────────
n_closes = len(closes)
n_entries = len(entries)
n_raw_trades = len(trades)

wins = [c for c in closes if c["pnl_usd"] > 0]
losses = [c for c in closes if c["pnl_usd"] <= 0]
n_wins = len(wins)
n_losses = len(losses)
wr = n_wins / max(n_closes, 1) * 100

total_pnl = sum(c["pnl_usd"] for c in closes)
total_win_pnl = sum(c["pnl_usd"] for c in wins)
total_loss_pnl = sum(c["pnl_usd"] for c in losses)
avg_win = total_win_pnl / max(n_wins, 1)
avg_loss = total_loss_pnl / max(n_losses, 1)

total_fees = sum(t["fee_cost"] for t in trades)
total_volume = sum(t["cost"] for t in trades)

print(f"\n📊 TRADE SUMMARY")
print(f"  Entries:          {n_entries}")
print(f"  Closes:           {n_closes}")
print(f"  Raw exchange fills: {n_raw_trades}")
print(f"  Win rate:         {wr:.1f}% ({n_wins}W / {n_losses}L)")
print(f"  Total PnL:        ${total_pnl:+.4f}")
print(f"  Gross wins:       ${total_win_pnl:+.4f}")
print(f"  Gross losses:     ${total_loss_pnl:+.4f}")
print(f"  Avg win:          ${avg_win:+.4f}")
print(f"  Avg loss:         ${avg_loss:+.4f}")
print(f"  Profit factor:    {abs(total_win_pnl/min(total_loss_pnl,-0.0001)):.2f}")
print(f"  Total fees:       ${total_fees:.4f}")
print(f"  Total volume:     ${total_volume:.2f}")

# ─── BY CLOSE REASON ───────────────────────────────────────
reasons = {}
for c in closes:
    r = c["reason"] or "unknown"
    if r not in reasons:
        reasons[r] = {"n": 0, "pnl": 0.0, "wins": 0}
    reasons[r]["n"] += 1
    reasons[r]["pnl"] += c["pnl_usd"]
    if c["pnl_usd"] > 0:
        reasons[r]["wins"] += 1

print(f"\n📋 BY CLOSE REASON")
print(f"  {'Reason':<16s} {'N':>4s} {'WR':>6s} {'PnL':>10s}")
for r, d in sorted(reasons.items(), key=lambda x: -x[1]["n"]):
    wr_r = d["wins"] / max(d["n"], 1) * 100
    print(f"  {r:<16s} {d['n']:>4d} {wr_r:>5.0f}% ${d['pnl']:>+8.4f}")

# ─── PER-SYMBOL STATS ─────────────────────────────────────
sym_stats = {}
for c in closes:
    s = c["symbol"]
    if s not in sym_stats:
        sym_stats[s] = {"n": 0, "wins": 0, "pnl": 0.0, "notional": 0.0, "max_layers": 0}
    sym_stats[s]["n"] += 1
    sym_stats[s]["pnl"] += c["pnl_usd"]
    sym_stats[s]["notional"] += c["notional"]
    sym_stats[s]["max_layers"] = max(sym_stats[s]["max_layers"], c["layers"])
    if c["pnl_usd"] > 0:
        sym_stats[s]["wins"] += 1

print(f"\n🏆 TOP 10 SYMBOLS (by PnL)")
print(f"  {'Symbol':<18s} {'T':>3s} {'WR':>5s} {'PnL':>10s} {'Notional':>10s} {'MaxL':>4s}")
for s, d in sorted(sym_stats.items(), key=lambda x: -x[1]["pnl"])[:10]:
    wr_s = d["wins"] / max(d["n"], 1) * 100
    print(f"  {s:<18s} {d['n']:>3d} {wr_s:>4.0f}% ${d['pnl']:>+8.4f} ${d['notional']:>8.0f} {d['max_layers']:>4d}")

print(f"\n💀 BOTTOM 10 SYMBOLS (by PnL)")
print(f"  {'Symbol':<18s} {'T':>3s} {'WR':>5s} {'PnL':>10s} {'Notional':>10s} {'MaxL':>4s}")
for s, d in sorted(sym_stats.items(), key=lambda x: x[1]["pnl"])[:10]:
    wr_s = d["wins"] / max(d["n"], 1) * 100
    print(f"  {s:<18s} {d['n']:>3d} {wr_s:>4.0f}% ${d['pnl']:>+8.4f} ${d['notional']:>8.0f} {d['max_layers']:>4d}")

# ─── EQUITY CURVE + DRAWDOWN ──────────────────────────────
pnl_series = []
cum = 0.0
for c in closes:
    cum += c["pnl_usd"]
    pnl_series.append({"ts": c["event_ts"], "cum_pnl": cum, "trade_pnl": c["pnl_usd"]})

peak = 0.0
max_dd = 0.0
max_dd_ts = 0
for p in pnl_series:
    peak = max(peak, p["cum_pnl"])
    dd = peak - p["cum_pnl"]
    if dd > max_dd:
        max_dd = dd
        max_dd_ts = p["ts"]

print(f"\n📈 EQUITY CURVE")
print(f"  Start PnL:        $0.00")
print(f"  End PnL:          ${cum:+.4f}")
print(f"  Peak PnL:         ${peak:+.4f}")
print(f"  Max drawdown:     ${max_dd:.4f}")
if max_dd_ts:
    print(f"  Max DD time:      {time.strftime('%m-%d %H:%M', time.localtime(max_dd_ts))}")

# ─── EXPOSURE ANALYSIS ─────────────────────────────────────
# Track notional exposure over time from entries/closes
exposure_events = []
for e in entries:
    exposure_events.append({"ts": e["event_ts"], "delta": e["notional"]})
for c in closes:
    exposure_events.append({"ts": c["event_ts"], "delta": -c["notional"]})
exposure_events.sort(key=lambda x: x["ts"])

exposure = 0.0
max_exposure = 0.0
max_exposure_ts = 0
exposure_snapshots = []
for ev in exposure_events:
    exposure += ev["delta"]
    exposure = max(exposure, 0)  # can't go below 0
    exposure_snapshots.append({"ts": ev["ts"], "exposure": exposure})
    if exposure > max_exposure:
        max_exposure = exposure
        max_exposure_ts = ev["ts"]

print(f"\n💰 EXPOSURE")
print(f"  Max exposure:     ${max_exposure:.2f}")
if max_exposure_ts:
    print(f"  Max exposure at:  {time.strftime('%m-%d %H:%M', time.localtime(max_exposure_ts))}")
if exposure_snapshots:
    avg_exp = sum(s["exposure"] for s in exposure_snapshots) / len(exposure_snapshots)
    print(f"  Avg exposure:     ${avg_exp:.2f}")

# ─── SHARPE / RISK METRICS ─────────────────────────────────
trade_pnls = [c["pnl_usd"] for c in closes]
if len(trade_pnls) >= 2:
    mean_pnl = sum(trade_pnls) / len(trade_pnls)
    variance = sum((x - mean_pnl) ** 2 for x in trade_pnls) / (len(trade_pnls) - 1)
    std_pnl = math.sqrt(variance)
    
    # Per-trade Sharpe
    sharpe_per_trade = mean_pnl / std_pnl if std_pnl > 0 else 0
    
    # Annualized (assume ~50 trades/hour based on data)
    session_hours = max((now - cutoff_ts) / 3600, 0.01)
    trades_per_hour = len(trade_pnls) / session_hours
    trades_per_year = trades_per_hour * 24 * 365
    sharpe_annual = sharpe_per_trade * math.sqrt(trades_per_year)
    
    # Sortino (downside deviation only)
    downside = [min(x - mean_pnl, 0) ** 2 for x in trade_pnls]
    downside_dev = math.sqrt(sum(downside) / max(len(downside) - 1, 1))
    sortino = mean_pnl / downside_dev if downside_dev > 0 else 0
    
    # Calmar ratio (annualized return / max DD)
    ann_return = total_pnl * (8760 / max(session_hours, 0.01))
    calmar = ann_return / max_dd if max_dd > 0 else float("inf")
    
    # Win/loss ratios
    avg_win_abs = abs(avg_win) if avg_win != 0 else 0.001
    avg_loss_abs = abs(avg_loss) if avg_loss != 0 else 0.001
    rr_ratio = avg_win_abs / avg_loss_abs
    
    # Expectancy
    expectancy = (wr/100 * avg_win_abs) - ((1-wr/100) * avg_loss_abs)
    
    # Largest single trade
    best_trade = max(trade_pnls)
    worst_trade = min(trade_pnls)
    
    # Consecutive wins/losses
    max_consec_wins = max_consec_losses = consec_wins = consec_losses = 0
    for p in trade_pnls:
        if p > 0:
            consec_wins += 1; consec_losses = 0
        else:
            consec_losses += 1; consec_wins = 0
        max_consec_wins = max(max_consec_wins, consec_wins)
        max_consec_losses = max(max_consec_losses, consec_losses)

    print(f"\n📐 RISK METRICS")
    print(f"  Mean PnL/trade:   ${mean_pnl:+.4f}")
    print(f"  Std PnL/trade:    ${std_pnl:.4f}")
    print(f"  Best trade:       ${best_trade:+.4f}")
    print(f"  Worst trade:      ${worst_trade:+.4f}")
    print(f"  R:R ratio:        {rr_ratio:.2f}")
    print(f"  Expectancy:       ${expectancy:+.4f}/trade")
    print(f"  Trades/hour:      {trades_per_hour:.1f}")
    print(f"  Sharpe (per-trade): {sharpe_per_trade:.3f}")
    print(f"  Sharpe (annual):  {sharpe_annual:.2f}")
    print(f"  Sortino:          {sortino:.3f}")
    print(f"  Calmar:           {calmar:.2f}")
    print(f"  Max consec wins:  {max_consec_wins}")
    print(f"  Max consec losses:{max_consec_losses}")

# ─── HOURLY BREAKDOWN ─────────────────────────────────────
print(f"\n⏰ HOURLY BREAKDOWN")
print(f"  {'Hour':<14s} {'T':>3s} {'WR':>5s} {'PnL':>10s} {'Entries':>7s}")
hourly = {}
for c in closes:
    h = time.strftime("%m-%d %H:00", time.localtime(c["event_ts"]))
    if h not in hourly:
        hourly[h] = {"n": 0, "wins": 0, "pnl": 0.0}
    hourly[h]["n"] += 1
    hourly[h]["pnl"] += c["pnl_usd"]
    if c["pnl_usd"] > 0:
        hourly[h]["wins"] += 1

hourly_entries = {}
for e in entries:
    h = time.strftime("%m-%d %H:00", time.localtime(e["event_ts"]))
    hourly_entries[h] = hourly_entries.get(h, 0) + 1

for h in sorted(hourly.keys()):
    d = hourly[h]
    wr_h = d["wins"] / max(d["n"], 1) * 100
    ent = hourly_entries.get(h, 0)
    print(f"  {h:<14s} {d['n']:>3d} {wr_h:>4.0f}% ${d['pnl']:>+8.4f} {ent:>7d}")

# ─── LAYER DISTRIBUTION ───────────────────────────────────
print(f"\n🧱 LAYER DISTRIBUTION AT CLOSE")
layer_dist = {}
for c in closes:
    l = c["layers"]
    if l not in layer_dist:
        layer_dist[l] = {"n": 0, "pnl": 0.0, "wins": 0}
    layer_dist[l]["n"] += 1
    layer_dist[l]["pnl"] += c["pnl_usd"]
    if c["pnl_usd"] > 0:
        layer_dist[l]["wins"] += 1

print(f"  {'Layers':>6s} {'N':>4s} {'WR':>6s} {'PnL':>10s} {'Avg':>10s}")
for l in sorted(layer_dist.keys()):
    d = layer_dist[l]
    wr_l = d["wins"] / max(d["n"], 1) * 100
    avg_l = d["pnl"] / max(d["n"], 1)
    print(f"  {l:>6d} {d['n']:>4d} {wr_l:>5.0f}% ${d['pnl']:>+8.4f} ${avg_l:>+8.4f}")

print(f"\n{'='*70}")
db.close()
