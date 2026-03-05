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

from sqlalchemy import BigInteger, Boolean, Column, Float, ForeignKey, Index, Integer, String, Text
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
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

    sub_accounts = relationship("SubAccount", back_populates="user")


# ── Sub Accounts ──

class SubAccount(Base):
    __tablename__ = "sub_accounts"
    
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=True)
    routing_prefix = Column(String, unique=True, nullable=True)
    name = Column(String, nullable=False)
    type = Column(String, default="USER")
    initial_balance = Column(Float, nullable=False)
    current_balance = Column(Float, nullable=False)
    status = Column(String, default="ACTIVE")
    liquidation_mode = Column(String, default="ADL_30")
    maintenance_rate = Column(Float, default=0.005)
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

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
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), unique=True, nullable=True)
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
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=False)
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
    taken_over_at = Column(BigInteger, nullable=True)
    opened_at = Column(BigInteger, nullable=True)
    closed_at = Column(BigInteger, nullable=True)

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
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=False)
    position_id = Column(String, ForeignKey("virtual_positions.id"), nullable=True)
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
    timestamp = Column(BigInteger, nullable=True)

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
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=False)
    balance_before = Column(Float, nullable=False)
    balance_after = Column(Float, nullable=False)
    change_amount = Column(Float, nullable=False)
    reason = Column(String, nullable=False)
    trade_id = Column(String, nullable=True)
    timestamp = Column(BigInteger, nullable=True)

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
    created_at = Column(BigInteger, nullable=True)
    filled_at = Column(BigInteger, nullable=True)
    cancelled_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_po_xoid", "exchange_order_id"),
        Index("idx_po_status_type", "status", "type"),
        Index("idx_po_sub_status", "sub_account_id", "status"),
    )


class OrderLifecycle(Base):
    __tablename__ = "order_lifecycles"

    id = Column(String, primary_key=True, default=_uuid)
    execution_scope = Column(String, default="SUB_ACCOUNT")
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=True)
    venue = Column(String, default="BINANCE_FUTURES")
    venue_account_key = Column(String, default="binance:futures:main")
    ownership_confidence = Column(String, default="HARD")
    origin_path = Column(String, default="PYTHON_CMD")
    strategy_type = Column(String, nullable=True)
    strategy_session_id = Column(String, nullable=True)
    parent_id = Column(String, nullable=True)
    client_order_id = Column(String, nullable=True)
    exchange_order_id = Column(String, nullable=True)
    symbol = Column(String, nullable=True)
    side = Column(String, nullable=True)
    order_type = Column(String, nullable=True)
    reduce_only = Column(Boolean, default=False)
    requested_qty = Column(Float, nullable=True)
    limit_price = Column(Float, nullable=True)
    decision_bid = Column(Float, nullable=True)
    decision_ask = Column(Float, nullable=True)
    decision_mid = Column(Float, nullable=True)
    decision_spread_bps = Column(Float, nullable=True)
    intent_ts = Column(BigInteger, nullable=True)
    ack_ts = Column(BigInteger, nullable=True)
    first_fill_ts = Column(BigInteger, nullable=True)
    done_ts = Column(BigInteger, nullable=True)
    final_status = Column(String, nullable=True)
    filled_qty = Column(Float, default=0)
    avg_fill_price = Column(Float, nullable=True)
    reprice_count = Column(Integer, default=0)
    reconciliation_status = Column(String, default="PENDING")
    reconciliation_reason = Column(String, nullable=True)
    last_reconciled_at = Column(BigInteger, nullable=True)
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_ol_sub_ts", "sub_account_id", "created_at"),
        Index("idx_ol_client_order_id", "client_order_id"),
        Index("idx_ol_exchange_order_id", "exchange_order_id"),
        Index("idx_ol_symbol_ts", "symbol", "created_at"),
        Index("idx_ol_reconcile_status_updated", "reconciliation_status", "updated_at"),
    )


class OrderLifecycleEvent(Base):
    __tablename__ = "order_lifecycle_events"

    id = Column(String, primary_key=True, default=_uuid)
    lifecycle_id = Column(String, nullable=False)
    stream_event_id = Column(String, unique=True, nullable=False)
    event_type = Column(String, nullable=False)
    source_ts = Column(BigInteger, nullable=True)
    ingested_ts = Column(BigInteger, nullable=True)
    payload_json = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_ole_lifecycle_created", "lifecycle_id", "created_at"),
        Index("idx_ole_event_type_source", "event_type", "source_ts"),
    )


class MarketQuote(Base):
    __tablename__ = "market_quotes"

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False)
    ts = Column(BigInteger, nullable=False)
    bid = Column(Float, nullable=False)
    ask = Column(Float, nullable=False)
    mid = Column(Float, nullable=False)
    spread_bps = Column(Float, nullable=True)
    source = Column(String, default="L1")
    created_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_mq_symbol_ts", "symbol", "ts"),
    )


