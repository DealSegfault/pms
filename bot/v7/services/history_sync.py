#!/usr/bin/env python3
"""Binance order/trade history sync service for v7."""

import asyncio
import hashlib
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

import aiohttp
import ccxt.async_support as ccxt_async
import websockets

try:
    import orjson
except ImportError:
    orjson = None

from .rate_limit import AsyncTokenBucket, BackoffConfig
from .storage import HistoryStore, to_raw_symbol

logger = logging.getLogger(__name__)

_SCOPE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _sanitize_scope(value: str) -> str:
    cleaned = _SCOPE_RE.sub("-", str(value or "").strip().lower()).strip("-._")
    return cleaned[:64] if len(cleaned) > 64 else cleaned


def _derive_scope(api_key: str, configured_scope: str) -> str:
    scoped = _sanitize_scope(configured_scope)
    if scoped:
        return scoped
    key = str(api_key or "").strip()
    if not key:
        return "acct-unknown"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return f"acct-{digest}"


@dataclass
class SyncConfig:
    """Config for history sync service."""
    db_path: str = "./v7_sessions/history.db"
    request_rate_per_sec: float = 3.0
    request_burst: float = 6.0
    order_limit: int = 1000
    trade_limit: int = 1000
    poll_interval_sec: float = 2.0
    overlap_ms: int = 1500
    stream_keepalive_sec: float = 1800.0
    default_backfill_days: int = 14
    websocket_enabled: bool = True
    account_scope: str = ""


