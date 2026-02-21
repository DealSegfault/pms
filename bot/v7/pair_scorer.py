#!/usr/bin/env python3
"""
Per-pair scoring from recent JSONL trade logs.

Computes opportunity, risk, and EV scores for each actively-traded pair.
Designed to be called periodically from the display loop.
"""
import json
import glob
import os
import time
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class PairScore:
    """Scoring summary for one symbol."""
    symbol: str
    # Raw stats
    entries: int = 0
    closes: int = 0
    win_rate: float = 0.0
    avg_pnl_bps: float = 0.0
    total_pnl_usd: float = 0.0
    max_exposure_usd: float = 0.0
    max_layers: int = 0
    worst_trade_bps: float = 0.0
    cum_dd_bps: float = 0.0          # Cumulative drawdown (worst trough)
    avg_notional: float = 0.0
    avg_hold_sec: float = 0.0        # Avg time between entry and close
    median_spread_bps: float = 0.0
    # Scores (0-100)
    opportunity_score: float = 0.0   # How active/tradeable
    risk_score: float = 0.0          # How dangerous (higher = riskier)
    ev_score: float = 0.0            # Expected value quality
    composite_score: float = 0.0     # Weighted overall

    @property
    def grade(self) -> str:
        """Letter grade from composite score."""
        if self.composite_score >= 80:
            return "A"
        elif self.composite_score >= 60:
            return "B"
        elif self.composite_score >= 40:
            return "C"
        elif self.composite_score >= 20:
            return "D"
        return "F"

    @property
    def grade_emoji(self) -> str:
        g = self.grade
        return {"A": "🟢", "B": "🔵", "C": "🟡", "D": "🟠", "F": "🔴"}[g]


def compute_pair_scores(
    log_dir: str,
    session_id: str,
    lookback_sec: float = 3600.0,
) -> Dict[str, PairScore]:
    """
    Read JSONL files for the current session, compute per-pair scores.

    Returns dict of symbol -> PairScore.
    """
    now = time.time()
    cutoff = now - lookback_sec

    # Find all JSONL files for this session
    pattern = os.path.join(log_dir, f"v7_*_{session_id}.jsonl")
    files = glob.glob(pattern)

    if not files:
        return {}

    # Parse all events
    events_by_sym: Dict[str, List[dict]] = {}
    for filepath in files:
        try:
            with open(filepath) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = rec.get("ts", 0)
                    if ts < cutoff:
                        continue
                    sym = rec.get("symbol", "")
                    if sym:
                        events_by_sym.setdefault(sym, []).append(rec)
        except Exception:
            continue

    if not events_by_sym:
        return {}

    # Compute raw stats per symbol
    scores: Dict[str, PairScore] = {}

    for sym, evts in events_by_sym.items():
        evts.sort(key=lambda x: x.get("ts", 0))
        entries = [e for e in evts if e.get("action") == "entry"]
        closes = [e for e in evts if e.get("action") == "close"]

        ps = PairScore(symbol=sym)
        ps.entries = len(entries)
        ps.closes = len(closes)

        # Max exposure from entries
        if entries:
            ps.max_exposure_usd = max(e.get("grid_notional", 0) for e in entries)
            ps.max_layers = max(e.get("grid_layers", 0) for e in entries)
            notionals = [e.get("notional", 0) for e in entries]
            ps.avg_notional = sum(notionals) / len(notionals) if notionals else 0
            spreads = [e.get("median_spread_bps", 0) for e in entries if e.get("median_spread_bps", 0) > 0]
            ps.median_spread_bps = sum(spreads) / len(spreads) if spreads else 0

        # Close stats
        if closes:
            pnls_bps = [c.get("pnl_bps", 0) for c in closes]
            pnls_usd = [c.get("pnl_usd", 0) for c in closes]
            wins = sum(1 for p in pnls_bps if p > 0)

            ps.win_rate = wins / len(pnls_bps) * 100
            ps.avg_pnl_bps = sum(pnls_bps) / len(pnls_bps)
            ps.total_pnl_usd = sum(pnls_usd)
            ps.worst_trade_bps = min(pnls_bps)

            # Cumulative DD (equity curve worst trough)
            cum = 0.0
            peak = 0.0
            worst_dd = 0.0
            for p in pnls_bps:
                cum += p
                peak = max(peak, cum)
                dd = cum - peak
                worst_dd = min(worst_dd, dd)
            ps.cum_dd_bps = worst_dd

        scores[sym] = ps

    # ═══ Scoring ═══

    # Collect distributions for normalization
    all_scores = list(scores.values())
    if not all_scores:
        return scores

    # --- Opportunity Score (0-100) ---
    # Based on: trade frequency, spread quality, entry count
    max_entries = max(s.entries for s in all_scores) or 1
    max_closes = max(s.closes for s in all_scores) or 1

    for ps in all_scores:
        freq = (ps.entries + ps.closes) / (max_entries + max_closes) * 40       # Activity: 0-40
        spread_q = min(ps.median_spread_bps / 15.0, 1.0) * 30                  # Spread quality: 0-30
        completion = (ps.closes / max(ps.entries, 1)) * 30                      # Completion rate: 0-30
        ps.opportunity_score = min(100, freq + spread_q + completion)

    # --- Risk Score (0-100, higher = riskier) ---
    max_exp = max(s.max_exposure_usd for s in all_scores) or 1
    max_layers_all = max(s.max_layers for s in all_scores) or 1

    for ps in all_scores:
        exp_risk = (ps.max_exposure_usd / max_exp) * 30                         # Exposure: 0-30
        layer_risk = (ps.max_layers / max_layers_all) * 20                      # Layer depth: 0-20
        dd_risk = min(abs(ps.cum_dd_bps) / 30.0, 1.0) * 30                     # DD severity: 0-30
        loss_risk = (1.0 - ps.win_rate / 100.0) * 20 if ps.closes > 0 else 10  # Loss rate: 0-20
        ps.risk_score = min(100, exp_risk + layer_risk + dd_risk + loss_risk)

    # --- EV Score (0-100) ---
    max_avg_pnl = max((s.avg_pnl_bps for s in all_scores if s.closes > 0), default=1) or 1
    max_total_usd = max((abs(s.total_pnl_usd) for s in all_scores if s.closes > 0), default=0.01) or 0.01

    for ps in all_scores:
        if ps.closes == 0:
            ps.ev_score = 25  # Unknown, neutral
            continue
        wr_component = ps.win_rate * 0.35                                       # Win rate: 0-35
        avg_pnl_component = max(0, ps.avg_pnl_bps / max_avg_pnl) * 35          # Avg PnL: 0-35
        usd_component = max(0, ps.total_pnl_usd / max_total_usd) * 30          # USD PnL: 0-30
        ps.ev_score = min(100, wr_component + avg_pnl_component + usd_component)

    # --- Composite ---
    for ps in all_scores:
        # EV weighted most heavily, risk penalizes
        ps.composite_score = (
            ps.ev_score * 0.50 +
            ps.opportunity_score * 0.25 +
            (100 - ps.risk_score) * 0.25
        )

    return scores


