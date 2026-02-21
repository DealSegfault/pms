#!/usr/bin/env python3
"""
Analyze multi-timeframe flow metrics from enriched JSONL close logs.

Purpose:
  - Find which new pair/global flow metrics separate winners from losers.
  - Propose simple candidate gates with winner-preservation constraints.
"""

import argparse
import glob
import json
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

JSONL_DIR = os.path.join(os.path.dirname(__file__), "v7_sessions")
FLOW_KEY_RE = re.compile(
    r"^(pair|global)_(tw|tps|nps|ti|lsr)_(1s|5s|10s|30s|60s|5m|10m)$"
)
EXTRA_KEYS = (
    "global_speed_ratio_1s_10s",
    "global_speed_ratio_5s_60s",
    "global_active_symbols_1s",
    "global_active_symbols_5s",
    "global_active_symbols_60s",
)


@dataclass
class Sample:
    session: str
    symbol: str
    pnl_usd: float
    pnl_bps: float
    metrics: Dict[str, float]


def _session_from_name(fname: str) -> str:
    parts = fname.replace(".jsonl", "").split("_")
    if len(parts) >= 3:
        return "_".join(parts[-2:])
    return "unknown"


def load_samples(session_filter: Optional[str] = None) -> List[Sample]:
    samples: List[Sample] = []
    for fpath in glob.glob(os.path.join(JSONL_DIR, "v7_*.jsonl")):
        fname = os.path.basename(fpath)
        session_id = _session_from_name(fname)
        if session_filter and session_filter not in session_id:
            continue

        with open(fpath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("action") != "close":
                    continue
                es = d.get("entry_signals", {}) or {}
                if not es:
                    continue
                # Require warm signals to avoid warmup contamination.
                if not any(float(v or 0.0) != 0.0 for v in es.values()):
                    continue

                metrics: Dict[str, float] = {}
                for k, v in es.items():
                    if FLOW_KEY_RE.match(k) or k in EXTRA_KEYS:
                        if isinstance(v, (int, float)):
                            metrics[k] = float(v)
                if not metrics:
                    continue

                samples.append(
                    Sample(
                        session=session_id,
                        symbol=str(d.get("symbol", "")),
                        pnl_usd=float(d.get("pnl_usd", 0.0) or 0.0),
                        pnl_bps=float(d.get("pnl_bps", 0.0) or 0.0),
                        metrics=metrics,
                    )
                )
    return samples


def fmt_delta(x: float) -> str:
    return f"{x:+.4f}"


def summarize_metrics(samples: List[Sample]) -> List[Tuple[str, float, float, float]]:
    wins = [s for s in samples if s.pnl_usd > 0]
    losses = [s for s in samples if s.pnl_usd < 0]

    keys = sorted({k for s in samples for k in s.metrics.keys()})
    rows: List[Tuple[str, float, float, float]] = []
    for key in keys:
        w_vals = [s.metrics[key] for s in wins if key in s.metrics]
        l_vals = [s.metrics[key] for s in losses if key in s.metrics]
        if not w_vals or not l_vals:
            continue
        w_mean = float(np.mean(w_vals))
        l_mean = float(np.mean(l_vals))
        rows.append((key, w_mean, l_mean, l_mean - w_mean))
    rows.sort(key=lambda r: abs(r[3]), reverse=True)
    return rows


def best_gate_for_metric(
    samples: List[Sample],
    key: str,
    min_win_preserve: float,
) -> Optional[Dict[str, float]]:
    vals = [s.metrics[key] for s in samples if key in s.metrics]
    if len(vals) < 20:
        return None

    wins = [s for s in samples if s.pnl_usd > 0 and key in s.metrics]
    losses = [s for s in samples if s.pnl_usd < 0 and key in s.metrics]
    if len(wins) < 10 or len(losses) < 10:
        return None

    baseline_ev = float(np.mean([s.pnl_bps for s in samples]))
    total_wins = len([s for s in samples if s.pnl_usd > 0])
    w_mean = float(np.mean([s.metrics[key] for s in wins]))
    l_mean = float(np.mean([s.metrics[key] for s in losses]))
    block_high = l_mean > w_mean

    best = None
    for q in (20, 30, 40, 50, 60, 70, 80):
        thr = float(np.percentile(vals, q))
        if block_high:
            blocked = [s for s in samples if s.metrics.get(key, 0.0) >= thr]
            passed = [s for s in samples if s.metrics.get(key, 0.0) < thr]
        else:
            blocked = [s for s in samples if s.metrics.get(key, 0.0) <= thr]
            passed = [s for s in samples if s.metrics.get(key, 0.0) > thr]

        if not passed:
            continue
        blocked_wins = sum(1 for s in blocked if s.pnl_usd > 0)
        blocked_losses = sum(1 for s in blocked if s.pnl_usd < 0)
        passed_wins = sum(1 for s in passed if s.pnl_usd > 0)
        win_preserved = passed_wins / max(total_wins, 1)
        new_ev = float(np.mean([s.pnl_bps for s in passed]))

        candidate = {
            "key": key,
            "q": float(q),
            "thr": thr,
            "block_high": 1.0 if block_high else 0.0,
            "blocked": float(len(blocked)),
            "blocked_wins": float(blocked_wins),
            "blocked_losses": float(blocked_losses),
            "win_preserved": win_preserved,
            "new_ev": new_ev,
            "ev_lift": new_ev - baseline_ev,
        }
        if candidate["win_preserved"] < min_win_preserve:
            continue
        if candidate["blocked_losses"] <= candidate["blocked_wins"]:
            continue
        if candidate["ev_lift"] < 0:
            continue
        if best is None or candidate["ev_lift"] > best["ev_lift"]:
            best = candidate
    return best


def main():
    ap = argparse.ArgumentParser(description="Analyze multi-timeframe flow window metrics")
    ap.add_argument("--session", default=None, help="Session id substring (e.g. 20260209_044547)")
    ap.add_argument("--min-losses", type=int, default=20, help="Min losses required for gate search")
    ap.add_argument("--min-win-preserve", type=float, default=0.80, help="Winner preservation floor")
    args = ap.parse_args()

    samples = load_samples(args.session)
    if not samples:
        print("No enriched warm samples with flow metrics found.")
        return

    wins = [s for s in samples if s.pnl_usd > 0]
    losses = [s for s in samples if s.pnl_usd < 0]
    sessions = sorted({s.session for s in samples})
    baseline_ev = float(np.mean([s.pnl_bps for s in samples]))

    print("Flow Metrics Analysis")
    print(f"Samples: {len(samples)} | Wins: {len(wins)} | Losses: {len(losses)}")
    print(f"Sessions: {len(sessions)} | Baseline EV: {baseline_ev:+.3f}bp")
    print()

    print("Top winner/loss separators (mean delta = loss - win):")
    rows = summarize_metrics(samples)
    for key, w_mean, l_mean, delta in rows[:20]:
        print(
            f"  {key:<30} win={w_mean:+.4f} loss={l_mean:+.4f} delta={fmt_delta(delta)}"
        )

    print()
    if len(losses) < args.min_losses:
        print(
            f"Gate search skipped: losses={len(losses)} < min_losses={args.min_losses}. "
            "Collect more sessions first."
        )
        return

    candidates = []
    metric_keys = sorted({k for s in samples for k in s.metrics.keys()})
    for key in metric_keys:
        best = best_gate_for_metric(samples, key, args.min_win_preserve)
        if best is not None:
            candidates.append(best)

    if not candidates:
        print("No qualifying single-metric gate found under current constraints.")
        return

    candidates.sort(key=lambda c: c["ev_lift"], reverse=True)
    print("Best candidate gates:")
    for c in candidates[:15]:
        op = ">=" if c["block_high"] > 0.5 else "<="
        print(
            f"  block if {c['key']} {op} {c['thr']:.6f} "
            f"(q{int(c['q'])}, blocked={int(c['blocked'])}, "
            f"blocked W/L={int(c['blocked_wins'])}/{int(c['blocked_losses'])}, "
            f"win_preserved={c['win_preserved']*100:.1f}%, "
            f"EV lift={c['ev_lift']:+.3f}bp)"
        )


if __name__ == "__main__":
    main()
