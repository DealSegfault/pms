"""
DB access — supports both PostgreSQL (asyncpg) and SQLite (aiosqlite).

Auto-detects from DATABASE_URL env var:
  - postgresql://... → asyncpg (primary, used in production)
  - not set / other  → aiosqlite fallback (prisma/pms.db)

All callers use SQLite-style ? placeholders — this wrapper auto-translates
to PostgreSQL $1,$2,... numbered params when using asyncpg.

Usage:
    db = Database()
    await db.connect()
    rows = await db.fetch_all("SELECT * FROM sub_accounts WHERE status = ?", ("ACTIVE",))
    await db.close()
"""

from __future__ import annotations

import os
import re
import logging
from pathlib import Path
from typing import Any, List, Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

logger = logging.getLogger(__name__)

# Default: SQLite at prisma/pms.db (relative to project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DB_PATH = _PROJECT_ROOT / "prisma" / "pms.db"

# Load .env from project root (same file Node/Prisma uses)
_ENV_FILE = _PROJECT_ROOT / ".env"
if _ENV_FILE.exists():
    with open(_ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

DATABASE_URL = os.getenv("DATABASE_URL", "")


def _is_postgres(url: str) -> bool:
    return url.startswith("postgresql://") or url.startswith("postgres://")


def _clean_pg_url(url: str) -> str:
    """Strip Prisma-specific query params that asyncpg doesn't understand."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    # Remove Prisma-specific params
    for key in ("connection_limit", "pool_timeout", "pgbouncer", "schema",
                "connect_timeout", "socket_timeout", "statement_cache_size"):
        params.pop(key, None)
    clean_query = urlencode(params, doseq=True)
    return urlunparse(parsed._replace(query=clean_query))


def _sqlite_to_pg_sql(sql: str) -> str:
    """Translate SQLite SQL dialect to PostgreSQL."""
    # datetime('now') → NOW()
    sql = sql.replace("datetime('now')", "NOW()")
    return sql


def _rewrite_placeholders(sql: str) -> str:
    """Rewrite ? placeholders to PostgreSQL $1, $2, $3..."""
    counter = 0
    def replacer(match):
        nonlocal counter
        counter += 1
        return f"${counter}"
    # Replace ? that aren't inside quotes
    # Simple approach: replace all ? (safe because our SQL doesn't use ? in strings)
    return re.sub(r'\?', replacer, sql)


class Database:
    """Async database wrapper — PostgreSQL (asyncpg) or SQLite (aiosqlite)."""

    def __init__(self, path: str = str(_DEFAULT_DB_PATH)):
        self._path = path
        self._use_pg = _is_postgres(DATABASE_URL)
        self._conn: Any = None  # aiosqlite.Connection or asyncpg.Pool
        self._pg_url = _clean_pg_url(DATABASE_URL) if self._use_pg else ""

    async def connect(self) -> None:
        """Open connection. Idempotent."""
        if self._conn is not None:
            return

        if self._use_pg:
            import asyncpg
            self._conn = await asyncpg.create_pool(
                self._pg_url,
                min_size=2,
                max_size=10,
                command_timeout=15,
            )
            logger.info("Database: PostgreSQL pool opened (%s)", self._pg_url.split("@")[-1])
        else:
            import aiosqlite
            self._conn = await aiosqlite.connect(self._path, timeout=10)
            self._conn.row_factory = aiosqlite.Row
            await self._conn.execute("PRAGMA journal_mode=WAL")
            logger.info("Database: SQLite connected (%s)", self._path)

    async def close(self) -> None:
        """Close connection gracefully."""
        if self._conn:
            if self._use_pg:
                await self._conn.close()
            else:
                await self._conn.close()
            self._conn = None

    async def fetch_all(self, sql: str, params: tuple = ()) -> List[dict]:
        """Execute query, return all rows as dicts."""
        assert self._conn, "Database not connected"
        if self._use_pg:
            sql = _sqlite_to_pg_sql(sql)
            sql = _rewrite_placeholders(sql)
            rows = await self._conn.fetch(sql, *params)
            return [dict(row) for row in rows]
        else:
            cursor = await self._conn.execute(sql, params)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def fetch_one(self, sql: str, params: tuple = ()) -> Optional[dict]:
        """Execute query, return first row as dict or None."""
        assert self._conn, "Database not connected"
        if self._use_pg:
            sql = _sqlite_to_pg_sql(sql)
            sql = _rewrite_placeholders(sql)
            row = await self._conn.fetchrow(sql, *params)
            return dict(row) if row else None
        else:
            cursor = await self._conn.execute(sql, params)
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def execute(self, sql: str, params: tuple = ()) -> int:
        """Execute INSERT/UPDATE/DELETE, return rows affected."""
        assert self._conn, "Database not connected"
        if self._use_pg:
            sql = _sqlite_to_pg_sql(sql)
            sql = _rewrite_placeholders(sql)
            result = await self._conn.execute(sql, *params)
            # asyncpg returns "INSERT 0 1" / "UPDATE 3" etc
            try:
                return int(result.split()[-1])
            except (ValueError, IndexError, AttributeError):
                return 0
        else:
            cursor = await self._conn.execute(sql, params)
            await self._conn.commit()
            return cursor.rowcount

    async def execute_returning(self, sql: str, params: tuple = ()) -> Optional[dict]:
        """Execute INSERT and return the inserted row (RETURNING)."""
        assert self._conn, "Database not connected"
        if self._use_pg:
            sql = _sqlite_to_pg_sql(sql)
            sql = _rewrite_placeholders(sql)
            row = await self._conn.fetchrow(sql, *params)
            return dict(row) if row else None
        else:
            cursor = await self._conn.execute(sql, params)
            await self._conn.commit()
            row = await cursor.fetchone()
            return dict(row) if row else None

    async def commit(self) -> None:
        """Explicit commit — no-op for PostgreSQL (auto-commits), commits for SQLite."""
        if not self._use_pg and self._conn:
            await self._conn.commit()
