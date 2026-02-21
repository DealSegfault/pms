#!/usr/bin/env python3
"""Query API layer over local history DB (Python + FastAPI)."""

import sqlite3
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .storage import HistoryStore, to_raw_symbol


class HistoryQueryAPI:
    """Read/query interface for iterative research loops."""

    def __init__(self, db_path: str = "./v7_sessions/history.db"):
        self.store = HistoryStore(db_path)

    def close(self):
        self.store.close()

    @staticmethod
    def _time_filter(column: str, start_ms: Optional[int], end_ms: Optional[int]) -> Tuple[str, List[Any]]:
        clauses: List[str] = []
        params: List[Any] = []
        if start_ms is not None:
            clauses.append(f"{column} >= ?")
            params.append(int(start_ms))
        if end_ms is not None:
            clauses.append(f"{column} <= ?")
            params.append(int(end_ms))
        if not clauses:
            return "", []
        return " AND " + " AND ".join(clauses), params

    def get_orders(
        self,
        symbol: Optional[str] = None,
        status: Optional[str] = None,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        limit: int = 500,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM orders WHERE 1=1"
        params: List[Any] = []

        if symbol:
            sql += " AND symbol = ?"
            params.append(to_raw_symbol(symbol))
        if status:
            sql += " AND status = ?"
            params.append(status.lower())

        time_sql, time_params = self._time_filter("update_time_ms", start_ms, end_ms)
        sql += time_sql
        params.extend(time_params)

        sql += " ORDER BY update_time_ms DESC LIMIT ? OFFSET ?"
        params.extend([max(1, min(limit, 5000)), max(0, offset)])

        return self.store.query(sql, params)

    def get_trades(
        self,
        symbol: Optional[str] = None,
        side: Optional[str] = None,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        limit: int = 1000,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM trades WHERE 1=1"
        params: List[Any] = []

        if symbol:
            sql += " AND symbol = ?"
            params.append(to_raw_symbol(symbol))
        if side:
            sql += " AND side = ?"
            params.append(side.lower())

        time_sql, time_params = self._time_filter("timestamp_ms", start_ms, end_ms)
        sql += time_sql
        params.extend(time_params)

        sql += " ORDER BY timestamp_ms DESC LIMIT ? OFFSET ?"
        params.extend([max(1, min(limit, 5000)), max(0, offset)])

        return self.store.query(sql, params)

    def get_order_lifecycle(self, order_id: str, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM order_events WHERE order_id = ?"
        params: List[Any] = [str(order_id)]
        if symbol:
            sql += " AND symbol = ?"
            params.append(to_raw_symbol(symbol))
        sql += " ORDER BY event_time_ms ASC"
        return self.store.query(sql, params)

    def summary(
        self,
        symbol: Optional[str] = None,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        filters = ["1=1"]
        params: List[Any] = []

        if symbol:
            filters.append("symbol = ?")
            params.append(to_raw_symbol(symbol))

        if start_ms is not None:
            filters.append("timestamp_ms >= ?")
            params.append(int(start_ms))
        if end_ms is not None:
            filters.append("timestamp_ms <= ?")
            params.append(int(end_ms))

        where = " AND ".join(filters)

        rows = self.store.query(
            f"""
            SELECT
                COUNT(*) AS trade_count,
                COALESCE(SUM(cost), 0) AS gross_notional,
                COALESCE(SUM(fee_cost), 0) AS total_fees,
                COALESCE(SUM(realized_pnl), 0) AS realized_pnl,
                COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
                MIN(timestamp_ms) AS first_trade_ms,
                MAX(timestamp_ms) AS last_trade_ms
            FROM trades
            WHERE {where}
            """,
            params,
        )
        if not rows:
            return {}
        r = rows[0]
        trade_count = int(r.get("trade_count") or 0)
        r["win_rate"] = (float(r.get("wins", 0)) / trade_count) if trade_count > 0 else 0.0
        return r

    def per_symbol_metrics(self, start_ms: Optional[int] = None, end_ms: Optional[int] = None) -> List[Dict[str, Any]]:
        filters = ["1=1"]
        params: List[Any] = []
        if start_ms is not None:
            filters.append("timestamp_ms >= ?")
            params.append(int(start_ms))
        if end_ms is not None:
            filters.append("timestamp_ms <= ?")
            params.append(int(end_ms))

        where = " AND ".join(filters)

        return self.store.query(
            f"""
            SELECT
                symbol,
                COUNT(*) AS trade_count,
                COALESCE(SUM(cost), 0) AS gross_notional,
                COALESCE(SUM(fee_cost), 0) AS total_fees,
                COALESCE(SUM(realized_pnl), 0) AS realized_pnl,
                COALESCE(AVG(realized_pnl), 0) AS avg_realized_pnl,
                COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losses,
                MIN(timestamp_ms) AS first_trade_ms,
                MAX(timestamp_ms) AS last_trade_ms
            FROM trades
            WHERE {where}
            GROUP BY symbol
            ORDER BY realized_pnl DESC
            """,
            params,
        )

    def sync_status(self) -> Dict[str, Any]:
        rows = self.store.query(
            """
            SELECT
                (SELECT COUNT(*) FROM orders) AS order_rows,
                (SELECT COUNT(*) FROM trades) AS trade_rows,
                (SELECT COUNT(*) FROM order_events) AS event_rows,
                (SELECT COUNT(*) FROM strategy_events) AS strategy_rows,
                (SELECT COUNT(*) FROM sync_state) AS state_rows,
                (SELECT MAX(update_time_ms) FROM orders) AS latest_order_ms,
                (SELECT MAX(timestamp_ms) FROM trades) AS latest_trade_ms
            """
        )
        return rows[0] if rows else {}

    def raw_select(self, sql: str, params: Optional[Sequence[Any]] = None) -> List[Dict[str, Any]]:
        """Read-only SQL for advanced iterative analysis."""
        stmt = sql.strip().lower()
        if not stmt.startswith("select"):
            raise ValueError("Only SELECT statements are allowed")
        if ";" in stmt.rstrip(";"):
            raise ValueError("Multiple statements are not allowed")
        return self.store.query(sql, params or ())


def create_history_api(db_path: str = "./v7_sessions/history.db"):
    """Create a FastAPI app exposing history queries."""
    from fastapi import FastAPI, Query

    app = FastAPI(title="V7 History Query API", version="1.0.0")
    api = HistoryQueryAPI(db_path)

    @app.get("/health")
    def health():
        return {"ok": True, "db_path": db_path}

    @app.get("/sync/status")
    def sync_status():
        return api.sync_status()

    @app.get("/orders")
    def orders(
        symbol: Optional[str] = None,
        status: Optional[str] = None,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        limit: int = Query(500, ge=1, le=5000),
        offset: int = Query(0, ge=0),
    ):
        return api.get_orders(symbol, status, start_ms, end_ms, limit, offset)

    @app.get("/trades")
    def trades(
        symbol: Optional[str] = None,
        side: Optional[str] = None,
        start_ms: Optional[int] = None,
        end_ms: Optional[int] = None,
        limit: int = Query(1000, ge=1, le=5000),
        offset: int = Query(0, ge=0),
    ):
        return api.get_trades(symbol, side, start_ms, end_ms, limit, offset)

    @app.get("/orders/{order_id}/events")
    def order_lifecycle(order_id: str, symbol: Optional[str] = None):
        return api.get_order_lifecycle(order_id, symbol)

    @app.get("/stats/summary")
    def summary(symbol: Optional[str] = None, start_ms: Optional[int] = None, end_ms: Optional[int] = None):
        return api.summary(symbol, start_ms, end_ms)

    @app.get("/stats/symbols")
    def per_symbol(start_ms: Optional[int] = None, end_ms: Optional[int] = None):
        return api.per_symbol_metrics(start_ms, end_ms)

    return app
