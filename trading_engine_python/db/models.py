"""
SQLAlchemy models mapping to existing Prisma-managed tables.

Column names use Prisma's @map() values (snake_case in DB).
Table names use Prisma's @@map() values.

IMPORTANT: These models are READ/WRITE views of existing tables.
           Schema is managed by Prisma migrations. Never run Base.metadata.create_all().
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import relationship

from .base import Base


def _uuid() -> str:
    return str(uuid.uuid4())


# ── Users ──

class User(Base):
    __tablename__ = "users"
    
    id = Column(String, primary_key=True, default=_uuid)
    username = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="USER")
    status = Column(String, default="PENDING")
    api_key = Column(String, unique=True, nullable=True)
    current_challenge = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    sub_accounts = relationship("SubAccount", back_populates="user")


# ── Sub Accounts ──

class SubAccount(Base):
    __tablename__ = "sub_accounts"
    
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, nullable=True)
    name = Column(String, nullable=False)
    type = Column(String, default="USER")
    initial_balance = Column(Float, nullable=False)
    current_balance = Column(Float, nullable=False)
    status = Column(String, default="ACTIVE")
    liquidation_mode = Column(String, default="ADL_30")
    maintenance_rate = Column(Float, default=0.005)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="sub_accounts", foreign_keys=[user_id])
    risk_rule = relationship("RiskRule", back_populates="sub_account", uselist=False)
    positions = relationship("VirtualPosition", back_populates="sub_account")
    trades = relationship("TradeExecution", back_populates="sub_account")
    balance_logs = relationship("BalanceLog", back_populates="sub_account")

    __table_args__ = (
        Index("idx_sa_user_status", "user_id", "status"),
        Index("idx_sa_status", "status"),
    )


# ── Risk Rules ──

class RiskRule(Base):
    __tablename__ = "risk_rules"
    
    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, unique=True, nullable=True)
    is_global = Column(Boolean, default=False)
    max_leverage = Column(Float, default=100)
    max_notional_per_trade = Column(Float, default=200)
    max_total_exposure = Column(Float, default=500)
    liquidation_threshold = Column(Float, default=0.90)

    sub_account = relationship("SubAccount", back_populates="risk_rule", foreign_keys=[sub_account_id])

    __table_args__ = (
        Index("idx_rr_global", "is_global"),
    )


# ── Virtual Positions ──

class VirtualPosition(Base):
    __tablename__ = "virtual_positions"
    
    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, nullable=False)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)           # LONG, SHORT
    entry_price = Column(Float, nullable=False)
    quantity = Column(Float, nullable=False)
    notional = Column(Float, nullable=False)
    leverage = Column(Float, nullable=False)
    margin = Column(Float, nullable=False)
    liquidation_price = Column(Float, nullable=False)
    status = Column(String, default="OPEN")          # OPEN, CLOSED, LIQUIDATED, TAKEN_OVER
    realized_pnl = Column(Float, nullable=True)
    taken_over = Column(Boolean, default=False)
    taken_over_by = Column(String, nullable=True)
    taken_over_at = Column(DateTime, nullable=True)
    opened_at = Column(DateTime, default=datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)

    sub_account = relationship("SubAccount", back_populates="positions", foreign_keys=[sub_account_id])
    trades = relationship("TradeExecution", back_populates="position")

    __table_args__ = (
        Index("idx_vp_sub_status", "sub_account_id", "status"),
        Index("idx_vp_symbol_status", "symbol", "status"),
        Index("idx_vp_sub_symbol_side_status", "sub_account_id", "symbol", "side", "status"),
    )


# ── Trade Executions ──

class TradeExecution(Base):
    __tablename__ = "trade_executions"
    
    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, nullable=False)
    position_id = Column(String, nullable=True)
    exchange_order_id = Column(String, nullable=True)
    client_order_id = Column(String, nullable=True)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)            # BUY, SELL
    type = Column(String, nullable=False)             # MARKET, LIMIT
    price = Column(Float, nullable=False)
    quantity = Column(Float, nullable=False)
    notional = Column(Float, nullable=False)
    fee = Column(Float, default=0)
    realized_pnl = Column(Float, nullable=True)
    action = Column(String, nullable=False)           # OPEN, CLOSE, LIQUIDATE, ADD
    origin_type = Column(String, default="MANUAL")    # MANUAL, BOT, API
    status = Column(String, default="FILLED")         # PENDING, FILLED, FAILED, CANCELLED
    signature = Column(String, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)

    sub_account = relationship("SubAccount", back_populates="trades", foreign_keys=[sub_account_id])
    position = relationship("VirtualPosition", back_populates="trades", foreign_keys=[position_id])

    __table_args__ = (
        Index("idx_te_sub_ts", "sub_account_id", "timestamp"),
        Index("idx_te_sub_status_ts", "sub_account_id", "status", "timestamp"),
        Index("idx_te_sub_symbol_ts", "sub_account_id", "symbol", "timestamp"),
        Index("idx_te_xoid", "exchange_order_id"),
    )


# ── Balance Logs ──

class BalanceLog(Base):
    __tablename__ = "balance_logs"
    
    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, nullable=False)
    balance_before = Column(Float, nullable=False)
    balance_after = Column(Float, nullable=False)
    change_amount = Column(Float, nullable=False)
    reason = Column(String, nullable=False)
    trade_id = Column(String, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

    sub_account = relationship("SubAccount", back_populates="balance_logs", foreign_keys=[sub_account_id])

    __table_args__ = (
        Index("idx_bl_sub_ts", "sub_account_id", "timestamp"),
    )


# ── Pending Orders ──

class PendingOrder(Base):
    __tablename__ = "pending_orders"
    
    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, nullable=False)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)
    type = Column(String, default="LIMIT")
    price = Column(Float, nullable=False)
    quantity = Column(Float, nullable=False)
    leverage = Column(Float, nullable=False)
    exchange_order_id = Column(String, nullable=True)
    status = Column(String, default="PENDING")
    created_at = Column(DateTime, default=datetime.utcnow)
    filled_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("idx_po_xoid", "exchange_order_id"),
        Index("idx_po_status_type", "status", "type"),
        Index("idx_po_sub_status", "sub_account_id", "status"),
    )
