"""
TCARollupWorker — periodic aggregate read-model builder for TCA tables.

Computes sub-account and strategy-session rollups from `order_lifecycles`,
`fill_facts`, and `fill_markouts`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_epoch_ms(value: Any) -> Optional[float]:
    if value in (None, "", "None"):
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).timestamp() * 1000.0
    if isinstance(value, (int, float)):
        numeric = float(value)
        return numeric if numeric > 10_000_000_000 else numeric * 1000.0
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() * 1000.0
        except ValueError:
            try:
                return _to_epoch_ms(float(value))
            except ValueError:
                return None
    return None


def _safe_avg(total: float, count: int) -> Optional[float]:
    return (total / count) if count else None


def _arrival_slippage_bps(side: str, decision_mid: float, avg_fill_price: float) -> Optional[float]:
    if decision_mid <= 0 or avg_fill_price <= 0:
        return None
    if side == "SELL":
        return ((decision_mid - avg_fill_price) / decision_mid) * 10_000.0
    return ((avg_fill_price - decision_mid) / decision_mid) * 10_000.0


def _new_rollup() -> Dict[str, Any]:
    return {
        "sub_account_id": None,
        "strategy_type": None,
        "order_count": 0,
        "terminal_order_count": 0,
        "fill_count": 0,
        "cancel_count": 0,
        "reject_count": 0,
        "total_requested_qty": 0.0,
        "total_filled_qty": 0.0,
        "total_fill_notional": 0.0,
        "total_reprice_count": 0,
        "arrival_slippage_total": 0.0,
        "arrival_slippage_count": 0,
        "ack_latency_total": 0.0,
        "ack_latency_count": 0,
        "working_time_total": 0.0,
        "working_time_count": 0,
        "markout_1s_total": 0.0,
        "markout_1s_count": 0,
        "markout_5s_total": 0.0,
        "markout_5s_count": 0,
        "markout_30s_total": 0.0,
        "markout_30s_count": 0,
    }


def _digest_value(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 10)
    return value


def _rollup_change_digest(
    sub_rollups: Dict[Tuple[str, str, str], Dict[str, Any]],
    strategy_rollups: Dict[Tuple[str, str, str], Dict[str, Any]],
) -> str:
    def encode_bucket(
        buckets: Dict[Tuple[str, str, str], Dict[str, Any]],
        key_names: Tuple[str, str, str],
    ) -> list:
        rows = []
        for key, agg in sorted(buckets.items(), key=lambda item: item[0]):
            key_part = {name: _digest_value(value) for name, value in zip(key_names, key)}
            agg_part = {name: _digest_value(agg.get(name)) for name in sorted(agg.keys())}
            rows.append({
                "key": key_part,
                "agg": agg_part,
            })
        return rows

    payload = {
        "sub": encode_bucket(sub_rollups, ("sub_account_id", "execution_scope", "ownership_confidence")),
        "strategy": encode_bucket(strategy_rollups, ("strategy_session_id", "execution_scope", "ownership_confidence")),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


class TCARollupWorker:
    """Periodic rebuild of TCA rollup tables."""

    def __init__(self, db: Any, *, interval_sec: float = 15.0) -> None:
        self._db = db
        self._interval_sec = interval_sec
        self._last_log_digest: Optional[str] = None

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                summary = await self.recompute_once()
                changed = summary.get("change_digest") != self._last_log_digest
                if changed and (summary["sub_account_rollups"] or summary["strategy_rollups"]):
                    logger.info(
                        "TCARollupWorker rebuilt %d sub-account rollup(s) and %d strategy rollup(s)",
                        summary["sub_account_rollups"],
                        summary["strategy_rollups"],
                    )
                if changed:
                    self._last_log_digest = summary.get("change_digest")
            except Exception as exc:
                logger.error("TCARollupWorker error: %s", exc)

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_sec)
            except asyncio.TimeoutError:
                continue

    async def recompute_once(self) -> dict:
        if not self._db:
            return {
                "sub_account_rollups": 0,
                "strategy_rollups": 0,
                "change_digest": None,
            }

        lifecycles = await self._db.fetch_all("SELECT * FROM order_lifecycles")
        fills = await self._db.fetch_all("SELECT * FROM fill_facts")
        markouts = await self._db.fetch_all("SELECT * FROM fill_markouts")

        markouts_by_fill: Dict[str, Dict[int, float]] = {}
        for row in markouts or []:
            horizon_ms = int(row.get("horizon_ms") or 0)
            markout_bps = row.get("markout_bps")
            if horizon_ms <= 0 or markout_bps is None:
                continue
            markouts_by_fill.setdefault(row["fill_fact_id"], {})[horizon_ms] = float(markout_bps)

        sub_rollups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        strategy_rollups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

        for row in lifecycles or []:
            execution_scope = row.get("execution_scope") or "SUB_ACCOUNT"
            ownership_confidence = row.get("ownership_confidence") or "HARD"
            sub_account_id = row.get("sub_account_id")
            strategy_session_id = row.get("strategy_session_id")

            ack_ts = _to_epoch_ms(row.get("ack_ts"))
            intent_ts = _to_epoch_ms(row.get("intent_ts"))
            done_ts = _to_epoch_ms(row.get("done_ts"))

            if sub_account_id:
                agg = sub_rollups.setdefault((sub_account_id, execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = sub_account_id
                self._accumulate_lifecycle(agg, row, ack_ts, intent_ts, done_ts)

            if strategy_session_id:
                agg = strategy_rollups.setdefault((strategy_session_id, execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or sub_account_id
                agg["strategy_type"] = agg["strategy_type"] or row.get("strategy_type")
                self._accumulate_lifecycle(agg, row, ack_ts, intent_ts, done_ts)

        for row in fills or []:
            execution_scope = row.get("execution_scope") or "SUB_ACCOUNT"
            ownership_confidence = row.get("ownership_confidence") or "HARD"
            sub_account_id = row.get("sub_account_id")
            lifecycle_id = row.get("lifecycle_id")
            markout_map = markouts_by_fill.get(row["id"], {})
            strategy_session_id = None
            strategy_type = None
            for lifecycle in lifecycles or []:
                if lifecycle["id"] == lifecycle_id:
                    strategy_session_id = lifecycle.get("strategy_session_id")
                    strategy_type = lifecycle.get("strategy_type")
                    if not sub_account_id:
                        sub_account_id = lifecycle.get("sub_account_id")
                    break

            if sub_account_id:
                agg = sub_rollups.setdefault((sub_account_id, execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = sub_account_id
                self._accumulate_fill(agg, row, markout_map)

            if strategy_session_id:
                agg = strategy_rollups.setdefault((strategy_session_id, execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or sub_account_id
                agg["strategy_type"] = agg["strategy_type"] or strategy_type
                self._accumulate_fill(agg, row, markout_map)

        await self._db.execute("DELETE FROM sub_account_tca_rollups")
        await self._db.execute("DELETE FROM strategy_tca_rollups")

        now = _now_utc()
        for (sub_account_id, execution_scope, ownership_confidence), agg in sub_rollups.items():
            await self._db.execute(
                """INSERT INTO sub_account_tca_rollups
                   (id, sub_account_id, execution_scope, ownership_confidence, order_count,
                    terminal_order_count, fill_count, cancel_count, reject_count,
                    total_requested_qty, total_filled_qty, total_fill_notional,
                    fill_ratio, cancel_to_fill_ratio, avg_arrival_slippage_bps, avg_ack_latency_ms, avg_working_time_ms,
                    avg_markout_1s_bps, avg_markout_5s_bps, avg_markout_30s_bps,
                    total_reprice_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(uuid.uuid4()),
                    sub_account_id,
                    execution_scope,
                    ownership_confidence,
                    agg["order_count"],
                    agg["terminal_order_count"],
                    agg["fill_count"],
                    agg["cancel_count"],
                    agg["reject_count"],
                    agg["total_requested_qty"],
                    agg["total_filled_qty"],
                    agg["total_fill_notional"],
                    (agg["total_filled_qty"] / agg["total_requested_qty"]) if agg["total_requested_qty"] > 0 else None,
                    (agg["cancel_count"] / agg["fill_count"]) if agg["fill_count"] > 0 else None,
                    _safe_avg(agg["arrival_slippage_total"], agg["arrival_slippage_count"]),
                    _safe_avg(agg["ack_latency_total"], agg["ack_latency_count"]),
                    _safe_avg(agg["working_time_total"], agg["working_time_count"]),
                    _safe_avg(agg["markout_1s_total"], agg["markout_1s_count"]),
                    _safe_avg(agg["markout_5s_total"], agg["markout_5s_count"]),
                    _safe_avg(agg["markout_30s_total"], agg["markout_30s_count"]),
                    agg["total_reprice_count"],
                    now,
                    now,
                ),
            )

        for (strategy_session_id, execution_scope, ownership_confidence), agg in strategy_rollups.items():
            await self._db.execute(
                """INSERT INTO strategy_tca_rollups
                   (id, strategy_session_id, sub_account_id, strategy_type, execution_scope,
                    ownership_confidence, order_count, terminal_order_count, fill_count,
                    cancel_count, reject_count, total_requested_qty, total_filled_qty,
                    total_fill_notional, fill_ratio, cancel_to_fill_ratio, avg_arrival_slippage_bps, avg_ack_latency_ms,
                    avg_working_time_ms, avg_markout_1s_bps, avg_markout_5s_bps,
                    avg_markout_30s_bps, total_reprice_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(uuid.uuid4()),
                    strategy_session_id,
                    agg["sub_account_id"],
                    agg["strategy_type"],
                    execution_scope,
                    ownership_confidence,
                    agg["order_count"],
                    agg["terminal_order_count"],
                    agg["fill_count"],
                    agg["cancel_count"],
                    agg["reject_count"],
                    agg["total_requested_qty"],
                    agg["total_filled_qty"],
                    agg["total_fill_notional"],
                    (agg["total_filled_qty"] / agg["total_requested_qty"]) if agg["total_requested_qty"] > 0 else None,
                    (agg["cancel_count"] / agg["fill_count"]) if agg["fill_count"] > 0 else None,
                    _safe_avg(agg["arrival_slippage_total"], agg["arrival_slippage_count"]),
                    _safe_avg(agg["ack_latency_total"], agg["ack_latency_count"]),
                    _safe_avg(agg["working_time_total"], agg["working_time_count"]),
                    _safe_avg(agg["markout_1s_total"], agg["markout_1s_count"]),
                    _safe_avg(agg["markout_5s_total"], agg["markout_5s_count"]),
                    _safe_avg(agg["markout_30s_total"], agg["markout_30s_count"]),
                    agg["total_reprice_count"],
                    now,
                    now,
                ),
            )

        return {
            "sub_account_rollups": len(sub_rollups),
            "strategy_rollups": len(strategy_rollups),
            "change_digest": _rollup_change_digest(sub_rollups, strategy_rollups),
        }

    @staticmethod
    def _accumulate_lifecycle(agg: Dict[str, Any], row: dict, ack_ts: Optional[float], intent_ts: Optional[float], done_ts: Optional[float]) -> None:
        agg["order_count"] += 1
        agg["total_requested_qty"] += float(row.get("requested_qty", 0) or 0)
        agg["total_reprice_count"] += int(row.get("reprice_count", 0) or 0)

        decision_mid = float(row.get("decision_mid", 0) or 0)
        avg_fill_price = float(row.get("avg_fill_price", 0) or 0)
        arrival_slippage = _arrival_slippage_bps(
            str(row.get("side", "") or "").upper(),
            decision_mid,
            avg_fill_price,
        )
        if arrival_slippage is not None:
            agg["arrival_slippage_total"] += arrival_slippage
            agg["arrival_slippage_count"] += 1

        final_status = str(row.get("final_status", "") or "").upper()
        if final_status:
            agg["terminal_order_count"] += 1
        if final_status in {"CANCELLED", "EXPIRED"}:
            agg["cancel_count"] += 1
        if final_status == "REJECTED":
            agg["reject_count"] += 1

        if ack_ts is not None and intent_ts is not None and ack_ts >= intent_ts:
            agg["ack_latency_total"] += (ack_ts - intent_ts)
            agg["ack_latency_count"] += 1
        if done_ts is not None and ack_ts is not None and done_ts >= ack_ts:
            agg["working_time_total"] += (done_ts - ack_ts)
            agg["working_time_count"] += 1

    @staticmethod
    def _accumulate_fill(agg: Dict[str, Any], row: dict, markout_map: Dict[int, float]) -> None:
        fill_qty = float(row.get("fill_qty", 0) or 0)
        fill_price = float(row.get("fill_price", 0) or 0)
        agg["fill_count"] += 1
        agg["total_filled_qty"] += fill_qty
        agg["total_fill_notional"] += fill_qty * fill_price

        if 1_000 in markout_map:
            agg["markout_1s_total"] += float(markout_map[1_000])
            agg["markout_1s_count"] += 1
        if 5_000 in markout_map:
            agg["markout_5s_total"] += float(markout_map[5_000])
            agg["markout_5s_count"] += 1
        if 30_000 in markout_map:
            agg["markout_30s_total"] += float(markout_map[30_000])
            agg["markout_30s_count"] += 1
