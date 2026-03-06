"""
Shared storage helpers for TCA read-model workers.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def parse_json(value: Any, default: Optional[Any] = None) -> Any:
    if value in (None, "", "null", "None"):
        return {} if default is None else default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except Exception:
        return {} if default is None else default


async def load_worker_cursor(db: Any, worker_key: str) -> dict:
    row = await db.fetch_one(
        "SELECT * FROM tca_worker_cursors WHERE worker_key = ?",
        (worker_key,),
    )
    if not row:
        return {}
    payload = parse_json(row.get("cursor_json"), default={})
    payload["_meta"] = {
        "last_run_started_at": row.get("last_run_started_at"),
        "last_run_completed_at": row.get("last_run_completed_at"),
        "last_success_at": row.get("last_success_at"),
        "last_run_meta": parse_json(row.get("last_run_meta_json"), default={}),
    }
    return payload


async def save_worker_cursor(
    db: Any,
    worker_key: str,
    *,
    cursor: dict,
    started_at: Optional[datetime] = None,
    completed_at: Optional[datetime] = None,
    last_success_at: Optional[datetime] = None,
    run_meta: Optional[dict] = None,
) -> None:
    now = utc_now()
    await db.execute(
        """INSERT INTO tca_worker_cursors
           (worker_key, cursor_json, last_run_started_at, last_run_completed_at,
            last_success_at, last_run_meta_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(worker_key) DO UPDATE SET
             cursor_json = excluded.cursor_json,
             last_run_started_at = COALESCE(excluded.last_run_started_at, tca_worker_cursors.last_run_started_at),
             last_run_completed_at = COALESCE(excluded.last_run_completed_at, tca_worker_cursors.last_run_completed_at),
             last_success_at = COALESCE(excluded.last_success_at, tca_worker_cursors.last_success_at),
             last_run_meta_json = COALESCE(excluded.last_run_meta_json, tca_worker_cursors.last_run_meta_json),
             updated_at = excluded.updated_at""",
        (
            worker_key,
            json_dumps(cursor or {}),
            started_at,
            completed_at,
            last_success_at,
            json_dumps(run_meta or {}),
            now,
            now,
        ),
    )


async def upsert_tca_anomaly(
    db: Any,
    *,
    anomaly_key: str,
    anomaly_type: str,
    sub_account_id: Optional[str] = None,
    root_strategy_session_id: Optional[str] = None,
    strategy_session_id: Optional[str] = None,
    lifecycle_id: Optional[str] = None,
    fill_fact_id: Optional[str] = None,
    severity: str = "WARN",
    status: str = "OPEN",
    payload: Optional[dict] = None,
    source_ts: Optional[datetime] = None,
) -> None:
    now = utc_now()
    await db.execute(
        """INSERT INTO tca_anomalies
           (id, anomaly_key, anomaly_type, sub_account_id, root_strategy_session_id,
            strategy_session_id, lifecycle_id, fill_fact_id, severity, status,
            payload_json, source_ts, first_seen_at, last_seen_at, resolved_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(anomaly_key) DO UPDATE SET
             anomaly_type = excluded.anomaly_type,
             sub_account_id = COALESCE(excluded.sub_account_id, tca_anomalies.sub_account_id),
             root_strategy_session_id = COALESCE(excluded.root_strategy_session_id, tca_anomalies.root_strategy_session_id),
             strategy_session_id = COALESCE(excluded.strategy_session_id, tca_anomalies.strategy_session_id),
             lifecycle_id = COALESCE(excluded.lifecycle_id, tca_anomalies.lifecycle_id),
             fill_fact_id = COALESCE(excluded.fill_fact_id, tca_anomalies.fill_fact_id),
             severity = excluded.severity,
             status = excluded.status,
             payload_json = excluded.payload_json,
             source_ts = COALESCE(excluded.source_ts, tca_anomalies.source_ts),
             last_seen_at = excluded.last_seen_at,
             resolved_at = CASE WHEN excluded.status = 'RESOLVED' THEN excluded.resolved_at ELSE NULL END,
             updated_at = excluded.updated_at""",
        (
            str(uuid.uuid4()),
            anomaly_key,
            anomaly_type,
            sub_account_id,
            root_strategy_session_id,
            strategy_session_id,
            lifecycle_id,
            fill_fact_id,
            severity,
            status,
            json_dumps(payload or {}),
            source_ts,
            now,
            now,
            now if status == "RESOLVED" else None,
            now,
            now,
        ),
    )


async def resolve_missing_anomalies(
    db: Any,
    *,
    anomaly_type: str,
    root_strategy_session_id: Optional[str] = None,
    lifecycle_id: Optional[str] = None,
    active_keys: set[str],
) -> None:
    if not root_strategy_session_id and not lifecycle_id:
        return
    clauses = ["anomaly_type = ?"]
    params: list[Any] = [anomaly_type]
    if root_strategy_session_id:
        clauses.append("root_strategy_session_id = ?")
        params.append(root_strategy_session_id)
    if lifecycle_id:
        clauses.append("lifecycle_id = ?")
        params.append(lifecycle_id)
    rows = await db.fetch_all(
        f"SELECT anomaly_key FROM tca_anomalies WHERE {' AND '.join(clauses)} AND status <> ?",
        tuple(params + ["RESOLVED"]),
    )
    for row in rows or []:
        key = str(row.get("anomaly_key") or "")
        if key and key not in active_keys:
            await upsert_tca_anomaly(
                db,
                anomaly_key=key,
                anomaly_type=anomaly_type,
                root_strategy_session_id=root_strategy_session_id,
                lifecycle_id=lifecycle_id,
                status="RESOLVED",
            )
