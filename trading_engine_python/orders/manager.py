"""
OrderManager — Central order state machine.

EVERY order (market, limit, chase reprice, scalper layer, TWAP lot, etc.)
goes through this class. Algo engines NEVER call the exchange directly.

State transitions:
- place_*()         → idle → placing (sends REST request)
- on_order_update() → placing → active (feed: NEW)
- on_order_update() → active → filled (feed: FILLED)  → calls on_fill callback
- cancel_order()    → active → cancelling (sends cancel REST)
- on_order_update() → cancelling → cancelled (feed: CANCELED) → calls on_cancel callback

Key insight from market_maker.py:
- REST responses do NOT drive state — they only move idle → placing
- Feed events drive ALL transitions: placing → active, active → filled
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from .state import OrderState, generate_client_order_id, TERMINAL_STATES
from .tracker import OrderTracker
from .exchange_client import ExchangeClient
from contracts.invariants import InvariantViolation

logger = logging.getLogger(__name__)

# Map order_type shorthand to client order ID prefix
_TYPE_PREFIX = {
    "MARKET": "MKT",
    "LIMIT": "LMT",
    "STOP_MARKET": "STP",
    "TAKE_PROFIT_MARKET": "TPM",
}


class OrderManager:
    """
    Central order state machine.

    EVERY order goes through this class. Algo engines delegate all
    exchange interactions here and register callbacks for state transitions.
    """

    def __init__(
        self,
        exchange_client: ExchangeClient,
        redis_client: Any = None,
        risk_engine: Any = None,
        symbol_info: Any = None,
        db: Any = None,
    ):
        self._exchange = exchange_client
        self._redis = redis_client
        self._risk = risk_engine  # Set later via set_risk_engine() (Step 7)
        self._symbol_info = symbol_info  # SymbolInfoCache for rounding
        self._db = db  # Database for pending_orders persistence
        self._tracker = OrderTracker()
        self._seq: int = 0  # Monotonic event sequence number

    def set_risk_engine(self, risk_engine: Any) -> None:
        """Wire up the risk engine after it's created (Step 7)."""
        self._risk = risk_engine

    def set_symbol_info(self, symbol_info: Any) -> None:
        """Wire up the symbol info cache."""
        self._symbol_info = symbol_info

    @property
    def tracker(self) -> OrderTracker:
        """Expose tracker for external queries."""
        return self._tracker

    def _next_seq(self) -> int:
        """Monotonic sequence number for event ordering."""
        self._seq += 1
        return self._seq

    # ── Public API: Place Orders ──

    async def place_market_order(
        self,
        sub_account_id: str,
        symbol: str,
        side: str,
        quantity: float,
        leverage: int = 1,
        origin: str = "MANUAL",
        parent_id: Optional[str] = None,
        on_fill: Optional[Callable] = None,
        on_cancel: Optional[Callable] = None,
        reduce_only: bool = False,
        **kwargs,
    ) -> OrderState:
        """
        Place a market order and track it.

        Args:
            symbol: Binance format (BTCUSDT)
            side: BUY or SELL

        Returns: OrderState (state="placing", fills arrive async via feed)
        """
        order = OrderState(
            client_order_id=generate_client_order_id(sub_account_id, "MKT"),
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            order_type="MARKET",
            quantity=quantity,
            leverage=leverage,
            origin=origin,
            parent_id=parent_id,
            on_fill=on_fill,
            on_cancel=on_cancel,
            reduce_only=reduce_only,
        )

        # Round quantity to exchange precision
        if self._symbol_info:
            quantity = self._symbol_info.round_quantity(symbol, quantity, is_market=True)
            order.quantity = quantity

        order.transition("placing")
        self._tracker.register(order)

        try:
            t0 = time.perf_counter()
            result = await self._exchange.create_market_order(
                symbol,
                side,
                quantity,
                newClientOrderId=order.client_order_id,
                reduceOnly="true" if reduce_only else None,
                **kwargs,
            )
            latency_ms = (time.perf_counter() - t0) * 1000
            logger.info("Market order placed in %.1fms: %s %s qty=%.6f", latency_ms, symbol, side, quantity)
            # Map exchange ID for feed routing
            eid = str(result.get("orderId", ""))
            if eid:
                self._tracker.update_exchange_id(order.client_order_id, eid)
            # DON'T set state to "active" — wait for feed confirmation

        except Exception as e:
            order.transition("failed")
            logger.error("Market order failed: %s %s %s — %s", symbol, side, quantity, e)
            await self._publish_event("order_failed", order, error=str(e))

        return order

    async def place_limit_order(
        self,
        sub_account_id: str,
        symbol: str,
        side: str,
        quantity: float,
        price: float,
        leverage: int = 1,
        origin: str = "MANUAL",
        parent_id: Optional[str] = None,
        on_fill: Optional[Callable] = None,
        on_cancel: Optional[Callable] = None,
        on_partial: Optional[Callable] = None,
        reduce_only: bool = False,
        **kwargs,
    ) -> OrderState:
        """Place a limit order (GTC) and track it."""
        order = OrderState(
            client_order_id=generate_client_order_id(sub_account_id, "LMT"),
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            order_type="LIMIT",
            quantity=quantity,
            price=price,
            leverage=leverage,
            origin=origin,
            parent_id=parent_id,
            on_fill=on_fill,
            on_cancel=on_cancel,
            on_partial=on_partial,
            reduce_only=reduce_only,
        )

        # Round price and quantity to exchange precision
        if self._symbol_info:
            quantity = self._symbol_info.round_quantity(symbol, quantity, is_market=False)
            price = self._symbol_info.round_price(symbol, price)
            order.quantity = quantity
            order.price = price

        order.transition("placing")
        self._tracker.register(order)

        try:
            t0 = time.perf_counter()
            result = await self._exchange.create_limit_order(
                symbol,
                side,
                quantity,
                price,
                newClientOrderId=order.client_order_id,
                reduceOnly="true" if reduce_only else None,
                **kwargs,
            )
            latency_ms = (time.perf_counter() - t0) * 1000
            logger.info("Limit order placed in %.1fms: %s %s qty=%.6f @ %.8f", latency_ms, symbol, side, quantity, price)
            eid = str(result.get("orderId", ""))
            if eid:
                self._tracker.update_exchange_id(order.client_order_id, eid)

            # Transition placing → active on REST success.
            # The feed will handle further transitions (filled/cancelled).
            order.transition("active")

            # Persist to pending_orders table
            await self._db_persist_pending_order(order)

        except Exception as e:
            order.transition("failed")
            logger.error("Limit order failed: %s %s %s@%s — %s", symbol, side, quantity, price, e)
            await self._publish_event("order_failed", order, error=str(e))

        return order

    async def place_batch_limit_orders(
        self, order_params: list[dict]
    ) -> list[OrderState]:
        """Place multiple limit orders in a single batch REST call.
        
        Each dict in order_params should have:
            sub_account_id, symbol, side, quantity, price, leverage,
            origin, parent_id, on_fill, on_cancel, reduce_only (all optional except first 5)
        
        Returns list of OrderState objects (same order as input).
        Orders that fail individually within the batch are marked as 'failed'.
        """
        if not order_params:
            return []

        # 1. Create OrderState objects and register in tracker
        orders: list[OrderState] = []
        exchange_params: list[dict] = []

        for p in order_params:
            symbol = p["symbol"]
            side = p["side"]
            quantity = float(p["quantity"])
            price = float(p["price"])

            order = OrderState(
                client_order_id=generate_client_order_id(p.get("sub_account_id", ""), "LMT"),
                sub_account_id=p.get("sub_account_id", ""),
                symbol=symbol,
                side=side,
                order_type="LIMIT",
                quantity=quantity,
                price=price,
                leverage=p.get("leverage", 1),
                origin=p.get("origin", "MANUAL"),
                parent_id=p.get("parent_id"),
                on_fill=p.get("on_fill"),
                on_cancel=p.get("on_cancel"),
                reduce_only=p.get("reduce_only", False),
            )

            # Round to exchange precision
            if self._symbol_info:
                order.quantity = self._symbol_info.round_quantity(symbol, quantity, is_market=False)
                order.price = self._symbol_info.round_price(symbol, price)

            order.transition("placing")
            self._tracker.register(order)
            orders.append(order)

            exchange_params.append({
                "symbol": symbol,
                "side": side,
                "quantity": order.quantity,
                "price": order.price,
                "newClientOrderId": order.client_order_id,
                "reduceOnly": order.reduce_only,
            })

        # 2. Send batch to exchange
        try:
            t0 = time.perf_counter()
            results = await self._exchange.create_batch_limit_orders(exchange_params)
            latency_ms = (time.perf_counter() - t0) * 1000
            logger.info(
                "Batch placed %d orders in %.1fms",
                len(exchange_params), latency_ms,
            )

            # 3. Map results back to OrderStates
            for i, (order, result) in enumerate(zip(orders, results)):
                if isinstance(result, dict) and "orderId" in result:
                    # Success
                    eid = str(result["orderId"])
                    self._tracker.update_exchange_id(order.client_order_id, eid)
                    order.transition("active")
                    await self._db_persist_pending_order(order)
                elif isinstance(result, dict) and "code" in result:
                    # Individual order failed within batch
                    order.transition("failed")
                    logger.error(
                        "Batch order %d failed: code=%s msg=%s",
                        i, result.get("code"), result.get("msg"),
                    )
                else:
                    order.transition("failed")
                    logger.error("Batch order %d: unexpected result: %s", i, result)

        except Exception as e:
            # Entire batch failed — mark all as failed
            for order in orders:
                if order.state == "placing":
                    order.transition("failed")
            logger.error("Batch order failed entirely: %s", e)

        return orders

    async def cancel_order(self, client_order_id: str) -> bool:
        """
        Cancel an order. Sets state to 'cancelling'.
        Actual confirmation comes from the feed.
        Returns True if cancel request was sent.
        """
        order = self._tracker.lookup(client_order_id=client_order_id)
        if not order:
            logger.warning("cancel_order: unknown order %s", client_order_id)
            return False

        # Terminal states — nothing to cancel
        if order.state in ("cancelled", "filled", "expired", "failed"):
            logger.warning(
                "cancel_order: order already in terminal state=%s (coid=%s)",
                order.state, client_order_id,
            )
            return False

        # If already cancelling, skip transition but re-send cancel to exchange (idempotent)
        if order.state != "cancelling":
            if not order.transition("cancelling"):
                logger.warning(
                    "cancel_order: can't cancel order in state=%s (coid=%s)",
                    order.state, client_order_id,
                )
                return False

        try:
            # Prefer exchange orderId (more reliable), fall back to clientOrderId
            t0 = time.perf_counter()
            if order.exchange_order_id:
                await self._exchange.cancel_order(
                    order.symbol,
                    orderId=int(order.exchange_order_id),
                )
            else:
                await self._exchange.cancel_order(
                    order.symbol,
                    origClientOrderId=order.client_order_id,
                )
            latency_ms = (time.perf_counter() - t0) * 1000
            logger.info("Cancel sent in %.1fms: %s %s", latency_ms, order.symbol, client_order_id)
        except Exception as e:
            err_str = str(e)
            # -2011 = "Unknown order" = order already gone (filled or expired)
            if "-2011" in err_str:
                logger.info("cancel_order: order already gone (filled/expired?): %s", client_order_id)
                # Let the feed confirm actual state — don't revert
            else:
                logger.warning("Cancel request failed (feed will resolve): %s — %s", client_order_id, e)

        return True

    async def cancel_all_orders_for_symbol(self, symbol: str) -> int:
        """Cancel all tracked active orders for a symbol. Returns count."""
        active = self._tracker.get_active_by_symbol(symbol)
        count = 0
        for order in active:
            if await self.cancel_order(order.client_order_id):
                count += 1
        return count

    async def cancel_all_orders_for_account(self, sub_account_id: str) -> int:
        """Cancel all tracked active orders for a sub-account (all symbols). Returns count."""
        active = self._tracker.get_by_sub_account(sub_account_id, active_only=True)
        count = 0
        for order in active:
            if await self.cancel_order(order.client_order_id):
                count += 1
        return count

    async def replace_order(
        self,
        client_order_id: str,
        new_price: float,
        new_quantity: Optional[float] = None,
    ) -> Optional[OrderState]:
        """
        Cancel-and-replace pattern (from market_maker update_quotes).
        1. Cancel existing order
        2. Place new order with same params but new price
        3. Link new order to same parent/callbacks
        Returns the new OrderState, or None if cancel failed, order was filled, or original not found.
        """
        old = self._tracker.lookup(client_order_id=client_order_id)
        if not old:
            return None

        t0 = time.perf_counter()

        # Cancel the old order — if cancel fails, do NOT place a new order
        cancelled = await self.cancel_order(client_order_id)
        if not cancelled:
            logger.warning("replace_order: can't cancel %s (state=%s), skipping replace", client_order_id, old.state)
            return None

        # Check if old order was filled during the cancel window.
        # The UserStream on_order_update runs in the same event loop and may have
        # processed a FILLED event while we were awaiting the cancel REST call.
        if old.state == "filled":
            logger.info("replace_order: old order %s was filled during cancel — aborting replace", client_order_id)
            return None

        # Place new order with same metadata
        result = await self.place_limit_order(
            sub_account_id=old.sub_account_id,
            symbol=old.symbol,
            side=old.side,
            quantity=new_quantity or old.quantity,
            price=new_price,
            leverage=old.leverage,
            origin=old.origin,
            parent_id=old.parent_id,
            on_fill=old.on_fill,
            on_cancel=old.on_cancel,
            on_partial=old.on_partial,
            reduce_only=old.reduce_only,
        )
        latency_ms = (time.perf_counter() - t0) * 1000
        logger.info("Replace order in %.1fms: %s %s @ %.8f", latency_ms, old.symbol, old.side, new_price)
        return result

    # ── Feed Event Handler (called by UserStreamService) ──

    async def on_order_update(self, data: dict) -> None:
        """
        Called by UserStreamService on ORDER_TRADE_UPDATE / TRADE_LITE.

        Expected data format (from binance_wss.py map_order_data_ws):
        {
            'symbol': 'BTCUSDT',
            'client_order_id': 'PMS...',
            'order_id': '123456',
            'side': 'BUY',
            'order_type': 'LIMIT',
            'order_status': 'NEW',  # NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED
            'price': '65000.00',
            'orig_qty': '0.001',
            'last_filled_qty': '0.001',
            'last_filled_price': '65001.50',
            'accumulated_filled_qty': '0.001',
            'avg_price': '65001.50',
        }
        """
        exchange_order_id = str(data.get("order_id", ""))
        client_order_id = data.get("client_order_id", "")
        status = data.get("order_status", "")

        # Skip orders that aren't ours (not PMS-prefixed)
        if client_order_id and not client_order_id.startswith("PMS"):
            return

        # Look up the order
        order = self._tracker.lookup(
            exchange_order_id=exchange_order_id,
            client_order_id=client_order_id,
        )
        if not order:
            logger.debug(
                "on_order_update: unknown order (coid=%s, eid=%s, status=%s) — not ours",
                client_order_id, exchange_order_id, status,
            )
            return

        old_state = order.state

        # ── Process status ──

        if status == "NEW":
            if not order.exchange_order_id and exchange_order_id:
                self._tracker.update_exchange_id(order.client_order_id, exchange_order_id)
            order.transition("active")
            await self._redis_set_open_order(order)
            # Publish order_placed for limit orders (frontend shows in open orders)
            if order.order_type == "LIMIT":
                await self._publish_event("order_placed", order)
            await self._publish_event("order_active", order)

        elif status == "PARTIALLY_FILLED":
            fill_price = float(data.get("last_filled_price", 0))
            fill_qty = float(data.get("last_filled_qty", 0))
            order.apply_fill(fill_price, fill_qty)

            if order.on_partial:
                try:
                    await order.on_partial(order)
                except Exception as e:
                    logger.error("on_partial callback error: %s", e)

            await self._publish_event("order_partial", order)

        elif status == "FILLED":
            fill_price = float(data.get("last_filled_price", 0))
            fill_qty = float(data.get("last_filled_qty", 0))
            avg_price = float(data.get("avg_price", 0))

            # ── Guard: reject duplicate FILLED events (e.g. TRADE_LITE + ORDER_TRADE_UPDATE) ──
            if not order.transition("filled"):
                logger.warning(
                    "Order %s already terminal (%s), ignoring duplicate FILLED event",
                    order.client_order_id, order.state,
                )
                return

            # ── Invariant: fill data sanity ──
            if fill_price <= 0 or fill_qty <= 0:
                logger.error(
                    "Order %s FILLED with invalid data: fill_price=%.8f fill_qty=%.8f",
                    order.client_order_id, fill_price, fill_qty,
                )

            order.apply_fill(fill_price, fill_qty)
            if avg_price > 0:
                order.avg_fill_price = avg_price

            # Remove from Redis open orders + update DB
            await self._redis_remove_open_order(order)
            await self._db_update_pending_order(order, "FILLED")

            # Call risk engine if available
            if self._risk:
                try:
                    await self._risk.on_order_fill(order)
                except Exception as e:
                    logger.error("Risk engine on_order_fill error: %s", e)

            # Call algo callback
            if order.on_fill:
                try:
                    await order.on_fill(order)
                except Exception as e:
                    logger.error("on_fill callback error: %s", e)

            await self._publish_event("order_filled", order)

        elif status in ("CANCELED", "CANCELLED", "EXPIRED", "REJECTED"):
            new_state = "cancelled" if status != "EXPIRED" else "expired"
            order.transition(new_state)

            if order.on_cancel:
                try:
                    await order.on_cancel(order, status)
                except Exception as e:
                    logger.error("on_cancel callback error: %s", e)

            await self._publish_event("order_cancelled", order, reason=status)
            await self._redis_remove_open_order(order)
            await self._db_update_pending_order(order, "CANCELLED")

        if order.state != old_state:
            logger.info(
                "Order %s: %s → %s (%s %s %s)",
                order.client_order_id, old_state, order.state,
                order.symbol, order.side, order.origin,
            )

    # ── Query API ──

    def get_order(self, client_order_id: str) -> Optional[OrderState]:
        """Get an order by client order ID."""
        return self._tracker.lookup(client_order_id=client_order_id)

    def get_active_orders(
        self,
        sub_account_id: Optional[str] = None,
        symbol: Optional[str] = None,
    ) -> List[OrderState]:
        """Get active orders, optionally filtered by sub-account or symbol."""
        if sub_account_id:
            return self._tracker.get_by_sub_account(sub_account_id, active_only=True)
        if symbol:
            return self._tracker.get_active_by_symbol(symbol)
        return [o for o in self._tracker._by_client_id.values() if o.is_active]

    def get_orders_by_parent(self, parent_id: str) -> List[OrderState]:
        """Get all orders for a parent algo (chase, scalper, etc.)."""
        return self._tracker.get_by_parent(parent_id)

    # ── Redis Event Publishing ──

    async def _publish_event(self, event_type: str, order: OrderState, **extra) -> None:
        """
        Publish order event to Redis PUB/SUB for JS to forward to frontend.

        KEY DESIGN: Events carry full account state (balance, positions, margin)
        so frontend can update locally without refetching /margin endpoint.
        Frontend only fetches /margin on page refresh (cold start).
        """
        from contracts.common import ts_ms, RedisKey

        # Get account snapshot for idempotent frontend update
        account_state = {}
        if self._risk and event_type in (
            "order_filled", "order_cancelled", "position_closed", "position_reduced"
        ):
            try:
                account_state = self._risk.get_account_snapshot(order.sub_account_id)
            except Exception as e:
                logger.error("Failed to get account snapshot: %s", e)

        payload = {
            "seq": self._next_seq(),
            "type": event_type,
            **order.to_event_dict(),
            "account": account_state,
            "timestamp": ts_ms(),
            **extra,
        }

        channel = RedisKey.event_channel(event_type)

        if self._redis:
            try:
                await self._redis.publish(channel, json.dumps(payload))
            except Exception as e:
                logger.error("Failed to publish event %s: %s", event_type, e)
        else:
            logger.debug("No Redis client — skipping publish: %s", event_type)

    # ── Redis Open Order Tracking ──

    async def _redis_set_open_order(self, order: OrderState) -> None:
        """Write active order to Redis hash for JS open-orders endpoint."""
        if not self._redis:
            return
        try:
            from contracts.common import RedisKey
            key = RedisKey.open_orders(order.sub_account_id)
            await self._redis.hset(key, order.client_order_id, json.dumps(order.to_event_dict()))
            await self._redis.expire(key, 86400)  # 24h TTL safety net
        except Exception as e:
            logger.error("Failed to set open order in Redis: %s", e)

    async def _redis_remove_open_order(self, order: OrderState) -> None:
        """Remove terminal order from Redis hash."""
        if not self._redis:
            return
        try:
            from contracts.common import RedisKey
            key = RedisKey.open_orders(order.sub_account_id)
            await self._redis.hdel(key, order.client_order_id)
        except Exception as e:
            logger.error("Failed to remove open order from Redis: %s", e)

    # ── Startup Recovery ──

    async def load_open_orders_from_exchange(self) -> int:
        """
        On startup, recover open orders using DB as the sub-account
        ownership source and exchange as the liveness source.

        1. Load PENDING orders from pending_orders DB table (has sub_account_id)
        2. Query exchange for all open orders (liveness check)
        3. Cross-reference: only recover orders that exist on BOTH
        4. Mark DB orders not on exchange as CANCELLED (stale)

        Returns count of recovered orders.
        """
        # Step 1: Load pending orders from DB (keyed by exchange_order_id)
        db_orders = {}
        if self._db:
            try:
                rows = await self._db.fetch_all(
                    "SELECT * FROM pending_orders WHERE status = 'PENDING'"
                )
                for row in rows:
                    eid = row.get("exchange_order_id")
                    if eid:
                        db_orders[str(eid)] = row
            except Exception as e:
                logger.error("Failed to load pending orders from DB: %s", e)

        # Step 2: Query exchange for open orders
        try:
            exchange_orders = await self._exchange.get_open_orders()
        except Exception as e:
            logger.error("Failed to fetch open orders from exchange: %s", e)
            return 0

        # Build set of exchange order IDs that are actually live
        exchange_eids = set()
        for eo in (exchange_orders or []):
            exchange_eids.add(str(eo.get("orderId", "")))

        # Step 3: Recover orders that exist in both DB and exchange
        count = 0
        for eo in (exchange_orders or []):
            coid = eo.get("clientOrderId", "")
            if not coid.startswith("PMS"):
                continue  # Not our order

            eid = str(eo.get("orderId", ""))
            db_row = db_orders.get(eid)

            # Resolve sub_account_id: prefer DB, fallback to prefix parsing
            if db_row:
                sub_account_id = db_row.get("sub_account_id", "")
                leverage = int(db_row.get("leverage", 1))
            else:
                # Fallback: parse from client order ID prefix
                parts = coid[3:].split("_", 2)
                sub_prefix = parts[0] if len(parts) >= 1 else ""
                sub_account_id = self._resolve_sub_account(sub_prefix)
                leverage = 1
                if not sub_account_id:
                    logger.debug("Cannot resolve sub-account for order %s", coid)
                    continue

            order = OrderState(
                client_order_id=coid,
                sub_account_id=sub_account_id,
                exchange_order_id=eid,
                symbol=eo.get("symbol", ""),
                side=eo.get("side", ""),
                order_type=eo.get("type", "LIMIT"),
                quantity=float(eo.get("origQty", 0)),
                price=float(eo.get("price", 0)),
                state="active",
                filled_qty=float(eo.get("executedQty", 0)),
                origin="RECOVERED",
                leverage=leverage,
                created_at=eo.get("time", 0) / 1000.0 if eo.get("time") else 0,
                reduce_only=eo.get("reduceOnly", False),
            )

            self._tracker.register(order)
            await self._redis_set_open_order(order)
            count += 1
            logger.debug("Recovered order: %s %s %s qty=%.6f @ %.2f (sub=%s)",
                         coid, order.symbol, order.side, order.quantity, order.price or 0, sub_account_id[:8])

        # Step 4: Mark stale DB orders (not on exchange) as CANCELLED
        if self._db:
            stale_count = 0
            for eid, row in db_orders.items():
                if eid not in exchange_eids:
                    try:
                        await self._db.execute(
                            "UPDATE pending_orders SET status = 'CANCELLED', cancelled_at = datetime('now') WHERE id = ?",
                            (row["id"],),
                        )
                        stale_count += 1
                    except Exception as e:
                        logger.error("Failed to mark stale order %s: %s", eid, e)
            if stale_count:
                logger.info("Marked %d stale DB orders as CANCELLED (not on exchange)", stale_count)

        if count:
            logger.info("Recovered %d open orders from exchange", count)
        return count

    def _resolve_sub_account(self, prefix: str) -> Optional[str]:
        """Resolve 8-char sub-account prefix to full ID using PositionBook."""
        if not self._risk:
            return None
        book = getattr(self._risk, 'position_book', None) or getattr(self._risk, '_book', None)
        if not book:
            return None
        for sub_id in book._entries:
            if sub_id.startswith(prefix):
                return sub_id
        return None

    # ── DB Persistence for Pending Orders ──

    async def _db_persist_pending_order(self, order: OrderState) -> None:
        """Write a new limit order to the pending_orders table."""
        if not self._db or order.order_type != "LIMIT":
            return
        try:
            # Map BUY/SELL to LONG/SHORT for DB consistency
            db_side = "LONG" if order.side == "BUY" else "SHORT"
            await self._db.execute(
                """INSERT INTO pending_orders
                   (id, sub_account_id, symbol, side, type, price, quantity, leverage,
                    exchange_order_id, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))""",
                (order.client_order_id, order.sub_account_id, order.symbol,
                 db_side, order.order_type, order.price, order.quantity,
                 float(order.leverage), order.exchange_order_id or ""),
            )
        except Exception as e:
            logger.error("Failed to persist pending order to DB: %s", e)

    async def _db_update_pending_order(self, order: OrderState, status: str) -> None:
        """Update pending order status (FILLED / CANCELLED)."""
        if not self._db:
            return
        try:
            if status == "FILLED":
                await self._db.execute(
                    "UPDATE pending_orders SET status = 'FILLED', filled_at = datetime('now') WHERE id = ?",
                    (order.client_order_id,),
                )
            else:
                await self._db.execute(
                    "UPDATE pending_orders SET status = 'CANCELLED', cancelled_at = datetime('now') WHERE id = ?",
                    (order.client_order_id,),
                )
        except Exception as e:
            logger.error("Failed to update pending order %s to %s: %s", order.client_order_id, status, e)

    # ── Housekeeping ──

    async def cleanup(self) -> int:
        """Clean up terminal orders older than 5 minutes + expire stale orders + purge ghost Redis entries."""
        # 1. Expire stale orders stuck in "placing" > 30s
        stale_count = 0
        for order in list(self._tracker._by_client_id.values()):
            if order.is_stale:
                order.transition("failed")
                stale_count += 1
                logger.warning(
                    "Expired stale order %s (stuck in placing for %.0fs)",
                    order.client_order_id, time.time() - order.created_at,
                )
                await self._redis_remove_open_order(order)
        if stale_count:
            logger.info("Expired %d stale orders", stale_count)

        # 2. Clean up terminal orders older than 5 min
        cleaned = self._tracker.cleanup_terminal()

        # 3. Purge ghost entries from Redis open_orders hashes
        ghost_count = await self._reconcile_redis_open_orders()

        # 4. Observability
        if cleaned or stale_count or ghost_count:
            logger.info(
                "OrderTracker: total=%d active=%d (cleaned=%d stale=%d ghosts=%d)",
                self._tracker.total_count, self._tracker.active_count,
                cleaned, stale_count, ghost_count,
            )

        return cleaned + stale_count + ghost_count

    async def _reconcile_redis_open_orders(self) -> int:
        """Scan all pms:open_orders:* hashes and remove entries with terminal state.

        Catches ghost entries where _redis_remove_open_order failed silently
        (e.g. during fills/cancels) or the engine crashed before cleanup.
        """
        if not self._redis:
            return 0

        ghost_count = 0
        terminal_states = {"filled", "cancelled", "expired", "failed"}

        try:
            async for key in self._redis.scan_iter(match="pms:open_orders:*", count=50):
                entries = await self._redis.hgetall(key)
                for field, raw in entries.items():
                    try:
                        data = json.loads(raw)
                        state = (data.get("state") or data.get("status") or "").lower()
                        if state in terminal_states:
                            await self._redis.hdel(key, field)
                            ghost_count += 1
                            logger.warning(
                                "Purged ghost open_order %s (state=%s) from %s",
                                field, state, key,
                            )
                    except (json.JSONDecodeError, TypeError):
                        # Corrupt entry — remove it
                        await self._redis.hdel(key, field)
                        ghost_count += 1
                        logger.warning("Purged corrupt open_order entry %s from %s", field, key)

                # If hash is now empty, delete the key entirely
                if entries and ghost_count > 0:
                    remaining = await self._redis.hlen(key)
                    if remaining == 0:
                        await self._redis.delete(key)
        except Exception as e:
            logger.error("Redis open_orders reconciliation error: %s", e)

        return ghost_count

    def __repr__(self) -> str:
        return f"OrderManager(tracker={self._tracker!r})"