class BinanceHistorySyncService:
    """
    Syncs Binance futures order/trade history into local SQLite.

    Features:
    - Historical backfill for orders + user trades.
    - Incremental polling with per-symbol cursors.
    - Optional user-data websocket ingest for live updates.
    - Adaptive throttling and retry backoff to avoid rate-limit errors.
    """

    def __init__(self, api_key: str, secret: str, config: Optional[SyncConfig] = None, testnet: bool = False):
        self.api_key = api_key
        self.secret = secret
        self.config = config or SyncConfig()
        self.testnet = testnet
        self.account_scope = _derive_scope(api_key, self.config.account_scope)

        self.store = HistoryStore(self.config.db_path)
        self.rate_limiter = AsyncTokenBucket(self.config.request_rate_per_sec, self.config.request_burst)
        self.backoff = BackoffConfig()

        options = {
            "defaultType": "future",
            "adjustForTimeDifference": True,
        }
        if testnet:
            options["testnet"] = True

        self.exchange = ccxt_async.binance(
            {
                "apiKey": api_key,
                "secret": secret,
                "options": options,
                "enableRateLimit": True,
                "timeout": 10000,
            }
        )

        self._markets_loaded = False
        self._session: Optional[aiohttp.ClientSession] = None
        self._listen_key: Optional[str] = None
        self._stream_task: Optional[asyncio.Task] = None
        self._keepalive_task: Optional[asyncio.Task] = None
        self._stream_stop: Optional[asyncio.Event] = None

        self._fapi_base = "https://testnet.binancefuture.com" if testnet else "https://fapi.binance.com"
        self._ws_base = "wss://stream.binancefuture.com" if testnet else "wss://fstream.binance.com"

    # ─── Lifecycle ─────────────────────────────────────────────

    async def initialize(self):
        if not self._session:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        if not self._markets_loaded:
            await self._api_call(self.exchange.load_markets)
            self._markets_loaded = True
            logger.info("History sync markets loaded: %d", len(self.exchange.markets))

    async def close(self):
        await self.stop_user_stream()
        try:
            await self.exchange.close()
        except Exception:
            pass
        if self._session:
            try:
                await self._session.close()
            except Exception:
                pass
            self._session = None
        self.store.close()

    # ─── Helpers ───────────────────────────────────────────────

    def _to_ccxt_symbol(self, raw_symbol: str) -> str:
        s = raw_symbol.upper()
        if s.endswith("USDT"):
            return f"{s[:-4]}/USDT:USDT"
        if s.endswith("USDC"):
            return f"{s[:-4]}/USDC:USDC"
        return s

    def _market_for_raw_symbol(self, raw_symbol: str) -> Optional[Dict[str, Any]]:
        market = self.exchange.markets_by_id.get(raw_symbol.upper())
        if isinstance(market, list):
            return market[0] if market else None
        return market

    @staticmethod
    def _is_supported_linear_perp_market(market: Optional[Dict[str, Any]]) -> bool:
        if not market:
            return False
        if not market.get("swap"):
            return False
        if not market.get("contract"):
            return False
        if not market.get("linear"):
            return False
        if market.get("inverse"):
            return False
        if market.get("active") is False:
            return False
        settle = str(market.get("settle") or "").upper()
        quote = str(market.get("quote") or "").upper()
        return settle in {"USDT", "USDC"} and quote in {"USDT", "USDC"}

    def _parse_json(self, raw: str) -> Dict[str, Any]:
        if orjson is not None:
            return orjson.loads(raw)
        import json
        return json.loads(raw)

    async def _api_call(self, fn, *args, weight: float = 1.0, **kwargs):
        attempt = 0
        while True:
            await self.rate_limiter.acquire(weight=weight)
            try:
                return await fn(*args, **kwargs)
            except (
                ccxt_async.RateLimitExceeded,
                ccxt_async.DDoSProtection,
                ccxt_async.ExchangeNotAvailable,
                ccxt_async.RequestTimeout,
            ) as e:
                delay = self.backoff.delay(attempt)
                attempt += 1
                logger.warning("Transient exchange error (%s), retry in %.2fs", type(e).__name__, delay)
                await asyncio.sleep(delay)
            except Exception as e:
                msg = str(e).lower()
                if "-1003" in msg or "too many requests" in msg or "way too much request" in msg:
                    delay = self.backoff.delay(attempt)
                    attempt += 1
                    logger.warning("Rate-limit response detected, retry in %.2fs", delay)
                    await asyncio.sleep(delay)
                    continue
                raise

    def _cursor_key(self, kind: str, symbol: str) -> str:
        return f"sync:{self.account_scope}:{kind}:{symbol.upper()}"

    def _get_cursor_ms(self, kind: str, symbol: str, fallback: int) -> int:
        value = self.store.get_state(self._cursor_key(kind, symbol), fallback)
        try:
            return int(value)
        except Exception:
            return fallback

    def _set_cursor_ms(self, kind: str, symbol: str, cursor_ms: int):
        self.store.set_state(self._cursor_key(kind, symbol), int(cursor_ms))

    @staticmethod
    def _order_ts_ms(order: Dict[str, Any]) -> int:
        info = order.get("info") or {}
        ts = order.get("timestamp") or info.get("updateTime") or info.get("time") or 0
        try:
            return int(float(ts))
        except Exception:
            return 0

    @staticmethod
    def _trade_ts_ms(trade: Dict[str, Any]) -> int:
        info = trade.get("info") or {}
        ts = trade.get("timestamp") or info.get("time") or 0
        try:
            return int(float(ts))
        except Exception:
            return 0

    # ─── Symbol discovery ──────────────────────────────────────

    async def discover_symbols(self, explicit_symbols: Optional[Iterable[str]] = None) -> List[str]:
        """
        Discover symbol universe for sync.

        Priority:
        1. Explicit symbol list.
        2. All active linear USDT/USDC perpetual futures markets from exchange metadata.
        """
        if explicit_symbols:
            return sorted({to_raw_symbol(s) for s in explicit_symbols if s})

        await self.initialize()
        symbols: set[str] = set()
        for market in self.exchange.markets.values():
            if not self._is_supported_linear_perp_market(market):
                continue
            market_id = str(market.get("id") or "").upper()
            if not market_id:
                continue
            symbols.add(to_raw_symbol(market_id))

        return sorted(symbols)

    # ─── Historical sync ───────────────────────────────────────

    async def sync_symbol_orders(self, symbol: str, since_ms: int, until_ms: Optional[int] = None) -> int:
        raw_symbol = to_raw_symbol(symbol)
        ccxt_symbol = self._to_ccxt_symbol(raw_symbol)
        limit = self.config.order_limit

        cursor = self._get_cursor_ms("orders", raw_symbol, since_ms)
        cursor = max(cursor - self.config.overlap_ms, since_ms)

        total = 0
        page_guard = 0
        while True:
            page_guard += 1
            if page_guard > 5000:
                logger.warning("Order sync guard hit for %s", raw_symbol)
                break

            try:
                orders = await self._api_call(
                    self.exchange.fetch_orders,
                    ccxt_symbol,
                    cursor,
                    limit,
                    weight=1.2,
                )
            except ccxt_async.BadRequest as e:
                # Some endpoints reject high `limit`; auto-fallback instead of aborting full backfill.
                if "parameter 'limit'" in str(e).lower() and limit > 100:
                    limit = 100
                    logger.warning("Order limit rejected for %s, retrying with limit=100", raw_symbol)
                    continue
                raise

            if not orders:
                break

            filtered = [o for o in orders if self._order_ts_ms(o) >= since_ms]
            if until_ms is not None:
                filtered = [o for o in filtered if self._order_ts_ms(o) <= until_ms]

            if filtered:
                total += self.store.upsert_orders(filtered)

            max_ts = max(self._order_ts_ms(o) for o in orders)
            if max_ts <= cursor:
                cursor += 1
            else:
                cursor = max_ts + 1

            self._set_cursor_ms("orders", raw_symbol, cursor)

            if len(orders) < limit:
                break
            if until_ms is not None and cursor > until_ms:
                break

        return total

    async def sync_symbol_trades(self, symbol: str, since_ms: int, until_ms: Optional[int] = None) -> int:
        raw_symbol = to_raw_symbol(symbol)
        ccxt_symbol = self._to_ccxt_symbol(raw_symbol)
        limit = self.config.trade_limit

        cursor = self._get_cursor_ms("trades", raw_symbol, since_ms)
        cursor = max(cursor - self.config.overlap_ms, since_ms)

        total = 0
        page_guard = 0
        while True:
            page_guard += 1
            if page_guard > 5000:
                logger.warning("Trade sync guard hit for %s", raw_symbol)
                break

            try:
                trades = await self._api_call(
                    self.exchange.fetch_my_trades,
                    ccxt_symbol,
                    cursor,
                    limit,
                    weight=1.0,
                )
            except ccxt_async.BadRequest as e:
                if "parameter 'limit'" in str(e).lower() and limit > 100:
                    limit = 100
                    logger.warning("Trade limit rejected for %s, retrying with limit=100", raw_symbol)
                    continue
                raise

            if not trades:
                break

            filtered = [t for t in trades if self._trade_ts_ms(t) >= since_ms]
            if until_ms is not None:
                filtered = [t for t in filtered if self._trade_ts_ms(t) <= until_ms]

            if filtered:
                total += self.store.upsert_trades(filtered)

            max_ts = max(self._trade_ts_ms(t) for t in trades)
            if max_ts <= cursor:
                cursor += 1
            else:
                cursor = max_ts + 1

            self._set_cursor_ms("trades", raw_symbol, cursor)

            if len(trades) < limit:
                break
            if until_ms is not None and cursor > until_ms:
                break

        return total

    async def backfill(
        self,
        symbols: Iterable[str],
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        days: Optional[int] = None,
    ) -> Dict[str, Dict[str, int]]:
        """Backfill historical orders and trades for given symbols."""
        await self.initialize()

        if start_ms is None:
            lookback_days = days if days is not None else self.config.default_backfill_days
            start_ms = int((time.time() - lookback_days * 86400) * 1000)
        if end_ms is None:
            end_ms = int(time.time() * 1000)

        result: Dict[str, Dict[str, int]] = {}
        for symbol in [to_raw_symbol(s) for s in symbols if s]:
            logger.info("Backfill %s (%s -> %s)", symbol, start_ms, end_ms)
            orders_n = await self.sync_symbol_orders(symbol, since_ms=start_ms, until_ms=end_ms)
            trades_n = await self.sync_symbol_trades(symbol, since_ms=start_ms, until_ms=end_ms)
            result[symbol] = {"orders": orders_n, "trades": trades_n}

        return result

    async def sync_once(self, symbols: Iterable[str], lookback_ms: int = 300_000) -> Dict[str, Dict[str, int]]:
        """Single incremental sync pass across symbols."""
        await self.initialize()
        end_ms = int(time.time() * 1000)
        start_ms = end_ms - max(lookback_ms, 1_000)

        out: Dict[str, Dict[str, int]] = {}
        for symbol in [to_raw_symbol(s) for s in symbols if s]:
            orders_n = await self.sync_symbol_orders(symbol, since_ms=start_ms, until_ms=end_ms)
            trades_n = await self.sync_symbol_trades(symbol, since_ms=start_ms, until_ms=end_ms)
            out[symbol] = {"orders": orders_n, "trades": trades_n}
        return out

    # ─── Live user stream (optional) ───────────────────────────

    async def _listen_key_request(self, method: str):
        if not self._session:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        url = f"{self._fapi_base}/fapi/v1/listenKey"
        headers = {"X-MBX-APIKEY": self.api_key}

        async with self._session.request(method, url, headers=headers) as resp:
            data = await resp.json()
            if resp.status >= 400:
                raise RuntimeError(f"listenKey {method} failed: status={resp.status} data={data}")
            return data

    async def _create_listen_key(self):
        data = await self._listen_key_request("POST")
        self._listen_key = data.get("listenKey")
        if not self._listen_key:
            raise RuntimeError("listenKey missing from response")

    async def _keepalive_loop(self):
        while self._stream_stop and not self._stream_stop.is_set():
            await asyncio.sleep(self.config.stream_keepalive_sec)
            try:
                await self._listen_key_request("PUT")
            except Exception as e:
                logger.warning("listenKey keepalive failed: %s", e)

    async def _delete_listen_key(self):
        try:
            await self._listen_key_request("DELETE")
        except Exception:
            pass

    def _ingest_order_trade_update(self, data: Dict[str, Any]):
        payload = data.get("o") or {}
        if not payload:
            return

        raw_symbol = to_raw_symbol(str(payload.get("s", "")))
        if not raw_symbol:
            return

        q = float(payload.get("q", 0) or 0)
        z = float(payload.get("z", 0) or 0)
        p = float(payload.get("p", 0) or 0)
        ap = float(payload.get("ap", 0) or 0)

        order = {
            "id": str(payload.get("i", "")),
            "symbol": self._to_ccxt_symbol(raw_symbol),
            "timestamp": int(payload.get("T") or data.get("E") or 0),
            "clientOrderId": payload.get("c"),
            "type": str(payload.get("o", "")).lower(),
            "side": str(payload.get("S", "")).lower(),
            "timeInForce": payload.get("f"),
            "amount": q,
            "filled": z,
            "remaining": max(q - z, 0.0),
            "price": p,
            "average": ap,
            "cost": ap * z if ap > 0 else p * z,
            "status": str(payload.get("X", "")).lower(),
            "info": {
                "symbol": raw_symbol,
                "orderId": payload.get("i"),
                "clientOrderId": payload.get("c"),
                "status": payload.get("X"),
                "type": payload.get("o"),
                "side": payload.get("S"),
                "timeInForce": payload.get("f"),
                "origQty": payload.get("q"),
                "executedQty": payload.get("z"),
                "price": payload.get("p"),
                "avgPrice": payload.get("ap"),
                "reduceOnly": payload.get("R", False),
                "updateTime": data.get("E"),
            },
        }

        self.store.upsert_orders([order])
        self.store.upsert_order_events([data])

        last_fill_qty = float(payload.get("l", 0) or 0)
        execution_type = str(payload.get("x", ""))
        if execution_type == "TRADE" and last_fill_qty > 0:
            trade_id = str(payload.get("t") or f"{payload.get('i')}:{data.get('E')}:{payload.get('z')}")
            last_fill_price = float(payload.get("L", 0) or 0)
            fee_cost = float(payload.get("n", 0) or 0)
            fee_currency = payload.get("N", "")

            trade = {
                "id": trade_id,
                "symbol": self._to_ccxt_symbol(raw_symbol),
                "order": str(payload.get("i", "")),
                "timestamp": int(payload.get("T") or data.get("E") or 0),
                "side": str(payload.get("S", "")).lower(),
                "takerOrMaker": "maker" if payload.get("m", False) else "taker",
                "price": last_fill_price,
                "amount": last_fill_qty,
                "cost": last_fill_price * last_fill_qty,
                "fee": {"cost": fee_cost, "currency": fee_currency},
                "info": {
                    "symbol": raw_symbol,
                    "orderId": payload.get("i"),
                    "realizedPnl": payload.get("rp", 0),
                    "commission": payload.get("n", 0),
                    "commissionAsset": payload.get("N", ""),
                    "time": payload.get("T") or data.get("E"),
                },
            }
            self.store.upsert_trades([trade])

    async def _user_stream_loop(self):
        while self._stream_stop and not self._stream_stop.is_set():
            try:
                if not self._listen_key:
                    await self._create_listen_key()
                ws_url = f"{self._ws_base}/ws/{self._listen_key}"
                logger.info("User stream connecting: %s", ws_url)

                async with websockets.connect(ws_url, ping_interval=25, ping_timeout=25, max_size=8_000_000) as ws:
                    logger.info("User stream connected")
                    async for raw in ws:
                        if self._stream_stop and self._stream_stop.is_set():
                            break
                        try:
                            data = self._parse_json(raw)
                            if data.get("e") == "ORDER_TRADE_UPDATE":
                                self._ingest_order_trade_update(data)
                        except Exception as e:
                            logger.debug("user stream parse failed: %s", e)
            except Exception as e:
                if self._stream_stop and not self._stream_stop.is_set():
                    logger.warning("user stream error: %s (reconnect in 3s)", e)
                    await asyncio.sleep(3.0)

    async def start_user_stream(self):
        if not self.config.websocket_enabled:
            return
        if self._stream_task and not self._stream_task.done():
            return
        self._stream_stop = asyncio.Event()
        await self._create_listen_key()
        self._stream_task = asyncio.create_task(self._user_stream_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def stop_user_stream(self):
        if self._stream_stop:
            self._stream_stop.set()

        if self._keepalive_task:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except (asyncio.CancelledError, Exception):
                pass
            self._keepalive_task = None

        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except (asyncio.CancelledError, Exception):
                pass
            self._stream_task = None

        await self._delete_listen_key()
        self._listen_key = None

    # ─── Long-running live sync ────────────────────────────────

    async def run_live_sync(
        self,
        symbols: Iterable[str],
        stop_event: Optional[asyncio.Event] = None,
        poll_interval_sec: Optional[float] = None,
    ):
        """
        Keep local DB synced in near real-time.

        Strategy:
        - user data stream for push updates (best latency)
        - incremental polling fallback to catch any missed events
        """
        await self.initialize()

        poll_interval = poll_interval_sec if poll_interval_sec is not None else self.config.poll_interval_sec
        stop = stop_event or asyncio.Event()
        symbol_list = [to_raw_symbol(s) for s in symbols if s]

        await self.start_user_stream()
        logger.info("Live sync started: %d symbols, poll=%.2fs", len(symbol_list), poll_interval)

        while not stop.is_set():
            try:
                await self.sync_once(symbol_list, lookback_ms=max(int(poll_interval * 3000), 3000))
                await asyncio.wait_for(stop.wait(), timeout=poll_interval)
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error("live sync pass failed: %s", e)
                await asyncio.sleep(1.0)

        await self.stop_user_stream()

    # ─── Sync status ───────────────────────────────────────────

    def sync_status(self) -> Dict[str, Any]:
        rows = self.store.query(
            """
            SELECT
                (SELECT COUNT(*) FROM orders) AS order_rows,
                (SELECT COUNT(*) FROM trades) AS trade_rows,
                (SELECT COUNT(*) FROM order_events) AS event_rows,
                (SELECT COUNT(*) FROM sync_state) AS state_rows,
                (SELECT MAX(update_time_ms) FROM orders) AS latest_order_ms,
                (SELECT MAX(timestamp_ms) FROM trades) AS latest_trade_ms
            """
        )
        base = rows[0] if rows else {}
        base["account_scope"] = self.account_scope
        return base
