"""
OrderTracker — In-memory multi-index for fast O(1) order lookups.

Maintains these indexes:
- client_order_id → OrderState  (primary key)
- exchange_order_id → client_order_id  (exchange feed routing)
- sub_account_id → set of client_order_ids  (account queries)
- symbol → set of client_order_ids  (symbol queries)
- parent_id → set of client_order_ids  (algo engine queries)

Thread-safety: NOT thread-safe. Designed for single asyncio event loop.
"""

from __future__ import annotations

import logging
import time
from typing import Dict, List, Optional, Set

from .state import OrderState, TERMINAL_STATES

logger = logging.getLogger(__name__)


class OrderTracker:
    """In-memory index for fast order lookup by various keys."""

    def __init__(self, max_terminal_age: float = 300.0):
        """
        Args:
            max_terminal_age: Seconds to keep terminal orders before cleanup.
                              Prevents unbounded memory growth.
        """
        self._by_client_id: Dict[str, OrderState] = {}
        self._by_exchange_id: Dict[str, str] = {}          # exchange_oid → client_oid
        self._by_sub_account: Dict[str, Set[str]] = {}     # sub_account_id → {client_oids}
        self._by_symbol: Dict[str, Set[str]] = {}           # symbol → {client_oids}
        self._by_parent: Dict[str, Set[str]] = {}           # parent_id → {client_oids}
        self._max_terminal_age = max_terminal_age

    # ── Registration ──

    def register(self, order: OrderState) -> None:
        """
        Register a new order in all indexes.
        Idempotent — re-registering updates the primary entry.
        """
        coid = order.client_order_id

        # Primary index
        self._by_client_id[coid] = order

        # Exchange ID index (may be set later via update_exchange_id)
        if order.exchange_order_id:
            self._by_exchange_id[order.exchange_order_id] = coid

        # Sub-account index
        if order.sub_account_id:
            self._by_sub_account.setdefault(order.sub_account_id, set()).add(coid)

        # Symbol index
        if order.symbol:
            self._by_symbol.setdefault(order.symbol, set()).add(coid)

        # Parent (algo) index
        if order.parent_id:
            self._by_parent.setdefault(order.parent_id, set()).add(coid)

    def update_exchange_id(self, client_order_id: str, exchange_order_id: str) -> None:
        """
        Set the exchange order ID for an order.
        Called when REST response returns the exchange-assigned ID.
        """
        order = self._by_client_id.get(client_order_id)
        if order is None:
            logger.warning(
                "update_exchange_id: unknown client_order_id=%s", client_order_id
            )
            return

        # Remove old mapping if it existed
        if order.exchange_order_id and order.exchange_order_id in self._by_exchange_id:
            del self._by_exchange_id[order.exchange_order_id]

        order.exchange_order_id = exchange_order_id
        self._by_exchange_id[exchange_order_id] = client_order_id

    def unregister(self, client_order_id: str) -> Optional[OrderState]:
        """
        Remove an order from ALL indexes. Returns the removed OrderState or None.
        """
        order = self._by_client_id.pop(client_order_id, None)
        if order is None:
            return None

        # Clean exchange ID index
        if order.exchange_order_id:
            self._by_exchange_id.pop(order.exchange_order_id, None)

        # Clean sub-account index
        if order.sub_account_id and order.sub_account_id in self._by_sub_account:
            self._by_sub_account[order.sub_account_id].discard(client_order_id)
            if not self._by_sub_account[order.sub_account_id]:
                del self._by_sub_account[order.sub_account_id]

        # Clean symbol index
        if order.symbol and order.symbol in self._by_symbol:
            self._by_symbol[order.symbol].discard(client_order_id)
            if not self._by_symbol[order.symbol]:
                del self._by_symbol[order.symbol]

        # Clean parent index
        if order.parent_id and order.parent_id in self._by_parent:
            self._by_parent[order.parent_id].discard(client_order_id)
            if not self._by_parent[order.parent_id]:
                del self._by_parent[order.parent_id]

        return order

    # ── Lookups ──

    def lookup(
        self,
        exchange_order_id: Optional[str] = None,
        client_order_id: Optional[str] = None,
    ) -> Optional[OrderState]:
        """
        Look up an order by exchange_order_id or client_order_id.
        Tries exchange_order_id first (most common in feed events),
        then falls back to client_order_id.
        """
        if exchange_order_id:
            coid = self._by_exchange_id.get(exchange_order_id)
            if coid:
                return self._by_client_id.get(coid)

        if client_order_id:
            return self._by_client_id.get(client_order_id)

        return None

    def get_by_sub_account(
        self, sub_account_id: str, active_only: bool = False
    ) -> List[OrderState]:
        """Get all orders for a sub-account. Optionally filter to active-only."""
        coids = self._by_sub_account.get(sub_account_id, set())
        orders = [self._by_client_id[c] for c in coids if c in self._by_client_id]
        if active_only:
            orders = [o for o in orders if o.is_active]
        return orders

    def get_by_symbol(self, symbol: str, active_only: bool = False) -> List[OrderState]:
        """Get all orders for a symbol. Optionally filter to active-only."""
        coids = self._by_symbol.get(symbol, set())
        orders = [self._by_client_id[c] for c in coids if c in self._by_client_id]
        if active_only:
            orders = [o for o in orders if o.is_active]
        return orders

    def get_active_by_symbol(self, symbol: str) -> List[OrderState]:
        """Get only active orders for a symbol."""
        return self.get_by_symbol(symbol, active_only=True)

    def get_by_parent(self, parent_id: str) -> List[OrderState]:
        """Get all orders belonging to a parent algo."""
        coids = self._by_parent.get(parent_id, set())
        return [self._by_client_id[c] for c in coids if c in self._by_client_id]

    # ── Housekeeping ──

    def cleanup_terminal(self, max_age_seconds: Optional[float] = None) -> int:
        """
        Remove orders in terminal states older than max_age_seconds.
        Returns the number of orders cleaned up.
        Prevents unbounded memory growth from completed orders.
        """
        cutoff = time.time() - (max_age_seconds or self._max_terminal_age)
        to_remove = [
            coid
            for coid, order in self._by_client_id.items()
            if order.is_terminal and order.updated_at < cutoff
        ]
        for coid in to_remove:
            self.unregister(coid)

        if to_remove:
            logger.debug("Cleaned up %d terminal orders", len(to_remove))

        return len(to_remove)

    # ── Stats ──

    @property
    def total_count(self) -> int:
        """Total number of tracked orders (including terminal)."""
        return len(self._by_client_id)

    @property
    def active_count(self) -> int:
        """Number of non-terminal orders."""
        return sum(1 for o in self._by_client_id.values() if o.is_active)

    def __repr__(self) -> str:
        return (
            f"OrderTracker(total={self.total_count}, "
            f"active={self.active_count}, "
            f"symbols={len(self._by_symbol)}, "
            f"accounts={len(self._by_sub_account)})"
        )
