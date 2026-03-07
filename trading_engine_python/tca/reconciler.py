"""
TCAReconciler — periodic lifecycle consistency checks.

This worker reads lifecycle tables plus read models such as `pending_orders`
and annotates lifecycle rows when the stream view and recovery/read models
disagree. It never mutates OMS, RiskEngine, or in-memory order state.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_datetime(value: Any) -> Optional[datetime]:
    if value in (None, "", "None"):
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 10_000_000_000:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            try:
                numeric = float(value)
            except ValueError:
                return None
            return _to_datetime(numeric)
    return None


class TCAReconciler:
    """Periodic worker that annotates lifecycle rows without reassigning ownership."""

    def __init__(
        self,
        db: Any,
        *,
        interval_sec: float = 30.0,
        intent_stale_after_sec: float = 15.0,
        working_stale_after_sec: float = 60.0,
        batch_size: int = 500,
    ) -> None:
        self._db = db
        self._interval_sec = interval_sec
        self._intent_stale_after_sec = intent_stale_after_sec
        self._working_stale_after_sec = working_stale_after_sec
        self._batch_size = max(50, batch_size)

    async def run(self, stop_event: asyncio.Event) -> None:
        """Periodic reconcile loop."""
        while not stop_event.is_set():
            try:
                summary = await self.reconcile_once()
                if summary["touched"]:
                    logger.info("TCAReconciler updated %d lifecycle row(s)", summary["touched"])
            except Exception as exc:
                logger.error("TCAReconciler reconcile error: %s", exc)

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_sec)
            except asyncio.TimeoutError:
                continue

    async def reconcile_once(self) -> dict:
        """Run one reconciliation pass."""
        if not self._db:
            return {"touched": 0, "stale": 0, "ambiguous": 0, "recovered": 0, "live": 0}

        rows = await self._db.fetch_all(
            """SELECT * FROM order_lifecycles
               WHERE final_status IS NULL
                  OR reconciliation_status IN ('PENDING', 'LIVE', 'STALE', 'AMBIGUOUS')
               ORDER BY COALESCE(last_reconciled_at, created_at) ASC, created_at ASC
               LIMIT ?""",
            (self._batch_size,),
        )

        summary = {"touched": 0, "stale": 0, "ambiguous": 0, "recovered": 0, "live": 0}
        for row in rows or []:
            outcome = await self._reconcile_row(row)
            if not outcome:
                continue
            summary["touched"] += 1
            summary[outcome] += 1
        return summary

    async def _reconcile_row(self, row: dict) -> Optional[str]:
        execution_scope = row.get("execution_scope") or "SUB_ACCOUNT"
        sub_account_id = row.get("sub_account_id")
        now = _now_utc()
        intent_ts = _to_datetime(row.get("intent_ts"))
        ack_ts = _to_datetime(row.get("ack_ts"))
        done_ts = _to_datetime(row.get("done_ts"))

        if execution_scope != "SUB_ACCOUNT" and not sub_account_id:
            return await self._apply_reconciliation(
                row,
                status="AMBIGUOUS",
                reason="EXTERNAL_OWNERSHIP_UNPROVEN",
                outcome="ambiguous",
            )

        if execution_scope == "SUB_ACCOUNT" and not sub_account_id:
            return await self._apply_reconciliation(
                row,
                status="AMBIGUOUS",
                reason="SUB_ACCOUNT_MISSING",
                outcome="ambiguous",
            )

        if not ack_ts and not done_ts and intent_ts:
            age_sec = (now - intent_ts).total_seconds()
            if age_sec >= self._intent_stale_after_sec:
                return await self._apply_reconciliation(
                    row,
                    status="STALE",
                    reason="MISSING_ACK",
                    outcome="stale",
                )
            return await self._apply_reconciliation(
                row,
                status="PENDING",
                reason="AWAITING_ACK",
                outcome="live",
            )

        pending = await self._lookup_pending_order(row)
        if pending:
            pending_status = (pending.get("status") or "").upper()
            if pending_status == "PENDING":
                return await self._apply_reconciliation(
                    row,
                    status="LIVE",
                    reason="PENDING_ORDER_MATCH",
                    outcome="live",
                )
            if pending_status in {"FILLED", "CANCELLED", "EXPIRED"} and not row.get("final_status"):
                final_status = "CANCELLED" if pending_status == "CANCELLED" else pending_status
                done_at = _to_datetime(
                    pending.get("filled_at")
                    or pending.get("cancelled_at")
                    or pending.get("created_at")
                )
                await self._update_terminal_from_read_model(row, final_status, done_at)
                return await self._apply_reconciliation(
                    row,
                    status="RECOVERED",
                    reason=f"PENDING_ORDER_{final_status}",
                    outcome="recovered",
                )

        reference_ts = ack_ts or intent_ts
        if reference_ts and not row.get("final_status"):
            age_sec = (now - reference_ts).total_seconds()
            if age_sec >= self._working_stale_after_sec:
                return await self._apply_reconciliation(
                    row,
                    status="STALE",
                    reason="MISSING_PENDING_ORDER",
                    outcome="stale",
                )

        return await self._apply_reconciliation(
            row,
            status="LIVE",
            reason="STREAM_ONLY",
            outcome="live",
        )

    async def _lookup_pending_order(self, row: dict) -> Optional[dict]:
        client_order_id = row.get("client_order_id")
        exchange_order_id = row.get("exchange_order_id")

        if client_order_id:
            pending = await self._db.fetch_one(
                "SELECT * FROM pending_orders WHERE client_order_id = ?",
                (client_order_id,),
            )
            if pending:
                return pending

        if exchange_order_id:
            pending = await self._db.fetch_one(
                "SELECT * FROM pending_orders WHERE exchange_order_id = ?",
                (exchange_order_id,),
            )
            if pending:
                return pending

        return None

    async def _update_terminal_from_read_model(
        self,
        row: dict,
        final_status: str,
        done_ts: Optional[datetime],
    ) -> None:
        await self._db.execute(
            """UPDATE order_lifecycles
               SET final_status = ?, done_ts = ?, updated_at = ?
               WHERE id = ?""",
            (final_status, done_ts or _now_utc(), _now_utc(), row["id"]),
        )

    async def _apply_reconciliation(
        self,
        row: dict,
        *,
        status: str,
        reason: str,
        outcome: str,
    ) -> Optional[str]:
        existing_status = row.get("reconciliation_status")
        existing_reason = row.get("reconciliation_reason")
        if existing_status == status and existing_reason == reason:
            return None

        now = _now_utc()
        await self._db.execute(
            """UPDATE order_lifecycles
               SET reconciliation_status = ?, reconciliation_reason = ?, last_reconciled_at = ?, updated_at = ?
               WHERE id = ?""",
            (status, reason, now, now, row["id"]),
        )
        await self._db.execute(
            """INSERT INTO order_lifecycle_events
               (id, lifecycle_id, stream_event_id, event_type, source_ts, ingested_ts, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(stream_event_id) DO NOTHING""",
            (
                f"reconcile-{row['id']}-{status}-{reason}",
                row["id"],
                f"reconcile:{row['id']}:{status}:{reason}",
                "TCA_RECONCILIATION",
                now,
                now,
                json.dumps({"status": status, "reason": reason, "lifecycleId": row["id"]}, sort_keys=True),
                now,
            ),
        )
        return outcome