class FillFact(Base):
    __tablename__ = "fill_facts"

    id = Column(String, primary_key=True, default=_uuid)
    lifecycle_id = Column(String, nullable=False)
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=True)
    source_event_id = Column(String, unique=True, nullable=True)
    execution_scope = Column(String, default="SUB_ACCOUNT")
    ownership_confidence = Column(String, default="HARD")
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=True)
    fill_ts = Column(BigInteger, nullable=False)
    fill_qty = Column(Float, nullable=False)
    fill_price = Column(Float, nullable=False)
    fill_bid = Column(Float, nullable=True)
    fill_ask = Column(Float, nullable=True)
    fill_mid = Column(Float, nullable=True)
    fill_spread_bps = Column(Float, nullable=True)
    sampled_at = Column(BigInteger, nullable=True)
    fee = Column(Float, default=0)
    maker_taker = Column(String, nullable=True)
    origin_type = Column(String, default="MANUAL")
    created_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_ff_sub_fill_ts", "sub_account_id", "fill_ts"),
        Index("idx_ff_symbol_fill_ts", "symbol", "fill_ts"),
        Index("idx_ff_lifecycle_fill_ts", "lifecycle_id", "fill_ts"),
    )


class FillMarkout(Base):
    __tablename__ = "fill_markouts"

    id = Column(String, primary_key=True, default=_uuid)
    fill_fact_id = Column(String, nullable=False)
    horizon_ms = Column(Integer, nullable=False)
    measured_ts = Column(BigInteger, nullable=True)
    mid_price = Column(Float, nullable=True)
    mark_price = Column(Float, nullable=True)
    markout_bps = Column(Float, nullable=True)
    created_at = Column(BigInteger, nullable=True)


class StrategySession(Base):
    __tablename__ = "strategy_sessions"

    id = Column(String, primary_key=True)
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=True)
    origin = Column(String, default="MANUAL")
    strategy_type = Column(String, nullable=True)
    symbol = Column(String, nullable=True)
    side = Column(String, nullable=True)
    started_at = Column(BigInteger, nullable=True)
    ended_at = Column(BigInteger, nullable=True)
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_ss_sub_started", "sub_account_id", "started_at"),
    )


class SubAccountTcaRollup(Base):
    __tablename__ = "sub_account_tca_rollups"

    id = Column(String, primary_key=True, default=_uuid)
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=False)
    execution_scope = Column(String, default="SUB_ACCOUNT")
    ownership_confidence = Column(String, default="HARD")
    order_count = Column(Integer, default=0)
    terminal_order_count = Column(Integer, default=0)
    fill_count = Column(Integer, default=0)
    cancel_count = Column(Integer, default=0)
    reject_count = Column(Integer, default=0)
    total_requested_qty = Column(Float, default=0)
    total_filled_qty = Column(Float, default=0)
    total_fill_notional = Column(Float, default=0)
    fill_ratio = Column(Float, nullable=True)
    cancel_to_fill_ratio = Column(Float, nullable=True)
    avg_arrival_slippage_bps = Column(Float, nullable=True)
    avg_ack_latency_ms = Column(Float, nullable=True)
    avg_working_time_ms = Column(Float, nullable=True)
    avg_markout_1s_bps = Column(Float, nullable=True)
    avg_markout_5s_bps = Column(Float, nullable=True)
    avg_markout_30s_bps = Column(Float, nullable=True)
    total_reprice_count = Column(Integer, default=0)
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_satr_scope_conf", "execution_scope", "ownership_confidence"),
    )


class StrategyTcaRollup(Base):
    __tablename__ = "strategy_tca_rollups"

    id = Column(String, primary_key=True, default=_uuid)
    strategy_session_id = Column(String, nullable=False)
    sub_account_id = Column(String, ForeignKey("sub_accounts.id"), nullable=True)
    strategy_type = Column(String, nullable=True)
    execution_scope = Column(String, default="SUB_ACCOUNT")
    ownership_confidence = Column(String, default="HARD")
    order_count = Column(Integer, default=0)
    terminal_order_count = Column(Integer, default=0)
    fill_count = Column(Integer, default=0)
    cancel_count = Column(Integer, default=0)
    reject_count = Column(Integer, default=0)
    total_requested_qty = Column(Float, default=0)
    total_filled_qty = Column(Float, default=0)
    total_fill_notional = Column(Float, default=0)
    fill_ratio = Column(Float, nullable=True)
    cancel_to_fill_ratio = Column(Float, nullable=True)
    avg_arrival_slippage_bps = Column(Float, nullable=True)
    avg_ack_latency_ms = Column(Float, nullable=True)
    avg_working_time_ms = Column(Float, nullable=True)
    avg_markout_1s_bps = Column(Float, nullable=True)
    avg_markout_5s_bps = Column(Float, nullable=True)
    avg_markout_30s_bps = Column(Float, nullable=True)
    total_reprice_count = Column(Integer, default=0)
    created_at = Column(BigInteger, nullable=True)
    updated_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        Index("idx_str_scope_conf", "execution_scope", "ownership_confidence"),
    )
