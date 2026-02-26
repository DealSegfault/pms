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
import json
import logging
import time
import uuid
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

    def set_order_manager(self, om: Any) -> None:
        """Wire up OrderManager for liquidation execution."""
        self._om = om
        self._liquidation.set_order_manager(om)

    @property
    def position_book(self) -> PositionBook:
        return self._book

    async def _publish_event(self, event_type: str, payload: dict) -> None:
        """Publish a position/margin event to Redis PUB/SUB for WS forwarding."""
        if not self._redis:
            return
        try:
            await self._redis.publish(f"pms:events:{event_type}", json.dumps(payload))
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
                        "openedAt": p["opened_at"] / 1000.0 if p.get("opened_at") else None,
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

        # Determine position side from order side
        position_side = "LONG" if fill_side == "BUY" else "SHORT"
        opposite_side = "SHORT" if fill_side == "BUY" else "LONG"

        # Check for existing position on opposite side (close/flip)
        existing = self._book.find_position(sub_id, symbol, opposite_side)

        if existing:
            # Closing or flipping existing position
            await self._close_position(existing, fill_price, fill_qty, order)
        else:
            # Opening new position or adding to existing same-side
            same_side = self._book.find_position(sub_id, symbol, position_side)
            if same_side:
                await self._add_to_position(same_side, fill_price, fill_qty, order)
            else:
                await self._open_position(sub_id, symbol, position_side, fill_price, fill_qty, order)

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
            })
            snapshot = self.get_account_snapshot(existing.sub_account_id)
            await self._publish_event("margin_update", {
                "subAccountId": existing.sub_account_id,
                "update": snapshot,
                **snapshot,
            })

            logger.info("Closed position: %s PnL=%.4f", existing.id[:8], pnl)
        else:
            # Partial close
            remaining = existing.quantity - fill_qty
            old_notional = existing.notional
            new_notional = remaining * existing.entry_price
            new_margin = compute_margin(new_notional, existing.leverage)

            self._book.update_position(
                existing.id, existing.sub_account_id,
                quantity=remaining, notional=new_notional, margin=new_margin,
            )

            # Credit partial PnL to balance
            account = self._book.get_account(existing.sub_account_id)
            new_balance = account.get("currentBalance", 0) + pnl
            self._book.update_balance(existing.sub_account_id, new_balance)

            # Publish position_reduced + margin_update to frontend
            await self._publish_event("position_reduced", {
                "subAccountId": existing.sub_account_id,
                "positionId": existing.id,
                "symbol": existing.symbol,
                "closedQty": fill_qty,
                "remainingQty": remaining,
                "realizedPnl": pnl,
            })
            snapshot = self.get_account_snapshot(existing.sub_account_id)
            await self._publish_event("margin_update", {
                "subAccountId": existing.sub_account_id,
                "update": snapshot,
                **snapshot,
            })

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

            # Evaluate liquidation
            result = self._liquidation.evaluate_account(
                sub_id,
                price_lookup=lambda s: self._market_data.get_mid_price(s) if self._market_data else None,
            )
            if result:
                tier, ratio, positions = result
                asyncio.create_task(
                    self._liquidation.execute_liquidation(sub_id, tier, ratio, positions)
                )

        # Write risk snapshot (throttled)
        await self._write_risk_snapshot(symbol)

    # ── ACCOUNT_UPDATE Handler ──

    async def on_account_update(self, data: dict) -> None:
        """
        Called by UserStreamService on ACCOUNT_UPDATE.
        Handles external position changes (reconciliation).
        """
        positions = data.get("positions", [])
        for pos_data in positions:
            symbol = pos_data.get("symbol", "")
            position_amount = pos_data.get("position_amount", 0)
            # TODO: Reconcile with PositionBook — if exchange closed position externally,
            # update our virtual position state.
            logger.debug("ACCOUNT_UPDATE: %s amount=%.6f", symbol, position_amount)

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
                    "UPDATE virtual_positions SET status='CLOSED', closed_at=?, close_price=?, realized_pnl=0 WHERE id=?",
                    (int(time.time() * 1000), pos.entry_price, pos.id),
                )
                await self._db.commit()
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
        """
        positions = self._book.get_by_sub_account(sub_account_id)
        account = self._book.get_account(sub_account_id)
        balance = account.get("currentBalance", 0)

        margin_used = sum(p.margin for p in positions)
        unrealized_pnl = sum(p.unrealized_pnl for p in positions)
        equity = balance + unrealized_pnl

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
            action = getattr(order, 'origin', 'MANUAL') if getattr(order, 'origin', '') == 'LIQUIDATION' else 'CLOSE'
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
                 action, getattr(order, 'origin', 'MANUAL'), sig, now_ms),
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
                     pnl, f"CLOSE:{pos.symbol}:{pos.side}", trade_id, now_ms),
                )
        except Exception as e:
            logger.error("Failed to persist close position: %s", e)

    def __repr__(self) -> str:
        return f"RiskEngine(book={self._book!r})"
