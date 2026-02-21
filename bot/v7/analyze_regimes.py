#!/usr/bin/env python3
"""
Flow Regime Segmentation Analysis
──────────────────────────────────
Loads all enriched JSONL trade logs and answers:
  1) Do losses concentrate in high-persistence flow regimes?
  2) What gating rule removes losses while preserving 70-80% of winners?

Usage:
  python analyze_regimes.py [--session SESSION_ID] [--all]
"""

import json
import os
import sys
import glob
from collections import defaultdict
from dataclasses import dataclass
from typing import List, Dict, Optional

import numpy as np

# ─── Config ───────────────────────────────────────────────────
JSONL_DIR = os.path.join(os.path.dirname(__file__), "v7_sessions")


@dataclass
class Trade:
    """One close event with entry+exit signal snapshots."""
    ts: float
    symbol: str
    reason: str
    layers: int
    pnl_usd: float
    pnl_bps: float
    total_notional: float
    median_spread_bps: float
    vol_blended_bps: float
    vol_drift_mult: float
    # Entry-time signals (notional-weighted avg across layers)
    entry_TI_2s: float = 0.0
    entry_TI_500ms: float = 0.0
    entry_z_TI_2s: float = 0.0
    entry_z_ret_2s: float = 0.0
    entry_z_MD_2s: float = 0.0
    entry_pump: float = 0.0
    entry_exhaust: float = 0.0
    entry_QI: float = 0.0
    entry_MD: float = 0.0
    entry_rv: float = 0.0
    entry_spread_bps: float = 0.0
    # Exit-time signals
    exit_TI_2s: float = 0.0
    exit_pump: float = 0.0
    exit_exhaust: float = 0.0
    exit_z_ret_2s: float = 0.0
    # Meta
    session: str = ""
    live: bool = False
    has_warm_signals: bool = False


