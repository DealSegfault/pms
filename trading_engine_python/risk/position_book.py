"""
PositionBook — In-memory position tracking with dual indexes.

Ported from JS server/risk/position-book.js.
Pure data structure with zero side effects. No DB, no exchange calls.

Data shape:
    _entries: {subAccountId: {account: dict, positions: {posId: VirtualPos}, rules: dict|None}}
    _symbol_accounts: {symbol: {subAccountIds}}  (reverse index)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


@dataclass
class VirtualPos:
    """In-memory position (lighter than DB model, runtime-only fields)."""
    id: str
    sub_account_id: str
    symbol: str                    # Binance format: BTCUSDT
    side: str                      # LONG / SHORT
    entry_price: float
    quantity: float
    notional: float
    leverage: int
    margin: float
    liquidation_price: float = 0.0
    opened_at: Optional[float] = None

    # Live-updated by RiskEngine on price ticks
    mark_price: float = 0.0
    unrealized_pnl: float = 0.0


class PositionBook:
    """
    In-memory position index (matches JS PositionBook structure).
    
    Dual-indexed:
    - _entries[sub_account_id] → {account, positions: {pos_id → VirtualPos}, rules}
    - _symbol_accounts[symbol] → set of sub_account_ids (reverse index)
    """

    def __init__(self):
        self._entries: Dict[str, dict] = {}
        self._symbol_accounts: Dict[str, Set[str]] = {}

    # ── Queries ──

    def get_entry(self, sub_account_id: str) -> Optional[dict]:
        """Get book entry: {account, positions, rules}."""
        return self._entries.get(sub_account_id)

    def get_accounts_for_symbol(self, symbol: str) -> Set[str]:
        """Get all sub-account IDs with positions on a symbol."""
        return self._symbol_accounts.get(symbol, set())

    def get_by_sub_account(self, sub_account_id: str) -> List[VirtualPos]:
        """Get all positions for a sub-account."""
        entry = self._entries.get(sub_account_id)
        if not entry:
            return []
        return list(entry["positions"].values())

    def get_position(self, sub_account_id: str, position_id: str) -> Optional[VirtualPos]:
        """Get a specific position."""
        entry = self._entries.get(sub_account_id)
        if not entry:
            return None
        return entry["positions"].get(position_id)

    def find_position(self, sub_account_id: str, symbol: str, side: str) -> Optional[VirtualPos]:
        """Find an open position matching sub-account + symbol + side."""
        entry = self._entries.get(sub_account_id)
        if not entry:
            return None

        # Primary: exact match
        for pos in entry["positions"].values():
            if pos.symbol == symbol and pos.side == side:
                return pos

        # Fallback: match by base symbol (handles ccxt vs Binance format mismatch)
        # e.g., 'BTC/USDT:USDT' → 'BTC', 'BTCUSDT' → 'BTC'
        def _extract_base(s: str) -> str:
            if '/' in s:
                return s.split('/')[0]
            # Binance format: remove USDT/BUSD suffix
            for suffix in ('USDT', 'BUSD', 'USDC', 'BTC', 'ETH', 'BNB'):
                if s.endswith(suffix) and len(s) > len(suffix):
                    return s[:-len(suffix)]
            return s

        target_base = _extract_base(symbol).upper()
        for pos in entry["positions"].values():
            if _extract_base(pos.symbol).upper() == target_base and pos.side == side:
                logger.warning(
                    "find_position: symbol format mismatch — searched '%s' matched '%s' (base='%s')",
                    symbol, pos.symbol, target_base,
                )
                return pos

        return None

    @property
    def size(self) -> int:
        """Number of tracked accounts."""
        return len(self._entries)

    def has(self, sub_account_id: str) -> bool:
        return sub_account_id in self._entries

    # ── Mutations ──

    def load(self, by_account: Dict[str, dict]) -> None:
        """
        Bulk-load positions grouped by account.
        by_account: {sub_account_id: {account: dict, positions: [dict], rules: dict|None}}
        """
        for sub_id, data in by_account.items():
            pos_map = {}
            for p in data.get("positions", []):
                vp = VirtualPos(
                    id=p["id"], sub_account_id=sub_id,
                    symbol=p["symbol"], side=p["side"],
                    entry_price=p["entryPrice"], quantity=p["quantity"],
                    notional=p["notional"], leverage=int(p["leverage"]),
                    margin=p["margin"], liquidation_price=p.get("liquidationPrice", 0),
                    opened_at=p.get("openedAt"),
                )
                pos_map[p["id"]] = vp
                self._add_symbol_index(p["symbol"], sub_id)

            self._entries[sub_id] = {
                "account": data.get("account", {}),
                "positions": pos_map,
                "rules": data.get("rules"),
            }

    def add(self, position: VirtualPos, account: dict) -> None:
        """Add a single position. Creates account entry if needed."""
        sub_id = position.sub_account_id
        entry = self._entries.get(sub_id)
        if not entry:
            entry = {"account": account, "positions": {}, "rules": None}
            self._entries[sub_id] = entry

        entry["positions"][position.id] = position
        entry["account"]["currentBalance"] = account.get("currentBalance", entry["account"].get("currentBalance", 0))
        self._add_symbol_index(position.symbol, sub_id)

    def remove(self, position_id: str, sub_account_id: str) -> Optional[VirtualPos]:
        """Remove a position. Cleans up reverse index. Returns the removed position."""
        entry = self._entries.get(sub_account_id)
        if not entry:
            return None

        pos = entry["positions"].pop(position_id, None)
        if not pos:
            return None

        # Clean up symbol index if no more positions for this symbol
        still_has = any(p.symbol == pos.symbol for p in entry["positions"].values())
        if not still_has:
            acct_set = self._symbol_accounts.get(pos.symbol)
            if acct_set:
                acct_set.discard(sub_account_id)
                if not acct_set:
                    del self._symbol_accounts[pos.symbol]

        # Keep account entry even when empty — balance/rules must persist
        # (Previously deleted here, causing get_account_snapshot to return $0)

        return pos

    def update_balance(self, sub_account_id: str, new_balance: float) -> None:
        """Update an account's cached balance."""
        entry = self._entries.get(sub_account_id)
        if entry:
            entry["account"]["currentBalance"] = new_balance

    def update_position(self, position_id: str, sub_account_id: str, **updates) -> None:
        """Patch specific fields on a position."""
        entry = self._entries.get(sub_account_id)
        if not entry:
            return
        pos = entry["positions"].get(position_id)
        if not pos:
            return
        for k, v in updates.items():
            if hasattr(pos, k):
                setattr(pos, k, v)

    def update_account_status(self, sub_account_id: str, status: str) -> None:
        """Update account status (e.g. after liquidation)."""
        entry = self._entries.get(sub_account_id)
        if entry:
            entry["account"]["status"] = status

    def get_account(self, sub_account_id: str) -> dict:
        """Get cached account metadata."""
        entry = self._entries.get(sub_account_id)
        return entry["account"] if entry else {}

    # ── Private ──

    def _add_symbol_index(self, symbol: str, sub_account_id: str) -> None:
        if symbol not in self._symbol_accounts:
            self._symbol_accounts[symbol] = set()
        self._symbol_accounts[symbol].add(sub_account_id)

    def __repr__(self) -> str:
        total_positions = sum(len(e["positions"]) for e in self._entries.values())
        return f"PositionBook(accounts={self.size}, positions={total_positions}, symbols={len(self._symbol_accounts)})"
