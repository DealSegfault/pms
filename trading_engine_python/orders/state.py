"""
OrderState — Universal order state dataclass.

Extends the market_maker.py OrderState with sub-account tracking,
origin metadata, fill tracking, and algo engine callbacks.

State machine (feed-driven — transitions come from exchange feed, NOT REST responses):

    idle ──place()──▶ placing ──feed:NEW──▶ active
                                             │
                         ┌──feed:FILLED──────┘──cancel()──▶ cancelling
                         │                                      │
                         ▼                         feed:CANCELED ▼
                       filled                              cancelled

    Additional terminal states: expired, failed
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional, Any

# Valid state transitions (current_state → set of allowed next states)
VALID_TRANSITIONS = {
    "idle":       {"placing"},
    "placing":    {"active", "filled", "cancelled", "failed"},
    "active":     {"cancelling", "filled", "cancelled", "expired"},
    "cancelling": {"cancelled", "filled", "expired"},
    # Terminal states — no transitions out
    "filled":     set(),
    "cancelled":  set(),
    "expired":    set(),
    "failed":     set(),
}

TERMINAL_STATES = {"filled", "cancelled", "expired", "failed"}


def generate_client_order_id(sub_account_id: str, order_type: str) -> str:
    """
    Generate a unique client order ID for Binance.

    Format: PMS{sub_prefix}_{type}_{uid}
    - Must be ≤ 36 chars (Binance limit)
    - Prefix PMS enables instant routing from exchange feed
    - 8-char sub-account prefix enables sub-account resolution without DB lookup

    Examples:
        PMS_a1b2c3d4_MKT_f9e8d7c6b5a4
        PMS_a1b2c3d4_LMT_1234abcd5678
    """
    prefix = sub_account_id[:8]
    uid = uuid.uuid4().hex[:12]
    return f"PMS{prefix}_{order_type}_{uid}"


@dataclass
class OrderState:
    """
    Universal order state — tracks every order across all algo types.

    Key insight from market_maker.py:
    - State transitions come from the FEED, not from REST responses
    - REST response only moves idle → placing
    - Feed confirms placing → active, and active → filled/cancelled
    """

    # ── Identity ──
    client_order_id: str                          # PMS{sub[:8]}_{type}_{uuid}
    sub_account_id: str = ""
    exchange_order_id: Optional[str] = None

    # ── Order details ──
    symbol: str = ""                              # Binance native: BTCUSDT
    side: str = ""                                # BUY / SELL
    order_type: str = "LIMIT"                     # LIMIT / MARKET / STOP_MARKET / TAKE_PROFIT_MARKET
    quantity: float = 0.0
    price: Optional[float] = None
    reduce_only: bool = False

    # ── State machine ──
    state: str = "idle"

    # ── Fill tracking ──
    filled_qty: float = 0.0
    avg_fill_price: float = 0.0
    last_fill_price: float = 0.0
    last_fill_qty: float = 0.0

    # ── Metadata ──
    origin: str = "MANUAL"                        # MANUAL / CHASE / SCALPER / TWAP / TRAIL_STOP / BASKET
    parent_id: Optional[str] = None               # Parent algo ID (chase_id, scalper_id, etc.)
    leverage: int = 1
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    # ── Callbacks (set by algo engines, called by OrderManager) ──
    # These are NOT serialized — runtime only. Use field(repr=False) to hide from logs.
    on_fill: Optional[Callable] = field(default=None, repr=False)
    on_cancel: Optional[Callable] = field(default=None, repr=False)
    on_partial: Optional[Callable] = field(default=None, repr=False)

    # ── Internal ──
    _extra: dict = field(default_factory=dict, repr=False)

    def transition(self, new_state: str) -> bool:
        """
        Attempt a state transition. Returns True if valid, False if rejected.
        Updates `updated_at` on success.
        """
        allowed = VALID_TRANSITIONS.get(self.state, set())
        if new_state not in allowed:
            return False
        self.state = new_state
        self.updated_at = time.time()
        return True

    @property
    def is_terminal(self) -> bool:
        """Check if this order is in a terminal (final) state."""
        return self.state in TERMINAL_STATES

    @property
    def is_active(self) -> bool:
        """Check if this order is alive on the exchange."""
        return self.state in ("placing", "active", "cancelling")

    @property
    def is_stale(self) -> bool:
        """Order stuck in 'placing' for > 30s — likely lost in transit."""
        return self.state == "placing" and (time.time() - self.created_at) > 30.0

    @property
    def remaining_qty(self) -> float:
        """Quantity still unfilled."""
        return max(0.0, self.quantity - self.filled_qty)

    @property
    def fill_pct(self) -> float:
        """Percentage filled (0.0 to 100.0)."""
        if self.quantity <= 0:
            return 0.0
        return (self.filled_qty / self.quantity) * 100.0

    def apply_fill(self, fill_price: float, fill_qty: float) -> None:
        """
        Apply a fill event from the exchange feed.
        Updates filled_qty, avg_fill_price, last_fill_price, last_fill_qty.
        """
        if fill_qty <= 0:
            return

        # Weighted average fill price
        total_filled = self.filled_qty + fill_qty
        if total_filled > 0:
            self.avg_fill_price = (
                (self.avg_fill_price * self.filled_qty) + (fill_price * fill_qty)
            ) / total_filled

        self.filled_qty = total_filled
        self.last_fill_price = fill_price
        self.last_fill_qty = fill_qty
        self.updated_at = time.time()

    def to_event_dict(self) -> dict:
        """
        Serialize to a dict suitable for Redis event publishing.
        Excludes callbacks and internal fields.
        """
        return {
            "clientOrderId": self.client_order_id,
            "exchangeOrderId": self.exchange_order_id,
            "subAccountId": self.sub_account_id,
            "symbol": self.symbol,
            "side": self.side,
            "orderType": self.order_type,
            "quantity": self.quantity,
            "price": self.price,
            "reduceOnly": self.reduce_only,
            "state": self.state,
            "filledQty": self.filled_qty,
            "avgFillPrice": self.avg_fill_price,
            "lastFillPrice": self.last_fill_price,
            "lastFillQty": self.last_fill_qty,
            "origin": self.origin,
            "parentId": self.parent_id,
            "leverage": self.leverage,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    def __repr__(self) -> str:
        return (
            f"OrderState(coid={self.client_order_id!r}, "
            f"sym={self.symbol}, side={self.side}, "
            f"state={self.state}, qty={self.quantity}, "
            f"filled={self.filled_qty}, origin={self.origin})"
        )
