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
            # ── External bot order: PMS-tagged but not tracked ──
            # Happens when a bot places orders directly on Binance with a PMS clientOrderId.
            # Create an ad-hoc OrderState so the fill flows through the full chain
            # (RiskEngine → VirtualPosition → DB → events).
            order = await self._create_bot_order_from_feed(data)
            if not order:
                logger.debug(
                    "on_order_update: unresolvable order (coid=%s, eid=%s, status=%s) — ignoring",
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
        """Resolve 8-char sub-account prefix to full ID.

        Checks PositionBook first (fast, in-memory), falls back to
        cached DB lookup for sub-accounts that don't yet have positions.
        """
        if not prefix:
            return None

        # 1. Check PositionBook (has all accounts loaded at startup)
        if self._risk:
            book = getattr(self._risk, 'position_book', None) or getattr(self._risk, '_book', None)
            if book:
                for sub_id in book._entries:
                    if sub_id.startswith(prefix):
                        return sub_id

        # 2. Check local cache (populated from DB on misses)
        if hasattr(self, '_sub_account_cache'):
            cached = self._sub_account_cache.get(prefix)
            if cached:
                return cached

        return None

    async def _resolve_sub_account_async(self, prefix: str) -> Optional[str]:
        """Resolve sub-account prefix with async DB fallback."""
        # Try synchronous resolution first
        result = self._resolve_sub_account(prefix)
        if result:
            return result

        # DB fallback: find sub-account whose ID starts with this prefix
        if self._db:
            try:
                row = await self._db.fetch_one(
                    "SELECT id FROM sub_accounts WHERE id LIKE ? AND status = 'ACTIVE' LIMIT 1",
                    (f"{prefix}%",),
                )
                if row:
                    full_id = row["id"]
                    # Cache for future lookups
                    if not hasattr(self, '_sub_account_cache'):
                        self._sub_account_cache = {}
                    self._sub_account_cache[prefix] = full_id
                    logger.info("Resolved sub-account prefix %s → %s (DB fallback)", prefix, full_id[:12])
                    return full_id
            except Exception as e:
                logger.error("DB sub-account lookup failed for prefix %s: %s", prefix, e)

        return None

    async def _create_bot_order_from_feed(self, data: dict) -> Optional[OrderState]:
        """
        Create an ad-hoc OrderState for an external bot order.

        Called when on_order_update receives a PMS-tagged clientOrderId
        that is NOT in the in-memory tracker (i.e. the order was placed
        directly on Binance by an external bot, not through our CommandHandler).

        Parses the clientOrderId prefix to resolve the sub-account,
        creates an OrderState with origin='BOT', and registers it so
        the fill flows through the full chain.
        """
        client_order_id = data.get("client_order_id", "")
        exchange_order_id = str(data.get("order_id", ""))
        status = data.get("order_status", "")

        if not client_order_id.startswith("PMS"):
            return None

        # Parse: PMS{sub8}_{type}_{uid} → extract sub-account prefix
        stripped = client_order_id[3:]  # Remove 'PMS'
        parts = stripped.split("_", 2)
        if len(parts) < 1 or not parts[0]:
            logger.warning("Bot order %s: cannot parse sub-account prefix", client_order_id)
            return None

        sub_prefix = parts[0]
        sub_account_id = await self._resolve_sub_account_async(sub_prefix)
        if not sub_account_id:
            logger.warning(
                "Bot order %s: could not resolve sub-account prefix '%s'",
                client_order_id, sub_prefix,
            )
            return None

        # Determine initial state based on incoming status
        # Bot orders arrive from the feed, so they're already on the exchange.
        if status in ("FILLED",):
            initial_state = "active"  # Will transition to "filled" in the main handler
        elif status in ("CANCELED", "CANCELLED", "EXPIRED", "REJECTED"):
            initial_state = "active"  # Will transition to terminal in the main handler
        else:
            initial_state = "active"

        order = OrderState(
            client_order_id=client_order_id,
            sub_account_id=sub_account_id,
            exchange_order_id=exchange_order_id if exchange_order_id else None,
            symbol=data.get("symbol", ""),
            side=data.get("side", ""),
            order_type=data.get("order_type", "MARKET"),
            quantity=float(data.get("orig_qty", 0)),
            price=float(data.get("price", 0)) if data.get("price") else None,
            state=initial_state,
            origin="BOT",
            leverage=1,  # Bot manages its own leverage
            reduce_only=data.get("reduce_only", False),
        )

        self._tracker.register(order)
        logger.info(
            "Created bot order from feed: %s %s %s qty=%.6f (sub=%s)",
            client_order_id, order.symbol, order.side,
            order.quantity, sub_account_id[:8],
        )
        return order

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

        # 4. Exchange-level fill reconciliation — catch missed WS events
        reconciled = await self._reconcile_active_orders()

        # 5. Observability
        total = cleaned + stale_count + ghost_count + reconciled
        if total:
            logger.info(
                "OrderTracker: total=%d active=%d (cleaned=%d stale=%d ghosts=%d reconciled=%d)",
                self._tracker.total_count, self._tracker.active_count,
                cleaned, stale_count, ghost_count, reconciled,
            )

        return total

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

    # ── Exchange-Level Fill Reconciliation ──

    _RECONCILE_STALE_THRESHOLD = 15.0   # seconds before checking exchange
    _RECONCILE_MAX_PER_CYCLE = 3        # limit REST calls per cleanup cycle

    async def _reconcile_active_orders(self) -> int:
        """Safety net: verify stale active orders against exchange REST API.

        Catches fills that the UserStream WebSocket dropped. For orders in
        non-terminal state for > 15s, queries the exchange for actual status.
        If exchange says FILLED but our tracker says 'active' → inject a
        synthetic fill event to trigger the full chain (risk engine, algo
        callbacks, virtual positions).

        Limited to 3 orders per cycle to avoid REST rate limit pressure.
        """
        now = time.time()
        reconciled = 0
        checked = 0

        for order in list(self._tracker._by_client_id.values()):
            if checked >= self._RECONCILE_MAX_PER_CYCLE:
                break

            # Only check orders that have been active for a while
            if order.is_terminal:
                continue
            if order.state not in ("active", "cancelling"):
                continue
            if (now - order.updated_at) < self._RECONCILE_STALE_THRESHOLD:
                continue
            if not order.exchange_order_id:
                continue

            checked += 1
            try:
                exchange_data = await self._exchange.get_order(
                    order.symbol,
                    orderId=int(order.exchange_order_id),
                )
            except Exception as e:
                err_str = str(e)
                if "-2013" in err_str:  # Order does not exist
                    logger.warning(
                        "Reconcile: order %s not found on exchange — marking expired",
                        order.client_order_id,
                    )
                    order.transition("expired")
                    await self._redis_remove_open_order(order)
                    reconciled += 1
                else:
                    logger.debug("Reconcile: query failed for %s: %s", order.client_order_id, e)
                continue

            exchange_status = exchange_data.get("status", "")

            if exchange_status == "FILLED":
                # ── Critical: exchange filled but we missed it ──
                logger.warning(
                    "RECONCILE: order %s FILLED on exchange but tracker state=%s — injecting fill",
                    order.client_order_id, order.state,
                )
                # Inject as a synthetic on_order_update event so the full chain fires:
                # risk engine → virtual position → algo callbacks → scalper unwind
                synthetic = {
                    "order_id": order.exchange_order_id,
                    "client_order_id": order.client_order_id,
                    "symbol": exchange_data.get("symbol", order.symbol),
                    "side": exchange_data.get("side", order.side),
                    "order_status": "FILLED",
                    "last_filled_qty": str(exchange_data.get("executedQty", order.quantity)),
                    "last_filled_price": str(exchange_data.get("avgPrice", "0")),
                    "accumulated_filled_qty": str(exchange_data.get("executedQty", "0")),
                    "avg_price": str(exchange_data.get("avgPrice", "0")),
                    "orig_qty": str(exchange_data.get("origQty", order.quantity)),
                }
                await self.on_order_update(synthetic)
                reconciled += 1

            elif exchange_status in ("CANCELED", "EXPIRED", "REJECTED"):
                logger.warning(
                    "RECONCILE: order %s %s on exchange but tracker state=%s — syncing",
                    order.client_order_id, exchange_status, order.state,
                )
                synthetic = {
                    "order_id": order.exchange_order_id,
                    "client_order_id": order.client_order_id,
                    "symbol": exchange_data.get("symbol", order.symbol),
                    "side": exchange_data.get("side", order.side),
                    "order_status": exchange_status,
                }
                await self.on_order_update(synthetic)
                reconciled += 1

            else:
                # Order still alive on exchange — touch updated_at to avoid
                # re-checking every cycle
                order.updated_at = now

        if reconciled:
            logger.info("Reconciled %d orders with exchange (checked %d)", reconciled, checked)

        return reconciled

    # ── Full State Reconciliation (on UserStream reconnect) ──

    async def reconcile_on_reconnect(self) -> dict:
        """Full state sync after UserStream WS reconnects.

        Unlike the periodic _reconcile_active_orders (limited to 3/cycle),
        this runs a complete sweep of ALL tracked orders + detects orphans.

        Returns summary dict with counts.
        """
        logger.warning("═══ RECONCILE ON RECONNECT — full state sync ═══")
        t0 = time.time()

        fills_recovered = 0
        cancels_recovered = 0
        orphans_registered = 0
        errors = 0

        # ── Step 1: Sync ALL tracked active orders with exchange ──
        active_orders = [
            o for o in self._tracker._by_client_id.values()
            if not o.is_terminal and o.exchange_order_id
        ]
        logger.info("Reconcile: checking %d tracked active orders against exchange", len(active_orders))

        for order in active_orders:
            try:
                exchange_data = await self._exchange.get_order(
                    order.symbol,
                    orderId=int(order.exchange_order_id),
                )
            except Exception as e:
                err_str = str(e)
                if "-2013" in err_str:
                    logger.warning("Reconcile: order %s not found on exchange — marking expired", order.client_order_id)
                    order.transition("expired")
                    await self._redis_remove_open_order(order)
                    cancels_recovered += 1
                else:
                    logger.error("Reconcile: query failed for %s: %s", order.client_order_id, e)
                    errors += 1
                continue

            exchange_status = exchange_data.get("status", "")

            if exchange_status == "FILLED" and order.state != "filled":
                logger.warning(
                    "RECONCILE: order %s FILLED on exchange (tracker=%s) — injecting fill",
                    order.client_order_id, order.state,
                )
                synthetic = {
                    "order_id": order.exchange_order_id,
                    "client_order_id": order.client_order_id,
                    "symbol": exchange_data.get("symbol", order.symbol),
                    "side": exchange_data.get("side", order.side),
                    "order_status": "FILLED",
                    "last_filled_qty": str(exchange_data.get("executedQty", order.quantity)),
                    "last_filled_price": str(exchange_data.get("avgPrice", "0")),
                    "accumulated_filled_qty": str(exchange_data.get("executedQty", "0")),
                    "avg_price": str(exchange_data.get("avgPrice", "0")),
                    "orig_qty": str(exchange_data.get("origQty", order.quantity)),
                }
                await self.on_order_update(synthetic)
                fills_recovered += 1

            elif exchange_status in ("CANCELED", "EXPIRED", "REJECTED") and not order.is_terminal:
                logger.warning(
                    "RECONCILE: order %s %s on exchange (tracker=%s) — syncing",
                    order.client_order_id, exchange_status, order.state,
                )
                synthetic = {
                    "order_id": order.exchange_order_id,
                    "client_order_id": order.client_order_id,
                    "symbol": exchange_data.get("symbol", order.symbol),
                    "side": exchange_data.get("side", order.side),
                    "order_status": exchange_status,
                }
                await self.on_order_update(synthetic)
                cancels_recovered += 1

        # ── Step 2: Detect orphan PMS orders on exchange we lost track of ──
        try:
            exchange_orders = await self._exchange.get_open_orders()
            tracked_eids = set(self._tracker._by_exchange_id.keys())

            for eo in (exchange_orders or []):
                coid = eo.get("clientOrderId", "")
                eid = str(eo.get("orderId", ""))
                if not coid.startswith("PMS"):
                    continue
                if eid in tracked_eids:
                    continue  # Already tracked

                # Orphan: on exchange but not in our tracker
                logger.warning(
                    "RECONCILE: orphan PMS order on exchange: %s (eid=%s, %s %s)",
                    coid, eid, eo.get("symbol"), eo.get("side"),
                )
                # Try to resolve sub-account from client order ID
                parts = coid[3:].split("_", 2)
                sub_prefix = parts[0] if len(parts) >= 1 else ""
                sub_account_id = self._resolve_sub_account(sub_prefix)
                if not sub_account_id:
                    logger.warning("Reconcile: cannot resolve sub-account for orphan %s", coid)
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
                    reduce_only=eo.get("reduceOnly", False),
                )
                self._tracker.register(order)
                await self._redis_set_open_order(order)
                orphans_registered += 1
                logger.info("Reconcile: registered orphan order %s", coid)

        except Exception as e:
            logger.error("Reconcile: failed to fetch open orders: %s", e)
            errors += 1

        # ── Step 3: Position reconciliation (delegate to RiskEngine) ──
        if self._risk:
            try:
                await self._risk.reconcile_positions(self._exchange)
            except Exception as e:
                logger.error("Reconcile: position reconciliation failed: %s", e)
                errors += 1

        elapsed_ms = (time.time() - t0) * 1000
        summary = {
            "fills_recovered": fills_recovered,
            "cancels_recovered": cancels_recovered,
            "orphans_registered": orphans_registered,
            "errors": errors,
            "elapsed_ms": round(elapsed_ms, 1),
        }
        logger.warning(
            "═══ RECONCILE COMPLETE in %.1fms: fills=%d cancels=%d orphans=%d errors=%d ═══",
            elapsed_ms, fills_recovered, cancels_recovered, orphans_registered, errors,
        )
        return summary

    def __repr__(self) -> str:
        return f"OrderManager(tracker={self._tracker!r})"
