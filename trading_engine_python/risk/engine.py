"""
RiskEngine — Facade composing PositionBook + Validator + Liquidation.

Called by:
    - OrderManager.on_order_fill() → opens/closes virtual positions
    - MarketDataService callbacks → price ticks trigger margin evaluation
    - UserStreamService → ACCOUNT_UPDATE for reconciliation
    - CommandHandler → pre-trade validation via validate_order()

This is the beating heart of the risk system.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import json
import logging
import math
import time
import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from .math import (
    compute_pnl,
    compute_margin,
    compute_liquidation_price,
    create_trade_signature,
    create_open_trade_signature,
)
from .position_book import PositionBook, VirtualPos
from .validator import TradeValidator
from .liquidation import LiquidationEngine

logger = logging.getLogger(__name__)
RECENT_FILL_TTL_SEC = 10.0


def _db_timestamp_to_seconds(value: Any) -> Optional[float]:
    """Normalize SQLite/PostgreSQL timestamp values to epoch seconds."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, (int, float)):
        return float(value) / 1000.0 if value > 10_000_000_000 else float(value)
    if isinstance(value, str):
        if value.isdigit():
            numeric = float(value)
            return numeric / 1000.0 if numeric > 10_000_000_000 else numeric
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


class RiskEngine:
    """
    Facade composing PositionBook + PriceService + Validator + Liquidation.

    Startup flow:
        1. Load all OPEN positions from DB into PositionBook
        2. Load risk rules per account
        3. Subscribe to MarketDataService for L1 on active symbols
        4. Start periodic cleanup/snapshot tasks

    Runtime flow:
        - on_order_fill() → create/close/flip virtual positions
        - on_price_tick() → update mark prices, evaluate margin, trigger liquidation
        - validate_order() → pre-trade 7-check validation
        - get_account_snapshot() → event-carried account state
    """

    def __init__(
        self,
        position_book: PositionBook,
        market_data: Any,
        exchange_client: Any,
        redis_client: Any = None,
        db: Any = None,
    ):
        self._book = position_book
        self._market_data = market_data
        self._exchange = exchange_client
        self._redis = redis_client
        self._db = db  # Database instance (aiosqlite wrapper)

        self._validator = TradeValidator(position_book, market_data, db)
        self._liquidation = LiquidationEngine(position_book)

        # Track last risk snapshot write time per account (throttle)
        self._last_snapshot_ts: Dict[str, float] = {}
        # Guard against concurrent liquidation tasks per account (#13)
        self._liquidating: set = set()
        # Server-scoped sub-account IDs (None = all, set = only these)
        self._managed_accounts: Optional[set] = None
        # Track which sub-account had recent PMS activity per symbol.
        # Used by on_account_update so manual exchange activity does not mutate
        # virtual positions unless there is evidence the update belongs to PMS.
        self._recent_fill_accounts: Dict[str, tuple[str, float]] = {}  # "BTCUSDT" → (sub_id, ts)

    def set_managed_accounts(self, sub_ids: set) -> None:
        """Set the sub-account IDs this server manages.

        When set, on_account_update will only reconcile positions
        for these sub-accounts, preventing cross-server pollution.
        """
        self._managed_accounts = sub_ids
        logger.info("RiskEngine: managing %d sub-accounts", len(sub_ids))

    def set_order_manager(self, om: Any) -> None:
        """Wire up OrderManager for liquidation execution."""
        self._om = om
        self._liquidation.set_order_manager(om)

    def _remember_recent_fill_account(self, symbol: str, sub_id: str) -> None:
        """Record recent PMS ownership evidence for ACCOUNT_UPDATE routing."""
        self._recent_fill_accounts[self._symbol_key(symbol)] = (sub_id, time.time())

    def _get_recent_fill_hint(self, symbol: str) -> Optional[str]:
        """Return a fresh PMS ownership hint for the symbol, if any."""
        symbol_key = self._symbol_key(symbol)
        hint = self._recent_fill_accounts.get(symbol_key)
        if not hint:
            return None
        sub_id, ts = hint
        if time.time() - ts > RECENT_FILL_TTL_SEC:
            self._recent_fill_accounts.pop(symbol_key, None)
            return None
        return sub_id

    def _get_active_order_accounts(self, symbol: str) -> set[str]:
        """Return managed sub-accounts with live PMS orders on the symbol."""
        om = getattr(self, "_om", None)
        if not om:
            return set()
        try:
            orders = om.get_active_orders(symbol=symbol)
        except Exception:
            try:
                orders = om.get_active_orders()
            except Exception:
                return set()

        accounts = set()
        target_key = self._symbol_key(symbol)
        for order in orders:
            sub_id = getattr(order, "sub_account_id", "")
            if not sub_id:
                continue
            if self._managed_accounts is not None and sub_id not in self._managed_accounts:
                continue
            order_symbol = getattr(order, "symbol", "")
            if order_symbol and self._symbol_key(order_symbol) != target_key:
                continue
            accounts.add(sub_id)
        return accounts

    def _get_managed_symbol_positions(self, symbol: str) -> list[VirtualPos]:
        """Return all managed virtual positions for a symbol across sub-accounts."""
        positions: list[VirtualPos] = []
        for sub_id in list(self._book._entries.keys()):
            if self._managed_accounts is not None and sub_id not in self._managed_accounts:
                continue
            pos = self._book.find_symbol_position(sub_id, symbol)
            if pos:
                positions.append(pos)
        return positions

    async def ensure_position_from_snapshot(
        self,
        sub_account_id: str,
        position_id: Optional[str] = None,
        symbol: Optional[str] = None,
    ) -> Optional[VirtualPos]:
        """Rehydrate a live position from the Redis risk snapshot if the book missed it."""
        if position_id:
            existing = self._book.get_position(sub_account_id, position_id)
            if existing:
                return existing
        if symbol:
            existing = self._book.find_symbol_position(sub_account_id, symbol)
            if existing:
                return existing
        if not self._redis:
            return None

        try:
            raw = await self._redis.get(f"pms:risk:{sub_account_id}")
        except Exception as e:
            logger.error("Failed to load risk snapshot for %s: %s", sub_account_id[:8], e)
            return None
        if not raw:
            return None

        try:
            snapshot = json.loads(raw)
        except Exception as e:
            logger.error("Invalid risk snapshot for %s: %s", sub_account_id[:8], e)
            return None

        positions = snapshot.get("positions") or []
        target = None
        for pos in positions:
            if position_id and (pos.get("id") == position_id or pos.get("positionId") == position_id):
                target = pos
                break
            if symbol and self._symbol_key(pos.get("symbol", "")) == self._symbol_key(symbol):
                target = pos
                break
        if not target:
            return None

        account = self._book.get_account(sub_account_id) or {
            "id": sub_account_id,
            "currentBalance": float(snapshot.get("balance", 0) or 0),
            "maintenanceRate": 0.005,
            "status": "ACTIVE",
        }
        pos_id = target.get("id") or target.get("positionId")
        if not pos_id:
            return None

        hydrated = VirtualPos(
            id=pos_id,
            sub_account_id=sub_account_id,
            symbol=target.get("symbol", symbol or ""),
            side=target.get("side", ""),
            entry_price=float(target.get("entryPrice", 0) or 0),
            quantity=float(target.get("quantity", 0) or 0),
            notional=float(target.get("notional", 0) or 0),
            leverage=int(target.get("leverage", 1) or 1),
            margin=float(target.get("margin", 0) or 0),
            liquidation_price=float(target.get("liquidationPrice", 0) or 0),
            opened_at=target.get("openedAt"),
            mark_price=float(target.get("markPrice", 0) or 0),
            unrealized_pnl=float(target.get("unrealizedPnl", 0) or 0),
        )

        try:
            self._book.add(hydrated, account)
        except RuntimeError:
            return self._book.get_position(sub_account_id, pos_id) or (
                self._book.find_symbol_position(sub_account_id, hydrated.symbol)
            )

        logger.warning(
            "Hydrated missing live position from risk snapshot: %s %s %s qty=%.6f",
            sub_account_id[:8],
            hydrated.symbol,
            hydrated.side,
            hydrated.quantity,
        )
        return hydrated

    @staticmethod
    def _symbol_key(symbol: str) -> str:
        return PositionBook._extract_base(symbol).upper()

    def _get_reference_price(
        self,
        symbol: str,
        exchange_entry_price: float,
        positions: list[VirtualPos],
    ) -> float:
        """Pick a common symbol price to compare actual backing vs virtual exposure."""
        mid = self._market_data.get_mid_price(symbol) if self._market_data else None
        if mid and mid > 0:
            return mid
        if self._market_data:
            for pos in positions:
                mid = self._market_data.get_mid_price(pos.symbol)
                if mid and mid > 0:
                    return mid
        if exchange_entry_price and exchange_entry_price > 0:
            return exchange_entry_price
        for pos in positions:
            if pos.mark_price and pos.mark_price > 0:
                return pos.mark_price
        for pos in positions:
            if pos.entry_price and pos.entry_price > 0:
                return pos.entry_price
        return 0.0

    def _get_symbol_min_notional(self, symbol: str) -> float:
        """Resolve the minimum deleverage step for a symbol."""
        om = getattr(self, "_om", None)
        symbol_info = getattr(om, "_symbol_info", None) if om else None
        if symbol_info:
            try:
                return max(5.0, float(symbol_info.get_min_notional(symbol)))
            except Exception:
                pass
        return 5.0

    @staticmethod
    def _build_virtual_adl_order(pos: VirtualPos, close_qty: float, fill_price: float) -> Any:
        """Synthetic order used to persist/admin-log virtual-only exchange ADL."""
        side = "SELL" if pos.side == "LONG" else "BUY"
        ts = int(time.time() * 1000)
        return SimpleNamespace(
            sub_account_id=pos.sub_account_id,
            symbol=pos.symbol,
            side=side,
            order_type="MARKET",
            filled_qty=close_qty,
            avg_fill_price=fill_price,
            exchange_order_id="",
            client_order_id=f"SYSADL_{pos.sub_account_id[:8]}_{ts}",
            origin="EXCHANGE_ADL",
            reduce_only=True,
            leverage=pos.leverage,
        )

    @staticmethod
    def _position_event_meta(order: Any) -> dict:
        """Optional metadata carried on position WS events."""
        origin = getattr(order, "origin", "")
        reason = getattr(order, "reason", "")
        payload = {}
        if origin:
            payload["originType"] = origin
        if reason:
            payload["reason"] = reason
        return payload

    def _plan_proportional_adl(
        self,
        positions: list[VirtualPos],
        target_notional: float,
        reference_price: float,
        increment: float,
    ) -> dict[str, float]:
        """Allocate a symbol-level deleverage target across positions proportionally."""
        if target_notional <= 0 or reference_price <= 0 or increment <= 0:
            return {}

        capacities = {
            pos.id: max(0.0, pos.quantity * reference_price)
            for pos in positions
        }
        total_capacity = sum(capacities.values())
        if total_capacity <= 0:
            return {}

        rounded_target = min(total_capacity, math.ceil(target_notional / increment) * increment)
        raw_shares = {
            pos.id: rounded_target * capacities[pos.id] / total_capacity
            for pos in positions
        }
        allocations = {
            pos.id: min(
                capacities[pos.id],
                math.floor(raw_shares[pos.id] / increment) * increment if capacities[pos.id] >= increment else 0.0,
            )
            for pos in positions
        }
        allocated = sum(allocations.values())
        remaining = max(0.0, rounded_target - allocated)

        while remaining >= increment - 1e-9:
            candidates = [
                pos for pos in positions
                if capacities[pos.id] - allocations[pos.id] >= increment - 1e-9
            ]
            if not candidates:
                break
            candidates.sort(
                key=lambda pos: (
                    raw_shares[pos.id] - allocations[pos.id],
                    capacities[pos.id] - allocations[pos.id],
                    capacities[pos.id],
                ),
                reverse=True,
            )
            chosen = candidates[0]
            allocations[chosen.id] += increment
            remaining = max(0.0, rounded_target - sum(allocations.values()))

        if remaining > 1e-9:
            candidates = [
                pos for pos in positions
                if capacities[pos.id] - allocations[pos.id] > 1e-9
            ]
            if candidates:
                candidates.sort(
                    key=lambda pos: (
                        capacities[pos.id] - allocations[pos.id],
                        capacities[pos.id],
                    ),
                    reverse=True,
                )
                chosen = candidates[0]
                free = capacities[chosen.id] - allocations[chosen.id]
                step = increment if free >= increment - 1e-9 else free
                allocations[chosen.id] = min(capacities[chosen.id], allocations[chosen.id] + step)

        return {
            pos_id: notional
            for pos_id, notional in allocations.items()
            if notional > 1e-9
        }

    async def _apply_virtual_exchange_adl(
        self,
        pos: VirtualPos,
        close_qty: float,
        fill_price: float,
        reason: str,
    ) -> None:
        """Virtually reduce a position because exchange backing disappeared externally."""
        close_qty = min(max(close_qty, 0.0), pos.quantity)
        if close_qty <= 1e-12:
            return

        logger.warning(
            "EXTERNAL BACKING ADL: %s %s %s qty=%.6f reason=%s",
            pos.sub_account_id[:8],
            pos.symbol,
            pos.side,
            close_qty,
            reason,
        )
        order = self._build_virtual_adl_order(pos, close_qty, fill_price)
        order.reason = reason
        await self._close_position(
            pos,
            fill_price,
            close_qty,
            order,
        )

    async def _apply_external_backing_guard(
        self,
        symbol: str,
        exchange_qty: float,
        entry_price: float,
    ) -> bool:
        """Deleverage virtual positions only when exchange backing falls below them."""
        positions = self._get_managed_symbol_positions(symbol)
        if not positions:
            return False

        reference_price = self._get_reference_price(symbol, entry_price, positions)
        if reference_price <= 0:
            logger.debug("Skipping external backing guard for %s: no reference price", symbol)
            return False

        actual_side = None
        if exchange_qty > 0:
            actual_side = "LONG"
        elif exchange_qty < 0:
            actual_side = "SHORT"

        unsupported = [pos for pos in positions if actual_side is None or pos.side != actual_side]
        for pos in sorted(unsupported, key=lambda p: p.quantity * reference_price, reverse=True):
            await self._apply_virtual_exchange_adl(
                pos,
                pos.quantity,
                reference_price,
                reason="UNBACKED_SIDE",
            )

        if actual_side is None:
            return bool(unsupported)

        supported = [
            pos for pos in self._get_managed_symbol_positions(symbol)
            if pos.side == actual_side
        ]
        if not supported:
            return bool(unsupported)

        actual_abs_qty = abs(exchange_qty)
        total_supported_qty = sum(pos.quantity for pos in supported)
        if actual_abs_qty >= total_supported_qty - 1e-12:
            return bool(unsupported)

        shortage_qty = total_supported_qty - actual_abs_qty
        shortage_notional = shortage_qty * reference_price
        increment = self._get_symbol_min_notional(symbol)
        plan = self._plan_proportional_adl(supported, shortage_notional, reference_price, increment)

        if not plan:
            return bool(unsupported)

        for pos in sorted(supported, key=lambda p: p.quantity * reference_price, reverse=True):
            close_notional = plan.get(pos.id, 0.0)
            if close_notional <= 1e-9:
                continue
            close_qty = min(pos.quantity, close_notional / reference_price)
            await self._apply_virtual_exchange_adl(
                pos,
                close_qty,
                reference_price,
                reason="BACKING_SHORTAGE",
            )

        return True

    async def reconcile_exchange_snapshot(self, positions: list[dict]) -> dict:
        """Apply the external backing guard from a full exchange snapshot."""
        snapshot = {
            self._symbol_key(p.get("symbol", "")): p
            for p in positions
            if p.get("symbol", "")
        }
        symbols = set(snapshot.keys())
        for sub_id in list(self._book._entries.keys()):
            if self._managed_accounts is not None and sub_id not in self._managed_accounts:
                continue
            for pos in self._book.get_by_sub_account(sub_id):
                symbols.add(self._symbol_key(pos.symbol))

        adjusted = 0
        for symbol_key in symbols:
            pos_data = snapshot.get(symbol_key, {})
            managed_positions = self._get_managed_symbol_positions(pos_data.get("symbol", symbol_key))
            symbol = managed_positions[0].symbol if managed_positions else pos_data.get("symbol", symbol_key)
            changed = await self._apply_external_backing_guard(
                symbol=symbol,
                exchange_qty=float(pos_data.get("position_amount", 0) or 0),
                entry_price=float(pos_data.get("entry_price", 0) or 0),
            )
            if changed:
                adjusted += 1
        return {"adjusted_symbols": adjusted}

    @property
    def position_book(self) -> PositionBook:
        return self._book

    async def _publish_event(self, event_type: str, payload: dict) -> None:
        """Publish a position/margin event to Redis PUB/SUB for WS forwarding."""
        from contracts.common import RedisKey
        if not self._redis:
            return
        try:
            await self._redis.publish(RedisKey.event_channel(event_type), json.dumps(payload))
        except Exception as e:
            logger.error("Failed to publish %s: %s", event_type, e)

    # ── Startup ──

    async def load_positions(self) -> int:
        """Load all OPEN positions from DB into PositionBook on startup."""
        if not self._db:
            logger.warning("No DB — skipping position load")
            return 0

        count = 0
        by_account = {}

        # Load all active sub-accounts
        accounts = await self._db.fetch_all(
            "SELECT * FROM sub_accounts WHERE status = ?", ("ACTIVE",)
        )

        for acct in accounts:
            acct_id = acct["id"]

            # Load open positions
            positions = await self._db.fetch_all(
                "SELECT * FROM virtual_positions WHERE sub_account_id = ? AND status = ?",
                (acct_id, "OPEN"),
            )

            # Load risk rules
            rule = await self._db.fetch_one(
                "SELECT * FROM risk_rules WHERE sub_account_id = ?",
                (acct_id,),
            )

            by_account[acct_id] = {
                "account": {
                    "id": acct_id,
                    "name": acct["name"],
                    "currentBalance": acct["current_balance"],
                    "maintenanceRate": acct.get("maintenance_rate", 0.005),
                    "liquidationMode": acct.get("liquidation_mode", "ADL_30"),
                    "status": acct["status"],
                },
                "positions": [
                    {
                        "id": p["id"],
                        "symbol": p["symbol"],
                        "side": p["side"],
                        "entryPrice": p["entry_price"],
                        "quantity": p["quantity"],
                        "notional": p["notional"],
                        "leverage": int(p["leverage"]),
                        "margin": p["margin"],
                        "liquidationPrice": p["liquidation_price"],
                        "openedAt": _db_timestamp_to_seconds(p.get("opened_at")),
                    }
                    for p in positions
                ],
                "rules": {
                    "max_leverage": rule["max_leverage"] if rule else 100,
                    "max_notional_per_trade": rule["max_notional_per_trade"] if rule else 200,
                    "max_total_exposure": rule["max_total_exposure"] if rule else 500,
                    "liquidation_threshold": rule["liquidation_threshold"] if rule else 0.90,
                },
            }
            count += len(positions)

        self._book.load(by_account)
        logger.info("Loaded %d positions across %d accounts into PositionBook", count, len(by_account))
        return count

    # ── Order Fill Handler ──

    async def on_order_fill(self, order: Any) -> None:
        """
        Called by OrderManager when a market/limit order fills.

        Determines if this is opening, closing, or flipping a position,
        then updates DB and PositionBook accordingly.
        """
        sub_id = order.sub_account_id
        symbol = order.symbol
        fill_side = order.side  # BUY or SELL
        fill_qty = order.filled_qty
        fill_price = order.avg_fill_price

        if fill_qty <= 0 or fill_price <= 0:
            return

        # Determine resulting direction from order side.
        incoming_side = "LONG" if fill_side == "BUY" else "SHORT"

        # Track which sub-account had this fill (for on_account_update hints)
        self._remember_recent_fill_account(symbol, sub_id)

        existing = self._book.find_symbol_position(sub_id, symbol)

        if not existing:
            if getattr(order, "reduce_only", False):
                logger.warning(
                    "ReduceOnly fill with no matching open position for %s — ignoring (prevents flip)",
                    symbol,
                )
                return
            await self._open_position(sub_id, symbol, incoming_side, fill_price, fill_qty, order)
            return

        if existing.side == incoming_side:
            await self._add_to_position(existing, fill_price, fill_qty, order)
            return

        close_qty = min(fill_qty, existing.quantity)
        await self._close_position(existing, fill_price, close_qty, order)

        remainder = fill_qty - close_qty
        if remainder <= 1e-12:
            return

        if getattr(order, "reduce_only", False):
            logger.warning(
                "ReduceOnly fill exceeded tracked position on %s by %.8f — not opening reverse side",
                symbol, remainder,
            )
            return

        await self._open_position(sub_id, symbol, incoming_side, fill_price, remainder, order)

    async def _open_position(
        self, sub_id: str, symbol: str, side: str, price: float, qty: float, order: Any
    ) -> None:
        """Create a new virtual position."""
        leverage = order.leverage or 1
        notional = qty * price
        margin = compute_margin(notional, leverage)
        liq_price = compute_liquidation_price(side, price, qty, margin)

        pos_id = str(uuid.uuid4())
        pos = VirtualPos(
            id=pos_id, sub_account_id=sub_id,
            symbol=symbol, side=side,
            entry_price=price, quantity=qty,
            notional=notional, leverage=leverage,
            margin=margin, liquidation_price=liq_price,
            opened_at=time.time(), mark_price=price,
        )

        account = self._book.get_account(sub_id)
        self._book.add(pos, account)

        # DB write
        if self._db:
            await self._persist_open_position(pos, order)

        # Subscribe to L1 for new symbol if not already subscribed (#14)
        if self._market_data and not self._book.get_accounts_for_symbol(symbol) - {sub_id}:
            # First position for this symbol — start receiving price ticks
            self._market_data.subscribe(symbol, self.on_price_tick)
            logger.info("Subscribed RiskEngine to L1 for new symbol %s", symbol)

        # Publish position_updated + margin_update to frontend
        await self._publish_event("position_updated", {
            "subAccountId": sub_id,
            "positionId": pos_id,
            "symbol": symbol,
            "side": side,
            "entryPrice": price,
            "quantity": qty,
            "notional": notional,
            "margin": margin,
            "leverage": leverage,
            "liquidationPrice": liq_price,
        })
        snapshot = self.get_account_snapshot(sub_id)
        await self._publish_event("margin_update", {
            "subAccountId": sub_id,
            "update": snapshot,
            **snapshot,
        })
        await self._refresh_account_snapshot(sub_id, snapshot)

        logger.info("Opened position: %s %s %s qty=%.6f @ %.2f margin=%.2f", pos_id[:8], symbol, side, qty, price, margin)

    async def _close_position(
        self, existing: VirtualPos, fill_price: float, fill_qty: float, order: Any
    ) -> None:
        """Close (fully or partially) an existing position."""
        pnl = compute_pnl(existing.side, existing.entry_price, fill_price, min(fill_qty, existing.quantity))

        if fill_qty >= existing.quantity:
            # Full close
            self._book.remove(existing.id, existing.sub_account_id)

            # Update balance
            account = self._book.get_account(existing.sub_account_id)
            new_balance = account.get("currentBalance", 0) + pnl
            self._book.update_balance(existing.sub_account_id, new_balance)

            if self._db:
                await self._persist_close_position(existing, fill_price, pnl, order)

            # Publish position_closed + margin_update to frontend
            await self._publish_event("position_closed", {
                "subAccountId": existing.sub_account_id,
                "positionId": existing.id,
                "symbol": existing.symbol,
                "side": existing.side,
                "realizedPnl": pnl,
                "closePrice": fill_price,
                **self._position_event_meta(order),
            })
            snapshot = self.get_account_snapshot(existing.sub_account_id)
            await self._publish_event("margin_update", {
                "subAccountId": existing.sub_account_id,
                "update": snapshot,
                **snapshot,
            })
            await self._refresh_account_snapshot(existing.sub_account_id, snapshot)

            logger.info("Closed position: %s PnL=%.4f", existing.id[:8], pnl)
        else:
            # Partial close
            remaining = existing.quantity - fill_qty
            old_notional = existing.notional
            new_notional = remaining * existing.entry_price
            new_margin = compute_margin(new_notional, existing.leverage)
            new_liq = compute_liquidation_price(existing.side, existing.entry_price, remaining, new_margin)

            self._book.update_position(
                existing.id, existing.sub_account_id,
                quantity=remaining, notional=new_notional, margin=new_margin,
                liquidation_price=new_liq,
            )

            # Credit partial PnL to balance
            account = self._book.get_account(existing.sub_account_id)
            new_balance = account.get("currentBalance", 0) + pnl
            self._book.update_balance(existing.sub_account_id, new_balance)

            # DB: persist partial close (#5)
            if self._db:
                await self._persist_partial_close(existing, remaining, new_notional, new_margin, new_liq, pnl, fill_price, fill_qty, order)

            # Publish position_reduced + margin_update to frontend
            await self._publish_event("position_reduced", {
                "subAccountId": existing.sub_account_id,
                "positionId": existing.id,
                "symbol": existing.symbol,
                "closedQty": fill_qty,
                "remainingQty": remaining,
                "realizedPnl": pnl,
                "liquidationPrice": new_liq,
                **self._position_event_meta(order),
            })
            snapshot = self.get_account_snapshot(existing.sub_account_id)
            await self._publish_event("margin_update", {
                "subAccountId": existing.sub_account_id,
                "update": snapshot,
                **snapshot,
            })
            await self._refresh_account_snapshot(existing.sub_account_id, snapshot)

            logger.info("Partial close: %s qty=%.6f→%.6f PnL=%.4f", existing.id[:8], existing.quantity, remaining, pnl)

    async def _add_to_position(
        self, existing: VirtualPos, fill_price: float, fill_qty: float, order: Any
    ) -> None:
        """Add to existing same-side position (average up/down)."""
        total_qty = existing.quantity + fill_qty
        # Weighted average entry price
        avg_entry = ((existing.entry_price * existing.quantity) + (fill_price * fill_qty)) / total_qty
        new_notional = total_qty * avg_entry
        new_margin = compute_margin(new_notional, existing.leverage)
        new_liq = compute_liquidation_price(existing.side, avg_entry, total_qty, new_margin)

        self._book.update_position(
            existing.id, existing.sub_account_id,
            entry_price=avg_entry, quantity=total_qty,
            notional=new_notional, margin=new_margin,
            liquidation_price=new_liq,
        )

        # DB: persist add-to-position (#5)
        if self._db:
            await self._persist_add_to_position(existing, avg_entry, total_qty, new_notional, new_margin, new_liq, fill_price, fill_qty, order)

        await self._publish_event("position_updated", {
            "subAccountId": existing.sub_account_id,
            "positionId": existing.id,
            "symbol": existing.symbol,
            "side": existing.side,
            "entryPrice": avg_entry,
            "quantity": total_qty,
            "notional": new_notional,
            "margin": new_margin,
            "leverage": existing.leverage,
            "liquidationPrice": new_liq,
            **self._position_event_meta(order),
        })
        snapshot = self.get_account_snapshot(existing.sub_account_id)
        await self._publish_event("margin_update", {
            "subAccountId": existing.sub_account_id,
            "update": snapshot,
            **snapshot,
        })
        await self._refresh_account_snapshot(existing.sub_account_id, snapshot)

        logger.info("Added to position: %s qty→%.6f entry→%.2f", existing.id[:8], total_qty, avg_entry)

    # ── Price Tick Handler ──

    async def on_price_tick(self, symbol: str, bid: float, ask: float, mid: float) -> None:
        """
        Called by MarketDataService on every L1 BBO change.

        1. Update mark_price on all positions for this symbol
        2. Recompute unrealized PnL
        3. Evaluate margin ratio per affected sub-account
        4. If margin breach → trigger liquidation
        """
        affected_accounts = self._book.get_accounts_for_symbol(symbol)
        if not affected_accounts:
            return

        for sub_id in list(affected_accounts):
            entry = self._book.get_entry(sub_id)
            if not entry:
                continue

            # Update all positions for this symbol
            for pos in entry["positions"].values():
                if pos.symbol == symbol:
                    pos.mark_price = mid
                    pos.unrealized_pnl = compute_pnl(pos.side, pos.entry_price, mid, pos.quantity)

            # Evaluate liquidation (with in-flight guard #13)
            result = self._liquidation.evaluate_account(
                sub_id,
                price_lookup=lambda s: self._market_data.get_mid_price(s) if self._market_data else None,
            )
            if result and sub_id not in self._liquidating:
                self._liquidating.add(sub_id)
                tier, ratio, positions = result
                asyncio.create_task(
                    self._guarded_liquidation(sub_id, tier, ratio, positions)
                )

        # Write risk snapshot (throttled)
        await self._write_risk_snapshot(symbol)

    # ── ACCOUNT_UPDATE Handler ──

    async def on_account_update(self, data: dict) -> None:
        """
        Called by UserStreamService on ACCOUNT_UPDATE.

        Binance sends this on EVERY fill with the authoritative exchange position
        data. We use it to reconcile virtual positions — if ORDER_TRADE_UPDATE fills
        were missed (WS glitch, race condition), this corrects the drift.

        IMPORTANT: Only reconciles positions for sub-accounts managed by THIS server,
        and only when there is recent PMS evidence (fresh PMS fill hint or active PMS
        order on the symbol). Manual exchange activity without PMS tagging must not
        mutate virtual positions.

        For each position in the update:
          - Exchange has position, we don't → log warning (can't auto-create, no sub-account info)
          - Both have position, quantities differ >1% → update PositionBook to match exchange
          - We have position, exchange shows 0 → force-close the ghost
        """
        positions = data.get("positions", [])
        if not positions:
            return

        for pos_data in positions:
            binance_symbol = pos_data.get("symbol", "")
            if not binance_symbol:
                continue

            exchange_qty = pos_data.get("position_amount", 0)  # signed: +long, -short
            entry_price = pos_data.get("entry_price", 0)
            exchange_side = "LONG" if exchange_qty > 0 else "SHORT"
            abs_qty = abs(exchange_qty)
            candidate_positions = self._get_managed_symbol_positions(binance_symbol)
            candidate_subs = [pos.sub_account_id for pos in candidate_positions]
            if not candidate_positions:
                if abs_qty > 0:
                    logger.debug(
                        "ACCOUNT_UPDATE: exchange has %s %s qty=%.6f but no matching virtual position",
                        binance_symbol, exchange_side, abs_qty,
                    )
                continue

            evidence_subs = self._get_active_order_accounts(binance_symbol).intersection(candidate_subs)
            hint_sub = self._get_recent_fill_hint(binance_symbol)
            if hint_sub in candidate_subs:
                evidence_subs.add(hint_sub)

            if not evidence_subs:
                await self._apply_external_backing_guard(
                    symbol=binance_symbol,
                    exchange_qty=exchange_qty,
                    entry_price=entry_price,
                )
                continue

            if hint_sub in evidence_subs:
                target_sub = hint_sub
            elif len(evidence_subs) == 1:
                target_sub = next(iter(evidence_subs))
            else:
                logger.warning(
                    "ACCOUNT_UPDATE direct reconcile skipped for %s qty=%.6f: ambiguous PMS evidence across sub-accounts %s",
                    binance_symbol,
                    abs_qty,
                    ", ".join(sorted(sub[:8] for sub in evidence_subs)),
                )
                await self._apply_external_backing_guard(
                    symbol=binance_symbol,
                    exchange_qty=exchange_qty,
                    entry_price=entry_price,
                )
                continue

            pos = self._book.find_symbol_position(target_sub, binance_symbol)
            if not pos:
                if abs_qty > 0:
                    logger.debug(
                        "ACCOUNT_UPDATE: PMS evidence resolved to %s for %s, but no virtual position exists",
                        target_sub[:8], binance_symbol,
                    )
                continue

            if abs_qty == 0:
                logger.warning(
                    "ACCOUNT_UPDATE RECONCILE: %s %s qty=%.6f is GONE on exchange — force closing",
                    pos.symbol, pos.side, pos.quantity,
                )
                await self.force_close_stale_position(pos)
                continue

            old_qty = pos.quantity
            old_side = pos.side
            side_changed = pos.side != exchange_side
            qty_diff_pct = abs(pos.quantity - abs_qty) / max(pos.quantity, abs_qty, 1e-10) * 100

            if side_changed or qty_diff_pct > 1.0:
                new_notional = abs_qty * (entry_price if entry_price > 0 else pos.entry_price)
                new_entry = entry_price if entry_price > 0 else pos.entry_price
                new_margin = compute_margin(new_notional, pos.leverage)
                new_liq = compute_liquidation_price(exchange_side, new_entry, abs_qty, new_margin)

                self._book.update_position(
                    pos.id, pos.sub_account_id,
                    side=exchange_side,
                    entry_price=new_entry, quantity=abs_qty,
                    notional=new_notional, margin=new_margin,
                    liquidation_price=new_liq,
                )

                if self._db:
                    try:
                        await self._db.execute(
                            """UPDATE virtual_positions
                               SET side=?, entry_price=?, quantity=?, notional=?, margin=?, liquidation_price=?
                               WHERE id=?""",
                            (exchange_side, new_entry, abs_qty, new_notional, new_margin, new_liq, pos.id),
                        )
                    except Exception as e:
                        logger.error("ACCOUNT_UPDATE DB update failed for %s: %s", pos.id[:8], e)

                await self._publish_event("position_updated", {
                    "subAccountId": pos.sub_account_id,
                    "positionId": pos.id,
                    "symbol": pos.symbol,
                    "side": exchange_side,
                    "entryPrice": new_entry,
                    "quantity": abs_qty,
                    "notional": new_notional,
                    "margin": new_margin,
                    "leverage": pos.leverage,
                    "liquidationPrice": new_liq,
                    "reconciled": True,
                })
                snapshot = self.get_account_snapshot(pos.sub_account_id)
                await self._publish_event("margin_update", {
                    "subAccountId": pos.sub_account_id,
                    "update": snapshot,
                    **snapshot,
                })
                await self._refresh_account_snapshot(pos.sub_account_id, snapshot)

                logger.warning(
                    "ACCOUNT_UPDATE RECONCILE: %s %s qty %.6f → %.6f side=%s (sub=%s, diff=%.1f%%)",
                    pos.symbol, old_side, old_qty, abs_qty, exchange_side, target_sub[:8], qty_diff_pct,
                )

    # ── Validation ──

    async def force_close_stale_position(self, pos) -> None:
        """
        Force-remove a virtual position that doesn't exist on exchange.
        Called when -2022 ReduceOnly is rejected (position already gone).
        """
        self._book.remove(pos.id, pos.sub_account_id)

        # DB: mark as closed
        if self._db:
            try:
                await self._db.execute(
                    "UPDATE virtual_positions SET status='CLOSED', closed_at=?, realized_pnl=0 WHERE id=?",
                    (int(time.time() * 1000), pos.id),
                )
            except Exception as e:
                logger.error("Failed to DB-close stale position %s: %s", pos.id[:8], e)

        # Publish position_closed + margin_update so frontend removes card
        await self._publish_event("position_closed", {
            "subAccountId": pos.sub_account_id,
            "positionId": pos.id,
            "symbol": pos.symbol,
            "side": pos.side,
            "realizedPnl": 0,
            "closePrice": pos.entry_price,
            "staleCleanup": True,
        })
        snapshot = self.get_account_snapshot(pos.sub_account_id)
        await self._publish_event("margin_update", {
            "subAccountId": pos.sub_account_id,
            "update": snapshot,
            **snapshot,
        })

        # Immediately refresh Redis risk snapshot so positions endpoint returns fresh data
        if self._redis:
            await self._refresh_account_snapshot(pos.sub_account_id, snapshot)

        logger.info("Force-closed stale position: %s %s", pos.id[:8], pos.symbol)

    async def validate_order(
        self, sub_account_id: str, symbol: str, side: str, quantity: float, leverage: int
    ) -> dict:
        """Pre-trade validation (7 checks). Delegated to TradeValidator."""
        return await self._validator.validate(sub_account_id, symbol, side, quantity, leverage)

    # ── Account Snapshot (event-carried state) ──

    def get_account_snapshot(self, sub_account_id: str) -> dict:
        """
        Current account state for event-carried state.
        Called by OrderManager._publish_event() to include in Redis events.

        Includes open limit orders from the in-memory OrderTracker so that
        the risk snapshot (and positions endpoint) shows pending scale/limit
        orders alongside positions.
        """
        positions = self._book.get_by_sub_account(sub_account_id)
        account = self._book.get_account(sub_account_id)
        balance = account.get("currentBalance", 0)

        margin_used = sum(p.margin for p in positions)
        unrealized_pnl = sum(p.unrealized_pnl for p in positions)
        equity = balance + unrealized_pnl

        # Include active limit orders from OrderManager tracker
        open_orders = []
        if hasattr(self, "_om") and self._om:
            try:
                active = self._om.get_active_orders(sub_account_id=sub_account_id)
                open_orders = [
                    {
                        "clientOrderId": o.client_order_id,
                        "exchangeOrderId": o.exchange_order_id,
                        "symbol": o.symbol,
                        "side": o.side,
                        "orderType": o.order_type,
                        "price": o.price,
                        "quantity": o.quantity,
                        "filledQty": o.filled_qty,
                        "origin": o.origin,
                        "leverage": o.leverage,
                        "reduceOnly": o.reduce_only,
                        "state": o.state,
                        "createdAt": o.created_at,
                    }
                    for o in active
                    if o.order_type == "LIMIT"
                ]
            except Exception as e:
                logger.debug("Failed to get open orders for snapshot: %s", e)

        return {
            "balance": balance,
            "equity": equity,
            "marginUsed": margin_used,
            "availableMargin": max(0, equity - margin_used),
            "positions": [
                {
                    "id": p.id,
                    "symbol": p.symbol,
                    "side": p.side,
                    "entryPrice": p.entry_price,
                    "quantity": p.quantity,
                    "notional": p.notional,
                    "margin": p.margin,
                    "leverage": p.leverage,
                    "liquidationPrice": p.liquidation_price,
                    "unrealizedPnl": p.unrealized_pnl,
                    "pnlPercent": (p.unrealized_pnl / p.margin * 100) if p.margin else 0,
                    "markPrice": p.mark_price,
                    "openedAt": p.opened_at,
                }
                for p in positions
            ],
            "openOrders": open_orders,
        }

    # ── Redis Snapshots ──

    async def _write_risk_snapshot(self, symbol: str) -> None:
        """Write risk snapshot to Redis for affected accounts (throttled 1s)."""
        if not self._redis:
            return

        now = time.time()
        affected = self._book.get_accounts_for_symbol(symbol)
        for sub_id in affected:
            if now - self._last_snapshot_ts.get(sub_id, 0) < 1.0:
                continue
            self._last_snapshot_ts[sub_id] = now

            snapshot = self.get_account_snapshot(sub_id)
            key = f"pms:risk:{sub_id}"
            try:
                await self._redis.set(key, json.dumps(snapshot), ex=60)
            except Exception as e:
                logger.error("Failed to write risk snapshot for %s: %s", sub_id, e)

    async def _refresh_account_snapshot(
        self,
        sub_account_id: str,
        snapshot: Optional[dict] = None,
    ) -> None:
        """Immediately refresh one account snapshot after a position mutation."""
        if not self._redis:
            return

        payload = snapshot or self.get_account_snapshot(sub_account_id)
        try:
            await self._redis.set(f"pms:risk:{sub_account_id}", json.dumps(payload), ex=60)
            self._last_snapshot_ts[sub_account_id] = time.time()
        except Exception as e:
            logger.error("Failed to refresh risk snapshot for %s: %s", sub_account_id, e)

    async def write_all_risk_snapshots(self) -> None:
        """Publish fresh risk snapshots for all managed accounts."""
        if not self._redis:
            return

        for sub_id in list(self._book._entries.keys()):
            if self._managed_accounts is not None and sub_id not in self._managed_accounts:
                continue
            snapshot = self.get_account_snapshot(sub_id)
            try:
                await self._redis.set(f"pms:risk:{sub_id}", json.dumps(snapshot), ex=60)
                self._last_snapshot_ts[sub_id] = time.time()
            except Exception as e:
                logger.error("Failed to write startup risk snapshot for %s: %s", sub_id, e)

    # ── DB Persistence Helpers (raw SQL via aiosqlite) ──

    async def _persist_open_position(self, pos: VirtualPos, order: Any) -> None:
        """Write new position and trade execution to DB."""
        if not self._db:
            return

        try:
            now_ms = int(time.time() * 1000)
            sig = create_open_trade_signature(pos.sub_account_id, pos.symbol, pos.side, pos.quantity)

            await self._db.execute(
                """INSERT INTO virtual_positions
                   (id, sub_account_id, symbol, side, entry_price, quantity, notional,
                    leverage, margin, liquidation_price, status, opened_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)""",
                (pos.id, pos.sub_account_id, pos.symbol, pos.side,
                 pos.entry_price, pos.quantity, pos.notional,
                 float(pos.leverage), pos.margin, pos.liquidation_price, now_ms),
            )

            trade_id = str(uuid.uuid4())
            side = "BUY" if pos.side == "LONG" else "SELL"
            await self._db.execute(
                """INSERT INTO trade_executions
                   (id, sub_account_id, position_id, exchange_order_id, client_order_id,
                    symbol, side, type, price, quantity, notional, fee, action,
                    origin_type, status, signature, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, 'FILLED', ?, ?)""",
                (trade_id, pos.sub_account_id, pos.id,
                 getattr(order, 'exchange_order_id', ''),
                 getattr(order, 'client_order_id', ''),
                 pos.symbol, side, getattr(order, 'order_type', 'MARKET'),
                 pos.entry_price, pos.quantity, pos.notional,
                 getattr(order, 'origin', 'MANUAL'), sig, now_ms),
            )
        except Exception as e:
            logger.error("Failed to persist open position: %s", e)

    async def _persist_close_position(
        self, pos: VirtualPos, close_price: float, pnl: float, order: Any
    ) -> None:
        """Update position to CLOSED and write trade execution + balance log."""
        if not self._db:
            return

        try:
            now_ms = int(time.time() * 1000)
            sig = create_trade_signature(pos.sub_account_id, "CLOSE", pos.id)

            # Close position
            await self._db.execute(
                "UPDATE virtual_positions SET status = 'CLOSED', realized_pnl = ?, closed_at = ? WHERE id = ?",
                (pnl, now_ms, pos.id),
            )

            # Trade execution
            trade_id = str(uuid.uuid4())
            side = "SELL" if pos.side == "LONG" else "BUY"
            origin = getattr(order, "origin", "MANUAL")
            if origin == "LIQUIDATION":
                action = "LIQUIDATION"
            elif origin == "EXCHANGE_ADL":
                action = "ADL"
            else:
                action = "CLOSE"
            await self._db.execute(
                """INSERT INTO trade_executions
                   (id, sub_account_id, position_id, exchange_order_id, client_order_id,
                    symbol, side, type, price, quantity, notional, fee, realized_pnl,
                    action, origin_type, status, signature, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'FILLED', ?, ?)""",
                (trade_id, pos.sub_account_id, pos.id,
                 getattr(order, 'exchange_order_id', ''),
                 getattr(order, 'client_order_id', ''),
                 pos.symbol, side, getattr(order, 'order_type', 'MARKET'),
                 close_price, pos.quantity, pos.quantity * close_price, pnl,
                 action, origin, sig, now_ms),
            )

            # Update balance
            acct = await self._db.fetch_one(
                "SELECT current_balance FROM sub_accounts WHERE id = ?",
                (pos.sub_account_id,),
            )
            if acct:
                old_balance = acct["current_balance"]
                new_balance = old_balance + pnl
                await self._db.execute(
                    "UPDATE sub_accounts SET current_balance = ?, updated_at = ? WHERE id = ?",
                    (new_balance, now_ms, pos.sub_account_id),
                )

                # Balance log
                await self._db.execute(
                    """INSERT INTO balance_logs
                       (id, sub_account_id, balance_before, balance_after, change_amount,
                        reason, trade_id, timestamp)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), pos.sub_account_id, old_balance, new_balance,
                     pnl, f"{action}:{pos.symbol}:{pos.side}", trade_id, now_ms),
                )
        except Exception as e:
            logger.error("Failed to persist close position: %s", e)

    async def _persist_partial_close(
        self, pos: VirtualPos, remaining: float, new_notional: float,
        new_margin: float, new_liq: float, pnl: float, fill_price: float, fill_qty: float, order: Any
    ) -> None:
        """Persist partial close: update position fields + write trade + update balance."""
        if not self._db:
            return
        try:
            now_ms = int(time.time() * 1000)
            sig = create_trade_signature(pos.sub_account_id, "PARTIAL_CLOSE", pos.id)

            # Update position with reduced quantity + new liquidation price
            await self._db.execute(
                "UPDATE virtual_positions SET quantity=?, notional=?, margin=?, liquidation_price=? WHERE id=?",
                (remaining, new_notional, new_margin, new_liq, pos.id),
            )

            # Trade execution record
            trade_id = str(uuid.uuid4())
            side = "SELL" if pos.side == "LONG" else "BUY"
            origin = getattr(order, "origin", "MANUAL")
            action = "ADL" if origin == "EXCHANGE_ADL" else "CLOSE"
            await self._db.execute(
                """INSERT INTO trade_executions
                   (id, sub_account_id, position_id, exchange_order_id, client_order_id,
                    symbol, side, type, price, quantity, notional, fee, realized_pnl,
                    action, origin_type, status, signature, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'FILLED', ?, ?)""",
                (trade_id, pos.sub_account_id, pos.id,
                 getattr(order, 'exchange_order_id', ''),
                 getattr(order, 'client_order_id', ''),
                 pos.symbol, side, getattr(order, 'order_type', 'MARKET'),
                 fill_price, fill_qty, fill_qty * fill_price, pnl,
                 action, origin, sig, now_ms),
            )

            # Update balance
            acct = await self._db.fetch_one(
                "SELECT current_balance FROM sub_accounts WHERE id=?",
                (pos.sub_account_id,),
            )
            if acct:
                old_balance = acct["current_balance"]
                new_balance = old_balance + pnl
                await self._db.execute(
                    "UPDATE sub_accounts SET current_balance=?, updated_at=? WHERE id=?",
                    (new_balance, now_ms, pos.sub_account_id),
                )
                await self._db.execute(
                    """INSERT INTO balance_logs
                       (id, sub_account_id, balance_before, balance_after, change_amount,
                        reason, trade_id, timestamp)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), pos.sub_account_id, old_balance, new_balance,
                     pnl, f"{action}:{pos.symbol}:{pos.side}", trade_id, now_ms),
                )
        except Exception as e:
            logger.error("Failed to persist partial close: %s", e)

    async def _persist_add_to_position(
        self, pos: VirtualPos, avg_entry: float, total_qty: float,
        new_notional: float, new_margin: float, new_liq: float,
        fill_price: float, fill_qty: float, order: Any
    ) -> None:
        """Persist add-to-position: update position fields + write trade."""
        if not self._db:
            return
        try:
            now_ms = int(time.time() * 1000)
            sig = create_trade_signature(pos.sub_account_id, "ADD", pos.id)

            # Update position with new avg entry and total qty
            await self._db.execute(
                """UPDATE virtual_positions
                   SET entry_price=?, quantity=?, notional=?, margin=?, liquidation_price=?
                   WHERE id=?""",
                (avg_entry, total_qty, new_notional, new_margin, new_liq, pos.id),
            )

            # Trade execution record
            trade_id = str(uuid.uuid4())
            side = "BUY" if pos.side == "LONG" else "SELL"
            await self._db.execute(
                """INSERT INTO trade_executions
                   (id, sub_account_id, position_id, exchange_order_id, client_order_id,
                    symbol, side, type, price, quantity, notional, fee,
                    action, origin_type, status, signature, timestamp)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ADD', ?, 'FILLED', ?, ?)""",
                (trade_id, pos.sub_account_id, pos.id,
                 getattr(order, 'exchange_order_id', ''),
                 getattr(order, 'client_order_id', ''),
                 pos.symbol, side, getattr(order, 'order_type', 'MARKET'),
                 fill_price, fill_qty, fill_qty * fill_price,
                 getattr(order, 'origin', 'MANUAL'), sig, now_ms),
            )
        except Exception as e:
            logger.error("Failed to persist add-to-position: %s", e)

    async def _guarded_liquidation(self, sub_id: str, tier: str, ratio: float, positions: list) -> None:
        """Execute liquidation with in-flight guard (#13)."""
        try:
            await self._liquidation.execute_liquidation(sub_id, tier, ratio, positions)
        finally:
            self._liquidating.discard(sub_id)

    # ── Position Reconciliation (on UserStream reconnect) ──

    async def reconcile_positions(self, exchange_client: Any) -> dict:
        """Compare PositionBook with exchange positions. Close ghosts.

        Called by OrderManager.reconcile_on_reconnect() after reconnecting.

        Note: can only detect ghosts (we have position, exchange doesn't).
        Cannot auto-create positions from exchange data because exchange has
        one aggregate position and we have sub-accounts.
        """
        logger.info("Position reconciliation: fetching exchange positions")

        try:
            exchange_positions = await exchange_client.get_position_risk()
        except Exception as e:
            logger.error("Position reconciliation: failed to fetch positions: %s", e)
            return {"ghosts_closed": 0, "errors": 1}

        # Build set of symbols with non-zero positions on exchange
        # Exchange returns Binance format: LYNUSDT → normalize to uppercase
        exchange_symbols = set()
        for ep in (exchange_positions or []):
            amt = float(ep.get("positionAmt", 0))
            if abs(amt) > 0:
                exchange_symbols.add(ep.get("symbol", "").upper())

        # Check each virtual position against exchange
        ghosts_closed = 0
        for sub_id in list(self._book._entries.keys()):
            positions = self._book.get_by_sub_account(sub_id)
            for pos in list(positions):
                # Convert ccxt symbol to Binance: 'LYN/USDT:USDT' → 'LYNUSDT'
                binance_sym = pos.symbol.replace("/", "").replace(":USDT", "").upper()
                if not binance_sym.endswith("USDT"):
                    binance_sym += "USDT"

                if binance_sym not in exchange_symbols:
                    # Ghost: we have position, exchange doesn't
                    logger.warning(
                        "RECONCILE GHOST: position %s %s %s qty=%.6f exists in PositionBook "
                        "but NOT on exchange — force closing",
                        pos.id[:8], pos.symbol, pos.side, pos.quantity,
                    )
                    await self.force_close_stale_position(pos)
                    ghosts_closed += 1

        if ghosts_closed:
            logger.warning("Position reconciliation: closed %d ghost positions", ghosts_closed)
        else:
            logger.info("Position reconciliation: no ghosts found (%d exchange positions, %d virtual)",
                        len(exchange_symbols), sum(len(self._book.get_by_sub_account(s)) for s in self._book._entries))

        return {"ghosts_closed": ghosts_closed, "errors": 0}

    def __repr__(self) -> str:
        return f"RiskEngine(book={self._book!r})"
