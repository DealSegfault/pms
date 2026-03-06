"""
ScalperRuntimeCollector — persists dedicated algo runtime checkpoints.

Consumes the dedicated algo runtime Redis stream and materializes resumable
runtime checkpoints without mutating OMS or risk state.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from contracts.common import StreamEventType, ts_external_to_s

logger = logging.getLogger(__name__)


def _db_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt_from_external(value: Any) -> datetime | None:
    seconds = ts_external_to_s(value)
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc).replace(tzinfo=None)


def _config_json(snapshot: dict) -> str:
    config = {
        "symbol": snapshot.get("symbol"),
        "startSide": snapshot.get("startSide"),
        "childCount": snapshot.get("childCount"),
        "longOffsetPct": snapshot.get("longOffsetPct"),
        "shortOffsetPct": snapshot.get("shortOffsetPct"),
        "longSizeUsd": snapshot.get("longSizeUsd"),
        "shortSizeUsd": snapshot.get("shortSizeUsd"),
        "neutralMode": snapshot.get("neutralMode"),
        "leverage": snapshot.get("leverage"),
        "skew": snapshot.get("skew"),
        "longMaxPrice": snapshot.get("longMaxPrice"),
        "shortMinPrice": snapshot.get("shortMinPrice"),
        "minFillSpreadPct": snapshot.get("minFillSpreadPct"),
        "fillDecayHalfLifeMs": snapshot.get("fillDecayHalfLifeMs"),
        "minRefillDelayMs": snapshot.get("minRefillDelayMs"),
        "allowLoss": snapshot.get("allowLoss"),
        "maxLossPerCloseBps": snapshot.get("maxLossPerCloseBps"),
        "maxFillsPerMinute": snapshot.get("maxFillsPerMinute"),
        "pnlFeedbackMode": snapshot.get("pnlFeedbackMode"),
        "pinLongToEntry": snapshot.get("pinLongToEntry"),
        "pinShortToEntry": snapshot.get("pinShortToEntry"),
    }
    return json.dumps(config, sort_keys=True, separators=(",", ":"))


class ScalperRuntimeCollector:
    def __init__(self, db: Any) -> None:
        self._db = db

    async def handle(self, events: list[dict]) -> None:
        processed = 0
        for event in events:
            if event.get("type") != StreamEventType.SCALPER_RUNTIME_SNAPSHOT:
                continue
            await self._record_checkpoint(event)
            processed += 1
        if processed:
            logger.debug("ScalperRuntimeCollector persisted %d runtime checkpoint(s)", processed)

    async def _record_checkpoint(self, event: dict) -> None:
        strategy_session_id = str(event.get("strategy_session_id") or "")
        sub_account_id = str(event.get("sub_account_id") or "")
        strategy_type = str(event.get("strategy_type") or "SCALPER")
        checkpoint_seq = int(event.get("checkpoint_seq") or 0)
        checkpoint_reason = str(event.get("checkpoint_reason") or "HEARTBEAT")
        status = str(event.get("status") or "ACTIVE")
        snapshot_json = str(event.get("snapshot_json") or "{}")
        checkpoint_ts = _dt_from_external(event.get("source_ts")) or _db_now()
        created_at = _db_now()

        if not strategy_session_id or not sub_account_id:
            return

        try:
            snapshot = json.loads(snapshot_json)
        except Exception:
            logger.error("ScalperRuntimeCollector: invalid snapshot_json for %s", strategy_session_id)
            return

        existing_session = await self._db.fetch_one(
            "SELECT strategy_session_id, initial_config_json FROM algo_runtime_sessions WHERE strategy_session_id = ?",
            (strategy_session_id,),
        )

        await self._db.execute(
            """INSERT INTO strategy_sessions
               (id, sub_account_id, origin, strategy_type, parent_strategy_session_id,
                root_strategy_session_id, session_role, symbol, side, started_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 origin = excluded.origin,
                 strategy_type = excluded.strategy_type,
                 parent_strategy_session_id = excluded.parent_strategy_session_id,
                 root_strategy_session_id = excluded.root_strategy_session_id,
                 session_role = excluded.session_role,
                 symbol = COALESCE(strategy_sessions.symbol, excluded.symbol),
                 side = COALESCE(strategy_sessions.side, excluded.side),
                 started_at = COALESCE(strategy_sessions.started_at, excluded.started_at),
                 updated_at = excluded.updated_at""",
            (
                strategy_session_id,
                sub_account_id,
                "SCALPER",
                strategy_type,
                None,
                strategy_session_id,
                "ROOT",
                snapshot.get("symbol"),
                snapshot.get("startSide"),
                _dt_from_external(snapshot.get("startedAt")) or checkpoint_ts,
                created_at,
                created_at,
            ),
        )

        checkpoint_id = f"{strategy_session_id}:{checkpoint_seq}"
        await self._db.execute(
            """INSERT INTO algo_runtime_checkpoints
               (id, strategy_session_id, sub_account_id, strategy_type, checkpoint_seq,
                checkpoint_ts, checkpoint_reason, status, snapshot_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(strategy_session_id, checkpoint_seq) DO NOTHING""",
            (
                checkpoint_id,
                strategy_session_id,
                sub_account_id,
                strategy_type,
                checkpoint_seq,
                checkpoint_ts,
                checkpoint_reason,
                status,
                snapshot_json,
                created_at,
            ),
        )

        initial_config_json = existing_session.get("initial_config_json") if existing_session else None
        current_config_json = _config_json(snapshot)
        if not initial_config_json:
            initial_config_json = current_config_json

        await self._db.execute(
            """INSERT INTO algo_runtime_sessions
               (strategy_session_id, sub_account_id, strategy_type, status, resume_policy,
                started_at, stopped_at, last_heartbeat_at, latest_checkpoint_id,
                initial_config_json, current_config_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(strategy_session_id) DO UPDATE SET
                 sub_account_id = excluded.sub_account_id,
                 strategy_type = excluded.strategy_type,
                 status = excluded.status,
                 resume_policy = excluded.resume_policy,
                 started_at = COALESCE(algo_runtime_sessions.started_at, excluded.started_at),
                 stopped_at = COALESCE(excluded.stopped_at, algo_runtime_sessions.stopped_at),
                 last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, algo_runtime_sessions.last_heartbeat_at),
                 latest_checkpoint_id = excluded.latest_checkpoint_id,
                 initial_config_json = COALESCE(algo_runtime_sessions.initial_config_json, excluded.initial_config_json),
                 current_config_json = excluded.current_config_json,
                 updated_at = excluded.updated_at""",
            (
                strategy_session_id,
                sub_account_id,
                strategy_type,
                status,
                "RECREATE_CHILD_ORDERS",
                _dt_from_external(snapshot.get("startedAt")) or checkpoint_ts,
                checkpoint_ts if status in ("CANCELLED", "FAILED", "COMPLETED") else None,
                checkpoint_ts if checkpoint_reason == "HEARTBEAT" else None,
                checkpoint_id,
                initial_config_json,
                current_config_json,
                created_at,
                created_at,
            ),
        )