def format_score_dashboard(
    scores: Dict[str, PairScore],
    top_n: int = 15,
) -> List[str]:
    """
    Format scores into dashboard lines for the display loop.

    Returns list of formatted strings.
    """
    if not scores:
        return ["  (no scored pairs yet)"]

    # Sort by composite score descending
    ranked = sorted(scores.values(), key=lambda s: s.composite_score, reverse=True)

    lines = []
    lines.append(
        f"  {'Pair':<14s} {'Grade':>5s} {'Comp':>4s} | "
        f"{'Opp':>3s} {'Risk':>4s} {'EV':>3s} | "
        f"{'WR':>3s} {'AvgBP':>6s} {'$PnL':>8s} | "
        f"{'MaxExp':>7s} {'MaxL':>4s} {'DD':>6s} | "
        f"{'E':>2s} {'C':>2s}"
    )
    lines.append(f"  {'─' * 100}")

    for ps in ranked[:top_n]:
        grade_str = f"{ps.grade_emoji}{ps.grade}"
        lines.append(
            f"  {ps.symbol:<14s} {grade_str:>5s} {ps.composite_score:4.0f} | "
            f"{ps.opportunity_score:3.0f} {ps.risk_score:4.0f} {ps.ev_score:3.0f} | "
            f"{ps.win_rate:3.0f} {ps.avg_pnl_bps:>+5.1f} {ps.total_pnl_usd:>+7.4f} | "
            f"${ps.max_exposure_usd:>6.0f} {'L'+str(ps.max_layers):>4s} {ps.cum_dd_bps:>+5.1f} | "
            f"{ps.entries:>2d} {ps.closes:>2d}"
        )

    # Summary line
    total_usd = sum(s.total_pnl_usd for s in ranked)
    avg_wr = sum(s.win_rate for s in ranked if s.closes > 0) / max(1, sum(1 for s in ranked if s.closes > 0))
    avg_comp = sum(s.composite_score for s in ranked) / len(ranked)
    a_count = sum(1 for s in ranked if s.grade == "A")
    b_count = sum(1 for s in ranked if s.grade == "B")
    c_count = sum(1 for s in ranked if s.grade == "C")
    df_count = sum(1 for s in ranked if s.grade in ("D", "F"))
    lines.append(f"  {'─' * 100}")
    lines.append(
        f"  {'TOTAL':<14s} avg={avg_comp:.0f} | "
        f"🟢{a_count} 🔵{b_count} 🟡{c_count} 🔴{df_count} | "
        f"WR={avg_wr:.0f}% ${total_usd:+.4f} | "
        f"{len(ranked)} pairs scored"
    )

    return lines
