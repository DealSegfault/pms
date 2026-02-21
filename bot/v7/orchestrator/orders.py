"""
Order management mixin — extracted from MultiGridRunner.

Handles the order execution loop, fire-and-forget entries, resting TP orders,
entry/TP amendment management, virtual position closes, and smart exit logic.
"""
import asyncio
import logging
import os
import time
from typing import Dict, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from bot.v7.grid_trader import GridTrader

logger = logging.getLogger(__name__)


class OrderMixin:
    """Order execution and management for MultiGridRunner."""

    async def _order_loop(self, stop: asyncio.Event):
        """Drain and execute queued orders — event-driven with timeout fallback."""
        if self._orders_ready is None:
            self._orders_ready = asyncio.Event()

        while not stop.is_set():
            try:
                await asyncio.wait_for(self._orders_ready.wait(), timeout=0.05)
            except asyncio.TimeoutError:
                pass

            self._orders_ready.clear()

            if self._shutting_down:
                break

            tasks = []
            for sym, trader in list(self.traders.items()):
                orders = trader.drain_orders()
                for order in orders:
                    if stop.is_set() or self._shutting_down:
                        break
                    tasks.append(self._execute_order(trader, order))

            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    def _on_order_update(self, order_id: str, status: str, fill):
        """
        Callback from user stream for fire-and-forget entries AND resting TP orders.
        Called synchronously from WS handler — must be fast, no await.
        """
        entry = self._pending_entries.pop(order_id, None)
        if entry is not None:
            self._handle_entry_fill(order_id, status, fill, entry)
            return
        for symbol, tp in list(self._resting_tp_orders.items()):
            if tp.get('order_id') == order_id:
                self._handle_tp_fill(order_id, status, fill, symbol, tp)
                return

    def _handle_entry_fill(self, order_id: str, status: str, fill, entry: dict):
        """Process a fire-and-forget entry fill/cancel from user stream."""
        trader = entry['trader']
        symbol = entry['symbol']
        if self._active_entry_orders.get(symbol) == order_id:
            del self._active_entry_orders[symbol]
        if status == 'FILLED' and fill is not None:
            excess_qty = trader.on_sell_fill(
                fill_price=fill.avg_price,
                fill_qty=fill.qty,
                order_id=fill.order_id,
                fee=fill.fee,
                layer_idx=entry.get('layer_idx', 0),
            )
            logger.info(
                f"🔥 {symbol} FIRE FILL {fill.qty}@{fill.avg_price:.6f} "
                f"(order {order_id[:8]}…)"
            )
            if excess_qty is not None and excess_qty > 0:
                logger.warning(f"🚨 {symbol} fire fill excess {excess_qty:.6f} — will sync")
            else:
                self._schedule_tp_order(symbol, trader)
        else:
            trader._pending_order = False
            logger.debug(f"🔥 {symbol} FIRE {status} (order {order_id[:8]}…)")
        self._persist_runtime_state(symbol, trader)

    def _handle_tp_fill(self, order_id: str, status: str, fill, symbol: str, tp: dict):
        """Process a resting TP fill/cancel from user stream."""
        trader = tp['trader']
        self._resting_tp_orders.pop(symbol, None)
        if status == 'FILLED' and fill is not None:
            logger.info(
                f"🏷️ {symbol} TP RESTING FILL {fill.qty}@{fill.avg_price:.6f} "
                f"(saved taker fee, order {order_id[:8]}…)"
            )
            trader.on_buy_fill(
                fill_price=fill.avg_price,
                fill_qty=fill.qty,
                order_id=fill.order_id,
                fee=fill.fee,
                reason='tp',
                decision_ask=float(trader.ask or 0),
            )
            self._persist_runtime_state(symbol, trader)
        else:
            logger.debug(f"📝 {symbol} TP {status} (order {order_id[:8]}…)")

    def _schedule_tp_order(self, symbol: str, trader):
        """Schedule a persistent TP order after entry fill. Non-blocking."""
        tp = trader.tp_price
        if tp <= 0:
            return
        existing = self._resting_tp_orders.pop(symbol, None)
        if existing:
            asyncio.ensure_future(self._cancel_tp_order(symbol, existing['order_id']))
        qty = sum(l.qty for l in trader.layers)
        if qty <= 0:
            return
        self._resting_tp_orders[symbol] = {
            'order_id': None,
            'price': tp,
            'qty': qty,
            'trader': trader,
            'ts': time.time(),
            'placing': True,
        }
        asyncio.ensure_future(self._place_tp_order(symbol, trader, qty, tp))

    async def _cancel_tp_order(self, symbol: str, order_id: str):
        """Cancel a resting TP order (handles multi-slice)."""
        if not order_id:
            return
        try:
            await self.executor.cancel_order(order_id, symbol)
            logger.debug(f"✗ {symbol} TP order {order_id[:8]}… cancelled")
        except Exception:
            pass
        tp_entry = self._resting_tp_orders.get(symbol)
        if tp_entry:
            for oid in tp_entry.get('all_order_ids', []):
                if oid != order_id:
                    try:
                        await self.executor.cancel_order(oid, symbol)
                    except Exception:
                        pass

    async def _place_tp_order(self, symbol: str, trader, qty: float, price: float):
        """Place a resting GTX buy (TP) order, spread across ticks if needed."""
        try:
            info = await self.executor.get_symbol_info(symbol)
            if not info:
                self._resting_tp_orders.pop(symbol, None)
                return
            rounded_price = self.executor._round_price(price, info)
            rounded_qty = self.executor._round_qty(qty, info)
            if rounded_qty < info.min_qty:
                self._resting_tp_orders.pop(symbol, None)
                return

            bid_qty = getattr(trader, 'min_bid_qty_1m', 0.0) or getattr(trader, 'bid_qty', 0.0)
            slices = self.executor.compute_stealth_slices(
                total_qty=rounded_qty,
                base_price=rounded_price,
                price_step=info.price_step,
                l1_depth_qty=bid_qty,
                max_fraction=trader.config.stealth_max_l1_fraction,
                max_ticks=trader.config.stealth_max_ticks,
                min_qty=info.min_qty,
                direction="down",
                always_split=trader.config.stealth_always_split,
                min_slices=trader.config.stealth_min_slices,
                max_slices=trader.config.stealth_max_slices,
            )

            if len(slices) > 1:
                logger.info(
                    f"🥷 {symbol} STEALTH TP: {len(slices)} slices "
                    f"(L1 bid={bid_qty:.1f}, order={rounded_qty:.1f})"
                )

            placed_oids = []
            for slice_qty, slice_price in slices:
                s_qty = self.executor._round_qty(slice_qty, info)
                s_price = self.executor._round_price(slice_price, info)
                if s_qty < info.min_qty:
                    continue

                order = await self.executor.exchange.create_order(
                    info.symbol, 'limit', 'buy', s_qty, s_price,
                    params={'timeInForce': 'GTX', 'reduceOnly': True},
                )
                order_id = str(order.get('id', ''))
                status = order.get('status', '')
                filled = float(order.get('filled', 0) or 0)

                tp_entry = self._resting_tp_orders.get(symbol)
                if not tp_entry:
                    if order_id:
                        await self.executor.cancel_order(order_id, symbol)
                    for oid in placed_oids:
                        try:
                            await self.executor.cancel_order(oid, symbol)
                        except Exception:
                            pass
                    return

                if status == 'closed' and filled > 0:
                    logger.info(f"🏷️ {symbol} TP RESTING FILL {s_qty}@{s_price} (saved taker fee, order {order_id[:8]}…)")
                    self._resting_tp_orders.pop(symbol, None)
                    trader._pending_exit = True
                    trader._pending_order = True
                    fill_result = type('Fill', (), {'qty': filled, 'avg_price': float(order.get('average', s_price) or s_price), 'fee': float(order.get('fee', {}).get('cost', 0) or 0), 'order_id': order_id})()
                    trader.on_buy_fill(
                        fill_price=fill_result.avg_price,
                        fill_qty=fill_result.qty,
                        order_id=fill_result.order_id,
                        fee=fill_result.fee,
                        reason='tp',
                        decision_ask=float(trader.ask or 0),
                    )
                    self._persist_runtime_state(symbol, trader)
                    for oid in placed_oids:
                        try:
                            await self.executor.cancel_order(oid, symbol)
                        except Exception:
                            pass
                    return

                if status in ('canceled', 'cancelled', 'expired', 'rejected'):
                    logger.debug(f"📝 {symbol} TP slice rejected: {status}")
                    continue

                placed_oids.append(order_id)

            if placed_oids:
                tp_entry = self._resting_tp_orders.get(symbol)
                if tp_entry:
                    tp_entry['order_id'] = placed_oids[0]
                    tp_entry['all_order_ids'] = placed_oids
                    tp_entry['placing'] = False
                    tp_entry['price'] = rounded_price
                    if len(placed_oids) == 1:
                        logger.info(f"📌 {symbol} TP RESTING placed {rounded_qty}@{rounded_price} (id={placed_oids[0][:8]}…)")
                    else:
                        logger.info(f"📌 {symbol} TP RESTING placed {len(placed_oids)} slices @ {rounded_price} (ids={[o[:8] for o in placed_oids]})")
            else:
                self._resting_tp_orders.pop(symbol, None)

        except Exception as e:
            error_str = str(e)
            if 'would immediately match' in error_str.lower() or '-5022' in error_str:
                logger.debug(f"📝 {symbol} TP post-only rejected (would be taker) — will retry")
            else:
                logger.warning(f"⚠️ {symbol} TP order placement failed: {e}")
            self._resting_tp_orders.pop(symbol, None)

    async def _manage_resting_entries(self, stop: asyncio.Event):
        """Manage resting entry orders: amend prices for 8s, then reap."""
        while not stop.is_set():
            try:
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break

            now = time.time()
            for oid, entry in list(self._pending_entries.items()):
                trader = entry['trader']
                symbol = entry['symbol']
                age = now - entry['ts']

                if age > 8.0:
                    self._pending_entries.pop(oid, None)
                    trader._pending_order = False
                    if self._active_entry_orders.get(symbol) == oid:
                        del self._active_entry_orders[symbol]
                    logger.warning(f"⏰ {symbol} entry {oid[:8]}… reaped after {age:.1f}s — cancelling")
                    try:
                        await self.executor.cancel_order(oid, symbol)
                    except Exception:
                        pass
                    continue

                if age > 2.0 and not trader.signal_still_valid():
                    self._pending_entries.pop(oid, None)
                    trader._pending_order = False
                    if self._active_entry_orders.get(symbol) == oid:
                        del self._active_entry_orders[symbol]
                    logger.info(f"📉 {symbol} entry {oid[:8]}… reaped — signal reversed ({age:.1f}s)")
                    try:
                        await self.executor.cancel_order(oid, symbol)
                    except Exception:
                        pass
                    continue

                current_ask = trader.ask
                if not current_ask or current_ask <= 0:
                    continue
                last_amend_ts = entry.get('last_amend_ts', 0)
                if now - last_amend_ts < 0.5:
                    continue
                old_price = entry.get('ref_price', 0)
                if abs(current_ask - old_price) / max(old_price, 1e-20) < 1e-8:
                    continue

                new_id = await self.executor.amend_order(
                    oid, symbol, 'sell', entry['qty'], current_ask
                )
                if new_id:
                    entry['ref_price'] = current_ask
                    entry['last_amend_ts'] = now
                    entry['amend_count'] = entry.get('amend_count', 0) + 1
                    if new_id != oid:
                        self._pending_entries.pop(oid, None)
                        self._pending_entries[new_id] = entry
                        if self._active_entry_orders.get(symbol) == oid:
                            self._active_entry_orders[symbol] = new_id
                    logger.debug(
                        f"📝 {symbol} entry amended to {current_ask:.6f} "
                        f"(#{entry.get('amend_count', 0)}, age {age:.1f}s)"
                    )
                else:
                    self._pending_entries.pop(oid, None)
                    trader._pending_order = False
                    if self._active_entry_orders.get(symbol) == oid:
                        del self._active_entry_orders[symbol]
                    logger.info(f"📝 {symbol} entry {oid[:8]}… amend failed — reaping")

    async def _manage_resting_tp_orders(self, stop: asyncio.Event):
        """Manage resting TP orders: amend prices and handle fills."""
        while not stop.is_set():
            try:
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                break

            now = time.time()
            for symbol, tp in list(self._resting_tp_orders.items()):
                if tp.get('placing'):
                    continue
                order_id = tp.get('order_id')
                if not order_id:
                    continue
                trader = tp['trader']

                if not trader.layers:
                    self._resting_tp_orders.pop(symbol, None)
                    await self._cancel_tp_order(symbol, order_id)
                    continue

                if now - tp['ts'] > 30.0:
                    current_tp = trader.tp_price
                    if current_tp > 0:
                        info = await self.executor.get_symbol_info(symbol)
                        rounded_tp = self.executor._round_price(current_tp, info) if info else current_tp
                        old_price = tp.get('price', 0)
                        if abs(rounded_tp - old_price) / max(old_price, 1e-20) < 1e-8:
                            tp['ts'] = now
                            continue
                    self._resting_tp_orders.pop(symbol, None)
                    await self._cancel_tp_order(symbol, order_id)
                    self._schedule_tp_order(symbol, trader)
                    continue

                current_tp = trader.tp_price
                if current_tp <= 0:
                    continue

                info = await self.executor.get_symbol_info(symbol)
                if info:
                    rounded_tp = self.executor._round_price(current_tp, info)
                else:
                    rounded_tp = current_tp

                old_price = tp.get('price', 0)
                current_qty = sum(l.qty for l in trader.layers)
                old_qty = tp.get('qty', 0)

                price_same = abs(rounded_tp - old_price) / max(old_price, 1e-20) < 1e-8
                qty_same = abs(current_qty - old_qty) / max(old_qty, 1e-20) < 1e-6
                if price_same and qty_same:
                    continue

                new_id = await self.executor.amend_order(
                    order_id, symbol, 'buy', current_qty, rounded_tp
                )
                if new_id:
                    tp['order_id'] = new_id
                    tp['price'] = rounded_tp
                    tp['qty'] = current_qty
                    logger.debug(f"📝 {symbol} TP amended to {rounded_tp:.6f}")
                else:
                    self._resting_tp_orders.pop(symbol, None)
                    await self._cancel_tp_order(symbol, order_id)
                    self._schedule_tp_order(symbol, trader)

    async def _close_virtual_position(self, symbol: str, trader, order: dict, vp_info: dict):
        """
        Close a virtual position via the PMS REST API.
        Called when the babysitter's GridTrader emits a TP/exit order for a position
        that only exists in PMS (not on the real exchange).
        """
        import aiohttp

        vp_id = str(vp_info.get('id', ''))
        reason = order.get("reason", "BABYSITTER_TP")
        close_price = float(order.get("bid", 0) or order.get("ask", 0) or trader.bid or 0)

        if not vp_id or close_price <= 0:
            logger.warning(f"⚠️ {symbol} virtual close skipped: missing id={vp_id} or price={close_price}")
            trader._pending_order = False
            trader._pending_exit = False
            return

        pms_port = os.environ.get("PMS_PORT", "3900")
        pms_url = getattr(self.config, 'pms_api_url', None) or f"http://localhost:{pms_port}/api/bot"
        url = f"{pms_url}/babysitter/close-position"

        payload = {
            "positionId": vp_id,
            "closePrice": close_price,
            "reason": reason.upper() if reason else "BABYSITTER_TP",
        }

        logger.info(
            f"🌐 {symbol} closing virtual position {vp_id[:8]}… @ ${close_price:.6f} "
            f"(reason={reason})"
        )

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    result = await resp.json()
                    if result.get("success"):
                        logger.info(f"✅ {symbol} virtual position closed via PMS: {vp_id[:8]}…")
                        self._virtual_position_ids.pop(symbol, None)
                        trader.sync_with_exchange_position(0.0, 0.0, source="virtual_close")
                        self._resting_tp_orders.pop(symbol, None)
                        self._persist_runtime_state(symbol, trader)
                    else:
                        error = result.get("error", "unknown")
                        logger.error(f"❌ {symbol} PMS virtual close failed: {error}")
        except Exception as e:
            logger.error(f"❌ {symbol} PMS virtual close request failed: {e}")

        trader._pending_order = False
        trader._pending_exit = False

    async def _execute_order(self, trader, order: dict):
        """Execute a single order. Entries use fire-and-forget; exits use blocking 3-step."""
        if not self.executor:
            return

        action = order["action"]
        symbol = order["symbol"]
        qty = order["qty"]

        try:
            if action == "sell":
                ref_price = order.get("ref_price", trader.ask)
                est_notional = max(float(ref_price), 0.0) * max(float(qty), 0.0)
                projected = self._portfolio_total_notional() + est_notional
                if projected > self.config.max_total_notional:
                    logger.warning(
                        f"⚠️ {symbol} SKIPPED — projected portfolio ${projected:.0f} "
                        f"> cap ${self.config.max_total_notional:.0f}"
                    )
                    trader._pending_order = False
                    return

                old_oid = self._active_entry_orders.get(symbol)
                if old_oid:
                    old_entry = self._pending_entries.pop(old_oid, None)
                    if old_entry:
                        logger.info(f"🔄 {symbol} cancelling old entry {old_oid[:8]}… before new fire")
                    try:
                        await self.executor.cancel_order(old_oid, symbol)
                    except Exception:
                        pass
                    self._active_entry_orders.pop(symbol, None)

                info = await self.executor.get_symbol_info(symbol)
                ask_qty = getattr(trader, 'min_ask_qty_1m', 0.0) or getattr(trader, 'ask_qty', 0.0)
                slices = self.executor.compute_stealth_slices(
                    total_qty=qty,
                    base_price=ref_price,
                    price_step=info.price_step if info else 0,
                    l1_depth_qty=ask_qty,
                    max_fraction=trader.config.stealth_max_l1_fraction,
                    max_ticks=trader.config.stealth_max_ticks,
                    min_qty=info.min_qty if info else 0,
                    direction="up",
                    always_split=trader.config.stealth_always_split,
                    min_slices=trader.config.stealth_min_slices,
                    max_slices=trader.config.stealth_max_slices,
                )

                if len(slices) > 1:
                    logger.info(
                        f"🥷 {symbol} STEALTH entry: {len(slices)} slices "
                        f"(L1 ask={ask_qty:.1f}, order={qty:.1f})"
                    )

                first_oid = None
                any_placed = False
                for slice_qty, slice_price in slices:
                    oid = await self.executor.fire_limit_sell(symbol, slice_qty, slice_price)
                    if oid:
                        any_placed = True
                        if first_oid is None:
                            first_oid = oid
                        self._pending_entries[oid] = {
                            'symbol': symbol,
                            'trader': trader,
                            'layer_idx': order.get('layer_idx', 0),
                            'ref_price': slice_price,
                            'qty': slice_qty,
                            'ts': time.time(),
                        }

                if first_oid:
                    self._active_entry_orders[symbol] = first_oid
                if not any_placed:
                    trader._pending_order = False

            elif action == "buy":
                vp_info = self._virtual_position_ids.get(symbol)
                if vp_info:
                    await self._close_virtual_position(symbol, trader, order, vp_info)
                    return

                resting_tp = self._resting_tp_orders.pop(symbol, None)
                if resting_tp and resting_tp.get('order_id'):
                    await self._cancel_tp_order(symbol, resting_tp['order_id'])

                bid = float(order.get("bid", 0) or 0)
                ask = float(order.get("ask", 0) or 0)
                reason = order.get("reason", "unknown")
                signal_ts = float(order.get("signal_ts", 0) or 0)
                min_net_bps = float(order.get("min_net_bps", 0) or 0)
                now_ts = time.time()

                if reason in ("fast_tp", "tp"):
                    exec_ask = float(trader.ask or ask or 0)
                    if exec_ask > 0:
                        cur_net_usd, cur_net_bps = trader.estimate_close_pnl(exec_ask)
                        signal_age_ms = (now_ts - signal_ts) * 1000.0 if signal_ts > 0 else 0.0
                        stale_ms = 1200.0 if reason == "fast_tp" else 2000.0
                        if cur_net_bps < min_net_bps:
                            logger.info(
                                f"⏭️ {symbol} skip stale {reason}: now {cur_net_bps:+.2f}bp "
                                f"< min {min_net_bps:+.2f}bp (age {signal_age_ms:.0f}ms, "
                                f"est ${cur_net_usd:+.4f})"
                            )
                            trader._pending_order = False
                            trader._pending_exit = False
                            return
                        if reason == "fast_tp" and signal_age_ms > stale_ms:
                            logger.info(
                                f"⏭️ {symbol} skip stale fast_tp: signal age {signal_age_ms:.0f}ms "
                                f"(>{stale_ms:.0f}ms), waiting for re-trigger"
                            )
                            trader._pending_order = False
                            trader._pending_exit = False
                            return
                    else:
                        trader._pending_order = False
                        trader._pending_exit = False
                        return

                fill = None
                exec_bid = float(trader.bid or bid or 0)
                exec_ask = float(trader.ask or ask or 0)

                if exec_bid > 0 and reason not in ("stop", "shutdown", "drawdown", "timeout"):
                    info = await self.executor.get_symbol_info(symbol)
                    if info:
                        maker_price = exec_bid + info.price_step
                        fill = await self.executor.limit_buy(symbol, qty, maker_price)
                        if fill:
                            logger.info(f"🏷️ {symbol} MAKER EXIT {fill.qty}@{fill.avg_price:.6f} (saved taker fee)")

                if not fill and exec_ask > 0:
                    fill = await self.executor.ioc_buy(symbol, qty, exec_ask)
                    if fill:
                        logger.debug(f"📋 {symbol} IOC EXIT {fill.qty}@{fill.avg_price:.6f}")

                if not fill:
                    fill = await self.executor.market_buy(symbol, qty)

                if fill:
                    fill_qty = max(float(fill.qty), 0.0)
                    fill_price = float(fill.avg_price)
                    fill_fee = float(fill.fee)
                    fill_order_id = str(fill.order_id)

                    is_partial_tp = bool(order.get("partial_tp", False))

                    if fill_qty + 1e-9 < qty and not is_partial_tp:
                        remaining_qty = max(qty - fill_qty, 0.0)
                        logger.warning(
                            f"⚠️ {symbol} partial close {fill_qty:.6f}/{qty:.6f} via {reason}; "
                            f"forcing market close of remaining {remaining_qty:.6f}"
                        )
                        sweep = await self.executor.market_buy(symbol, remaining_qty)
                        if sweep:
                            total_qty = fill_qty + float(sweep.qty)
                            if total_qty > 0:
                                total_cost = fill_price * fill_qty + float(sweep.avg_price) * float(sweep.qty)
                                fill_price = total_cost / total_qty
                            fill_qty = total_qty
                            fill_fee += float(sweep.fee)
                            fill_order_id = f"{fill_order_id}+{sweep.order_id}"

                    if fill_qty + 1e-9 < qty and not is_partial_tp:
                        logger.error(
                            f"❌ {symbol} close incomplete after sweep ({fill_qty:.6f}/{qty:.6f}); "
                            f"syncing local grid to exchange"
                        )
                        await self._sync_trader_from_exchange(trader, symbol, source="partial_close")
                        return

                    trader.on_buy_fill(
                        fill_price=fill_price,
                        fill_qty=fill_qty,
                        order_id=fill_order_id,
                        fee=fill_fee,
                        reason=reason,
                        decision_ask=float(order.get("ask", 0) or 0),
                        partial_tp=is_partial_tp,
                        inverse_tp_zone=int(order.get("inverse_tp_zone", -1)),
                    )
                    self._persist_runtime_state(symbol, trader)
                else:
                    logger.error(f"BUY {symbol} failed ALL 3 methods — syncing local grid to exchange")
                    await self._sync_trader_from_exchange(trader, symbol, source="buy_failed")

        except Exception as e:
            logger.error(f"Order execution error {symbol}: {e}")
            trader._pending_order = False
            trader._pending_exit = False
