"""
Quote history store for replay-safe TCA sampling.

Persists a bounded stream of L1 quotes so TCA can look up fill-time and
markout-time context by timestamp instead of whatever quote happens to be live
when the sampler runs.
"""

from __future__ import annotations
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dt_from_ms(ts_ms: int) -> datetime:
    return datetime.fromtimestamp(ts_ms / 1000.0, timezone.utc).replace(tzinfo=None)


def _ms_from_dt(value: Any) -> Optional[int]:
    if value in (None, "", "None"):
        return None
    if isinstance(value, datetime):
        return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            try:
                numeric = float(value)
                return int(numeric if numeric > 10_000_000_000 else numeric * 1000.0)
            except ValueError:
                return None
    if isinstance(value, (int, float)):
        numeric = float(value)
        return int(numeric if numeric > 10_000_000_000 else numeric * 1000.0)
    return None


def _spread_bps(bid: float, ask: float, mid: float) -> Optional[float]:
    if bid <= 0 or ask <= 0 or mid <= 0:
        return None
    return ((ask - bid) / mid) * 10_000.0


class MarketQuoteStore:
    """Persist and query bounded market quote history."""

    def __init__(
        self,
        db: Any,
        *,
        retention_ms: int = 3_600_000,
        max_gap_ms: int = 15_000,
        prune_interval_ms: int = 60_000,
    ) -> None:
        self._db = db
        self._retention_ms = retention_ms
        self._max_gap_ms = max_gap_ms
        self._prune_interval_ms = prune_interval_ms
        self._last_prune_ms: dict[str, int] = {}

    async def record_quote(
        self,
        symbol: str,
        *,
        bid: float,
        ask: float,
        mid: float,
        ts_ms: int,
        source: str = "L1",
    ) -> None:
        if not self._db or not symbol or ts_ms <= 0:
            return

        quote_ts = _dt_from_ms(ts_ms)
        await self._db.execute(
            """INSERT INTO market_quotes
               (id, symbol, ts, bid, ask, mid, spread_bps, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(symbol, ts) DO NOTHING""",
            (
                str(uuid.uuid4()),
                symbol,
                quote_ts,
                bid,
                ask,
                mid,
                _spread_bps(bid, ask, mid),
                source,
                _utc_now(),
            ),
        )
        await self._prune(symbol, ts_ms)

    async def find_nearest_quote(
        self,
        symbol: str,
        target_ts_ms: int,
        *,
        max_gap_ms: Optional[int] = None,
    ) -> Optional[dict]:
        if not self._db or not symbol or target_ts_ms <= 0:
            return None

        max_gap = self._max_gap_ms if max_gap_ms is None else max_gap_ms
        target_dt = _dt_from_ms(target_ts_ms)
        before_row = await self._db.fetch_one(
            """SELECT * FROM market_quotes
               WHERE symbol = ? AND ts <= ?
               ORDER BY ts DESC
               LIMIT 1""",
            (symbol, target_dt),
        )
        after_row = await self._db.fetch_one(
            """SELECT * FROM market_quotes
               WHERE symbol = ? AND ts >= ?
               ORDER BY ts ASC
               LIMIT 1""",
            (symbol, target_dt),
        )

        candidates = []
        for row in (before_row, after_row):
            if not row:
                continue
            row = dict(row)
            row_ts_ms = _ms_from_dt(row.get("ts"))
            if row_ts_ms is None:
                continue
            delta = abs(row_ts_ms - target_ts_ms)
            if delta > max_gap:
                continue
            row["ts_ms"] = row_ts_ms
            candidates.append((delta, row_ts_ms, row))

        if not candidates:
            return None

        candidates.sort(key=lambda item: (item[0], item[1]))
        return candidates[0][2]

    async def latest_quote(self, symbol: str) -> Optional[dict]:
        if not self._db or not symbol:
            return None
        row = await self._db.fetch_one(
            """SELECT * FROM market_quotes
               WHERE symbol = ?
               ORDER BY ts DESC
               LIMIT 1""",
            (symbol,),
        )
        if not row:
            return None
        row = dict(row)
        row["ts_ms"] = _ms_from_dt(row.get("ts"))
        return row

    async def _prune(self, symbol: str, newest_ts_ms: int) -> None:
        if self._retention_ms <= 0:
            return
        last_prune_ms = int(self._last_prune_ms.get(symbol) or 0)
        if self._prune_interval_ms > 0 and last_prune_ms and (newest_ts_ms - last_prune_ms) < self._prune_interval_ms:
            return
        cutoff_dt = _dt_from_ms(max(0, newest_ts_ms - self._retention_ms))
        try:
            await self._db.execute(
                "DELETE FROM market_quotes WHERE symbol = ? AND ts < ?",
                (symbol, cutoff_dt),
            )
            self._last_prune_ms[symbol] = newest_ts_ms
        except Exception as exc:
            logger.debug("MarketQuoteStore prune skipped for %s: %s", symbol, exc)
