"""
StrategyLotLedgerWorker — rebuild exact FIFO lot ownership for impacted root sessions.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from trading_engine_python.tca.storage import (
    load_worker_cursor,
    resolve_missing_anomalies,
    save_worker_cursor,
    upsert_tca_anomaly,
    utc_now,
)

logger = logging.getLogger(__name__)

WORKER_KEY = "strategy_lot_ledger"
FULL_RECONCILE_SEC = 60 * 60
OPENING_ROLES = {"ENTRY", "ADD", "HEDGE"}
CLOSING_ROLES = {"UNWIND", "FLATTEN"}
EPSILON = 1e-12


def _to_datetime(value: Any) -> Optional[datetime]:
    if value in (None, "", "None"):
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
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
                return _to_datetime(float(value))
            except ValueError:
                return None
    return None


def _cursor_to_meta(cursor: dict) -> dict:
    return {
        key: (value.isoformat() if isinstance(value, datetime) else value)
        for key, value in (cursor or {}).items()
    }


def _max_ts(rows: Sequence[dict], field: str) -> Optional[datetime]:
    latest = None
    for row in rows or []:
        current = _to_datetime(row.get(field))
        if current and (latest is None or current > latest):
            latest = current
    return latest


def _build_in_clause(values: Sequence[Any]) -> tuple[str, tuple[Any, ...]]:
    if not values:
        return "(NULL)", ()
    return f"({','.join('?' for _ in values)})", tuple(values)


def _position_side_for_open(order_side: str) -> str:
    return "LONG" if str(order_side or "").upper() == "BUY" else "SHORT"


def _position_side_for_close(order_side: str) -> str:
    return "LONG" if str(order_side or "").upper() == "SELL" else "SHORT"


def _compute_pnl(position_side: str, open_price: float, close_price: float, qty: float) -> float:
    if position_side == "SHORT":
        return (open_price - close_price) * qty
    return (close_price - open_price) * qty


def _lot_id(fill_fact_id: Any) -> str:
    return f"lot:{fill_fact_id}"


def _realization_id(close_fill_fact_id: Any, lot_id: str) -> str:
    return f"realization:{close_fill_fact_id}:{lot_id}"


class StrategyLotLedgerWorker:
    def __init__(
        self,
        db: Any,
        *,
        interval_sec: float = 5.0,
        full_reconcile_sec: float = FULL_RECONCILE_SEC,
    ) -> None:
        self._db = db
        self._interval_sec = interval_sec
        self._full_reconcile_sec = full_reconcile_sec

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                summary = await self.rebuild_once()
                if summary["lot_count"] or summary["realization_count"] or summary["anomaly_count"]:
                    logger.debug(
                        "StrategyLotLedgerWorker rebuilt %d root session(s), %d lot(s), %d realization(s), %d anomaly/anomalies mode=%s changed_rows=%s",
                        summary.get("impacted_root_sessions", 0),
                        summary["lot_count"],
                        summary["realization_count"],
                        summary["anomaly_count"],
                        summary.get("reconcile_mode", "incremental"),
                        summary.get("changed_rows", {}),
                    )
            except Exception as exc:
                logger.error("StrategyLotLedgerWorker error: %s", exc)

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_sec)
            except asyncio.TimeoutError:
                continue

    async def rebuild_once(self) -> dict:
        if not self._db:
            return {
                "lot_count": 0,
                "realization_count": 0,
                "anomaly_count": 0,
                "impacted_root_sessions": 0,
                "reconcile_mode": "disabled",
                "changed_rows": {},
            }

        started_at = utc_now()
        cursor_state = await load_worker_cursor(self._db, WORKER_KEY)
        cursor_meta = cursor_state.pop("_meta", {})
        last_success = _to_datetime(cursor_meta.get("last_success_at"))
        full_reconcile = last_success is None or (started_at - last_success) >= timedelta(seconds=self._full_reconcile_sec)
        current_cursor = {
            "lifecycle_updated_at": _to_datetime(cursor_state.get("lifecycle_updated_at")),
            "fill_created_at": _to_datetime(cursor_state.get("fill_created_at")),
        }

        await save_worker_cursor(
            self._db,
            WORKER_KEY,
            cursor=_cursor_to_meta(current_cursor),
            started_at=started_at,
        )

        if full_reconcile:
            root_session_ids = await self._load_all_root_sessions()
            next_cursor = await self._load_full_cursor_state()
            changed_rows = {
                "lifecycles": next_cursor.pop("_lifecycle_count", 0),
                "fills": next_cursor.pop("_fill_count", 0),
            }
            reconcile_mode = "full"
        else:
            root_session_ids, changed_rows, next_cursor = await self._collect_impacted_root_sessions(current_cursor)
            reconcile_mode = "incremental"
            if not root_session_ids:
                await save_worker_cursor(
                    self._db,
                    WORKER_KEY,
                    cursor=_cursor_to_meta(next_cursor),
                    completed_at=started_at,
                    last_success_at=started_at,
                    run_meta={
                        "reconcile_mode": reconcile_mode,
                        "changed_rows": changed_rows,
                        "impacted_root_sessions": 0,
                    },
                )
                return {
                    "lot_count": 0,
                    "realization_count": 0,
                    "anomaly_count": 0,
                    "impacted_root_sessions": 0,
                    "reconcile_mode": reconcile_mode,
                    "changed_rows": changed_rows,
                }

        rows = await self._load_rows_for_root_sessions(root_session_ids)
        summary = await self._rebuild_root_sessions(root_session_ids, rows)
        completed_at = utc_now()
        await save_worker_cursor(
            self._db,
            WORKER_KEY,
            cursor=_cursor_to_meta(next_cursor),
            completed_at=completed_at,
            last_success_at=completed_at,
            run_meta={
                "reconcile_mode": reconcile_mode,
                "changed_rows": changed_rows,
                "impacted_root_sessions": len(root_session_ids),
            },
        )

        return {
            **summary,
            "impacted_root_sessions": len(root_session_ids),
            "reconcile_mode": reconcile_mode,
            "changed_rows": changed_rows,
        }

    async def _load_all_root_sessions(self) -> list[str]:
        rows = await self._db.fetch_all(
            """SELECT DISTINCT root_strategy_session_id
               FROM order_lifecycles
               WHERE root_strategy_session_id IS NOT NULL"""
        )
        return sorted(str(row.get("root_strategy_session_id")) for row in rows or [] if row.get("root_strategy_session_id"))

    async def _load_full_cursor_state(self) -> dict:
        lifecycle_rows = await self._db.fetch_all(
            "SELECT updated_at FROM order_lifecycles WHERE root_strategy_session_id IS NOT NULL"
        )
        fill_rows = await self._db.fetch_all(
            """SELECT f.created_at
               FROM fill_facts f
               JOIN order_lifecycles l ON l.id = f.lifecycle_id
               WHERE l.root_strategy_session_id IS NOT NULL"""
        )
        return {
            "lifecycle_updated_at": _max_ts(lifecycle_rows, "updated_at"),
            "fill_created_at": _max_ts(fill_rows, "created_at"),
            "_lifecycle_count": len(lifecycle_rows),
            "_fill_count": len(fill_rows),
        }

    async def _collect_impacted_root_sessions(self, cursor: dict) -> tuple[list[str], dict, dict]:
        impacted: set[str] = set()
        changed_rows = {}
        next_cursor = dict(cursor)

        lifecycle_rows = await self._db.fetch_all(
            """SELECT root_strategy_session_id, updated_at
               FROM order_lifecycles
               WHERE root_strategy_session_id IS NOT NULL AND updated_at > ?""",
            (cursor["lifecycle_updated_at"],),
        ) if cursor.get("lifecycle_updated_at") else []
        changed_rows["lifecycles"] = len(lifecycle_rows)
        impacted.update(str(row.get("root_strategy_session_id")) for row in lifecycle_rows if row.get("root_strategy_session_id"))
        next_cursor["lifecycle_updated_at"] = _max_ts(lifecycle_rows, "updated_at") or cursor.get("lifecycle_updated_at")

        fill_rows = await self._db.fetch_all(
            """SELECT l.root_strategy_session_id, f.created_at
               FROM fill_facts f
               JOIN order_lifecycles l ON l.id = f.lifecycle_id
               WHERE l.root_strategy_session_id IS NOT NULL AND f.created_at > ?""",
            (cursor["fill_created_at"],),
        ) if cursor.get("fill_created_at") else []
        changed_rows["fills"] = len(fill_rows)
        impacted.update(str(row.get("root_strategy_session_id")) for row in fill_rows if row.get("root_strategy_session_id"))
        next_cursor["fill_created_at"] = _max_ts(fill_rows, "created_at") or cursor.get("fill_created_at")

        return sorted(impacted), changed_rows, next_cursor

    async def _load_rows_for_root_sessions(self, root_session_ids: Sequence[str]) -> list[dict]:
        if not root_session_ids:
            return []
        in_clause, params = _build_in_clause(root_session_ids)
        return await self._db.fetch_all(
            f"""SELECT
                    f.id AS fill_fact_id,
                    f.lifecycle_id,
                    f.sub_account_id,
                    f.fill_ts,
                    f.fill_qty,
                    f.fill_price,
                    f.fee,
                    f.created_at AS fill_created_at,
                    l.strategy_session_id,
                    l.root_strategy_session_id,
                    l.order_role,
                    l.side,
                    l.symbol,
                    l.updated_at AS lifecycle_updated_at
                FROM fill_facts f
                JOIN order_lifecycles l ON l.id = f.lifecycle_id
                WHERE l.root_strategy_session_id IN {in_clause}
                ORDER BY l.root_strategy_session_id ASC, f.fill_ts ASC, f.created_at ASC, f.id ASC""",
            params,
        )

    async def _rebuild_root_sessions(self, root_session_ids: Sequence[str], rows: Sequence[dict]) -> dict:
        if not root_session_ids:
            return {"lot_count": 0, "realization_count": 0, "anomaly_count": 0}

        in_clause, params = _build_in_clause(root_session_ids)
        await self._db.execute(
            f"DELETE FROM strategy_lot_realizations WHERE root_strategy_session_id IN {in_clause}",
            params,
        )
        await self._db.execute(
            f"DELETE FROM strategy_position_lots WHERE root_strategy_session_id IN {in_clause}",
            params,
        )

        rows_by_root: Dict[str, List[dict]] = defaultdict(list)
        for row in rows or []:
            root_strategy_session_id = row.get("root_strategy_session_id")
            if root_strategy_session_id:
                rows_by_root[str(root_strategy_session_id)].append(row)

        lot_count = 0
        realization_count = 0
        anomaly_count = 0
        now = utc_now()

        for root_strategy_session_id in root_session_ids:
            root_rows = rows_by_root.get(str(root_strategy_session_id), [])
            open_lots: Dict[Tuple[str, str, str, str], List[dict]] = defaultdict(list)
            root_lots: List[dict] = []
            root_realizations: List[dict] = []
            active_anomaly_keys: set[str] = set()

            for row in root_rows:
                sub_account_id = row.get("sub_account_id")
                symbol = row.get("symbol")
                order_role = str(row.get("order_role") or "UNKNOWN").upper()
                order_side = str(row.get("side") or "").upper()
                if not sub_account_id or not symbol or order_role in {"REPRICE", "UNKNOWN"}:
                    continue

                fill_qty = float(row.get("fill_qty") or 0.0)
                fill_price = float(row.get("fill_price") or 0.0)
                fee = float(row.get("fee") or 0.0)
                fill_ts = _to_datetime(row.get("fill_ts")) or now
                source_strategy_session_id = row.get("strategy_session_id") or root_strategy_session_id
                key_position_side = (
                    _position_side_for_open(order_side)
                    if order_role in OPENING_ROLES
                    else _position_side_for_close(order_side)
                )
                key = (str(sub_account_id), str(root_strategy_session_id), str(symbol), key_position_side)

                if order_role in OPENING_ROLES:
                    lot = {
                        "id": _lot_id(row.get("fill_fact_id")),
                        "sub_account_id": str(sub_account_id),
                        "root_strategy_session_id": str(root_strategy_session_id),
                        "source_strategy_session_id": str(source_strategy_session_id),
                        "symbol": str(symbol),
                        "position_side": key_position_side,
                        "source_lifecycle_id": row.get("lifecycle_id"),
                        "source_fill_fact_id": row.get("fill_fact_id"),
                        "opened_ts": fill_ts,
                        "open_qty": fill_qty,
                        "remaining_qty": fill_qty,
                        "open_price": fill_price,
                        "open_fee": fee,
                        "status": "OPEN",
                        "closed_ts": None,
                    }
                    open_lots[key].append(lot)
                    root_lots.append(lot)
                    continue

                if order_role not in CLOSING_ROLES:
                    continue

                remaining_close = fill_qty
                bucket = open_lots.get(key, [])
                for lot in bucket:
                    if remaining_close <= EPSILON:
                        break
                    lot_remaining = float(lot["remaining_qty"] or 0.0)
                    if lot_remaining <= EPSILON:
                        continue
                    allocated_qty = min(remaining_close, lot_remaining)
                    gross_realized_pnl = _compute_pnl(key_position_side, float(lot["open_price"]), fill_price, allocated_qty)
                    open_fee_allocated = float(lot["open_fee"] or 0.0) * (
                        allocated_qty / float(lot["open_qty"] or allocated_qty or 1.0)
                    )
                    close_fee_allocated = fee * (allocated_qty / fill_qty) if fill_qty > 0 else 0.0
                    net_realized_pnl = gross_realized_pnl - open_fee_allocated - close_fee_allocated
                    lot["remaining_qty"] = max(0.0, lot_remaining - allocated_qty)
                    if lot["remaining_qty"] <= EPSILON:
                        lot["remaining_qty"] = 0.0
                        lot["status"] = "CLOSED"
                        lot["closed_ts"] = fill_ts
                    root_realizations.append({
                        "id": _realization_id(row.get("fill_fact_id"), lot["id"]),
                        "lot_id": lot["id"],
                        "sub_account_id": str(sub_account_id),
                        "root_strategy_session_id": str(root_strategy_session_id),
                        "source_strategy_session_id": str(source_strategy_session_id),
                        "close_lifecycle_id": row.get("lifecycle_id"),
                        "close_fill_fact_id": row.get("fill_fact_id"),
                        "realized_ts": fill_ts,
                        "allocated_qty": allocated_qty,
                        "open_price": float(lot["open_price"]),
                        "close_price": fill_price,
                        "gross_realized_pnl": gross_realized_pnl,
                        "open_fee_allocated": open_fee_allocated,
                        "close_fee_allocated": close_fee_allocated,
                        "net_realized_pnl": net_realized_pnl,
                    })
                    remaining_close -= allocated_qty

                if remaining_close > EPSILON:
                    anomaly_key = f"UNMATCHED_CLOSE_QTY:{row.get('fill_fact_id')}"
                    active_anomaly_keys.add(anomaly_key)
                    anomaly_count += 1
                    await upsert_tca_anomaly(
                        self._db,
                        anomaly_key=anomaly_key,
                        anomaly_type="SESSION_PNL",
                        sub_account_id=str(sub_account_id),
                        root_strategy_session_id=str(root_strategy_session_id),
                        strategy_session_id=str(source_strategy_session_id),
                        lifecycle_id=row.get("lifecycle_id"),
                        fill_fact_id=row.get("fill_fact_id"),
                        severity="WARN",
                        status="OPEN",
                        payload={
                            "reason": "UNMATCHED_CLOSE_QTY",
                            "unmatchedQty": remaining_close,
                            "rootStrategySessionId": root_strategy_session_id,
                            "closeFillFactId": row.get("fill_fact_id"),
                        },
                        source_ts=fill_ts,
                    )

            await resolve_missing_anomalies(
                self._db,
                anomaly_type="SESSION_PNL",
                root_strategy_session_id=str(root_strategy_session_id),
                active_keys=active_anomaly_keys,
            )

            for lot in root_lots:
                await self._db.execute(
                    """INSERT INTO strategy_position_lots
                       (id, sub_account_id, root_strategy_session_id, source_strategy_session_id,
                        symbol, position_side, source_lifecycle_id, source_fill_fact_id,
                        opened_ts, open_qty, remaining_qty, open_price, open_fee,
                        status, closed_ts, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        lot["id"],
                        lot["sub_account_id"],
                        lot["root_strategy_session_id"],
                        lot["source_strategy_session_id"],
                        lot["symbol"],
                        lot["position_side"],
                        lot["source_lifecycle_id"],
                        lot["source_fill_fact_id"],
                        lot["opened_ts"],
                        lot["open_qty"],
                        lot["remaining_qty"],
                        lot["open_price"],
                        lot["open_fee"],
                        lot["status"],
                        lot["closed_ts"],
                        now,
                        now,
                    ),
                )
                lot_count += 1

            for realization in root_realizations:
                await self._db.execute(
                    """INSERT INTO strategy_lot_realizations
                       (id, lot_id, sub_account_id, root_strategy_session_id, source_strategy_session_id,
                        close_lifecycle_id, close_fill_fact_id, realized_ts, allocated_qty,
                        open_price, close_price, gross_realized_pnl, open_fee_allocated,
                        close_fee_allocated, net_realized_pnl, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        realization["id"],
                        realization["lot_id"],
                        realization["sub_account_id"],
                        realization["root_strategy_session_id"],
                        realization["source_strategy_session_id"],
                        realization["close_lifecycle_id"],
                        realization["close_fill_fact_id"],
                        realization["realized_ts"],
                        realization["allocated_qty"],
                        realization["open_price"],
                        realization["close_price"],
                        realization["gross_realized_pnl"],
                        realization["open_fee_allocated"],
                        realization["close_fee_allocated"],
                        realization["net_realized_pnl"],
                        now,
                    ),
                )
                realization_count += 1

        return {
            "lot_count": lot_count,
            "realization_count": realization_count,
            "anomaly_count": anomaly_count,
        }
