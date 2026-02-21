#!/usr/bin/env python3
"""SQLite storage for Binance order/trade history and sync cursors."""

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def to_raw_symbol(symbol: str) -> str:
    """Normalize symbols to raw Binance style, e.g. LAUSDT."""
    if not symbol:
        return ""
    s = symbol.upper()
    if "/" in s:
        base = s.split("/")[0]
        quote = s.split("/")[1].split(":")[0]
        return f"{base}{quote}"
    return s.replace(":", "").replace("/", "")


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


class HistoryStore:
    """Persistent store for orders, trades, order events, and sync state."""

    def __init__(self, db_path: str = "./v7_sessions/history.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute("PRAGMA synchronous=NORMAL;")
        self.conn.execute("PRAGMA temp_store=MEMORY;")
        self._init_schema()

    def close(self):
        try:
            with self._lock:
                self.conn.close()
        except Exception:
            pass

    def _init_schema(self):
        with self._lock:
            self.conn.executescript(
                """
            CREATE TABLE IF NOT EXISTS orders (
                order_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                client_order_id TEXT,
                side TEXT,
                type TEXT,
                time_in_force TEXT,
                status TEXT,
                amount REAL,
                filled REAL,
                remaining REAL,
                price REAL,
                avg_price REAL,
                cost REAL,
                reduce_only INTEGER DEFAULT 0,
                post_only INTEGER DEFAULT 0,
                create_time_ms INTEGER,
                update_time_ms INTEGER,
                first_seen_ts REAL NOT NULL,
                last_seen_ts REAL NOT NULL,
                raw_json TEXT,
                PRIMARY KEY(order_id, symbol)
            );

            CREATE INDEX IF NOT EXISTS idx_orders_symbol_time
                ON orders(symbol, update_time_ms);
            CREATE INDEX IF NOT EXISTS idx_orders_status_time
                ON orders(status, update_time_ms);

            CREATE TABLE IF NOT EXISTS order_events (
                event_id TEXT PRIMARY KEY,
                order_id TEXT,
                symbol TEXT,
                event_type TEXT,
                execution_type TEXT,
                status TEXT,
                side TEXT,
                price REAL,
                last_fill_price REAL,
                amount REAL,
                filled REAL,
                last_fill_qty REAL,
                fee_cost REAL,
                fee_currency TEXT,
                realized_pnl REAL,
                event_time_ms INTEGER,
                raw_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_order_events_symbol_time
                ON order_events(symbol, event_time_ms);
            CREATE INDEX IF NOT EXISTS idx_order_events_order
                ON order_events(order_id, event_time_ms);

            CREATE TABLE IF NOT EXISTS trades (
                trade_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                order_id TEXT,
                side TEXT,
                taker_or_maker TEXT,
                price REAL,
                qty REAL,
                cost REAL,
                fee_cost REAL,
                fee_currency TEXT,
                realized_pnl REAL,
                timestamp_ms INTEGER,
                raw_json TEXT,
                PRIMARY KEY(trade_id, symbol)
            );

            CREATE INDEX IF NOT EXISTS idx_trades_symbol_time
                ON trades(symbol, timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_trades_order
                ON trades(order_id, timestamp_ms);

            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_ts REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS strategy_events (
                event_id TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                action TEXT NOT NULL,
                reason TEXT,
                layer_idx INTEGER,
                layers INTEGER,
                qty REAL,
                price REAL,
                notional REAL,
                pnl_bps REAL,
                pnl_usd REAL,
                spread_bps REAL,
                median_spread_bps REAL,
                vol_blended_bps REAL,
                vol_drift_mult REAL,
                edge_lcb_bps REAL,
                edge_required_bps REAL,
                recovery_debt_usd REAL,
                event_ts REAL NOT NULL,
                event_time_ms INTEGER,
                payload_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_strategy_events_symbol_time
                ON strategy_events(symbol, event_time_ms);
            CREATE INDEX IF NOT EXISTS idx_strategy_events_action_time
                ON strategy_events(action, event_time_ms);
                """
            )
            self.conn.commit()

    # ─── State ─────────────────────────────────────────────────

    def set_state(self, key: str, value: Any):
        payload = json.dumps(value)
        with self._lock:
            self.conn.execute(
                """
            INSERT INTO sync_state(key, value, updated_ts)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value=excluded.value,
                updated_ts=excluded.updated_ts
            """,
                (key, payload, time.time()),
            )
            self.conn.commit()

    def get_state(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self.conn.execute("SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return default

    # ─── Strategy events ───────────────────────────────────────

    def upsert_strategy_events(self, events: Iterable[Dict[str, Any]]) -> int:
        rows: List[Tuple[Any, ...]] = []
        now = time.time()

        for event in events:
            event_id = str(event.get("event_id") or "").strip()
            symbol = to_raw_symbol(str(event.get("symbol") or ""))
            action = str(event.get("action") or "").strip().lower()
            if not event_id or not symbol or not action:
                continue

            event_ts = _safe_float(event.get("event_ts"), now)
            event_time_ms = _safe_int(event.get("event_time_ms"), int(event_ts * 1000))
            payload = event.get("payload")
            payload_json = None
            if payload is not None:
                try:
                    payload_json = json.dumps(payload, separators=(",", ":"), default=str)
                except Exception:
                    payload_json = None

            rows.append(
                (
                    event_id,
                    symbol,
                    action,
                    str(event.get("reason") or ""),
                    _safe_int(event.get("layer_idx"), 0),
                    _safe_int(event.get("layers"), 0),
                    _safe_float(event.get("qty"), 0.0),
                    _safe_float(event.get("price"), 0.0),
                    _safe_float(event.get("notional"), 0.0),
                    _safe_float(event.get("pnl_bps"), 0.0),
                    _safe_float(event.get("pnl_usd"), 0.0),
                    _safe_float(event.get("spread_bps"), 0.0),
                    _safe_float(event.get("median_spread_bps"), 0.0),
                    _safe_float(event.get("vol_blended_bps"), 0.0),
                    _safe_float(event.get("vol_drift_mult"), 0.0),
                    _safe_float(event.get("edge_lcb_bps"), 0.0),
                    _safe_float(event.get("edge_required_bps"), 0.0),
                    _safe_float(event.get("recovery_debt_usd"), 0.0),
                    event_ts,
                    event_time_ms,
                    payload_json,
                )
            )

        if not rows:
            return 0

        with self._lock:
            self.conn.executemany(
                """
            INSERT INTO strategy_events(
                event_id, symbol, action, reason, layer_idx, layers, qty, price, notional,
                pnl_bps, pnl_usd, spread_bps, median_spread_bps, vol_blended_bps,
                vol_drift_mult, edge_lcb_bps, edge_required_bps, recovery_debt_usd,
                event_ts, event_time_ms, payload_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_id) DO UPDATE SET
                symbol=excluded.symbol,
                action=excluded.action,
                reason=excluded.reason,
                layer_idx=excluded.layer_idx,
                layers=excluded.layers,
                qty=excluded.qty,
                price=excluded.price,
                notional=excluded.notional,
                pnl_bps=excluded.pnl_bps,
                pnl_usd=excluded.pnl_usd,
                spread_bps=excluded.spread_bps,
                median_spread_bps=excluded.median_spread_bps,
                vol_blended_bps=excluded.vol_blended_bps,
                vol_drift_mult=excluded.vol_drift_mult,
                edge_lcb_bps=excluded.edge_lcb_bps,
                edge_required_bps=excluded.edge_required_bps,
                recovery_debt_usd=excluded.recovery_debt_usd,
                event_ts=excluded.event_ts,
                event_time_ms=excluded.event_time_ms,
                payload_json=excluded.payload_json
                """,
                rows,
            )
            self.conn.commit()
        return len(rows)

    def prune_strategy_events(self, retain_days: float) -> int:
        keep_days = max(float(retain_days), 0.0)
        if keep_days <= 0:
            return 0
        cutoff_ms = int((time.time() - keep_days * 86400.0) * 1000.0)
        with self._lock:
            cur = self.conn.execute(
                "DELETE FROM strategy_events WHERE event_time_ms > 0 AND event_time_ms < ?",
                (cutoff_ms,),
            )
            self.conn.commit()
            return int(cur.rowcount if cur.rowcount is not None else 0)

    # ─── Inserts / Upserts ────────────────────────────────────

    def upsert_orders(self, orders: Iterable[Dict[str, Any]]) -> int:
        rows: List[Tuple[Any, ...]] = []
        now = time.time()

        for order in orders:
            norm = self._normalize_order(order)
            if not norm:
                continue
            rows.append(
                (
                    norm["order_id"],
                    norm["symbol"],
                    norm["client_order_id"],
                    norm["side"],
                    norm["type"],
                    norm["time_in_force"],
                    norm["status"],
                    norm["amount"],
                    norm["filled"],
                    norm["remaining"],
                    norm["price"],
                    norm["avg_price"],
                    norm["cost"],
                    int(norm["reduce_only"]),
                    int(norm["post_only"]),
                    norm["create_time_ms"],
                    norm["update_time_ms"],
                    now,
                    now,
                    norm["raw_json"],
                )
            )

        if not rows:
            return 0

        with self._lock:
            self.conn.executemany(
                """
            INSERT INTO orders(
                order_id, symbol, client_order_id, side, type, time_in_force, status,
                amount, filled, remaining, price, avg_price, cost,
                reduce_only, post_only, create_time_ms, update_time_ms,
                first_seen_ts, last_seen_ts, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(order_id, symbol) DO UPDATE SET
                client_order_id=excluded.client_order_id,
                side=excluded.side,
                type=excluded.type,
                time_in_force=excluded.time_in_force,
                status=excluded.status,
                amount=excluded.amount,
                filled=excluded.filled,
                remaining=excluded.remaining,
                price=excluded.price,
                avg_price=excluded.avg_price,
                cost=excluded.cost,
                reduce_only=excluded.reduce_only,
                post_only=excluded.post_only,
                create_time_ms=COALESCE(orders.create_time_ms, excluded.create_time_ms),
                update_time_ms=MAX(COALESCE(orders.update_time_ms, 0), COALESCE(excluded.update_time_ms, 0)),
                last_seen_ts=excluded.last_seen_ts,
                raw_json=excluded.raw_json
                """,
                rows,
            )
            self.conn.commit()
        return len(rows)

    def upsert_order_events(self, events: Iterable[Dict[str, Any]]) -> int:
        rows: List[Tuple[Any, ...]] = []
        for event in events:
            norm = self._normalize_order_event(event)
            if not norm:
                continue
            rows.append(
                (
                    norm["event_id"],
                    norm["order_id"],
                    norm["symbol"],
                    norm["event_type"],
                    norm["execution_type"],
                    norm["status"],
                    norm["side"],
                    norm["price"],
                    norm["last_fill_price"],
                    norm["amount"],
                    norm["filled"],
                    norm["last_fill_qty"],
                    norm["fee_cost"],
                    norm["fee_currency"],
                    norm["realized_pnl"],
                    norm["event_time_ms"],
                    norm["raw_json"],
                )
            )

        if not rows:
            return 0

        with self._lock:
            self.conn.executemany(
                """
            INSERT OR IGNORE INTO order_events(
                event_id, order_id, symbol, event_type, execution_type, status, side,
                price, last_fill_price, amount, filled, last_fill_qty,
                fee_cost, fee_currency, realized_pnl, event_time_ms, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            self.conn.commit()
        return len(rows)

    def upsert_trades(self, trades: Iterable[Dict[str, Any]]) -> int:
        rows: List[Tuple[Any, ...]] = []
        for trade in trades:
            norm = self._normalize_trade(trade)
            if not norm:
                continue
            rows.append(
                (
                    norm["trade_id"],
                    norm["symbol"],
                    norm["order_id"],
                    norm["side"],
                    norm["taker_or_maker"],
                    norm["price"],
                    norm["qty"],
                    norm["cost"],
                    norm["fee_cost"],
                    norm["fee_currency"],
                    norm["realized_pnl"],
                    norm["timestamp_ms"],
                    norm["raw_json"],
                )
            )

        if not rows:
            return 0

        with self._lock:
            self.conn.executemany(
                """
            INSERT INTO trades(
                trade_id, symbol, order_id, side, taker_or_maker,
                price, qty, cost, fee_cost, fee_currency, realized_pnl,
                timestamp_ms, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trade_id, symbol) DO UPDATE SET
                order_id=COALESCE(excluded.order_id, trades.order_id),
                side=COALESCE(excluded.side, trades.side),
                taker_or_maker=COALESCE(excluded.taker_or_maker, trades.taker_or_maker),
                price=excluded.price,
                qty=excluded.qty,
                cost=excluded.cost,
                fee_cost=excluded.fee_cost,
                fee_currency=COALESCE(excluded.fee_currency, trades.fee_currency),
                realized_pnl=excluded.realized_pnl,
                timestamp_ms=MAX(COALESCE(trades.timestamp_ms, 0), COALESCE(excluded.timestamp_ms, 0)),
                raw_json=excluded.raw_json
                """,
                rows,
            )
            self.conn.commit()
        return len(rows)

    # ─── Query ─────────────────────────────────────────────────

    def query(self, sql: str, params: Sequence[Any] = ()) -> List[Dict[str, Any]]:
        with self._lock:
            cur = self.conn.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]

    def get_symbol_recovery_stats(
        self, symbol: str, lookback_hours: float = 168.0
    ) -> Dict[str, Any]:
        """Per-symbol recovery metrics from trades history.

        Returns dict with: total_rpnl, trade_count, total_fees,
        first_trade_ms, last_trade_ms, hours_span, rpnl_per_hour.
        """
        sym = to_raw_symbol(symbol)
        cutoff_ms = int((time.time() - lookback_hours * 3600.0) * 1000.0)
        with self._lock:
            row = self.conn.execute(
                """
                SELECT
                    COALESCE(SUM(realized_pnl), 0.0) AS total_rpnl,
                    COUNT(*) AS trade_count,
                    COALESCE(SUM(fee_cost), 0.0) AS total_fees,
                    MIN(timestamp_ms) AS first_trade_ms,
                    MAX(timestamp_ms) AS last_trade_ms
                FROM trades
                WHERE symbol = ? AND timestamp_ms >= ?
                """,
                (sym, cutoff_ms),
            ).fetchone()

        if not row or row["trade_count"] == 0:
            return {
                "total_rpnl": 0.0,
                "trade_count": 0,
                "total_fees": 0.0,
                "first_trade_ms": 0,
                "last_trade_ms": 0,
                "hours_span": 0.0,
                "rpnl_per_hour": 0.0,
            }

        first_ms = _safe_int(row["first_trade_ms"])
        last_ms = _safe_int(row["last_trade_ms"])
        span_hours = max((last_ms - first_ms) / 3_600_000.0, 0.01)  # min 36s
        rpnl = _safe_float(row["total_rpnl"])

        return {
            "total_rpnl": rpnl,
            "trade_count": _safe_int(row["trade_count"]),
            "total_fees": _safe_float(row["total_fees"]),
            "first_trade_ms": first_ms,
            "last_trade_ms": last_ms,
            "hours_span": span_hours,
            "rpnl_per_hour": rpnl / span_hours if span_hours > 0 else 0.0,
        }

    # ─── Normalization ─────────────────────────────────────────

    def _normalize_order(self, order: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        info = order.get("info") or {}

        order_id = str(order.get("id") or info.get("orderId") or "").strip()
        symbol = to_raw_symbol(str(order.get("symbol") or info.get("symbol") or ""))
        if not order_id or not symbol:
            return None

        amount = _safe_float(order.get("amount", info.get("origQty", 0)))
        filled = _safe_float(order.get("filled", info.get("executedQty", 0)))
        remaining = _safe_float(order.get("remaining", max(amount - filled, 0)))
        price = _safe_float(order.get("price", info.get("price", 0)))
        avg_price = _safe_float(order.get("average", info.get("avgPrice", 0)))
        cost = _safe_float(order.get("cost", info.get("cumQuote", 0)))

        create_ms = _safe_int(
            order.get("timestamp", info.get("time", info.get("updateTime")))
        )
        update_ms = _safe_int(info.get("updateTime", create_ms))
        if create_ms <= 0:
            create_ms = update_ms

        return {
            "order_id": order_id,
            "symbol": symbol,
            "client_order_id": str(order.get("clientOrderId") or info.get("clientOrderId") or ""),
            "side": str(order.get("side") or info.get("side") or "").lower(),
            "type": str(order.get("type") or info.get("type") or "").lower(),
            "time_in_force": str(order.get("timeInForce") or info.get("timeInForce") or ""),
            "status": str(order.get("status") or info.get("status") or "").lower(),
            "amount": amount,
            "filled": filled,
            "remaining": remaining,
            "price": price,
            "avg_price": avg_price,
            "cost": cost,
            "reduce_only": bool(info.get("reduceOnly", False)),
            "post_only": str(info.get("timeInForce", "")).upper() == "GTX",
            "create_time_ms": create_ms,
            "update_time_ms": update_ms,
            "raw_json": json.dumps(order, separators=(",", ":"), default=str),
        }

    def _normalize_trade(self, trade: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        info = trade.get("info") or {}
        trade_id = str(trade.get("id") or info.get("id") or info.get("tradeId") or "").strip()
        symbol = to_raw_symbol(str(trade.get("symbol") or info.get("symbol") or ""))
        if not trade_id or not symbol:
            return None

        fee = trade.get("fee") or {}
        return {
            "trade_id": trade_id,
            "symbol": symbol,
            "order_id": str(trade.get("order") or info.get("orderId") or ""),
            "side": str(trade.get("side") or info.get("side") or "").lower(),
            "taker_or_maker": str(trade.get("takerOrMaker") or "").lower(),
            "price": _safe_float(trade.get("price", info.get("price", 0))),
            "qty": _safe_float(trade.get("amount", info.get("qty", 0))),
            "cost": _safe_float(trade.get("cost", info.get("quoteQty", 0))),
            "fee_cost": _safe_float(fee.get("cost", info.get("commission", 0))),
            "fee_currency": str(fee.get("currency") or info.get("commissionAsset") or ""),
            "realized_pnl": _safe_float(info.get("realizedPnl", 0)),
            "timestamp_ms": _safe_int(trade.get("timestamp", info.get("time", 0))),
            "raw_json": json.dumps(trade, separators=(",", ":"), default=str),
        }

    def _normalize_order_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        payload = event.get("o", event)
        order_id = str(payload.get("i") or payload.get("orderId") or "").strip()
        symbol = to_raw_symbol(str(payload.get("s") or payload.get("symbol") or ""))
        if not order_id or not symbol:
            return None

        event_time_ms = _safe_int(event.get("E") or payload.get("T") or payload.get("updateTime") or 0)
        execution_type = str(payload.get("x") or payload.get("executionType") or "")
        status = str(payload.get("X") or payload.get("status") or "")
        filled = _safe_float(payload.get("z") or payload.get("executedQty") or 0)
        event_id = f"{symbol}|{order_id}|{event_time_ms}|{execution_type}|{filled}"

        return {
            "event_id": event_id,
            "order_id": order_id,
            "symbol": symbol,
            "event_type": str(event.get("e") or "ORDER_TRADE_UPDATE"),
            "execution_type": execution_type,
            "status": status,
            "side": str(payload.get("S") or payload.get("side") or "").lower(),
            "price": _safe_float(payload.get("p") or payload.get("price") or 0),
            "last_fill_price": _safe_float(payload.get("L") or payload.get("lastFilledPrice") or 0),
            "amount": _safe_float(payload.get("q") or payload.get("origQty") or 0),
            "filled": filled,
            "last_fill_qty": _safe_float(payload.get("l") or payload.get("lastFilledQty") or 0),
            "fee_cost": _safe_float(payload.get("n") or payload.get("commission") or 0),
            "fee_currency": str(payload.get("N") or payload.get("commissionAsset") or ""),
            "realized_pnl": _safe_float(payload.get("rp") or payload.get("realizedPnl") or 0),
            "event_time_ms": event_time_ms,
            "raw_json": json.dumps(event, separators=(",", ":"), default=str),
        }
