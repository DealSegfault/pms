from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Set


@dataclass(frozen=True)
class VirtualPosition:
    id: str
    sub_account_id: str
    symbol: str
    side: str
    entry_price: float
    quantity: float
    notional: float


@dataclass(frozen=True)
class SignalSnapshot:
    bias: str
    momentum_bps_30s: float
    momentum_bps_120s: float
    vol_bps_60s: float
    edge_bps: float


@dataclass(frozen=True)
class TpEvaluation:
    model: str
    target_bps: float
    pnl_bps: float
    should_close: bool
    reason: str


@dataclass
class UserSession:
    user_id: str
    sub_account_id: str
    tp_mode: str = "auto"
    active: bool = True
    error: Optional[str] = None

    virtual_positions: Dict[str, VirtualPosition] = field(default_factory=dict)
    excluded_positions: Set[str] = field(default_factory=set)
    last_model_by_position: Dict[str, str] = field(default_factory=dict)

    total_trades: int = 0
    total_pnl_usd: float = 0.0
    wins: int = 0
    losses: int = 0

