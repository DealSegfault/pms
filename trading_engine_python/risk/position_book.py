"""
PositionBook — In-memory position tracking with net-position invariants.

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

from contracts.common import normalize_symbol, ts_external_to_s

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
    
    Indexed:
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

    def find_symbol_position(self, sub_account_id: str, symbol: str) -> Optional[VirtualPos]:
        """Find the single open position for a symbol.

        One-way mode invariant: at most one open position per sub-account + symbol.
        If duplicates are present, fail fast so the engine does not keep running
        on an ambiguous risk model.
        """
        entry = self._entries.get(sub_account_id)
        if not entry:
            return None

        matches = [
            pos for pos in entry["positions"].values()
            if self._extract_base(pos.symbol).upper() == self._extract_base(symbol).upper()
        ]
        if not matches:
            return None
        if len(matches) > 1:
            raise RuntimeError(
                f"One-way invariant violated for {sub_account_id}:{symbol}: "
                f"{len(matches)} open positions"
            )
        return matches[0]

    def find_position(self, sub_account_id: str, symbol: str, side: str) -> Optional[VirtualPos]:
        """Find an open position matching sub-account + symbol + side."""
        pos = self.find_symbol_position(sub_account_id, symbol)
        if not pos:
            return None
        if pos.side != side:
            return None
        if pos.symbol != symbol and self._extract_base(pos.symbol).upper() == self._extract_base(symbol).upper():
            logger.warning(
                "find_position: symbol format mismatch — searched '%s' matched '%s' (base='%s')",
                symbol, pos.symbol, self._extract_base(symbol).upper(),
            )
        return pos

    @property
    def size(self) -> int:
        """Number of tracked accounts."""
        return len(self._entries)

    def has(self, sub_account_id: str) -> bool:
        return sub_account_id in self._entries

    # ── Mutations ──

    def load(self, by_account: Dict[str, dict]) -> List[str]:
        """
        Bulk-load positions grouped by account.
        by_account: {sub_account_id: {account: dict, positions: [dict], rules: dict|None}}
        Returns list of stale position IDs that were skipped (duplicates).
        """
        all_stale_ids: List[str] = []
        for sub_id, data in by_account.items():
            pos_map = {}
            # Track seen base symbols → best position dict so far
            seen_symbols: Dict[str, dict] = {}

            for p in data.get("positions", []):
                symbol_key = self._extract_base(p["symbol"]).upper()
                if symbol_key in seen_symbols:
                    # Duplicate base symbol — keep the one with the larger notional
                    prev = seen_symbols[symbol_key]
                    if p["notional"] >= prev["notional"]:
                        # Current position wins, demote the previous one
                        stale_id = prev["id"]
                        seen_symbols[symbol_key] = p
                    else:
                        # Previous position wins, skip the current one
                        stale_id = p["id"]
                    all_stale_ids.append(stale_id)
                    logger.error(
                        "One-way invariant violated while loading %s:%s — "
                        "duplicate base '%s' detected. Skipping stale position %s "
                        "(will auto-close in DB)",
                        sub_id, p["symbol"], symbol_key, stale_id,
                    )
                    continue
                seen_symbols[symbol_key] = p

            # Build VirtualPos map from the winning positions only
            for p in seen_symbols.values():
                vp = VirtualPos(
                    id=p["id"], sub_account_id=sub_id,
                    symbol=normalize_symbol(p["symbol"]) if p.get("symbol") else "", side=p["side"],
                    entry_price=p["entryPrice"], quantity=p["quantity"],
                    notional=p["notional"], leverage=int(p["leverage"]),
                    margin=p["margin"], liquidation_price=p.get("liquidationPrice", 0),
                    opened_at=ts_external_to_s(p.get("openedAt")),
                )
                pos_map[p["id"]] = vp
                self._add_symbol_index(p["symbol"], sub_id)

            self._entries[sub_id] = {
                "account": data.get("account", {}),
                "positions": pos_map,
                "rules": data.get("rules"),
            }
        return all_stale_ids

    def add(self, position: VirtualPos, account: dict) -> None:
        """Add a single position. Creates account entry if needed."""
        sub_id = position.sub_account_id
        entry = self._entries.get(sub_id)
        if not entry:
            entry = {"account": account, "positions": {}, "rules": None}
            self._entries[sub_id] = entry

        existing = self.find_symbol_position(sub_id, position.symbol)
        if existing and existing.id != position.id:
            raise RuntimeError(
                f"One-way invariant violated while adding {sub_id}:{position.symbol}: "
                f"{existing.id} already open"
            )

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

    @staticmethod
    def _extract_base(symbol: str) -> str:
        if '/' in symbol:
            return symbol.split('/')[0]
        for suffix in ("USDT", "BUSD", "USDC", "BTC", "ETH", "BNB"):
            if symbol.endswith(suffix) and len(symbol) > len(suffix):
                return symbol[:-len(suffix)]
        return symbol

    def __repr__(self) -> str:
        total_positions = sum(len(e["positions"]) for e in self._entries.values())
        return f"PositionBook(accounts={self.size}, positions={total_positions}, symbols={len(self._symbol_accounts)})"
