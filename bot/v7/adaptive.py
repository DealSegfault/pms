#!/usr/bin/env python3
"""Adaptive run planner for v7 based on previous session logs."""

from __future__ import annotations

import glob
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

SESSION_RE = re.compile(r"^v7_[A-Z0-9]+_(\d{8}_\d{6})\.jsonl$")
BAD_EXIT_REASONS = {"stop", "timeout", "shutdown", "drawdown"}


@dataclass
class AdaptivePlan:
    mode: str
    sessions_used: int
    trades_used: int
    lookback_sessions: int
    overrides: Dict[str, Any] = field(default_factory=dict)
    auto_blacklist: List[str] = field(default_factory=list)
    summary: Dict[str, Any] = field(default_factory=dict)
    reason_rates: Dict[str, float] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)


def _session_files(log_dir: str) -> Dict[str, List[str]]:
    groups: Dict[str, List[str]] = {}
    for path in glob.glob(os.path.join(log_dir, "v7_*.jsonl")):
        name = os.path.basename(path)
        m = SESSION_RE.match(name)
        if not m:
            continue
        session_id = m.group(1)
        groups.setdefault(session_id, []).append(path)
    return groups


def _load_close_trades(paths: Sequence[str], live_only: Optional[bool] = None) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for path in paths:
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if row.get("action") != "close":
                        continue
                    if live_only is not None and bool(row.get("live", False)) != bool(live_only):
                        continue
                    out.append(row)
        except FileNotFoundError:
            continue
    return out


