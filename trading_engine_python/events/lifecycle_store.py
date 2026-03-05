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

logger = logging.getLogger(__name__)

DEFAULT_VENUE = "BINANCE_FUTURES"
DEFAULT_VENUE_ACCOUNT_KEY = os.getenv("TCA_VENUE_ACCOUNT_KEY", "binance:futures:main")


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


class LifecycleStore:
    """Persist lifecycle rows, event rows, and fill facts from stream events."""

    def __init__(self, db: Any) -> None:
        self._db = db

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
        if not strategy_session_id:
            return

        existing = await self._db.fetch_one(
            "SELECT id, ended_at FROM strategy_sessions WHERE id = ?",
            (strategy_session_id,),
        )
        if not existing:
            await self._db.execute(
                """INSERT INTO strategy_sessions
                   (id, sub_account_id, origin, strategy_type, symbol, side,
                    started_at, ended_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    strategy_session_id,
                    doc["sub_account_id"],
                    doc["origin"],
                    doc["strategy_type"],
                    doc["symbol"],
                    doc["side"],
                    doc["session_started_at"] or doc["event_ts"] or _db_now(),
                    doc["done_ts"],
                    _db_now(),
                    _db_now(),
                ),
            )
            return

        if doc["done_ts"] and not existing.get("ended_at"):
            await self._db.execute(
                "UPDATE strategy_sessions SET ended_at = ?, updated_at = ? WHERE id = ?",
                (doc["done_ts"], _db_now(), strategy_session_id),
            )

    async def _insert_lifecycle(self, lifecycle_id: str, doc: dict) -> None:
        await self._db.execute(
            """INSERT INTO order_lifecycles
               (id, execution_scope, sub_account_id, venue, venue_account_key,
               ownership_confidence, origin_path, strategy_type, strategy_session_id, parent_id,
                client_order_id, exchange_order_id, symbol, side, order_type, reduce_only,
                requested_qty, limit_price, decision_bid, decision_ask, decision_mid, decision_spread_bps,
                intent_ts, ack_ts, first_fill_ts, done_ts,
                final_status, filled_qty, avg_fill_price, reprice_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                doc["parent_id"],
                doc["client_order_id"],
                doc["exchange_order_id"],
                doc["symbol"],
                doc["side"],
                doc["order_type"],
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
            "parent_id": existing.get("parent_id") or doc["parent_id"],
            "client_order_id": existing.get("client_order_id") or doc["client_order_id"],
            "exchange_order_id": existing.get("exchange_order_id") or doc["exchange_order_id"],
            "symbol": doc["symbol"] or existing.get("symbol"),
            "side": doc["side"] or existing.get("side"),
            "order_type": doc["order_type"] or existing.get("order_type"),
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
                   parent_id = ?, client_order_id = ?, exchange_order_id = ?, symbol = ?, side = ?,
                   order_type = ?, reduce_only = ?, requested_qty = ?, limit_price = ?,
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
                merged["parent_id"],
                merged["client_order_id"],
                merged["exchange_order_id"],
                merged["symbol"],
                merged["side"],
                merged["order_type"],
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
                0,
                None,
                doc["origin"],
                _db_now(),
            ),
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
            "strategy_type": _strategy_type(str(origin), parent_id),
            "strategy_session_id": parent_id,
            "parent_id": parent_id,
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
            "reprice_count": _to_int(event.get("reprice_count")),
            "session_started_at": event_ts if event_type == "ORDER_INTENT" else None,
            "event_ts": event_ts,
            "ingested_ts": ingested_ts,
            "payload_json": json.dumps(event, sort_keys=True),
        }
