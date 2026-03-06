"""
LifecycleStore — Persist canonical lifecycle/TCA read models from Redis Streams.

The trade event stream remains the source of truth. This store materializes
append-only lifecycle tables without mutating OMS/risk behavior.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from contracts.common import normalize_symbol, ts_external_to_s
from trading_engine_python.tca.storage import upsert_tca_anomaly

logger = logging.getLogger(__name__)

DEFAULT_VENUE = "BINANCE_FUTURES"
DEFAULT_VENUE_ACCOUNT_KEY = os.getenv("TCA_VENUE_ACCOUNT_KEY", "binance:futures:main")
ORDER_ROLES = {"ENTRY", "ADD", "UNWIND", "FLATTEN", "REPRICE", "HEDGE", "UNKNOWN"}


def _db_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt_from_external(value: Any) -> Optional[datetime]:
    seconds = ts_external_to_s(value)
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc).replace(tzinfo=None)


def _to_float(value: Any) -> Optional[float]:
    if value in (None, "", "None"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> Optional[int]:
    if value in (None, "", "None"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_bool(value: Any, default: bool = False) -> bool:
    if value in (None, "", "None"):
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes")


def _normalize_order_role(value: Any) -> str:
    role = str(value or "").strip().upper()
    if role in ORDER_ROLES:
        return role
    return "UNKNOWN"


def _coalesce(*values: Any) -> Any:
    for value in values:
        if value not in (None, "", "None"):
            return value
    return None


def _origin_path(event_type: str, origin: str, event: dict) -> str:
    origin_upper = (origin or "MANUAL").upper()
    if origin_upper == "BACKFILL":
        return "BACKFILL"
    if origin_upper == "RECOVERED":
        return "RECOVERED"
    if event_type == "ORDER_INTENT" and (origin_upper == "BOT" or event.get("user_id")):
        return "PROXY_BOT"
    if origin_upper == "BOT":
        return "BOT_FEED"
    return "PYTHON_CMD"


def _ownership_confidence(origin: str, sub_account_id: Optional[str]) -> str:
    origin_upper = (origin or "").upper()
    if origin_upper == "BACKFILL":
        return "BACKFILL"
    if sub_account_id:
        return "HARD"
    return "UNKNOWN"


def _strategy_type(origin: str, parent_id: Optional[str]) -> Optional[str]:
    if not parent_id:
        return None
    return (origin or "MANUAL").upper()


def _strategy_type_from_session_id(session_id: Optional[str], fallback: Optional[str] = None) -> Optional[str]:
    text = str(session_id or "").strip().lower()
    if text.startswith("scalper_") or text.startswith("scalper-"):
        return "SCALPER"
    if text.startswith("chase_") or text.startswith("chase-"):
        return "CHASE"
    if text.startswith("twap_") or text.startswith("twap-"):
        return "TWAP"
    if text.startswith("trail_stop_") or text.startswith("trail-stop_") or text.startswith("trailstop_"):
        return "TRAIL_STOP"
    if fallback:
        return str(fallback).upper()
    return None


class LifecycleStore:
    """Persist lifecycle rows, event rows, and fill facts from stream events."""

    def __init__(self, db: Any) -> None:
        self._db = db
        self._unknown_role_count = 0
        self._unknown_lineage_count = 0

    async def record(self, event: dict, order: Any = None) -> Optional[str]:
        """Persist one canonical lifecycle event idempotently."""
        if not self._db:
            return None

        doc = self._normalize_event(event, order=order)
        if not doc["stream_event_id"]:
            return None
        if not doc["client_order_id"] and not doc["exchange_order_id"]:
            return None

        existing_event = await self._db.fetch_one(
            "SELECT id FROM order_lifecycle_events WHERE stream_event_id = ?",
            (doc["stream_event_id"],),
        )
        if existing_event:
            return None

        await self._ensure_strategy_session(doc)
        lifecycle = await self._find_lifecycle(doc)
        if lifecycle:
            lifecycle_id = lifecycle["id"]
            await self._update_lifecycle(lifecycle, doc)
        else:
            lifecycle_id = str(uuid.uuid4())
            await self._insert_lifecycle(lifecycle_id, doc)

        await self._insert_event(lifecycle_id, doc)
        await self._insert_fill_fact(lifecycle_id, doc)
        await self._upsert_lineage_edges(lifecycle_id, doc)
        await self._record_lineage_anomaly_if_needed(lifecycle_id, doc)
        return lifecycle_id

    async def _find_lifecycle(self, doc: dict) -> Optional[dict]:
        if doc["client_order_id"]:
            row = await self._db.fetch_one(
                "SELECT * FROM order_lifecycles WHERE client_order_id = ?",
                (doc["client_order_id"],),
            )
            if row:
                return row
        if doc["exchange_order_id"]:
            row = await self._db.fetch_one(
                "SELECT * FROM order_lifecycles WHERE exchange_order_id = ?",
                (doc["exchange_order_id"],),
            )
            if row:
                return row
        return None

    async def _ensure_strategy_session(self, doc: dict) -> None:
        strategy_session_id = doc["strategy_session_id"]
        parent_strategy_session_id = doc["parent_strategy_session_id"]
        root_strategy_session_id = doc["root_strategy_session_id"] or strategy_session_id
        session_started_at = doc["session_started_at"] or doc["event_ts"] or _db_now()

        async def _upsert_session(session_id: str, *, session_role: str, origin: str) -> None:
            session_strategy_type = _strategy_type_from_session_id(session_id, doc["strategy_type"])
            session_origin = session_strategy_type or str(origin or doc["origin"] or "MANUAL").upper()
            existing = await self._db.fetch_one(
                "SELECT id, ended_at FROM strategy_sessions WHERE id = ?",
                (session_id,),
            )
            if not existing:
                await self._db.execute(
                    """INSERT INTO strategy_sessions
                       (id, sub_account_id, origin, strategy_type, parent_strategy_session_id,
                        root_strategy_session_id, session_role, symbol, side,
                        started_at, ended_at, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        doc["sub_account_id"],
                        session_origin,
                        session_strategy_type,
                        parent_strategy_session_id if session_role == "CHILD" else None,
                        root_strategy_session_id,
                        session_role,
                        doc["symbol"],
                        doc["side"],
                        session_started_at,
                        doc["done_ts"] if session_id == strategy_session_id else None,
                        _db_now(),
                        _db_now(),
                    ),
                )
                return

            await self._db.execute(
                """UPDATE strategy_sessions
                   SET origin = ?, strategy_type = ?, parent_strategy_session_id = ?,
                       root_strategy_session_id = ?, session_role = ?, symbol = COALESCE(symbol, ?),
                       side = COALESCE(side, ?), started_at = COALESCE(started_at, ?),
                       ended_at = COALESCE(ended_at, ?), updated_at = ?
                   WHERE id = ?""",
                (
                    session_origin,
                    session_strategy_type,
                    parent_strategy_session_id if session_role == "CHILD" else None,
                    root_strategy_session_id,
                    session_role,
                    doc["symbol"],
                    doc["side"],
                    session_started_at,
                    doc["done_ts"] if session_id == strategy_session_id else None,
                    _db_now(),
                    session_id,
                ),
            )

        if root_strategy_session_id:
            root_role = "ROOT"
            await _upsert_session(root_strategy_session_id, session_role=root_role, origin=doc["origin"])

        if strategy_session_id:
            session_role = "ROOT" if strategy_session_id == root_strategy_session_id else ("CHILD" if parent_strategy_session_id else "STANDALONE")
            await _upsert_session(strategy_session_id, session_role=session_role, origin=doc["origin"])

    async def _insert_lifecycle(self, lifecycle_id: str, doc: dict) -> None:
        await self._db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key,
               ownership_confidence, origin_path, strategy_type, strategy_session_id, parent_strategy_session_id,
               root_strategy_session_id, parent_id,
                client_order_id, exchange_order_id, symbol, side, order_type, order_role, reduce_only,
                requested_qty, limit_price, decision_bid, decision_ask, decision_mid, decision_spread_bps,
                intent_ts, ack_ts, first_fill_ts, done_ts,
                final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                lifecycle_id,
                doc["execution_scope"],
                doc["sub_account_id"],
                doc["venue"],
                doc["venue_account_key"],
                doc["ownership_confidence"],
                doc["origin_path"],
                doc["strategy_type"],
                doc["strategy_session_id"],
                doc["parent_strategy_session_id"],
                doc["root_strategy_session_id"],
                doc["parent_id"],
                doc["client_order_id"],
                doc["exchange_order_id"],
                doc["symbol"],
                doc["side"],
                doc["order_type"],
                doc["order_role"],
                doc["reduce_only"],
                doc["requested_qty"],
                doc["limit_price"],
                doc["decision_bid"],
                doc["decision_ask"],
                doc["decision_mid"],
                doc["decision_spread_bps"],
                doc["intent_ts"],
                doc["ack_ts"],
                doc["first_fill_ts"],
                doc["done_ts"],
                doc["final_status"],
                doc["filled_qty"] or 0,
                doc["avg_fill_price"],
                doc["reprice_count"] or 0,
                _db_now(),
                _db_now(),
            ),
        )

    async def _update_lifecycle(self, existing: dict, doc: dict) -> None:
        merged = {
            "execution_scope": doc["execution_scope"] or existing.get("execution_scope") or "SUB_ACCOUNT",
            "sub_account_id": existing.get("sub_account_id") or doc["sub_account_id"],
            "venue": existing.get("venue") or doc["venue"],
            "venue_account_key": existing.get("venue_account_key") or doc["venue_account_key"],
            "ownership_confidence": doc["ownership_confidence"] or existing.get("ownership_confidence") or "HARD",
            "origin_path": doc["origin_path"] or existing.get("origin_path") or "PYTHON_CMD",
            "strategy_type": existing.get("strategy_type") or doc["strategy_type"],
            "strategy_session_id": existing.get("strategy_session_id") or doc["strategy_session_id"],
            "parent_strategy_session_id": existing.get("parent_strategy_session_id") or doc["parent_strategy_session_id"],
            "root_strategy_session_id": existing.get("root_strategy_session_id") or doc["root_strategy_session_id"],
            "parent_id": existing.get("parent_id") or doc["parent_id"],
            "client_order_id": existing.get("client_order_id") or doc["client_order_id"],
            "exchange_order_id": existing.get("exchange_order_id") or doc["exchange_order_id"],
            "symbol": doc["symbol"] or existing.get("symbol"),
            "side": doc["side"] or existing.get("side"),
            "order_type": doc["order_type"] or existing.get("order_type"),
            "order_role": doc["order_role"] if doc["order_role"] != "UNKNOWN" else (existing.get("order_role") or "UNKNOWN"),
            "reduce_only": bool(existing.get("reduce_only")) or doc["reduce_only"],
            "requested_qty": existing.get("requested_qty") or doc["requested_qty"],
            "limit_price": existing.get("limit_price") or doc["limit_price"],
            "decision_bid": existing.get("decision_bid") or doc["decision_bid"],
            "decision_ask": existing.get("decision_ask") or doc["decision_ask"],
            "decision_mid": existing.get("decision_mid") or doc["decision_mid"],
            "decision_spread_bps": existing.get("decision_spread_bps") or doc["decision_spread_bps"],
            "intent_ts": existing.get("intent_ts") or doc["intent_ts"],
            "ack_ts": existing.get("ack_ts") or doc["ack_ts"],
            "first_fill_ts": existing.get("first_fill_ts") or doc["first_fill_ts"],
            "done_ts": doc["done_ts"] or existing.get("done_ts"),
            "final_status": doc["final_status"] or existing.get("final_status"),
            "filled_qty": doc["filled_qty"] if doc["filled_qty"] is not None else existing.get("filled_qty", 0),
            "avg_fill_price": doc["avg_fill_price"] or existing.get("avg_fill_price"),
            "reprice_count": max(int(existing.get("reprice_count") or 0), int(doc["reprice_count"] or 0)),
        }
        await self._db.execute(
            """UPDATE order_lifecycles
               SET execution_scope = ?, sub_account_id = ?, venue = ?, venue_account_key = ?,
                   ownership_confidence = ?, origin_path = ?, strategy_type = ?, strategy_session_id = ?,
                   parent_strategy_session_id = ?, root_strategy_session_id = ?, parent_id = ?,
                   client_order_id = ?, exchange_order_id = ?, symbol = ?, side = ?,
                   order_type = ?, order_role = ?, reduce_only = ?, requested_qty = ?, limit_price = ?,
                   decision_bid = ?, decision_ask = ?, decision_mid = ?, decision_spread_bps = ?,
                   intent_ts = ?, ack_ts = ?, first_fill_ts = ?, done_ts = ?, final_status = ?, filled_qty = ?,
                   avg_fill_price = ?, reprice_count = ?, updated_at = ?
               WHERE id = ?""",
            (
                merged["execution_scope"],
                merged["sub_account_id"],
                merged["venue"],
                merged["venue_account_key"],
                merged["ownership_confidence"],
                merged["origin_path"],
                merged["strategy_type"],
                merged["strategy_session_id"],
                merged["parent_strategy_session_id"],
                merged["root_strategy_session_id"],
                merged["parent_id"],
                merged["client_order_id"],
                merged["exchange_order_id"],
                merged["symbol"],
                merged["side"],
                merged["order_type"],
                merged["order_role"],
                merged["reduce_only"],
                merged["requested_qty"],
                merged["limit_price"],
                merged["decision_bid"],
                merged["decision_ask"],
                merged["decision_mid"],
                merged["decision_spread_bps"],
                merged["intent_ts"],
                merged["ack_ts"],
                merged["first_fill_ts"],
                merged["done_ts"],
                merged["final_status"],
                merged["filled_qty"] or 0,
                merged["avg_fill_price"],
                merged["reprice_count"],
                _db_now(),
                existing["id"],
            ),
        )

    async def _insert_event(self, lifecycle_id: str, doc: dict) -> None:
        await self._db.execute(
            """INSERT INTO order_lifecycle_events
               (id, lifecycle_id, stream_event_id, event_type, source_ts, ingested_ts, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                lifecycle_id,
                doc["stream_event_id"],
                doc["event_type"],
                doc["event_ts"],
                doc["ingested_ts"],
                doc["payload_json"],
                _db_now(),
            ),
        )

    async def _insert_fill_fact(self, lifecycle_id: str, doc: dict) -> None:
        if doc["fill_qty"] is None or doc["fill_qty"] <= 0:
            return
        if doc["fill_price"] is None or doc["fill_price"] <= 0:
            return
        await self._db.execute(
            """INSERT INTO fill_facts
               (id, lifecycle_id, sub_account_id, source_event_id, execution_scope,
                ownership_confidence, symbol, side, fill_ts, fill_qty, fill_price,
                fee, maker_taker, origin_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_event_id) DO NOTHING""",
            (
                str(uuid.uuid4()),
                lifecycle_id,
                doc["sub_account_id"],
                doc["stream_event_id"],
                doc["execution_scope"],
                doc["ownership_confidence"],
                doc["symbol"],
                doc["side"],
                doc["first_fill_ts"] or doc["event_ts"] or _db_now(),
                doc["fill_qty"],
                doc["fill_price"],
                doc["fee"] or 0,
                doc["maker_taker"],
                doc["origin"],
                _db_now(),
            ),
        )

    async def _insert_lineage_edge(
        self,
        *,
        execution_scope: str,
        sub_account_id: Optional[str],
        ownership_confidence: str,
        parent_node_type: str,
        parent_node_id: str,
        child_node_type: str,
        child_node_id: str,
        relation_type: str,
        source_event_id: Optional[str],
        source_ts: Optional[datetime],
        ingested_ts: Optional[datetime],
    ) -> None:
        if not parent_node_id or not child_node_id:
            return
        await self._db.execute(
            """INSERT INTO algo_lineage_edges
               (id, execution_scope, sub_account_id, ownership_confidence,
                parent_node_type, parent_node_id, child_node_type, child_node_id,
                relation_type, source_event_id, source_ts, ingested_ts, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(parent_node_type, parent_node_id, child_node_type, child_node_id, relation_type)
               DO NOTHING""",
            (
                str(uuid.uuid4()),
                execution_scope,
                sub_account_id,
                ownership_confidence,
                parent_node_type,
                parent_node_id,
                child_node_type,
                child_node_id,
                relation_type,
                source_event_id,
                source_ts,
                ingested_ts,
                _db_now(),
            ),
        )

    async def _upsert_lineage_edges(self, lifecycle_id: str, doc: dict) -> None:
        strategy_session_id = doc.get("strategy_session_id")
        parent_strategy_session_id = doc.get("parent_strategy_session_id")
        if strategy_session_id:
            await self._insert_lineage_edge(
                execution_scope=doc["execution_scope"],
                sub_account_id=doc["sub_account_id"],
                ownership_confidence=doc["ownership_confidence"],
                parent_node_type="STRATEGY_SESSION",
                parent_node_id=str(strategy_session_id),
                child_node_type="ORDER_LIFECYCLE",
                child_node_id=lifecycle_id,
                relation_type="SUBMITS_ORDER",
                source_event_id=doc["stream_event_id"],
                source_ts=doc["event_ts"],
                ingested_ts=doc["ingested_ts"],
            )

        if strategy_session_id and parent_strategy_session_id and strategy_session_id != parent_strategy_session_id:
            await self._insert_lineage_edge(
                execution_scope=doc["execution_scope"],
                sub_account_id=doc["sub_account_id"],
                ownership_confidence=doc["ownership_confidence"],
                parent_node_type="STRATEGY_SESSION",
                parent_node_id=str(parent_strategy_session_id),
                child_node_type="STRATEGY_SESSION",
                child_node_id=str(strategy_session_id),
                relation_type="SPAWNS_SESSION",
                source_event_id=doc["stream_event_id"],
                source_ts=doc["event_ts"],
                ingested_ts=doc["ingested_ts"],
            )

        replaces_client_order_id = doc.get("replaces_client_order_id")
        if replaces_client_order_id:
            previous = await self._db.fetch_one(
                "SELECT id FROM order_lifecycles WHERE client_order_id = ?",
                (replaces_client_order_id,),
            )
            if previous and previous.get("id"):
                await self._insert_lineage_edge(
                    execution_scope=doc["execution_scope"],
                    sub_account_id=doc["sub_account_id"],
                    ownership_confidence=doc["ownership_confidence"],
                    parent_node_type="ORDER_LIFECYCLE",
                    parent_node_id=previous["id"],
                    child_node_type="ORDER_LIFECYCLE",
                    child_node_id=lifecycle_id,
                    relation_type="REPRICES_ORDER",
                    source_event_id=doc["stream_event_id"],
                    source_ts=doc["event_ts"],
                    ingested_ts=doc["ingested_ts"],
                )

        if doc.get("fill_qty") and doc.get("fill_price"):
            fill = await self._db.fetch_one(
                "SELECT id FROM fill_facts WHERE source_event_id = ?",
                (doc["stream_event_id"],),
            )
            if fill and fill.get("id"):
                await self._insert_lineage_edge(
                    execution_scope=doc["execution_scope"],
                    sub_account_id=doc["sub_account_id"],
                    ownership_confidence=doc["ownership_confidence"],
                    parent_node_type="ORDER_LIFECYCLE",
                    parent_node_id=lifecycle_id,
                    child_node_type="FILL_FACT",
                    child_node_id=fill["id"],
                    relation_type="GENERATES_FILL",
                    source_event_id=doc["stream_event_id"],
                    source_ts=doc["event_ts"],
                    ingested_ts=doc["ingested_ts"],
                )

    async def _record_lineage_anomaly_if_needed(self, lifecycle_id: str, doc: dict) -> None:
        origin = str(doc.get("origin") or "").upper()
        is_algo = origin in {"SCALPER", "CHASE", "TWAP", "TRAIL_STOP"}
        if not is_algo:
            return

        reasons: list[str] = []
        if doc.get("order_role", "UNKNOWN") == "UNKNOWN":
            self._unknown_role_count += 1
        if not doc.get("strategy_session_id"):
            if doc.get("order_role", "UNKNOWN") == "UNKNOWN":
                reasons.append("UNKNOWN_ORDER_ROLE")
            self._unknown_lineage_count += 1
            reasons.append("MISSING_STRATEGY_SESSION")
        if not reasons:
            if doc.get("order_role", "UNKNOWN") == "UNKNOWN":
                logger.info(
                    "LifecycleStore role anomaly (UNKNOWN_ORDER_ROLE) unknown_role_count=%d unknown_lineage_count=%d",
                    self._unknown_role_count,
                    self._unknown_lineage_count,
                )
            return

        reason = "|".join(reasons)
        now = _db_now()
        payload = {
            "reason": reason,
            "origin": origin or "UNKNOWN",
            "orderRole": doc.get("order_role", "UNKNOWN"),
            "strategySessionId": doc.get("strategy_session_id"),
            "clientOrderId": doc.get("client_order_id"),
        }
        await self._db.execute(
            """INSERT INTO order_lifecycle_events
               (id, lifecycle_id, stream_event_id, event_type, source_ts, ingested_ts, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(stream_event_id) DO NOTHING""",
            (
                str(uuid.uuid4()),
                lifecycle_id,
                f"lineage-anomaly:{doc['stream_event_id']}:{reason}",
                "TCA_LINEAGE_ANOMALY",
                doc["event_ts"] or now,
                doc["ingested_ts"] or now,
                json.dumps(payload, sort_keys=True),
                now,
            ),
        )
        await upsert_tca_anomaly(
            self._db,
            anomaly_key=f"LINEAGE:{lifecycle_id}:{reason}",
            anomaly_type="LINEAGE",
            sub_account_id=doc.get("sub_account_id"),
            root_strategy_session_id=doc.get("root_strategy_session_id"),
            strategy_session_id=doc.get("strategy_session_id"),
            lifecycle_id=lifecycle_id,
            severity="WARN",
            status="OPEN",
            payload=payload,
            source_ts=doc["event_ts"] or now,
        )
        logger.info(
            "LifecycleStore lineage anomaly (%s) unknown_role_count=%d unknown_lineage_count=%d",
            reason,
            self._unknown_role_count,
            self._unknown_lineage_count,
        )

    def _normalize_event(self, event: dict, order: Any = None) -> dict:
        event_type = str(event.get("type", "") or "")
        client_order_id = _coalesce(event.get("client_order_id"), getattr(order, "client_order_id", None))
        exchange_order_id = _coalesce(event.get("exchange_order_id"), getattr(order, "exchange_order_id", None))
        origin = _coalesce(event.get("origin"), getattr(order, "origin", None), "MANUAL")
        parent_id = _coalesce(event.get("parent_id"), getattr(order, "parent_id", None))
        symbol = normalize_symbol(_coalesce(event.get("symbol"), getattr(order, "symbol", None)) or "")
        quantity = _to_float(_coalesce(event.get("quantity"), getattr(order, "quantity", None)))
        limit_price = _to_float(_coalesce(event.get("price"), getattr(order, "price", None)))
        avg_fill_price = _to_float(_coalesce(event.get("avg_price"), getattr(order, "avg_fill_price", None)))
        fill_price = _to_float(_coalesce(event.get("fill_price"), avg_fill_price))
        fill_qty = _to_float(event.get("fill_qty"))
        filled_qty = _to_float(_coalesce(event.get("filled_qty"), getattr(order, "filled_qty", None), fill_qty))
        event_ts = _dt_from_external(
            _coalesce(
                event.get("source_ts"),
                event.get("intent_ts"),
                event.get("rejected_ts"),
                event.get("ts"),
                event.get("ingested_ts"),
            )
        )
        ingested_ts = _dt_from_external(_coalesce(event.get("ingested_ts"), event.get("ts"), event.get("source_ts")))
        reason = str(_coalesce(event.get("reason"), event.get("status"), "") or "").upper()
        final_status = None
        if event_type == "ORDER_STATE_FILLED":
            final_status = "FILLED"
        elif event_type == "ORDER_STATE_REJECTED":
            final_status = "REJECTED"
        elif event_type == "ORDER_STATE_CANCELLED":
            final_status = "EXPIRED" if reason == "EXPIRED" else "CANCELLED"

        stream_event_id = str(
            _coalesce(
                event.get("_event_id"),
                event.get("stream_event_id"),
                f"{event_type}:{client_order_id or ''}:{exchange_order_id or ''}:{event.get('source_ts') or event.get('ts') or ''}:{event.get('fill_qty') or ''}:{event.get('fill_price') or ''}",
            )
        )

        strategy_session_id = _coalesce(
            event.get("strategy_session_id"),
            getattr(order, "strategy_session_id", None),
            parent_id,
        )
        parent_strategy_session_id = _coalesce(
            event.get("parent_strategy_session_id"),
            getattr(order, "parent_strategy_session_id", None),
        )
        root_strategy_session_id = _coalesce(
            event.get("root_strategy_session_id"),
            getattr(order, "root_strategy_session_id", None),
            strategy_session_id,
        )
        replaces_client_order_id = _coalesce(
            event.get("replaces_client_order_id"),
            getattr(order, "replaces_client_order_id", None),
        )
        order_role = _normalize_order_role(
            _coalesce(event.get("order_role"), getattr(order, "order_role", None), "UNKNOWN")
        )

        return {
            "stream_event_id": stream_event_id,
            "event_type": event_type,
            "client_order_id": client_order_id,
            "exchange_order_id": exchange_order_id,
            "sub_account_id": _coalesce(event.get("sub_account_id"), getattr(order, "sub_account_id", None)),
            "execution_scope": _coalesce(event.get("execution_scope"), "SUB_ACCOUNT"),
            "venue": _coalesce(event.get("venue"), DEFAULT_VENUE),
            "venue_account_key": _coalesce(event.get("venue_account_key"), DEFAULT_VENUE_ACCOUNT_KEY),
            "ownership_confidence": _ownership_confidence(origin, _coalesce(event.get("sub_account_id"), getattr(order, "sub_account_id", None))),
            "origin_path": _origin_path(event_type, origin, event),
            "origin": str(origin),
            "strategy_type": _strategy_type(str(origin), strategy_session_id),
            "strategy_session_id": strategy_session_id,
            "parent_strategy_session_id": parent_strategy_session_id,
            "root_strategy_session_id": root_strategy_session_id,
            "parent_id": parent_id,
            "order_role": order_role,
            "replaces_client_order_id": replaces_client_order_id,
            "symbol": symbol or None,
            "side": _coalesce(event.get("side"), getattr(order, "side", None)),
            "order_type": _coalesce(event.get("order_type"), getattr(order, "order_type", None)),
            "reduce_only": _to_bool(_coalesce(event.get("reduce_only"), getattr(order, "reduce_only", None))),
            "requested_qty": quantity,
            "limit_price": limit_price,
            "decision_bid": _to_float(event.get("decision_bid")),
            "decision_ask": _to_float(event.get("decision_ask")),
            "decision_mid": _to_float(event.get("decision_mid")),
            "decision_spread_bps": _to_float(event.get("decision_spread_bps")),
            "intent_ts": event_ts if event_type == "ORDER_INTENT" else None,
            "ack_ts": event_ts if event_type == "ORDER_STATE_NEW" else None,
            "first_fill_ts": event_ts if event_type in ("ORDER_STATE_PARTIAL", "ORDER_STATE_FILLED") else None,
            "done_ts": event_ts if final_status else None,
            "final_status": final_status,
            "filled_qty": filled_qty,
            "avg_fill_price": avg_fill_price or fill_price,
            "fill_qty": fill_qty,
            "fill_price": fill_price or avg_fill_price,
            "fee": _to_float(_coalesce(event.get("commission"), event.get("fee"))),
            "maker_taker": _coalesce(event.get("maker_taker"), event.get("makerTaker")),
            "reprice_count": _to_int(event.get("reprice_count")),
            "session_started_at": event_ts if event_type == "ORDER_INTENT" else None,
            "event_ts": event_ts,
            "ingested_ts": ingested_ts,
            "payload_json": json.dumps(event, sort_keys=True),
        }