def load_trades(session_filter: Optional[str] = None) -> List[Trade]:
    """Load all close events from enriched JSONL files."""
    pattern = os.path.join(JSONL_DIR, "v7_*.jsonl")
    files = glob.glob(pattern)

    trades = []
    skipped_no_signals = 0
    skipped_cold = 0
    total_close = 0
    total_entry = 0

    for fpath in sorted(files):
        fname = os.path.basename(fpath)
        # Extract session ID from filename: v7_SYMBOL_SESSIONID.jsonl
        parts = fname.replace(".jsonl", "").split("_")
        if len(parts) >= 3:
            session_id = "_".join(parts[-2:])  # e.g., "20260209_044547"
        else:
            session_id = "unknown"

        if session_filter and session_filter not in session_id:
            continue

        try:
            with open(fpath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    action = d.get("action", "")
                    if action == "entry":
                        total_entry += 1
                        continue
                    if action != "close":
                        continue

                    total_close += 1

                    # Check for enriched signals
                    entry_sigs = d.get("entry_signals", {})
                    exit_sigs = d.get("exit_signals", {})

                    if not entry_sigs and not exit_sigs:
                        skipped_no_signals += 1
                        continue

                    # Check if entry signals are warm (not all zeros)
                    warm = any(v != 0.0 for v in entry_sigs.values()) if entry_sigs else False
                    if not warm:
                        skipped_cold += 1

                    t = Trade(
                        ts=d.get("ts", 0),
                        symbol=d.get("symbol", ""),
                        reason=d.get("reason", ""),
                        layers=d.get("layers", 0),
                        pnl_usd=d.get("pnl_usd", 0),
                        pnl_bps=d.get("pnl_bps", 0),
                        total_notional=d.get("total_notional", 0),
                        median_spread_bps=d.get("median_spread_bps", 0),
                        vol_blended_bps=d.get("vol_blended_bps", 0),
                        vol_drift_mult=d.get("vol_drift_mult", 0),
                        # Entry signals
                        entry_TI_2s=entry_sigs.get("TI_2s", 0),
                        entry_TI_500ms=entry_sigs.get("TI_500ms", 0),
                        entry_z_TI_2s=entry_sigs.get("z_TI_2s", 0),
                        entry_z_ret_2s=entry_sigs.get("z_ret_2s", 0),
                        entry_z_MD_2s=entry_sigs.get("z_MD_2s", 0),
                        entry_pump=entry_sigs.get("pump_score", 0),
                        entry_exhaust=entry_sigs.get("exhaust_score", 0),
                        entry_QI=entry_sigs.get("QI", 0),
                        entry_MD=entry_sigs.get("MD", 0),
                        entry_rv=entry_sigs.get("rv_1s", 0),
                        entry_spread_bps=entry_sigs.get("spread_bps", 0),
                        # Exit signals
                        exit_TI_2s=exit_sigs.get("TI_2s", 0),
                        exit_pump=exit_sigs.get("pump_score", 0),
                        exit_exhaust=exit_sigs.get("exhaust_score", 0),
                        exit_z_ret_2s=exit_sigs.get("z_ret_2s", 0),
                        # Meta
                        session=session_id,
                        live=d.get("live", False),
                        has_warm_signals=warm,
                    )
                    trades.append(t)
        except Exception as e:
            print(f"  ⚠️ Error reading {fname}: {e}")

    return trades, total_close, total_entry, skipped_no_signals, skipped_cold


# ─── Regime Classification ───────────────────────────────────

def classify_regime(t: Trade) -> str:
    """Classify a trade into a flow regime based on entry-time signals."""
    if not t.has_warm_signals:
        return "cold_start"

    # High persistence: strong buy flow sustained
    if t.entry_TI_2s > 0.3 and t.entry_z_ret_2s > 1.5:
        if t.entry_exhaust > 0.5:
            return "pump_exhausting"  # Good: pump with signs of reversal
        else:
            return "pump_persistent"  # Dangerous: sustained trend

    # Moderate pump
    if t.entry_pump > 2.0:
        if t.entry_exhaust > 0.0:
            return "pump_with_exhaust"  # Decent: pump starting to fade
        else:
            return "pump_no_exhaust"  # Risky: pure momentum

    # Strong reversal signal
    if t.entry_z_ret_2s < -0.5 and t.entry_TI_2s < 0.0:
        return "mean_reversion"  # Favorable: price already pulling back

    # Low activity
    if abs(t.entry_TI_2s) < 0.15 and abs(t.entry_z_ret_2s) < 0.5:
        return "quiet"

    return "mixed"


# ─── Analysis ─────────────────────────────────────────────────

def print_separator(char="═", width=100):
    print(char * width)


def analyze_regimes(trades: List[Trade]):
    """Full regime segmentation analysis."""
    if not trades:
        print("❌ No enriched trades found. Run more sessions with signal logging enabled.")
        return

    warm = [t for t in trades if t.has_warm_signals]
    cold = [t for t in trades if not t.has_warm_signals]

    print_separator()
    print(f"  📊 FLOW REGIME SEGMENTATION ANALYSIS")
    print_separator()

    # ── Overview ──
    print(f"\n  Total enriched trades: {len(trades)}")
    print(f"  Warm signals (usable): {len(warm)}")
    print(f"  Cold start (warmup):   {len(cold)}")
    print(f"  Sessions: {len(set(t.session for t in trades))}")
    print(f"  Symbols:  {len(set(t.symbol for t in trades))}")
    total_pnl = sum(t.pnl_usd for t in trades)
    wr = sum(1 for t in trades if t.pnl_usd > 0) / max(len(trades), 1) * 100
    print(f"  Total PnL: ${total_pnl:+.4f} | WR: {wr:.1f}%")

    if len(warm) < 10:
        print(f"\n  ⚠️ Only {len(warm)} warm trades — need more data for reliable analysis.")
        print(f"  Let the session run and accumulate ≥50 warm trades.")
        print()

    # ── Regime Breakdown ──
    print(f"\n{'─' * 100}")
    print(f"  REGIME BREAKDOWN (warm trades only)")
    print(f"{'─' * 100}")

    regime_trades: Dict[str, List[Trade]] = defaultdict(list)
    for t in warm:
        regime = classify_regime(t)
        regime_trades[regime].append(t)

    # Header
    print(f"  {'Regime':<22} {'N':>5} {'WR%':>6} {'AvgPnL':>8} {'TotalPnL':>10} "
          f"{'AvgEntry_TI':>11} {'AvgPump':>8} {'AvgExh':>7} {'Med$':>7}")
    print(f"  {'─' * 88}")

    for regime in sorted(regime_trades.keys()):
        rts = regime_trades[regime]
        n = len(rts)
        wins = sum(1 for t in rts if t.pnl_usd > 0)
        wr_r = wins / max(n, 1) * 100
        avg_pnl = np.mean([t.pnl_bps for t in rts])
        total_pnl_r = sum(t.pnl_usd for t in rts)
        avg_ti = np.mean([t.entry_TI_2s for t in rts])
        avg_pump = np.mean([t.entry_pump for t in rts])
        avg_exh = np.mean([t.entry_exhaust for t in rts])
        med_notional = np.median([t.total_notional for t in rts])

        emoji = "🟢" if avg_pnl > 0 else "🔴"
        print(f"  {emoji} {regime:<20} {n:>5} {wr_r:>5.1f}% {avg_pnl:>+7.1f}bp "
              f"${total_pnl_r:>+9.4f} {avg_ti:>+10.3f} {avg_pump:>+7.2f} "
              f"{avg_exh:>+6.2f} ${med_notional:>6.2f}")

    # ── Losers Deep Dive ──
    losers = [t for t in warm if t.pnl_usd < 0]
    winners = [t for t in warm if t.pnl_usd > 0]

    if losers:
        print(f"\n{'─' * 100}")
        print(f"  LOSERS vs WINNERS — Signal Distribution")
        print(f"{'─' * 100}")

        def stats(vals):
            if not vals:
                return 0, 0, 0, 0
            return np.mean(vals), np.median(vals), np.percentile(vals, 25), np.percentile(vals, 75)

        features = [
            ("entry_TI_2s", lambda t: t.entry_TI_2s),
            ("entry_TI_500ms", lambda t: t.entry_TI_500ms),
            ("entry_z_ret_2s", lambda t: t.entry_z_ret_2s),
            ("entry_z_TI_2s", lambda t: t.entry_z_TI_2s),
            ("entry_pump", lambda t: t.entry_pump),
            ("entry_exhaust", lambda t: t.entry_exhaust),
            ("entry_QI", lambda t: t.entry_QI),
            ("entry_MD", lambda t: t.entry_MD),
            ("entry_rv", lambda t: t.entry_rv),
            ("entry_spread_bps", lambda t: t.entry_spread_bps),
        ]

        print(f"  {'Feature':<18} {'── Winners ──':>30}      {'── Losers ──':>30}")
        print(f"  {'':18} {'mean':>8} {'med':>8} {'p25':>8} {'p75':>8}  "
              f"   {'mean':>8} {'med':>8} {'p25':>8} {'p75':>8}   {'delta':>8}")
        print(f"  {'─' * 96}")

        for fname, getter in features:
            w_vals = [getter(t) for t in winners]
            l_vals = [getter(t) for t in losers]
            w_mean, w_med, w_p25, w_p75 = stats(w_vals)
            l_mean, l_med, l_p25, l_p75 = stats(l_vals)
            delta = l_mean - w_mean
            flag = " ⚠️" if abs(delta) > 0.3 else ""
            print(f"  {fname:<18} {w_mean:>+8.3f} {w_med:>+8.3f} {w_p25:>+8.3f} {w_p75:>+8.3f}  "
                  f"   {l_mean:>+8.3f} {l_med:>+8.3f} {l_p25:>+8.3f} {l_p75:>+8.3f}  "
                  f" {delta:>+8.3f}{flag}")

    # ── Gating Rule Search ──
    if len(warm) >= 10:
        print(f"\n{'─' * 100}")
        print(f"  GATING RULE SEARCH — Testing Candidate Thresholds")
        print(f"{'─' * 100}")

        rules = [
            # (name, filter_fn) — filter_fn returns True if trade should be BLOCKED
            ("TI_2s > 0.4", lambda t: t.entry_TI_2s > 0.4),
            ("TI_2s > 0.3", lambda t: t.entry_TI_2s > 0.3),
            ("TI_2s > 0.5", lambda t: t.entry_TI_2s > 0.5),
            ("z_ret > 2.0", lambda t: t.entry_z_ret_2s > 2.0),
            ("z_ret > 1.5", lambda t: t.entry_z_ret_2s > 1.5),
            ("pump > 3.0 & exh < 0", lambda t: t.entry_pump > 3.0 and t.entry_exhaust < 0),
            ("pump > 2.5 & exh < 0", lambda t: t.entry_pump > 2.5 and t.entry_exhaust < 0),
            ("TI > 0.3 & z_ret > 1.5", lambda t: t.entry_TI_2s > 0.3 and t.entry_z_ret_2s > 1.5),
            ("TI > 0.3 & z_ret > 1.0", lambda t: t.entry_TI_2s > 0.3 and t.entry_z_ret_2s > 1.0),
            ("TI > 0.4 & exh < -0.5", lambda t: t.entry_TI_2s > 0.4 and t.entry_exhaust < -0.5),
            ("persistent: TI>0.3 & z_ret>1.5 & exh<0",
             lambda t: t.entry_TI_2s > 0.3 and t.entry_z_ret_2s > 1.5 and t.entry_exhaust < 0),
        ]

        total_wins = len(winners)
        total_losses = len(losers)
        baseline_wr = total_wins / max(len(warm), 1) * 100
        baseline_ev = np.mean([t.pnl_bps for t in warm])
        baseline_pnl = sum(t.pnl_usd for t in warm)

        print(f"  Baseline: {len(warm)}T | WR {baseline_wr:.1f}% | EV {baseline_ev:+.1f}bp | PnL ${baseline_pnl:+.4f}")
        print()
        print(f"  {'Rule':<40} {'Block':>5} {'Pass':>5} {'BlkWin':>6} {'BlkLos':>6} "
              f"{'WinPreserved':>12} {'NewEV':>7} {'NewPnL':>9} {'Verdict':>8}")
        print(f"  {'─' * 104}")

        for name, gate_fn in rules:
            blocked = [t for t in warm if gate_fn(t)]
            passed = [t for t in warm if not gate_fn(t)]

            blocked_wins = sum(1 for t in blocked if t.pnl_usd > 0)
            blocked_losses = sum(1 for t in blocked if t.pnl_usd < 0)

            passed_wins = sum(1 for t in passed if t.pnl_usd > 0)
            win_preserved = passed_wins / max(total_wins, 1) * 100

            new_ev = np.mean([t.pnl_bps for t in passed]) if passed else 0
            new_pnl = sum(t.pnl_usd for t in passed)

            # Verdict
            if win_preserved >= 70 and new_ev > baseline_ev and blocked_losses > blocked_wins:
                verdict = "✅ GOOD"
            elif win_preserved >= 70 and new_ev > baseline_ev:
                verdict = "🟡 OK"
            elif win_preserved < 70:
                verdict = "❌ OVER"
            else:
                verdict = "❌ WORSE"

            print(f"  {name:<40} {len(blocked):>5} {len(passed):>5} "
                  f"{blocked_wins:>6} {blocked_losses:>6} "
                  f"{win_preserved:>10.1f}% {new_ev:>+6.1f}bp "
                  f"${new_pnl:>+8.4f} {verdict:>8}")

    # ── Entry vs Exit Signal Drift ──
    if warm:
        print(f"\n{'─' * 100}")
        print(f"  ENTRY → EXIT SIGNAL DRIFT")
        print(f"{'─' * 100}")
        print(f"  Positive drift = signal strengthened during hold (bad for shorts)")
        print(f"  Negative drift = signal faded (good for shorts — mean reversion)")
        print()
        print(f"  {'':>5} {'TI_2s drift':>14} {'pump drift':>14} {'z_ret drift':>14}")

        for label, subset in [("Winners", winners), ("Losers", losers)]:
            if not subset:
                continue
            ti_drift = np.mean([t.exit_TI_2s - t.entry_TI_2s for t in subset])
            pump_drift = np.mean([t.exit_pump - t.entry_pump for t in subset])
            zret_drift = np.mean([t.exit_z_ret_2s - t.entry_z_ret_2s for t in subset])
            print(f"  {label:>7}: {ti_drift:>+13.3f} {pump_drift:>+13.3f} {zret_drift:>+13.3f}")

    # ── Individual Loser Details ──
    big_losers = sorted([t for t in warm if t.pnl_bps < -5], key=lambda t: t.pnl_bps)[:15]
    if big_losers:
        print(f"\n{'─' * 100}")
        print(f"  TOP {len(big_losers)} BIGGEST LOSERS — Entry Signal Detail")
        print(f"{'─' * 100}")
        print(f"  {'Symbol':<16} {'PnL':>8} {'Reason':>8} {'TI_2s':>7} {'TI_500':>7} "
              f"{'z_ret':>7} {'pump':>7} {'exh':>7} {'QI':>7} {'rv':>7} {'Regime':<20}")
        print(f"  {'─' * 96}")

        for t in big_losers:
            regime = classify_regime(t)
            print(f"  {t.symbol:<16} {t.pnl_bps:>+7.1f}bp {t.reason:>8} "
                  f"{t.entry_TI_2s:>+6.3f} {t.entry_TI_500ms:>+6.3f} "
                  f"{t.entry_z_ret_2s:>+6.2f} {t.entry_pump:>+6.2f} "
                  f"{t.entry_exhaust:>+6.2f} {t.entry_QI:>+6.3f} "
                  f"{t.entry_rv:>6.4f} {regime:<20}")

    print_separator()
    print(f"  Analysis complete. {len(trades)} enriched trades analyzed.")
    print_separator()


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Flow Regime Segmentation Analysis")
    parser.add_argument("--session", "-s", default=None, help="Filter by session ID substring")
    parser.add_argument("--all", "-a", action="store_true", help="Include all sessions (default: enriched only)")
    parser.add_argument("--warm-only", "-w", action="store_true", help="Only analyze warm-signal trades")
    args = parser.parse_args()

    print(f"\n  Loading JSONL trades from {JSONL_DIR}...")
    trades, total_close, total_entry, no_sigs, cold = load_trades(args.session)

    print(f"  Files scanned: {len(glob.glob(os.path.join(JSONL_DIR, 'v7_*.jsonl')))}")
    print(f"  Total close events: {total_close}")
    print(f"  Total entry events: {total_entry}")
    print(f"  Skipped (no signals): {no_sigs}")
    print(f"  Cold start (zeros): {cold}")
    print(f"  Enriched trades: {len(trades)}")
    print()

    if args.warm_only:
        trades = [t for t in trades if t.has_warm_signals]
        print(f"  Filtered to warm-only: {len(trades)} trades")

    analyze_regimes(trades)


if __name__ == "__main__":
    main()
