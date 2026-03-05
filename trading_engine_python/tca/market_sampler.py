"""
TCAMarketSampler — attach fill-time L1 context and derive markouts.

This worker is read-only with respect to OMS/risk state. It subscribes to the
shared market-data service, enriches `fill_facts`, and populates
`fill_markouts` when horizons are due.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

DEFAULT_MARKOUT_HORIZONS_MS = (1_000, 5_000, 30_000)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_epoch_ms(value: Any) -> Optional[int]:
    if value in (None, "", "None"):
        return None
    if isinstance(value, datetime):
        return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)
    if isinstance(value, (int, float)):
        numeric = float(value)
        return int(numeric if numeric > 10_000_000_000 else numeric * 1000.0)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return int(parsed.timestamp() * 1000)
        except ValueError:
            try:
                return _to_epoch_ms(float(value))
            except ValueError:
                return None
    return None


def _spread_bps(bid: float, ask: float, mid: float) -> Optional[float]:
    if bid <= 0 or ask <= 0 or mid <= 0:
        return None
    return ((ask - bid) / mid) * 10_000.0


def _markout_bps(side: str, fill_price: float, mark_mid: float) -> Optional[float]:
    if fill_price <= 0 or mark_mid <= 0:
        return None
    if side == "SELL":
        return ((fill_price - mark_mid) / fill_price) * 10_000.0
    return ((mark_mid - fill_price) / fill_price) * 10_000.0


class TCAMarketSampler:
    """Periodic L1 enrichment and markout computation worker."""

    def __init__(
        self,
        db: Any,
        market_data: Any,
        *,
        interval_sec: float = 1.0,
        horizons_ms: Iterable[int] = DEFAULT_MARKOUT_HORIZONS_MS,
        quote_store: Any = None,
        quote_max_gap_ms: int = 15_000,
    ) -> None:
        self._db = db
        self._market_data = market_data
        self._interval_sec = interval_sec
        self._horizons_ms = tuple(sorted(set(int(h) for h in horizons_ms if h > 0)))
        self._subscribed_symbols: set[str] = set()
        self._quote_store = quote_store
        self._quote_max_gap_ms = quote_max_gap_ms

    async def run(self, stop_event: asyncio.Event) -> None:
        """Periodic sampler loop."""
        while not stop_event.is_set():
            try:
                summary = await self.sample_once()
                if summary["fill_context_updates"] or summary["markouts_inserted"]:
                    logger.info(
                        "TCAMarketSampler updated %d fill context row(s), inserted %d markout row(s)",
                        summary["fill_context_updates"],
                        summary["markouts_inserted"],
                    )
            except Exception as exc:
                logger.error("TCAMarketSampler error: %s", exc)

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._interval_sec)
            except asyncio.TimeoutError:
                continue

        await self._unsubscribe_all()

    async def sample_once(self) -> dict:
        """Run one fill-context + markout pass."""
        if not self._db or not self._market_data:
            return {"fill_context_updates": 0, "markouts_inserted": 0}

        fills = await self._db.fetch_all("SELECT * FROM fill_facts")
        markout_rows = await self._db.fetch_all("SELECT fill_fact_id, horizon_ms FROM fill_markouts")
        existing_markouts = {(row["fill_fact_id"], int(row["horizon_ms"])) for row in markout_rows or []}

        fill_context_updates = 0
        markouts_inserted = 0
        for fill in fills or []:
            symbol = fill.get("symbol")
            if not symbol:
                continue
            self._ensure_subscription(symbol)

            fill_ts_ms = _to_epoch_ms(fill.get("fill_ts"))
            if not fill_ts_ms:
                continue

            fill_quote = await self._lookup_quote(symbol, fill_ts_ms)
            if not fill_quote:
                continue

            bid = float(fill_quote.get("bid", 0) or 0)
            ask = float(fill_quote.get("ask", 0) or 0)
            mid = float(fill_quote.get("mid", 0) or 0)
            sampled_ts_ms = _to_epoch_ms(fill_quote.get("ts_ms")) or _to_epoch_ms(fill_quote.get("ts"))
            if sampled_ts_ms is None:
                continue

            fill_mid = fill.get("fill_mid")
            if fill_mid in (None, ""):
                await self._db.execute(
                    """UPDATE fill_facts
                       SET fill_bid = ?, fill_ask = ?, fill_mid = ?, fill_spread_bps = ?, sampled_at = ?
                       WHERE id = ?""",
                    (
                        bid,
                        ask,
                        mid,
                        _spread_bps(bid, ask, mid),
                        datetime.fromtimestamp(sampled_ts_ms / 1000.0, timezone.utc).replace(tzinfo=None),
                        fill["id"],
                    ),
                )
                fill["fill_mid"] = mid
                fill_context_updates += 1

            fill_price = float(fill.get("fill_price", 0) or 0)
            fill_side = str(fill.get("side", "") or "").upper()
            effective_fill_mid = float(fill.get("fill_mid", 0) or 0) or mid

            if not fill_ts_ms or fill_price <= 0 or effective_fill_mid <= 0:
                continue

            for horizon_ms in self._horizons_ms:
                if (fill["id"], horizon_ms) in existing_markouts:
                    continue
                markout_quote = await self._lookup_quote(symbol, fill_ts_ms + horizon_ms)
                if not markout_quote:
                    continue
                measured_ts_ms = _to_epoch_ms(markout_quote.get("ts_ms")) or _to_epoch_ms(markout_quote.get("ts"))
                if measured_ts_ms is None:
                    continue
                mark_mid = float(markout_quote.get("mid", 0) or 0)
                if mark_mid <= 0:
                    continue
                await self._db.execute(
                    """INSERT INTO fill_markouts
                       (id, fill_fact_id, horizon_ms, measured_ts, mid_price, mark_price, markout_bps, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(fill_fact_id, horizon_ms) DO NOTHING""",
                    (
                        str(uuid.uuid4()),
                        fill["id"],
                        horizon_ms,
                        datetime.fromtimestamp(measured_ts_ms / 1000.0, timezone.utc).replace(tzinfo=None),
                        effective_fill_mid,
                        mark_mid,
                        _markout_bps(fill_side, fill_price, mark_mid),
                        _now_utc(),
                    ),
                )
                existing_markouts.add((fill["id"], horizon_ms))
                markouts_inserted += 1

        return {
            "fill_context_updates": fill_context_updates,
            "markouts_inserted": markouts_inserted,
        }

    async def _noop_market_callback(self, symbol: str, bid: float, ask: float, mid: float) -> None:
        """No-op callback to keep the market-data subscription alive."""
        return None

    def _ensure_subscription(self, symbol: str) -> None:
        if symbol in self._subscribed_symbols:
            return
        self._market_data.subscribe(symbol, self._noop_market_callback)
        self._subscribed_symbols.add(symbol)

    async def _lookup_quote(self, symbol: str, target_ts_ms: int) -> Optional[dict]:
        if self._quote_store:
            quote = await self._quote_store.find_nearest_quote(
                symbol,
                target_ts_ms,
                max_gap_ms=self._quote_max_gap_ms,
            )
            if quote:
                return quote

        if not self._market_data:
            return None
        l1 = self._market_data.get_l1(symbol)
        if not l1:
            return None
        return {
            "bid": float(l1.get("bid", 0) or 0),
            "ask": float(l1.get("ask", 0) or 0),
            "mid": float(l1.get("mid", 0) or 0),
            "ts_ms": _to_epoch_ms(l1.get("ts")),
        }

    async def _unsubscribe_all(self) -> None:
        for symbol in list(self._subscribed_symbols):
            try:
                self._market_data.unsubscribe(symbol, self._noop_market_callback)
            except Exception:
                pass
        self._subscribed_symbols.clear()