def _summarize(trades: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(trades)
    if n == 0:
        return {
            "trade_count": 0,
            "sum_usd": 0.0,
            "sum_bps": 0.0,
            "avg_usd": 0.0,
            "avg_bps": 0.0,
            "cap_bps": 0.0,
            "worst_bps": 0.0,
            "win_rate": 0.0,
            "bad_exit_rate": 0.0,
            "timeout_rate": 0.0,
        }

    sum_usd = 0.0
    sum_bps = 0.0
    sum_notional = 0.0
    wins = 0
    worst_bps: Optional[float] = None
    bad_exit_n = 0
    timeout_n = 0

    for t in trades:
        pnl_usd = float(t.get("pnl_usd", 0.0) or 0.0)
        pnl_bps = float(t.get("pnl_bps", 0.0) or 0.0)
        notional = float(t.get("total_notional", 0.0) or 0.0)
        reason = str(t.get("reason", ""))

        sum_usd += pnl_usd
        sum_bps += pnl_bps
        sum_notional += max(notional, 0.0)
        if pnl_usd > 0:
            wins += 1
        if worst_bps is None or pnl_bps < worst_bps:
            worst_bps = pnl_bps
        if reason in BAD_EXIT_REASONS:
            bad_exit_n += 1
        if reason == "timeout":
            timeout_n += 1

    return {
        "trade_count": n,
        "sum_usd": sum_usd,
        "sum_bps": sum_bps,
        "avg_usd": sum_usd / n,
        "avg_bps": sum_bps / n,
        "cap_bps": (sum_usd / sum_notional * 10000.0) if sum_notional > 0 else 0.0,
        "worst_bps": float(worst_bps if worst_bps is not None else 0.0),
        "win_rate": wins / n,
        "bad_exit_rate": bad_exit_n / n,
        "timeout_rate": timeout_n / n,
    }


def _reason_rates(trades: Sequence[Dict[str, Any]]) -> Dict[str, float]:
    if not trades:
        return {}
    counts: Dict[str, int] = {}
    n = len(trades)
    for t in trades:
        reason = str(t.get("reason", ""))
        counts[reason] = counts.get(reason, 0) + 1
    return {k: v / n for k, v in sorted(counts.items(), key=lambda kv: kv[0])}


def _symbol_stats(trades: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    grouped: Dict[str, Dict[str, float]] = {}
    for t in trades:
        symbol = str(t.get("symbol", "")).upper()
        if not symbol:
            continue
        g = grouped.setdefault(
            symbol, {"n": 0.0, "sum_usd": 0.0, "sum_bps": 0.0, "sum_notional": 0.0, "worst_bps": 0.0}
        )
        pnl_usd = float(t.get("pnl_usd", 0.0) or 0.0)
        pnl_bps = float(t.get("pnl_bps", 0.0) or 0.0)
        notional = float(t.get("total_notional", 0.0) or 0.0)
        g["n"] += 1.0
        g["sum_usd"] += pnl_usd
        g["sum_bps"] += pnl_bps
        g["sum_notional"] += max(notional, 0.0)
        if g["n"] == 1:
            g["worst_bps"] = pnl_bps
        else:
            g["worst_bps"] = min(g["worst_bps"], pnl_bps)

    for symbol, g in grouped.items():
        n = max(g["n"], 1.0)
        g["avg_bps"] = g["sum_bps"] / n
        g["cap_bps"] = (g["sum_usd"] / g["sum_notional"] * 10000.0) if g["sum_notional"] > 0 else 0.0
    return grouped


def _auto_blacklist_symbols(trades: Sequence[Dict[str, Any]]) -> List[str]:
    stats = _symbol_stats(trades)
    out: Set[str] = set()
    for symbol, s in stats.items():
        n = int(s["n"])
        cap_bps = float(s.get("cap_bps", 0.0))
        avg_bps = float(s.get("avg_bps", 0.0))
        worst_bps = float(s.get("worst_bps", 0.0))
        # Keep this conservative: only blacklist symbols with enough evidence.
        if n >= 20 and cap_bps <= -20.0:
            out.add(symbol)
        elif n >= 30 and avg_bps <= -10.0 and worst_bps <= -150.0:
            out.add(symbol)
    return sorted(out)


def build_adaptive_plan(
    config: Any,
    lookback_sessions: int = 5,
    live_only: bool = True,
    exclude_session_id: Optional[str] = None,
) -> AdaptivePlan:
    groups = _session_files(config.log_dir)
    sessions = sorted(groups.keys(), reverse=True)
    if exclude_session_id:
        sessions = [s for s in sessions if s != exclude_session_id]

    picked_sessions = sessions[: max(1, int(lookback_sessions))]
    picked_files: List[str] = []
    for sid in picked_sessions:
        picked_files.extend(groups.get(sid, []))

    trades = _load_close_trades(picked_files, live_only=live_only)
    summary = _summarize(trades)
    reason_rates = _reason_rates(trades)

    overrides: Dict[str, Any] = {}
    notes: List[str] = []

    if summary["trade_count"] < 120:
        mode = "cold_start_defensive"
        notes.append("Insufficient recent trade count; forcing defensive defaults.")
        overrides["min_spread_bps"] = max(float(config.min_spread_bps), 5.0)
        overrides["max_spread_bps"] = min(float(config.max_spread_bps), 15.0)
        overrides["max_trend_bps"] = min(float(config.max_trend_bps), 5.0)
        overrides["loss_cooldown_sec"] = max(float(config.loss_cooldown_sec), 8.0)
    else:
        cap_bps = float(summary["cap_bps"])
        worst_bps = float(summary["worst_bps"])
        bad_exit_rate = float(summary["bad_exit_rate"])

        if cap_bps < 0.0 or worst_bps <= -500.0 or bad_exit_rate >= 0.20:
            mode = "defensive"
            notes.append("Recent EV/risk weak; tightening filters and grid depth.")
            overrides["min_spread_bps"] = max(float(config.min_spread_bps), 5.0)
            overrides["max_spread_bps"] = min(float(config.max_spread_bps), 15.0)
            overrides["max_trend_bps"] = min(float(config.max_trend_bps), 5.0)
            overrides["loss_cooldown_sec"] = max(float(config.loss_cooldown_sec), 8.0)
        elif cap_bps >= 15.0 and worst_bps > -350.0 and bad_exit_rate <= 0.12:
            mode = "balanced_expand"
            notes.append("Recent EV strong; keeping safety but allowing moderate throughput.")
            overrides["min_spread_bps"] = max(float(config.min_spread_bps), 5.0)
            overrides["max_spread_bps"] = min(max(float(config.max_spread_bps), 15.0), 18.0)
            overrides["max_trend_bps"] = min(float(config.max_trend_bps), 5.0)
        else:
            mode = "stabilize"
            notes.append("Recent EV mixed; using stable spread/trend regime filters.")
            overrides["min_spread_bps"] = max(float(config.min_spread_bps), 5.0)
            overrides["max_spread_bps"] = min(float(config.max_spread_bps), 15.0)
            overrides["max_trend_bps"] = min(float(config.max_trend_bps), 5.0)

    auto_blacklist = _auto_blacklist_symbols(trades)
    if auto_blacklist:
        notes.append(f"Auto-blacklisted symbols from recent runs: {', '.join(auto_blacklist)}")

    return AdaptivePlan(
        mode=mode,
        sessions_used=len(picked_sessions),
        trades_used=len(trades),
        lookback_sessions=max(1, int(lookback_sessions)),
        overrides=overrides,
        auto_blacklist=auto_blacklist,
        summary=summary,
        reason_rates=reason_rates,
        notes=notes,
    )


def apply_adaptive_plan(config: Any, plan: AdaptivePlan) -> None:
    for key, value in plan.overrides.items():
        setattr(config, key, value)
    merged = set(config.blacklist or set())
    merged.update(plan.auto_blacklist)
    config.blacklist = merged


def load_session_trades(log_dir: str, session_id: str, live_only: Optional[bool] = None) -> List[Dict[str, Any]]:
    paths = glob.glob(os.path.join(log_dir, f"v7_*_{session_id}.jsonl"))
    return _load_close_trades(paths, live_only=live_only)


def summarize_session(log_dir: str, session_id: str, live_only: Optional[bool] = None) -> Dict[str, Any]:
    trades = load_session_trades(log_dir, session_id, live_only=live_only)
    return _summarize(trades)


def update_adaptive_state(
    state_path: str,
    session_id: str,
    plan: AdaptivePlan,
    session_summary: Dict[str, Any],
) -> None:
    path = Path(state_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    state: Dict[str, Any] = {"version": 1, "runs": []}
    if path.exists():
        try:
            state = json.loads(path.read_text())
            if not isinstance(state, dict):
                state = {"version": 1, "runs": []}
        except Exception:
            state = {"version": 1, "runs": []}

    runs = state.get("runs")
    if not isinstance(runs, list):
        runs = []

    run_entry = {
        "ts": time.time(),
        "session_id": session_id,
        "plan_mode": plan.mode,
        "plan_overrides": plan.overrides,
        "auto_blacklist": plan.auto_blacklist,
        "lookback_sessions": plan.lookback_sessions,
        "sessions_used": plan.sessions_used,
        "trades_used_for_plan": plan.trades_used,
        "session_summary": session_summary,
    }
    runs.append(run_entry)
    state["runs"] = runs[-120:]
    state["last_updated"] = time.time()
    state["last_session_id"] = session_id
    state["last_plan_mode"] = plan.mode
    path.write_text(json.dumps(state, indent=2, sort_keys=True))
