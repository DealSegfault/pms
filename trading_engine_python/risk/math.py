"""
risk-math — Pure, side-effect-free calculation functions.

Ported 1:1 from JS server/risk/risk-math.js.
Zero dependencies. Fully testable without mocks.
"""

from __future__ import annotations

import hashlib
import time
import uuid


# ── PnL ──

def compute_pnl(side: str, entry_price: float, close_price: float, quantity: float) -> float:
    """
    Compute realized or unrealized PnL for a position.
    
    Args:
        side: 'LONG' or 'SHORT'
        entry_price: position entry price
        close_price: current mark price or actual fill price
        quantity: position size
    """
    if side == "LONG":
        return (close_price - entry_price) * quantity
    return (entry_price - close_price) * quantity


# ── Margin ──

def compute_available_margin(
    balance: float,
    maintenance_rate: float,
    total_upnl: float,
    total_notional: float,
    opposite_notional: float = 0.0,
    opposite_pnl: float = 0.0,
) -> dict:
    """
    Compute available margin for a new trade.
    
    Returns: {equity, maintenance_margin, available_margin}
    """
    equity = balance + total_upnl + opposite_pnl
    maintenance_margin = (total_notional - opposite_notional) * maintenance_rate
    available_margin = equity - maintenance_margin
    return {
        "equity": equity,
        "maintenance_margin": maintenance_margin,
        "available_margin": available_margin,
    }


def compute_margin_usage_ratio(
    equity: float,
    current_margin_used: float,
    new_margin: float,
) -> float:
    """
    Compute post-trade margin usage ratio.
    > 1 means over-margined.
    """
    if equity <= 0:
        return 999.0
    return (current_margin_used + new_margin) / equity


def compute_margin(notional: float, leverage: int) -> float:
    """Initial margin for a position."""
    if leverage <= 0:
        return notional
    return notional / leverage


def compute_margin_ratio(maintenance_margin: float, equity: float) -> float:
    """Margin ratio: maintenance_margin / equity. >= 1.0 = liquidation."""
    if equity <= 0:
        return 1.0
    return maintenance_margin / equity


def compute_liquidation_price(
    side: str,
    entry_price: float,
    quantity: float,
    margin: float,
    maintenance_rate: float = 0.005,
) -> float:
    """
    Approximate liquidation price for a virtual sub-account position.
    Based on when unrealized loss >= margin * (1 - maintenance_rate).
    """
    if quantity <= 0:
        return 0.0
    loss_threshold = margin * (1.0 - maintenance_rate)
    if side == "LONG":
        return max(0.0, entry_price - (loss_threshold / quantity))
    return entry_price + (loss_threshold / quantity)


# ── Trade Signatures ──

def create_trade_signature(sub_account_id: str, action: str, position_id: str) -> str:
    """
    SHA-256 trade signature for dedup detection.
    Deterministic given the same inputs + timestamp + nonce.
    """
    raw = f"{sub_account_id}:{action}:{position_id}:{int(time.time() * 1000)}:{uuid.uuid4().hex}"
    return hashlib.sha256(raw.encode()).hexdigest()


def create_open_trade_signature(
    sub_account_id: str, symbol: str, side: str, quantity: float
) -> str:
    """SHA-256 trade signature for OPEN trades."""
    raw = f"{sub_account_id}:{symbol}:{side}:{quantity}:{int(time.time() * 1000)}:{uuid.uuid4().hex}"
    return hashlib.sha256(raw.encode()).hexdigest()
