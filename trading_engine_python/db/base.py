"""
DB access — thin aiosqlite wrapper.

Maps to existing Prisma-managed SQLite database at prisma/pms.db.
Tables already exist from Prisma migrations — DO NOT create/drop tables.

Usage:
    db = Database()
    await db.connect()
    rows = await db.fetch_all("SELECT * FROM sub_accounts WHERE status = ?", ("ACTIVE",))
    await db.close()
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List, Optional

import aiosqlite

# Default: SQLite at prisma/pms.db (relative to project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DB_PATH = _PROJECT_ROOT / "prisma" / "pms.db"
DB_PATH = os.getenv("DB_PATH", str(_DEFAULT_DB_PATH))


class Database:
    """Thin async SQLite wrapper using aiosqlite."""

    def __init__(self, path: str = DB_PATH):
        self._path = path
        self._conn: Optional[aiosqlite.Connection] = None

    async def connect(self) -> None:
        """Open connection. Idempotent."""
        if self._conn is not None:
            return
        self._conn = await aiosqlite.connect(self._path, timeout=10)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")

    async def close(self) -> None:
        """Close connection gracefully."""
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def fetch_all(self, sql: str, params: tuple = ()) -> List[dict]:
        """Execute query, return all rows as dicts."""
        assert self._conn, "Database not connected"
        cursor = await self._conn.execute(sql, params)
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def fetch_one(self, sql: str, params: tuple = ()) -> Optional[dict]:
        """Execute query, return first row as dict or None."""
        assert self._conn, "Database not connected"
        cursor = await self._conn.execute(sql, params)
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def execute(self, sql: str, params: tuple = ()) -> int:
        """Execute INSERT/UPDATE/DELETE, return rows affected."""
        assert self._conn, "Database not connected"
        cursor = await self._conn.execute(sql, params)
        await self._conn.commit()
        return cursor.rowcount

    async def execute_returning(self, sql: str, params: tuple = ()) -> Optional[dict]:
        """Execute INSERT and return the inserted row (SQLite RETURNING)."""
        assert self._conn, "Database not connected"
        cursor = await self._conn.execute(sql, params)
        await self._conn.commit()
        row = await cursor.fetchone()
        return dict(row) if row else None
