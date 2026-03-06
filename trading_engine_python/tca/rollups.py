"""
TCARollupWorker — bounded aggregate read-model builder for TCA tables.

Recomputes only impacted sub-accounts by tracking table-level cursors and
upserting rollup rows with precomputed qualityByRole JSON.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

from trading_engine_python.tca.storage import json_dumps, load_worker_cursor, save_worker_cursor, utc_now

import logging

logger = logging.getLogger(__name__)

WORKER_KEY = "tca_rollups"
FULL_RECONCILE_SEC = 60 * 60
ROLE_KEYS = ("ENTRY", "ADD", "UNWIND", "FLATTEN", "REPRICE", "HEDGE", "UNKNOWN")


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


def _normalize_rollup_ts(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if value in (None, "", "None"):
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric /= 1000.0
        return datetime.fromtimestamp(numeric, timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            try:
                return _normalize_rollup_ts(float(value))
            except ValueError:
                return None
    return None


def _normalize_role(value: Any) -> str:
    role = str(value or "UNKNOWN").upper()
    return role if role in ROLE_KEYS else "UNKNOWN"


def _quality_bucket() -> Dict[str, Any]:
    return {
        "lifecycleCount": 0,
        "fillCount": 0,
        "arrivalTotal": 0.0,
        "arrivalCount": 0,
        "mark1Total": 0.0,
        "mark1Count": 0,
        "mark5Total": 0.0,
        "mark5Count": 0,
        "mark30Total": 0.0,
        "mark30Count": 0,
    }


def _new_rollup() -> Dict[str, Any]:
    return {
        "sub_account_id": None,
        "strategy_type": None,
        "rollup_level": "SESSION",
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
        "realized_pnl": 0.0,
        "unrealized_pnl": 0.0,
        "net_pnl": 0.0,
        "fees_total": 0.0,
        "open_qty": 0.0,
        "open_notional": 0.0,
        "close_count": 0,
        "win_count": 0,
        "loss_count": 0,
        "win_rate": None,
        "max_drawdown_pnl": None,
        "max_runup_pnl": None,
        "last_sampled_at": None,
        "quality_buckets": {},
        "quality_by_role": {},
    }


def _safe_max(values: Iterable[Optional[float]]) -> Optional[float]:
    nums = [value for value in values if value is not None]
    return max(nums) if nums else None


def _safe_min(values: Iterable[Optional[float]]) -> Optional[float]:
    nums = [value for value in values if value is not None]
    return min(nums) if nums else None


def _bucket_quality(agg: Dict[str, Any], role: str) -> Dict[str, Any]:
    role_key = _normalize_role(role)
    buckets = agg.setdefault("quality_buckets", {})
    if role_key not in buckets:
        buckets[role_key] = _quality_bucket()
    return buckets[role_key]


def _finalize_quality(agg: Dict[str, Any]) -> Dict[str, Any]:
    output = {}
    for role, bucket in sorted((agg.get("quality_buckets") or {}).items()):
        avg_arrival = _safe_avg(bucket["arrivalTotal"], bucket["arrivalCount"])
        avg_mark1 = _safe_avg(bucket["mark1Total"], bucket["mark1Count"])
        avg_mark5 = _safe_avg(bucket["mark5Total"], bucket["mark5Count"])
        avg_mark30 = _safe_avg(bucket["mark30Total"], bucket["mark30Count"])
        mark1 = min(50.0, max(0.0, -(avg_mark1 or 0.0)))
        mark5 = min(50.0, max(0.0, -(avg_mark5 or 0.0)))
        arrival = min(50.0, max(0.0, abs(avg_arrival or 0.0)))
        output[role] = {
            "lifecycleCount": bucket["lifecycleCount"],
            "fillCount": bucket["fillCount"],
            "avgArrivalSlippageBps": avg_arrival,
            "avgMarkout1sBps": avg_mark1,
            "avgMarkout5sBps": avg_mark5,
            "avgMarkout30sBps": avg_mark30,
            "toxicityScore": (0.5 * mark1) + (0.3 * mark5) + (0.2 * arrival),
        }
    agg["quality_by_role"] = output
    agg.pop("quality_buckets", None)
    return output


def _digest_value(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 10)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _digest_value(v) for k, v in sorted(value.items())}
    return value


def _rollup_change_digest(
    sub_rollups: Dict[Tuple[str, str, str], Dict[str, Any]],
    strategy_rollups: Dict[Tuple[str, str, str, str], Dict[str, Any]],
) -> str:
    def encode_bucket(buckets: Dict[Tuple[Any, ...], Dict[str, Any]], key_names: Tuple[str, ...]) -> list:
        rows = []
        for key, agg in sorted(buckets.items(), key=lambda item: item[0]):
            key_part = {name: _digest_value(value) for name, value in zip(key_names, key)}
            agg_part = {name: _digest_value(agg.get(name)) for name in sorted(agg.keys()) if name != "quality_by_role_json"}
            rows.append({"key": key_part, "agg": agg_part})
        return rows

    encoded = json_dumps({
        "sub": encode_bucket(sub_rollups, ("sub_account_id", "execution_scope", "ownership_confidence")),
        "strategy": encode_bucket(strategy_rollups, ("strategy_session_id", "execution_scope", "ownership_confidence", "rollup_level")),
    })
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


def _max_ts(rows: Sequence[dict], field: str) -> Optional[datetime]:
    latest = None
    for row in rows or []:
        current = _normalize_rollup_ts(row.get(field))
        if current and (latest is None or current > latest):
            latest = current
    return latest


def _cursor_to_meta(cursor: dict) -> dict:
    return {
        key: (value.isoformat() if isinstance(value, datetime) else value)
        for key, value in (cursor or {}).items()
    }


def _build_in_clause(values: Sequence[Any]) -> tuple[str, tuple[Any, ...]]:
    if not values:
        return "(NULL)", ()
    return f"({','.join('?' for _ in values)})", tuple(values)


class TCARollupWorker:
    """Periodic bounded rebuild of TCA rollup tables."""

    def __init__(self, db: Any, *, interval_sec: float = 15.0, full_reconcile_sec: float = FULL_RECONCILE_SEC) -> None:
        self._db = db
        self._interval_sec = interval_sec
        self._full_reconcile_sec = full_reconcile_sec
        self._last_log_digest: Optional[str] = None

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                summary = await self.recompute_once()
                changed = summary.get("change_digest") != self._last_log_digest
                if changed and (summary["sub_account_rollups"] or summary["strategy_rollups"]):
                    logger.info(
                        "TCARollupWorker rebuilt %d sub-account rollup(s) and %d strategy rollup(s) mode=%s impacted_sub_accounts=%d changed_rows=%s",
                        summary["sub_account_rollups"],
                        summary["strategy_rollups"],
                        summary.get("reconcile_mode", "incremental"),
                        summary.get("impacted_sub_accounts", 0),
                        summary.get("changed_rows", {}),
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
                "reconcile_mode": "disabled",
                "impacted_sub_accounts": 0,
                "changed_rows": {},
            }

        started_at = utc_now()
        cursor_state = await load_worker_cursor(self._db, WORKER_KEY)
        cursor_meta = cursor_state.pop("_meta", {})
        previous_digest = cursor_meta.get("last_run_meta", {}).get("last_digest")
        last_success = _normalize_rollup_ts(cursor_meta.get("last_success_at"))
        full_reconcile = last_success is None or (started_at - last_success) >= timedelta(seconds=self._full_reconcile_sec)

        current_cursor = {
            "lifecycle_updated_at": _normalize_rollup_ts(cursor_state.get("lifecycle_updated_at")),
            "fill_created_at": _normalize_rollup_ts(cursor_state.get("fill_created_at")),
            "markout_created_at": _normalize_rollup_ts(cursor_state.get("markout_created_at")),
            "sample_created_at": _normalize_rollup_ts(cursor_state.get("sample_created_at")),
            "session_updated_at": _normalize_rollup_ts(cursor_state.get("session_updated_at")),
        }

        await save_worker_cursor(
            self._db,
            WORKER_KEY,
            cursor=_cursor_to_meta(current_cursor),
            started_at=started_at,
        )

        if full_reconcile:
            scope = await self._load_scope_full()
            impacted_sub_accounts = sorted({row.get("sub_account_id") for row in scope["strategy_sessions"] if row.get("sub_account_id")})
            next_cursor = {
                "lifecycle_updated_at": _max_ts(scope["lifecycles"], "updated_at"),
                "fill_created_at": _max_ts(scope["fills"], "created_at"),
                "markout_created_at": _max_ts(scope["markouts"], "created_at"),
                "sample_created_at": _max_ts(scope["pnl_samples"], "created_at"),
                "session_updated_at": _max_ts(scope["strategy_sessions"], "updated_at"),
            }
            changed_rows = {
                "lifecycles": len(scope["lifecycles"]),
                "fills": len(scope["fills"]),
                "markouts": len(scope["markouts"]),
                "samples": len(scope["pnl_samples"]),
                "sessions": len(scope["strategy_sessions"]),
            }
        else:
            impacted_sub_accounts, changed_rows, next_cursor = await self._collect_impacted_sub_accounts(current_cursor)
            if not impacted_sub_accounts:
                await save_worker_cursor(
                    self._db,
                    WORKER_KEY,
                    cursor=_cursor_to_meta(next_cursor),
                    completed_at=started_at,
                    last_success_at=started_at,
                    run_meta={
                        "reconcile_mode": "incremental",
                        "last_digest": previous_digest,
                        "changed_rows": changed_rows,
                        "impacted_sub_accounts": 0,
                    },
                )
                return {
                    "sub_account_rollups": 0,
                    "strategy_rollups": 0,
                    "change_digest": previous_digest,
                    "reconcile_mode": "incremental",
                    "impacted_sub_accounts": 0,
                    "changed_rows": changed_rows,
                }
            scope = await self._load_scope_for_sub_accounts(impacted_sub_accounts)

        sub_rollups, strategy_rollups = self._compute_rollups(scope)
        await self._persist_rollups(
            sub_rollups=sub_rollups,
            strategy_rollups=strategy_rollups,
            impacted_sub_accounts=impacted_sub_accounts,
            full_reconcile=full_reconcile,
        )

        digest = _rollup_change_digest(sub_rollups, strategy_rollups)
        completed_at = utc_now()
        await save_worker_cursor(
            self._db,
            WORKER_KEY,
            cursor=_cursor_to_meta(next_cursor),
            completed_at=completed_at,
            last_success_at=completed_at,
            run_meta={
                "reconcile_mode": "full" if full_reconcile else "incremental",
                "last_digest": digest,
                "changed_rows": changed_rows,
                "impacted_sub_accounts": len(impacted_sub_accounts),
            },
        )

        return {
            "sub_account_rollups": len(sub_rollups),
            "strategy_rollups": len(strategy_rollups),
            "change_digest": digest,
            "reconcile_mode": "full" if full_reconcile else "incremental",
            "impacted_sub_accounts": len(impacted_sub_accounts),
            "changed_rows": changed_rows,
        }

    async def _collect_impacted_sub_accounts(self, cursor: dict) -> tuple[list[str], dict, dict]:
        changed_rows = {}
        impacted: set[str] = set()
        next_cursor = dict(cursor)

        lifecycle_rows = await self._db.fetch_all(
            "SELECT sub_account_id, updated_at FROM order_lifecycles WHERE updated_at > ?",
            (cursor["lifecycle_updated_at"],),
        ) if cursor.get("lifecycle_updated_at") else []
        changed_rows["lifecycles"] = len(lifecycle_rows)
        impacted.update(str(row.get("sub_account_id")) for row in lifecycle_rows if row.get("sub_account_id"))
        next_cursor["lifecycle_updated_at"] = _max_ts(lifecycle_rows, "updated_at") or cursor.get("lifecycle_updated_at")

        fill_rows = await self._db.fetch_all(
            "SELECT sub_account_id, created_at FROM fill_facts WHERE created_at > ?",
            (cursor["fill_created_at"],),
        ) if cursor.get("fill_created_at") else []
        changed_rows["fills"] = len(fill_rows)
        impacted.update(str(row.get("sub_account_id")) for row in fill_rows if row.get("sub_account_id"))
        next_cursor["fill_created_at"] = _max_ts(fill_rows, "created_at") or cursor.get("fill_created_at")

        markout_rows = await self._db.fetch_all(
            """SELECT f.sub_account_id, m.created_at
               FROM fill_markouts m
               JOIN fill_facts f ON f.id = m.fill_fact_id
               WHERE m.created_at > ?""",
            (cursor["markout_created_at"],),
        ) if cursor.get("markout_created_at") else []
        changed_rows["markouts"] = len(markout_rows)
        impacted.update(str(row.get("sub_account_id")) for row in markout_rows if row.get("sub_account_id"))
        next_cursor["markout_created_at"] = _max_ts(markout_rows, "created_at") or cursor.get("markout_created_at")

        sample_rows = await self._db.fetch_all(
            "SELECT sub_account_id, created_at FROM strategy_session_pnl_samples WHERE created_at > ?",
            (cursor["sample_created_at"],),
        ) if cursor.get("sample_created_at") else []
        changed_rows["samples"] = len(sample_rows)
        impacted.update(str(row.get("sub_account_id")) for row in sample_rows if row.get("sub_account_id"))
        next_cursor["sample_created_at"] = _max_ts(sample_rows, "created_at") or cursor.get("sample_created_at")

        session_rows = await self._db.fetch_all(
            "SELECT sub_account_id, updated_at FROM strategy_sessions WHERE updated_at > ?",
            (cursor["session_updated_at"],),
        ) if cursor.get("session_updated_at") else []
        changed_rows["sessions"] = len(session_rows)
        impacted.update(str(row.get("sub_account_id")) for row in session_rows if row.get("sub_account_id"))
        next_cursor["session_updated_at"] = _max_ts(session_rows, "updated_at") or cursor.get("session_updated_at")

        return sorted(impacted), changed_rows, next_cursor

    async def _load_scope_full(self) -> dict:
        return {
            "strategy_sessions": await self._db.fetch_all("SELECT * FROM strategy_sessions"),
            "lifecycles": await self._db.fetch_all("SELECT * FROM order_lifecycles"),
            "fills": await self._db.fetch_all("SELECT * FROM fill_facts"),
            "markouts": await self._db.fetch_all("SELECT * FROM fill_markouts"),
            "pnl_samples": await self._db.fetch_all("SELECT * FROM strategy_session_pnl_samples"),
        }

    async def _load_scope_for_sub_accounts(self, sub_account_ids: Sequence[str]) -> dict:
        in_clause, params = _build_in_clause(sub_account_ids)
        return {
            "strategy_sessions": await self._db.fetch_all(
                f"SELECT * FROM strategy_sessions WHERE sub_account_id IN {in_clause}",
                params,
            ),
            "lifecycles": await self._db.fetch_all(
                f"SELECT * FROM order_lifecycles WHERE sub_account_id IN {in_clause}",
                params,
            ),
            "fills": await self._db.fetch_all(
                f"SELECT * FROM fill_facts WHERE sub_account_id IN {in_clause}",
                params,
            ),
            "markouts": await self._db.fetch_all(
                f"""SELECT m.*
                    FROM fill_markouts m
                    JOIN fill_facts f ON f.id = m.fill_fact_id
                    WHERE f.sub_account_id IN {in_clause}""",
                params,
            ),
            "pnl_samples": await self._db.fetch_all(
                f"SELECT * FROM strategy_session_pnl_samples WHERE sub_account_id IN {in_clause}",
                params,
            ),
        }

    def _compute_rollups(self, scope: dict) -> tuple[Dict[Tuple[str, str, str], Dict[str, Any]], Dict[Tuple[str, str, str, str], Dict[str, Any]]]:
        lifecycles = scope.get("lifecycles") or []
        fills = scope.get("fills") or []
        markouts = scope.get("markouts") or []
        strategy_sessions = scope.get("strategy_sessions") or []
        pnl_samples = scope.get("pnl_samples") or []

        markouts_by_fill: Dict[str, Dict[int, float]] = {}
        for row in markouts:
            horizon_ms = int(row.get("horizon_ms") or row.get("horizonMs") or 0)
            markout_bps = row.get("markout_bps", row.get("markoutBps"))
            fill_fact_id = row.get("fill_fact_id", row.get("fillFactId"))
            if not fill_fact_id or horizon_ms <= 0 or markout_bps is None:
                continue
            markouts_by_fill.setdefault(str(fill_fact_id), {})[horizon_ms] = float(markout_bps)

        lifecycle_by_id = {str(row["id"]): row for row in lifecycles if row.get("id")}
        session_by_id = {str(row["id"]): row for row in strategy_sessions if row.get("id")}

        sub_rollups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        strategy_rollups: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}

        latest_sample_by_session: Dict[str, dict] = {}
        drawdown_by_session: Dict[str, Optional[float]] = {}
        runup_by_session: Dict[str, Optional[float]] = {}

        for sample in pnl_samples:
            session_id = sample.get("strategy_session_id")
            if not session_id:
                continue
            sampled_at = _normalize_rollup_ts(sample.get("sampled_at"))
            row = {**sample, "_sampled_at_norm": sampled_at}
            existing = latest_sample_by_session.get(str(session_id))
            if not existing or (
                sampled_at and existing.get("_sampled_at_norm") and sampled_at >= existing["_sampled_at_norm"]
            ) or (sampled_at and not existing.get("_sampled_at_norm")):
                latest_sample_by_session[str(session_id)] = row

        grouped_samples = defaultdict(list)
        for sample in pnl_samples:
            session_id = sample.get("strategy_session_id")
            if session_id:
                grouped_samples[str(session_id)].append(float(sample.get("net_pnl") or 0.0))
        for session_id, values in grouped_samples.items():
            drawdown_by_session[session_id] = _safe_min(values)
            runup_by_session[session_id] = _safe_max(values)

        for row in lifecycles:
            execution_scope = row.get("execution_scope") or "SUB_ACCOUNT"
            ownership_confidence = row.get("ownership_confidence") or "HARD"
            sub_account_id = row.get("sub_account_id")
            strategy_session_id = row.get("strategy_session_id")
            root_strategy_session_id = row.get("root_strategy_session_id") or strategy_session_id
            ack_ts = _to_epoch_ms(row.get("ack_ts"))
            intent_ts = _to_epoch_ms(row.get("intent_ts"))
            done_ts = _to_epoch_ms(row.get("done_ts"))

            if sub_account_id:
                agg = sub_rollups.setdefault((str(sub_account_id), execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = str(sub_account_id)
                self._accumulate_lifecycle(agg, row, ack_ts, intent_ts, done_ts)

            if strategy_session_id:
                agg = strategy_rollups.setdefault((str(strategy_session_id), execution_scope, ownership_confidence, "SESSION"), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or (str(sub_account_id) if sub_account_id else None)
                agg["strategy_type"] = agg["strategy_type"] or row.get("strategy_type")
                agg["rollup_level"] = "SESSION"
                self._accumulate_lifecycle(agg, row, ack_ts, intent_ts, done_ts)

            if root_strategy_session_id:
                root_row = session_by_id.get(str(root_strategy_session_id), {})
                agg = strategy_rollups.setdefault((str(root_strategy_session_id), execution_scope, ownership_confidence, "ROOT"), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or (str(sub_account_id) if sub_account_id else None) or root_row.get("sub_account_id")
                agg["strategy_type"] = agg["strategy_type"] or root_row.get("strategy_type") or row.get("strategy_type")
                agg["rollup_level"] = "ROOT"
                self._accumulate_lifecycle(agg, row, ack_ts, intent_ts, done_ts)

        for row in fills:
            execution_scope = row.get("execution_scope") or "SUB_ACCOUNT"
            ownership_confidence = row.get("ownership_confidence") or "HARD"
            lifecycle_id = row.get("lifecycle_id")
            lifecycle = lifecycle_by_id.get(str(lifecycle_id)) if lifecycle_id else None
            markout_map = markouts_by_fill.get(str(row.get("id")), {})
            sub_account_id = row.get("sub_account_id") or (lifecycle.get("sub_account_id") if lifecycle else None)
            strategy_session_id = lifecycle.get("strategy_session_id") if lifecycle else None
            root_strategy_session_id = lifecycle.get("root_strategy_session_id") if lifecycle else None
            strategy_type = lifecycle.get("strategy_type") if lifecycle else None

            if sub_account_id:
                agg = sub_rollups.setdefault((str(sub_account_id), execution_scope, ownership_confidence), _new_rollup())
                agg["sub_account_id"] = str(sub_account_id)
                self._accumulate_fill(agg, row, markout_map, lifecycle)

            if strategy_session_id:
                agg = strategy_rollups.setdefault((str(strategy_session_id), execution_scope, ownership_confidence, "SESSION"), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or (str(sub_account_id) if sub_account_id else None)
                agg["strategy_type"] = agg["strategy_type"] or strategy_type
                agg["rollup_level"] = "SESSION"
                self._accumulate_fill(agg, row, markout_map, lifecycle)

            if root_strategy_session_id:
                root_row = session_by_id.get(str(root_strategy_session_id), {})
                agg = strategy_rollups.setdefault((str(root_strategy_session_id), execution_scope, ownership_confidence, "ROOT"), _new_rollup())
                agg["sub_account_id"] = agg["sub_account_id"] or (str(sub_account_id) if sub_account_id else None) or root_row.get("sub_account_id")
                agg["strategy_type"] = agg["strategy_type"] or root_row.get("strategy_type") or strategy_type
                agg["rollup_level"] = "ROOT"
                self._accumulate_fill(agg, row, markout_map, lifecycle)

        sub_economics: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        root_economics: Dict[str, Dict[str, Any]] = {}
        for session_id, sample in latest_sample_by_session.items():
            session_row = session_by_id.get(session_id, {})
            sub_account_id = sample.get("sub_account_id") or session_row.get("sub_account_id")
            root_session_id = session_row.get("root_strategy_session_id") or session_id
            if sub_account_id:
                econ = sub_economics.setdefault((str(sub_account_id), "SUB_ACCOUNT", "HARD"), {
                    "realized_pnl": 0.0,
                    "unrealized_pnl": 0.0,
                    "net_pnl": 0.0,
                    "fees_total": 0.0,
                    "last_sampled_at": None,
                })
                self._accumulate_sub_account_economics(econ, sample)

            root_econ = root_economics.setdefault(str(root_session_id), {
                "realized_pnl": 0.0,
                "unrealized_pnl": 0.0,
                "net_pnl": 0.0,
                "fees_total": 0.0,
                "open_qty": 0.0,
                "open_notional": 0.0,
                "close_count": 0,
                "win_count": 0,
                "loss_count": 0,
                "max_drawdown_pnl": None,
                "max_runup_pnl": None,
                "last_sampled_at": None,
            })
            self._accumulate_root_economics(
                root_econ,
                sample,
                drawdown_by_session.get(session_id),
                runup_by_session.get(session_id),
            )

            session_rollup = strategy_rollups.setdefault((session_id, "SUB_ACCOUNT", "HARD", "SESSION"), _new_rollup())
            session_rollup["sub_account_id"] = session_rollup["sub_account_id"] or (str(sub_account_id) if sub_account_id else None)
            session_rollup["strategy_type"] = session_rollup["strategy_type"] or session_row.get("strategy_type")
            session_rollup["rollup_level"] = "SESSION"
            self._apply_session_sample(session_rollup, sample, drawdown_by_session.get(session_id), runup_by_session.get(session_id))

        for (sub_account_id, execution_scope, ownership_confidence), econ in sub_economics.items():
            agg = sub_rollups.setdefault((sub_account_id, execution_scope, ownership_confidence), _new_rollup())
            agg["sub_account_id"] = sub_account_id
            agg["realized_pnl"] = econ["realized_pnl"]
            agg["unrealized_pnl"] = econ["unrealized_pnl"]
            agg["net_pnl"] = econ["net_pnl"]
            agg["fees_total"] = econ["fees_total"]
            agg["last_sampled_at"] = econ["last_sampled_at"]

        for root_session_id, econ in root_economics.items():
            root_row = session_by_id.get(root_session_id, {})
            root_rollup = strategy_rollups.setdefault((root_session_id, "SUB_ACCOUNT", "HARD", "ROOT"), _new_rollup())
            root_rollup["sub_account_id"] = root_rollup["sub_account_id"] or root_row.get("sub_account_id")
            root_rollup["strategy_type"] = root_rollup["strategy_type"] or root_row.get("strategy_type")
            root_rollup["rollup_level"] = "ROOT"
            root_rollup["realized_pnl"] = econ["realized_pnl"]
            root_rollup["unrealized_pnl"] = econ["unrealized_pnl"]
            root_rollup["net_pnl"] = econ["net_pnl"]
            root_rollup["fees_total"] = econ["fees_total"]
            root_rollup["open_qty"] = econ["open_qty"]
            root_rollup["open_notional"] = econ["open_notional"]
            root_rollup["close_count"] = econ["close_count"]
            root_rollup["win_count"] = econ["win_count"]
            root_rollup["loss_count"] = econ["loss_count"]
            root_rollup["win_rate"] = (econ["win_count"] / econ["close_count"]) if econ["close_count"] > 0 else None
            root_rollup["max_drawdown_pnl"] = econ["max_drawdown_pnl"]
            root_rollup["max_runup_pnl"] = econ["max_runup_pnl"]
            root_rollup["last_sampled_at"] = econ["last_sampled_at"]

        for agg in sub_rollups.values():
            quality = _finalize_quality(agg)
            agg["quality_by_role_json"] = json_dumps(quality)

        for agg in strategy_rollups.values():
            quality = _finalize_quality(agg)
            agg["quality_by_role_json"] = json_dumps(quality)

        return sub_rollups, strategy_rollups

    async def _persist_rollups(
        self,
        *,
        sub_rollups: Dict[Tuple[str, str, str], Dict[str, Any]],
        strategy_rollups: Dict[Tuple[str, str, str, str], Dict[str, Any]],
        impacted_sub_accounts: Sequence[str],
        full_reconcile: bool,
    ) -> None:
        if full_reconcile:
            await self._db.execute("DELETE FROM sub_account_tca_rollups")
            await self._db.execute("DELETE FROM strategy_tca_rollups")
        else:
            for sub_account_id in impacted_sub_accounts:
                await self._db.execute("DELETE FROM sub_account_tca_rollups WHERE sub_account_id = ?", (sub_account_id,))
                await self._db.execute("DELETE FROM strategy_tca_rollups WHERE sub_account_id = ?", (sub_account_id,))

        now = utc_now()
        for (sub_account_id, execution_scope, ownership_confidence), agg in sub_rollups.items():
            await self._db.execute(
                """INSERT INTO sub_account_tca_rollups
                   (id, sub_account_id, execution_scope, ownership_confidence, quality_by_role_json,
                    order_count, terminal_order_count, fill_count, cancel_count, reject_count,
                    total_requested_qty, total_filled_qty, total_fill_notional,
                    fill_ratio, cancel_to_fill_ratio, avg_arrival_slippage_bps, avg_ack_latency_ms, avg_working_time_ms,
                    avg_markout_1s_bps, avg_markout_5s_bps, avg_markout_30s_bps,
                    realized_pnl, unrealized_pnl, net_pnl, fees_total, last_sampled_at,
                    total_reprice_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(sub_account_id, execution_scope, ownership_confidence) DO UPDATE SET
                     quality_by_role_json = excluded.quality_by_role_json,
                     order_count = excluded.order_count,
                     terminal_order_count = excluded.terminal_order_count,
                     fill_count = excluded.fill_count,
                     cancel_count = excluded.cancel_count,
                     reject_count = excluded.reject_count,
                     total_requested_qty = excluded.total_requested_qty,
                     total_filled_qty = excluded.total_filled_qty,
                     total_fill_notional = excluded.total_fill_notional,
                     fill_ratio = excluded.fill_ratio,
                     cancel_to_fill_ratio = excluded.cancel_to_fill_ratio,
                     avg_arrival_slippage_bps = excluded.avg_arrival_slippage_bps,
                     avg_ack_latency_ms = excluded.avg_ack_latency_ms,
                     avg_working_time_ms = excluded.avg_working_time_ms,
                     avg_markout_1s_bps = excluded.avg_markout_1s_bps,
                     avg_markout_5s_bps = excluded.avg_markout_5s_bps,
                     avg_markout_30s_bps = excluded.avg_markout_30s_bps,
                     realized_pnl = excluded.realized_pnl,
                     unrealized_pnl = excluded.unrealized_pnl,
                     net_pnl = excluded.net_pnl,
                     fees_total = excluded.fees_total,
                     last_sampled_at = excluded.last_sampled_at,
                     total_reprice_count = excluded.total_reprice_count,
                     updated_at = excluded.updated_at""",
                (
                    f"sub:{sub_account_id}:{execution_scope}:{ownership_confidence}",
                    sub_account_id,
                    execution_scope,
                    ownership_confidence,
                    agg["quality_by_role_json"],
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
                    agg["realized_pnl"],
                    agg["unrealized_pnl"],
                    agg["net_pnl"],
                    agg["fees_total"],
                    agg["last_sampled_at"],
                    agg["total_reprice_count"],
                    now,
                    now,
                ),
            )

        for (strategy_session_id, execution_scope, ownership_confidence, rollup_level), agg in strategy_rollups.items():
            await self._db.execute(
                """INSERT INTO strategy_tca_rollups
                   (id, strategy_session_id, sub_account_id, strategy_type, rollup_level, execution_scope,
                    ownership_confidence, quality_by_role_json, order_count, terminal_order_count, fill_count,
                    cancel_count, reject_count, total_requested_qty, total_filled_qty,
                    total_fill_notional, fill_ratio, cancel_to_fill_ratio, avg_arrival_slippage_bps, avg_ack_latency_ms,
                    avg_working_time_ms, avg_markout_1s_bps, avg_markout_5s_bps,
                    avg_markout_30s_bps, realized_pnl, unrealized_pnl, net_pnl, fees_total,
                    open_qty, open_notional, close_count, win_count, loss_count, win_rate,
                    max_drawdown_pnl, max_runup_pnl, last_sampled_at, total_reprice_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_session_id, execution_scope, ownership_confidence, rollup_level) DO UPDATE SET
                     sub_account_id = excluded.sub_account_id,
                     strategy_type = excluded.strategy_type,
                     quality_by_role_json = excluded.quality_by_role_json,
                     order_count = excluded.order_count,
                     terminal_order_count = excluded.terminal_order_count,
                     fill_count = excluded.fill_count,
                     cancel_count = excluded.cancel_count,
                     reject_count = excluded.reject_count,
                     total_requested_qty = excluded.total_requested_qty,
                     total_filled_qty = excluded.total_filled_qty,
                     total_fill_notional = excluded.total_fill_notional,
                     fill_ratio = excluded.fill_ratio,
                     cancel_to_fill_ratio = excluded.cancel_to_fill_ratio,
                     avg_arrival_slippage_bps = excluded.avg_arrival_slippage_bps,
                     avg_ack_latency_ms = excluded.avg_ack_latency_ms,
                     avg_working_time_ms = excluded.avg_working_time_ms,
                     avg_markout_1s_bps = excluded.avg_markout_1s_bps,
                     avg_markout_5s_bps = excluded.avg_markout_5s_bps,
                     avg_markout_30s_bps = excluded.avg_markout_30s_bps,
                     realized_pnl = excluded.realized_pnl,
                     unrealized_pnl = excluded.unrealized_pnl,
                     net_pnl = excluded.net_pnl,
                     fees_total = excluded.fees_total,
                     open_qty = excluded.open_qty,
                     open_notional = excluded.open_notional,
                     close_count = excluded.close_count,
                     win_count = excluded.win_count,
                     loss_count = excluded.loss_count,
                     win_rate = excluded.win_rate,
                     max_drawdown_pnl = excluded.max_drawdown_pnl,
                     max_runup_pnl = excluded.max_runup_pnl,
                     last_sampled_at = excluded.last_sampled_at,
                     total_reprice_count = excluded.total_reprice_count,
                     updated_at = excluded.updated_at""",
                (
                    f"strategy:{strategy_session_id}:{execution_scope}:{ownership_confidence}:{rollup_level}",
                    strategy_session_id,
                    agg["sub_account_id"],
                    agg["strategy_type"],
                    rollup_level,
                    execution_scope,
                    ownership_confidence,
                    agg["quality_by_role_json"],
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
                    agg["realized_pnl"],
                    agg["unrealized_pnl"],
                    agg["net_pnl"],
                    agg["fees_total"],
                    agg["open_qty"],
                    agg["open_notional"],
                    agg["close_count"],
                    agg["win_count"],
                    agg["loss_count"],
                    agg["win_rate"],
                    agg["max_drawdown_pnl"],
                    agg["max_runup_pnl"],
                    agg["last_sampled_at"],
                    agg["total_reprice_count"],
                    now,
                    now,
                ),
            )

    @staticmethod
    def _accumulate_sub_account_economics(agg: Dict[str, Any], sample: dict) -> None:
        agg["realized_pnl"] += float(sample.get("realized_pnl") or 0.0)
        agg["unrealized_pnl"] += float(sample.get("unrealized_pnl") or 0.0)
        agg["net_pnl"] += float(sample.get("net_pnl") or 0.0)
        agg["fees_total"] += float(sample.get("fees_total") or 0.0)
        sampled_at = sample.get("_sampled_at_norm") or _normalize_rollup_ts(sample.get("sampled_at"))
        if sampled_at and (agg["last_sampled_at"] is None or sampled_at > agg["last_sampled_at"]):
            agg["last_sampled_at"] = sampled_at

    @staticmethod
    def _accumulate_root_economics(
        agg: Dict[str, Any],
        sample: dict,
        max_drawdown_pnl: Optional[float],
        max_runup_pnl: Optional[float],
    ) -> None:
        agg["realized_pnl"] += float(sample.get("realized_pnl") or 0.0)
        agg["unrealized_pnl"] += float(sample.get("unrealized_pnl") or 0.0)
        agg["net_pnl"] += float(sample.get("net_pnl") or 0.0)
        agg["fees_total"] += float(sample.get("fees_total") or 0.0)
        agg["open_qty"] += float(sample.get("open_qty") or 0.0)
        agg["open_notional"] += float(sample.get("open_notional") or 0.0)
        agg["close_count"] += int(sample.get("close_count") or 0)
        agg["win_count"] += int(sample.get("win_count") or 0)
        agg["loss_count"] += int(sample.get("loss_count") or 0)
        agg["max_drawdown_pnl"] = max_drawdown_pnl if agg["max_drawdown_pnl"] is None else _safe_min([agg["max_drawdown_pnl"], max_drawdown_pnl])
        agg["max_runup_pnl"] = max_runup_pnl if agg["max_runup_pnl"] is None else _safe_max([agg["max_runup_pnl"], max_runup_pnl])
        sampled_at = sample.get("_sampled_at_norm") or _normalize_rollup_ts(sample.get("sampled_at"))
        if sampled_at and (agg["last_sampled_at"] is None or sampled_at > agg["last_sampled_at"]):
            agg["last_sampled_at"] = sampled_at

    @staticmethod
    def _apply_session_sample(
        agg: Dict[str, Any],
        sample: dict,
        max_drawdown_pnl: Optional[float],
        max_runup_pnl: Optional[float],
    ) -> None:
        agg["realized_pnl"] = float(sample.get("realized_pnl") or 0.0)
        agg["unrealized_pnl"] = float(sample.get("unrealized_pnl") or 0.0)
        agg["net_pnl"] = float(sample.get("net_pnl") or 0.0)
        agg["fees_total"] = float(sample.get("fees_total") or 0.0)
        agg["open_qty"] = float(sample.get("open_qty") or 0.0)
        agg["open_notional"] = float(sample.get("open_notional") or 0.0)
        agg["close_count"] = int(sample.get("close_count") or 0)
        agg["win_count"] = int(sample.get("win_count") or 0)
        agg["loss_count"] = int(sample.get("loss_count") or 0)
        agg["win_rate"] = (agg["win_count"] / agg["close_count"]) if agg["close_count"] > 0 else None
        agg["max_drawdown_pnl"] = max_drawdown_pnl
        agg["max_runup_pnl"] = max_runup_pnl
        agg["last_sampled_at"] = sample.get("_sampled_at_norm") or _normalize_rollup_ts(sample.get("sampled_at"))

    @staticmethod
    def _accumulate_lifecycle(agg: Dict[str, Any], row: dict, ack_ts: Optional[float], intent_ts: Optional[float], done_ts: Optional[float]) -> None:
        agg["order_count"] += 1
        agg["total_requested_qty"] += float(row.get("requested_qty", 0) or 0)
        agg["total_reprice_count"] += int(row.get("reprice_count", 0) or 0)

        role_bucket = _bucket_quality(agg, row.get("order_role"))
        role_bucket["lifecycleCount"] += 1

        decision_mid = float(row.get("decision_mid", 0) or 0)
        avg_fill_price = float(row.get("avg_fill_price", 0) or 0)
        arrival_slippage = _arrival_slippage_bps(str(row.get("side", "") or "").upper(), decision_mid, avg_fill_price)
        if arrival_slippage is not None:
            agg["arrival_slippage_total"] += arrival_slippage
            agg["arrival_slippage_count"] += 1
            role_bucket["arrivalTotal"] += arrival_slippage
            role_bucket["arrivalCount"] += 1

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
    def _accumulate_fill(agg: Dict[str, Any], row: dict, markout_map: Dict[int, float], lifecycle: Optional[dict]) -> None:
        fill_qty = float(row.get("fill_qty", 0) or 0)
        fill_price = float(row.get("fill_price", 0) or 0)
        agg["fill_count"] += 1
        agg["total_filled_qty"] += fill_qty
        agg["total_fill_notional"] += fill_qty * fill_price

        role_bucket = _bucket_quality(agg, lifecycle.get("order_role") if lifecycle else "UNKNOWN")
        role_bucket["fillCount"] += 1

        if 1_000 in markout_map:
            markout = float(markout_map[1_000])
            agg["markout_1s_total"] += markout
            agg["markout_1s_count"] += 1
            role_bucket["mark1Total"] += markout
            role_bucket["mark1Count"] += 1
        if 5_000 in markout_map:
            markout = float(markout_map[5_000])
            agg["markout_5s_total"] += markout
            agg["markout_5s_count"] += 1
            role_bucket["mark5Total"] += markout
            role_bucket["mark5Count"] += 1
        if 30_000 in markout_map:
            markout = float(markout_map[30_000])
            agg["markout_30s_total"] += markout
            agg["markout_30s_count"] += 1
            role_bucket["mark30Total"] += markout
            role_bucket["mark30Count"] += 1
