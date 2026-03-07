"""
StrategySessionSampler — dense 5s sampling for root strategy sessions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

from contracts.common import EventType, RedisKey, ts_ms
from contracts.events import StrategySampleEvent

logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _bucket_now(bucket_ms: int) -> datetime:
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    bucketed = now_ms - (now_ms % bucket_ms)
    return datetime.fromtimestamp(bucketed / 1000.0, timezone.utc).replace(tzinfo=None)


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
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            return None
    return None


def _mark_price(market_data: Any, symbol: str, fallback: float) -> float:
    if market_data and symbol:
        try:
            l1 = market_data.get_l1(symbol)
            if l1 and float(l1.get("mid", 0) or 0) > 0:
                return float(l1["mid"])
        except Exception:
            pass
    return fallback


def _build_in_clause(values: list[str]) -> tuple[str, tuple[str, ...]]:
    if not values:
        return "(NULL)", ()
    return f"({','.join('?' for _ in values)})", tuple(values)


class StrategySessionSampler:
    def __init__(
        self,
        db: Any,
        market_data: Any = None,
        redis_client: Any = None,
        *,
        interval_sec: float = 5.0,
        db_interval_sec: float = 15.0,
        live_retention_sec: int = 3600,
        live_cap: int = 720,
    ) -> None:
        self._db = db
        self._market_data = market_data
        self._redis = redis_client
        self._interval_sec = interval_sec
        self._db_interval_sec = max(interval_sec, db_interval_sec)
        self._live_retention_sec = live_retention_sec
        self._live_cap = max(60, live_cap)

    async def run(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                summary = await self.sample_once()
                if summary["pnl_samples"] or summary["param_samples"]:
                    logger.debug(
                        "StrategySessionSampler wrote %d pnl sample(s) and %d param sample(s)",
                        summary["pnl_samples"],
                        summary["param_samples"],
                    )
            except Exception as exc:
                logger.error("StrategySessionSampler error: %s", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_sec)
            except asyncio.TimeoutError:
                continue

    async def sample_once(self) -> dict:
        if not self._db:
            return {"pnl_samples": 0, "param_samples": 0, "live_samples": 0}

        live_sampled_at = _bucket_now(5_000)
        sampled_at = _bucket_now(int(self._db_interval_sec * 1000))
        sessions = await self._load_active_sessions()
        if not sessions:
            return {"pnl_samples": 0, "param_samples": 0, "live_samples": 0}

        session_ids = [str(session["strategy_session_id"]) for session in sessions if session.get("strategy_session_id")]
        open_lots, realizations, fill_counts = await self._load_session_data(session_ids)

        open_by_session = defaultdict(list)
        for row in open_lots or []:
            open_by_session[row["root_strategy_session_id"]].append(row)

        realizations_by_session = defaultdict(list)
        close_fill_ids = defaultdict(set)
        for row in realizations or []:
            realizations_by_session[row["root_strategy_session_id"]].append(row)
            if row.get("close_fill_fact_id"):
                close_fill_ids[row["root_strategy_session_id"]].add(row["close_fill_fact_id"])

        fill_count_by_session = {
            row["root_strategy_session_id"]: int(row.get("fill_count") or 0)
            for row in fill_counts or []
        }

        pnl_samples = 0
        param_samples = 0
        live_samples = 0
        for session in sessions:
            snapshot = session.get("_snapshot")
            if not snapshot:
                snapshot = await self._load_checkpoint_snapshot(session["strategy_session_id"])
            if not snapshot:
                continue

            symbol = str(snapshot.get("symbol") or "")
            mark_price = _mark_price(self._market_data, symbol, float(snapshot.get("lastKnownPrice", 0) or 0))
            session_id = session["strategy_session_id"]
            session_lots = open_by_session.get(session_id, [])
            session_realizations = realizations_by_session.get(session_id, [])

            open_qty = 0.0
            open_notional = 0.0
            unrealized_pnl = 0.0
            fees_total = 0.0
            for lot in session_lots:
                remaining_qty = float(lot.get("remaining_qty") or 0)
                open_qty += remaining_qty
                open_notional += remaining_qty * mark_price if mark_price > 0 else 0.0
                fees_total += float(lot.get("open_fee") or 0)
                if mark_price > 0:
                    if lot.get("position_side") == "SHORT":
                        unrealized_pnl += (float(lot.get("open_price") or 0) - mark_price) * remaining_qty
                    else:
                        unrealized_pnl += (mark_price - float(lot.get("open_price") or 0)) * remaining_qty

            realized_pnl = 0.0
            close_totals = Counter()
            for realization in session_realizations:
                realized_pnl += float(realization.get("net_realized_pnl") or 0)
                fees_total += float(realization.get("close_fee_allocated") or 0)
                close_id = realization.get("close_fill_fact_id")
                if close_id:
                    close_totals[close_id] += float(realization.get("net_realized_pnl") or 0)

            win_count = sum(1 for value in close_totals.values() if value > 0)
            loss_count = sum(1 for value in close_totals.values() if value < 0)
            close_count = len(close_totals)
            net_pnl = realized_pnl + unrealized_pnl

            sample_event = StrategySampleEvent(
                strategy_session_id=session_id,
                sub_account_id=session["sub_account_id"],
                symbol=symbol,
                status=str(snapshot.get("status") or "ACTIVE"),
                sampled_at=ts_ms() if live_sampled_at is None else int(live_sampled_at.replace(tzinfo=timezone.utc).timestamp() * 1000),
                net_pnl=net_pnl,
                realized_pnl=realized_pnl,
                unrealized_pnl=unrealized_pnl,
                open_qty=open_qty,
                open_notional=open_notional,
                fill_count=fill_count_by_session.get(session_id, 0),
                close_count=close_count,
                win_count=win_count,
                loss_count=loss_count,
                long_active_slots=sum(1 for slot in (snapshot.get("longSlots") or []) if slot.get("active")),
                short_active_slots=sum(1 for slot in (snapshot.get("shortSlots") or []) if slot.get("active")),
                long_paused_slots=sum(1 for slot in (snapshot.get("longSlots") or []) if slot.get("paused")),
                short_paused_slots=sum(1 for slot in (snapshot.get("shortSlots") or []) if slot.get("paused")),
                long_retrying_slots=sum(1 for slot in (snapshot.get("longSlots") or []) if slot.get("retryAt")),
                short_retrying_slots=sum(1 for slot in (snapshot.get("shortSlots") or []) if slot.get("retryAt")),
            )
            if await self._publish_live_sample(sample_event):
                live_samples += 1

            await self._db.execute(
                """INSERT INTO strategy_session_pnl_samples
                   (id, strategy_session_id, sub_account_id, sampled_at, mark_price,
                    realized_pnl, unrealized_pnl, net_pnl, fees_total,
                    open_qty, open_notional, fill_count, close_count, win_count, loss_count, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_session_id, sampled_at) DO NOTHING""",
                (
                    str(uuid.uuid4()),
                    session_id,
                    session["sub_account_id"],
                    sampled_at,
                    mark_price if mark_price > 0 else None,
                    realized_pnl,
                    unrealized_pnl,
                    net_pnl,
                    fees_total,
                    open_qty,
                    open_notional,
                    fill_count_by_session.get(session_id, 0),
                    close_count,
                    win_count,
                    loss_count,
                    _now_utc(),
                ),
            )
            pnl_samples += 1

            long_slots = snapshot.get("longSlots") or []
            short_slots = snapshot.get("shortSlots") or []
            pause_reasons = Counter()
            for slot in long_slots + short_slots:
                reason = slot.get("pauseReason")
                if reason:
                    pause_reasons[reason] += 1

            await self._db.execute(
                """INSERT INTO strategy_session_param_samples
                   (id, strategy_session_id, sub_account_id, sampled_at, sample_reason, status, start_side,
                    neutral_mode, allow_loss, reduce_only_armed, leverage, child_count, skew,
                    long_offset_pct, short_offset_pct, long_size_usd, short_size_usd,
                    long_max_price, short_min_price, pin_long_to_entry, pin_short_to_entry,
                    min_fill_spread_pct, fill_decay_half_life_ms, min_refill_delay_ms,
                    max_loss_per_close_bps, max_fills_per_minute, pnl_feedback_mode,
                    last_known_price, total_fill_count, long_active_slots, short_active_slots,
                    long_paused_slots, short_paused_slots, long_retrying_slots, short_retrying_slots,
                    pause_reasons_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_session_id, sampled_at, sample_reason) DO NOTHING""",
                (
                    str(uuid.uuid4()),
                    session_id,
                    session["sub_account_id"],
                    sampled_at,
                    "HEARTBEAT",
                    snapshot.get("status"),
                    snapshot.get("startSide"),
                    bool(snapshot.get("neutralMode", False)),
                    bool(snapshot.get("allowLoss", True)),
                    bool(snapshot.get("reduceOnlyArmed", False)),
                    int(snapshot.get("leverage", 1) or 1),
                    int(snapshot.get("childCount", 1) or 1),
                    int(snapshot.get("skew", 0) or 0),
                    float(snapshot.get("longOffsetPct", 0) or 0),
                    float(snapshot.get("shortOffsetPct", 0) or 0),
                    float(snapshot.get("longSizeUsd", 0) or 0),
                    float(snapshot.get("shortSizeUsd", 0) or 0),
                    snapshot.get("longMaxPrice"),
                    snapshot.get("shortMinPrice"),
                    bool(snapshot.get("pinLongToEntry", False)),
                    bool(snapshot.get("pinShortToEntry", False)),
                    float(snapshot.get("minFillSpreadPct", 0) or 0),
                    float(snapshot.get("fillDecayHalfLifeMs", 0) or 0),
                    float(snapshot.get("minRefillDelayMs", 0) or 0),
                    int(snapshot.get("maxLossPerCloseBps", 0) or 0),
                    int(snapshot.get("maxFillsPerMinute", 0) or 0),
                    snapshot.get("pnlFeedbackMode"),
                    mark_price if mark_price > 0 else snapshot.get("lastKnownPrice"),
                    int(snapshot.get("totalFillCount", 0) or 0),
                    sum(1 for slot in long_slots if slot.get("active")),
                    sum(1 for slot in short_slots if slot.get("active")),
                    sum(1 for slot in long_slots if slot.get("paused")),
                    sum(1 for slot in short_slots if slot.get("paused")),
                    sum(1 for slot in long_slots if slot.get("retryAt")),
                    sum(1 for slot in short_slots if slot.get("retryAt")),
                    json.dumps(dict(pause_reasons), sort_keys=True),
                    _now_utc(),
                ),
            )
            param_samples += 1

        return {"pnl_samples": pnl_samples, "param_samples": param_samples, "live_samples": live_samples}

    async def _load_active_sessions(self) -> list[dict]:
        sessions = await self._load_active_sessions_from_redis()
        if sessions:
            return sessions
        return await self._db.fetch_all(
            """SELECT * FROM algo_runtime_sessions
               WHERE strategy_type = ? AND status = ?""",
            ("SCALPER", "ACTIVE"),
        )

    async def _load_active_sessions_from_redis(self) -> list[dict]:
        if not self._redis:
            return []

        snapshots: list[dict] = []
        try:
            active_keys = await self._redis.keys("pms:active_scalper:*")
        except Exception:
            return []

        seen: set[str] = set()
        for key in active_keys or []:
            try:
                entries = await self._redis.hgetall(key)
            except Exception:
                continue
            for raw_state in (entries or {}).values():
                try:
                    slim = json.loads(raw_state)
                except Exception:
                    continue
                strategy_session_id = str(slim.get("scalperId") or "")
                sub_account_id = str(slim.get("subAccountId") or "")
                if not strategy_session_id or not sub_account_id or strategy_session_id in seen:
                    continue
                try:
                    runtime_json = await self._redis.get(RedisKey.scalper(strategy_session_id))
                except Exception:
                    runtime_json = None
                if not runtime_json:
                    continue
                try:
                    snapshot = json.loads(runtime_json)
                except Exception:
                    continue
                if str(snapshot.get("status") or "").upper() != "ACTIVE":
                    continue
                seen.add(strategy_session_id)
                snapshots.append({
                    "strategy_session_id": strategy_session_id,
                    "sub_account_id": sub_account_id,
                    "_snapshot": snapshot,
                })
        return snapshots

    async def _load_session_data(self, session_ids: list[str]) -> tuple[list[dict], list[dict], list[dict]]:
        in_clause, params = _build_in_clause(session_ids)
        open_lots = await self._db.fetch_all(
            f"""SELECT * FROM strategy_position_lots
                WHERE status = ? AND root_strategy_session_id IN {in_clause}""",
            ("OPEN", *params),
        )
        realizations = await self._db.fetch_all(
            f"SELECT * FROM strategy_lot_realizations WHERE root_strategy_session_id IN {in_clause}",
            params,
        )
        fill_counts = await self._db.fetch_all(
            f"""SELECT l.root_strategy_session_id, COUNT(*) AS fill_count
                FROM fill_facts f
                JOIN order_lifecycles l ON l.id = f.lifecycle_id
                WHERE l.root_strategy_session_id IN {in_clause}
                GROUP BY l.root_strategy_session_id""",
            params,
        )
        return open_lots or [], realizations or [], fill_counts or []

    async def _load_checkpoint_snapshot(self, strategy_session_id: str) -> Optional[dict]:
        checkpoint = await self._db.fetch_one(
            """SELECT snapshot_json
               FROM algo_runtime_checkpoints
               WHERE strategy_session_id = ?
               ORDER BY checkpoint_seq DESC
               LIMIT 1""",
            (strategy_session_id,),
        )
        if not checkpoint or not checkpoint.get("snapshot_json"):
            return None
        try:
            return json.loads(checkpoint["snapshot_json"])
        except Exception:
            return None

    async def _publish_live_sample(self, event: StrategySampleEvent) -> bool:
        if not self._redis:
            return False
        payload = event.to_dict()
        encoded = json.dumps(payload, sort_keys=True)
        try:
            key = RedisKey.strategy_samples(event.strategy_session_id)
            await self._redis.lpush(key, encoded)
            await self._redis.ltrim(key, 0, self._live_cap - 1)
            await self._redis.expire(key, self._live_retention_sec)
            await self._redis.publish(RedisKey.event_channel(EventType.STRATEGY_SAMPLE), encoded)
            return True
        except Exception as exc:
            logger.debug("StrategySessionSampler live publish skipped for %s: %s", event.strategy_session_id, exc)
            return False
