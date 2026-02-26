"""
SQLAlchemy base + async engine setup.

Maps to existing Prisma-managed SQLite database at prisma/pms.db.
Tables already exist from Prisma migrations — DO NOT create/drop tables.
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

# Default: SQLite at prisma/pms.db (relative to project root)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DB_PATH = _PROJECT_ROOT / "prisma" / "pms.db"
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite+aiosqlite:///{_DEFAULT_DB_PATH}",
)


class Base(DeclarativeBase):
    """Declarative base for all SQLAlchemy models."""
    pass


def get_engine(url: str = DATABASE_URL, **kwargs):
    """Create async engine. Pool size options ignored for SQLite."""
    return create_async_engine(url, echo=False, **kwargs)


def get_session_factory(engine=None):
    """Create async session factory."""
    if engine is None:
        engine = get_engine()
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
