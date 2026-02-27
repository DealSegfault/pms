"""
CommandHandler — Consumes trade commands from JS via Redis BLPOP.

Flow:
    JS Express ──LPUSH──▶ Redis Queue ──BLPOP──▶ CommandHandler ──dispatch──▶ OrderManager / AlgoEngine
                                                        │
                                                        ▼
                                                  Redis SET pms:result:{requestId}
                                                        │
                                                  JS ◀──GET──┘

Symbol/Side conversion is done by JS proxy BEFORE LPUSH.
Python always receives Binance-native format: BTCUSDT, BUY/SELL.

Each command has a requestId. Result is written to pms:result:{requestId} with 30s TTL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

from contracts.common import normalize_side, normalize_symbol, RedisKey

logger = logging.getLogger(__name__)

# Command queues — JS pushes to these, Python BLPOPs
COMMAND_QUEUES = [
    RedisKey.CMD_TRADE,
    RedisKey.CMD_LIMIT,
    RedisKey.CMD_SCALE,
    RedisKey.CMD_CLOSE,
    RedisKey.CMD_CLOSE_ALL,
    RedisKey.CMD_CANCEL,
    RedisKey.CMD_CANCEL_ALL,
    RedisKey.CMD_BASKET,
    RedisKey.CMD_CHASE,
    RedisKey.CMD_CHASE_CANCEL,
    RedisKey.CMD_SCALPER,
    RedisKey.CMD_SCALPER_CANCEL,
    RedisKey.CMD_TWAP,
    RedisKey.CMD_TWAP_CANCEL,
    RedisKey.CMD_TWAP_BASKET,
    RedisKey.CMD_TWAP_BASKET_CANCEL,
    RedisKey.CMD_TRAIL_STOP,
    RedisKey.CMD_TRAIL_STOP_CANCEL,
    RedisKey.CMD_VALIDATE,
]

# Map queue name → handler method name
QUEUE_ROUTE = {
    RedisKey.CMD_TRADE: "handle_trade",
    RedisKey.CMD_LIMIT: "handle_limit",
    RedisKey.CMD_SCALE: "handle_scale",
    RedisKey.CMD_CLOSE: "handle_close",
    RedisKey.CMD_CLOSE_ALL: "handle_close_all",
    RedisKey.CMD_CANCEL: "handle_cancel",
    RedisKey.CMD_CANCEL_ALL: "handle_cancel_all",
    RedisKey.CMD_BASKET: "handle_basket",
    RedisKey.CMD_CHASE: "handle_chase",
    RedisKey.CMD_CHASE_CANCEL: "handle_chase_cancel",
    RedisKey.CMD_SCALPER: "handle_scalper",
    RedisKey.CMD_SCALPER_CANCEL: "handle_scalper_cancel",
    RedisKey.CMD_TWAP: "handle_twap",
    RedisKey.CMD_TWAP_CANCEL: "handle_twap_cancel",
    RedisKey.CMD_TWAP_BASKET: "handle_twap_basket",
    RedisKey.CMD_TWAP_BASKET_CANCEL: "handle_twap_basket_cancel",
    RedisKey.CMD_TRAIL_STOP: "handle_trail_stop",
    RedisKey.CMD_TRAIL_STOP_CANCEL: "handle_trail_stop_cancel",
    RedisKey.CMD_VALIDATE: "handle_validate",
}


class CommandHandler:
    """
    Consumes commands from JS via Redis BLPOP.
    Each command has a requestId — result is written to pms:result:{requestId}.

    Algo engines (chase, scalper, twap, trail_stop) are wired up after creation
    via set_*_engine() methods — same pattern as OrderManager.set_risk_engine().
    """

    # Side/symbol normalization now from contracts.common (single source of truth)
    _normalize_side = staticmethod(normalize_side)
    _normalize_symbol = staticmethod(normalize_symbol)

    def __init__(
        self,
        redis_client: Any,
        order_manager: Any,
        risk_engine: Any = None,
    ):
        self._redis = redis_client
        self._order_manager = order_manager
        self._risk = risk_engine
        self._running = False

        # Algo engines — wired up later (Steps 8-10)
        self._chase_engine: Any = None
        self._scalper_engine: Any = None
        self._twap_engine: Any = None
        self._trail_stop_engine: Any = None

    def set_risk_engine(self, engine: Any) -> None:
        self._risk = engine

    def set_chase_engine(self, engine: Any) -> None:
        self._chase_engine = engine

    def set_scalper_engine(self, engine: Any) -> None:
        self._scalper_engine = engine

    def set_twap_engine(self, engine: Any) -> None:
        self._twap_engine = engine

    def set_trail_stop_engine(self, engine: Any) -> None:
        self._trail_stop_engine = engine

    # ── Main Loop ──

    async def run(self) -> None:
        """Main loop — BLPOP on all command queues."""
        self._running = True
        logger.info("CommandHandler started — listening on %d queues", len(COMMAND_QUEUES))

        while self._running:
            try:
                result = await self._redis.blpop(COMMAND_QUEUES, timeout=1)
                if not result:
                    continue  # Timeout — loop back

                queue, raw = result
                queue = queue.decode() if isinstance(queue, bytes) else queue
                raw = raw.decode() if isinstance(raw, bytes) else raw

                try:
                    command = json.loads(raw)
                except json.JSONDecodeError:
                    logger.error("Invalid JSON from queue %s: %s", queue, raw[:100])
                    continue

                request_id = command.get("requestId", "unknown")
                logger.debug("Command received: queue=%s, requestId=%s", queue, request_id)

                try:
                    handler_name = QUEUE_ROUTE.get(queue)
                    if not handler_name:
                        raise ValueError(f"Unknown queue: {queue}")

                    handler = getattr(self, handler_name, None)
                    if not handler:
                        raise ValueError(f"No handler for: {handler_name}")

                    cmd_result = await handler(command)
                    await self._respond(request_id, cmd_result)

                except Exception as e:
                    logger.error("Command failed: queue=%s, requestId=%s — %s", queue, request_id, e)
                    await self._respond(request_id, {"success": False, "error": str(e)})

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("CommandHandler loop error: %s", e)
                await asyncio.sleep(1)  # Prevent tight error loop

    async def stop(self) -> None:
        """Graceful shutdown."""
        self._running = False
        logger.info("CommandHandler stopped")

    # ── Response ──

    async def _respond(self, request_id: str, result: dict) -> None:
        """Write result to Redis for JS to read. TTL 30s."""
        if request_id == "unknown":
            return
        try:
            await self._redis.set(
                RedisKey.result(request_id),
                json.dumps(result),
                ex=30,
            )
        except Exception as e:
            logger.error("Failed to write result for %s: %s", request_id, e)

    # ── Order Handlers ──

    async def handle_trade(self, cmd: dict) -> dict:
        """Handle market order."""
        order = await self._order_manager.place_market_order(
            sub_account_id=cmd["subAccountId"],
            symbol=cmd["symbol"],
            side=self._normalize_side(cmd["side"]),
            quantity=float(cmd["quantity"]),
            leverage=int(cmd.get("leverage", 1)),
            reduce_only=bool(cmd.get("reduceOnly", False)),
        )
        return {"success": True, "clientOrderId": order.client_order_id, "state": order.state}

    async def handle_limit(self, cmd: dict) -> dict:
        """Handle limit order."""
        order = await self._order_manager.place_limit_order(
            sub_account_id=cmd["subAccountId"],
            symbol=cmd["symbol"],
            side=self._normalize_side(cmd["side"]),
            quantity=float(cmd["quantity"]),
            price=float(cmd["price"]),
            leverage=int(cmd.get("leverage", 1)),
            reduce_only=bool(cmd.get("reduceOnly", False)),
        )
        return {"success": True, "clientOrderId": order.client_order_id, "state": order.state}

    async def handle_scale(self, cmd: dict) -> dict:
        """Handle scale/grid orders — multiple limit orders at different prices."""
        symbol = cmd["symbol"]
        side = self._normalize_side(cmd["side"])
        orders = []
        errors = []
        for level in cmd.get("levels", []):
            try:
                order = await self._order_manager.place_limit_order(
                    sub_account_id=cmd["subAccountId"],
                    symbol=symbol,
                    side=side,
                    quantity=float(level["quantity"]),
                    price=float(level["price"]),
                    leverage=int(cmd.get("leverage", 1)),
                    origin="BASKET",
                )
                orders.append({"clientOrderId": order.client_order_id, "price": level["price"]})
            except Exception as e:
                errors.append({"price": level["price"], "error": str(e)})
        total = len(orders) + len(errors)
        return {
            "success": len(orders) > 0,
            "placed": len(orders),
            "failed": len(errors),
            "total": total,
            "orders": orders,
            "errors": errors,
        }

    async def handle_close(self, cmd: dict) -> dict:
        """Handle close position — market order to flatten."""
        symbol = cmd["symbol"]
        side = self._normalize_side(cmd["side"])
        sub_account_id = cmd["subAccountId"]
        quantity = float(cmd["quantity"])
        position_id = cmd.get("positionId")  # JS now sends this

        order = await self._order_manager.place_market_order(
            sub_account_id=sub_account_id,
            symbol=symbol,
            side=side,
            quantity=quantity,
            reduce_only=True,
            origin="MANUAL",
        )

        if order.state == "failed":
            # Position likely doesn't exist on exchange (e.g. -2022 ReduceOnly rejected)
            # Force-clean the stale virtual position from our books
            if self._risk:
                # Find the position we were trying to close (opposite side of close order)
                pos_side = "LONG" if side == "SELL" else "SHORT"
                existing = self._risk.position_book.find_position(sub_account_id, symbol, pos_side)
                if existing:
                    await self._risk.force_close_stale_position(existing)
                    logger.warning("Force-closed stale position %s (exchange rejected reduceOnly)", existing.id[:8])
                    return {"success": True, "staleCleanup": True, "positionId": existing.id}

                # Position not in book — try direct DB cleanup using positionId from JS
                if position_id and self._risk._db:
                    try:
                        import time as _time
                        await self._risk._db.execute(
                            "UPDATE virtual_positions SET status='CLOSED', closed_at=?, realized_pnl=0 WHERE id=? AND status='OPEN'",
                            (int(_time.time() * 1000), position_id),
                        )
                        # Database.execute() auto-commits — no extra commit needed
                        logger.warning("Force-closed ghost position %s via direct DB update", position_id[:8])
                        return {"success": True, "staleCleanup": True, "positionId": position_id}
                    except Exception as e:
                        logger.error("Direct DB cleanup for %s failed: %s", position_id[:8], e)

            return {"success": False, "error": "Close order failed and no position found to clean up"}

        return {"success": True, "clientOrderId": order.client_order_id, "state": order.state}


    async def handle_close_all(self, cmd: dict) -> dict:
        """Handle close all positions for a sub-account."""
        sub_id = cmd.get("subAccountId")
        if not sub_id:
            return {"success": False, "error": "subAccountId required"}

        # 1. Cancel all pending orders first
        try:
            cancelled = await self._order_manager.cancel_all_orders_for_account(sub_id)
            logger.info("close_all: cancelled %d orders for %s", cancelled, sub_id[:8])
        except Exception as e:
            logger.error("close_all: cancel orders failed: %s", e)

        # 2. Close each open position with reduce-only market orders
        positions = self._risk.position_book.get_by_sub_account(sub_id)
        if not positions:
            return {"success": True, "closedCount": 0, "cancelledCount": cancelled if 'cancelled' in dir() else 0}

        closed = 0
        errors = []
        for pos in positions:
            close_side = "SELL" if pos.side == "LONG" else "BUY"
            try:
                order = await self._order_manager.place_market_order(
                    sub_account_id=sub_id,
                    symbol=pos.symbol,
                    side=close_side,
                    quantity=pos.quantity,
                    reduce_only=True,
                    origin="CLOSE_ALL",
                )
                closed += 1
            except Exception as e:
                errors.append(f"{pos.symbol}: {e}")
                logger.error("close_all: failed to close %s: %s", pos.symbol, e)

        return {
            "success": len(errors) == 0,
            "closedCount": closed,
            "cancelledCount": cancelled if 'cancelled' in dir() else 0,
            "errors": errors if errors else None,
        }

    async def handle_cancel(self, cmd: dict) -> dict:
        """Handle cancel single order."""
        client_order_id = cmd.get("clientOrderId")
        if not client_order_id:
            return {"success": False, "error": "clientOrderId required"}
        ok = await self._order_manager.cancel_order(client_order_id)
        return {"success": ok}

    async def handle_cancel_all(self, cmd: dict) -> dict:
        """Handle cancel all orders — for a symbol or entire account."""
        symbol = cmd.get("symbol")
        if symbol:
            count = await self._order_manager.cancel_all_orders_for_symbol(
                symbol
            )
        else:
            count = await self._order_manager.cancel_all_orders_for_account(
                cmd["subAccountId"]
            )
        return {"success": True, "cancelledCount": count}

    async def handle_basket(self, cmd: dict) -> dict:
        """Handle basket trade — multiple market orders."""
        orders = []
        for item in cmd.get("items", []):
            symbol = item["symbol"]
            side = self._normalize_side(item["side"])
            order = await self._order_manager.place_market_order(
                sub_account_id=cmd["subAccountId"],
                symbol=symbol,
                side=side,
                quantity=float(item["quantity"]),
                leverage=int(item.get("leverage", 1)),
                origin="BASKET",
            )
            orders.append({"clientOrderId": order.client_order_id, "symbol": symbol})
        return {"success": True, "orders": orders}

    # ── Algo Handlers (delegate to algo engines — Steps 8-10) ──

    async def handle_chase(self, cmd: dict) -> dict:
        """Start chase order — delegates to ChaseEngine."""
        if not self._chase_engine:
            return {"success": False, "error": "Chase engine not available"}
        # Normalize side: LONG→BUY, SHORT→SELL (matching all other handlers)
        cmd["side"] = self._normalize_side(cmd["side"])
        chase_id = await self._chase_engine.start_chase(cmd)
        chase_state = self._chase_engine._active.get(chase_id)
        return {
            "success": True,
            "chaseId": chase_id,
            "symbol": cmd.get("symbol", ""),  # Keep original format for frontend
            "side": cmd.get("side", ""),
            "currentOrderPrice": chase_state.current_order_price if chase_state else None,
            "stalkOffsetPct": chase_state.stalk_offset_pct if chase_state else 0,
            "stalkMode": chase_state.stalk_mode if chase_state else "none",
        }

    async def handle_chase_cancel(self, cmd: dict) -> dict:
        """Cancel chase order."""
        if not self._chase_engine:
            return {"success": False, "error": "Chase engine not available"}
        ok = await self._chase_engine.cancel_chase(cmd.get("chaseId"))
        return {"success": ok}

    async def handle_scalper(self, cmd: dict) -> dict:
        """Start scalper — delegates to ScalperEngine."""
        if not self._scalper_engine:
            return {"success": False, "error": "Scalper engine not available"}
        # Symbol passed through as-is (ccxt format) — same pattern as chase handler.
        # normalize_symbol would convert to Binance native (STEEMUSDT) which breaks
        # MarketData.get_l1() lookups (keyed by ccxt format STEEM/USDT:USDT).
        scalper_id = await self._scalper_engine.start_scalper(cmd)
        scalper_state = self._scalper_engine.get_state(scalper_id)
        long_count = len(scalper_state.long_slots) if scalper_state else 0
        short_count = len(scalper_state.short_slots) if scalper_state else 0
        return {
            "success": True,
            "scalperId": scalper_id,
            "symbol": cmd.get("symbol", ""),
            "startSide": cmd.get("startSide", "LONG"),
            "childCount": cmd.get("childCount", 1),
            "neutralMode": bool(cmd.get("neutralMode", False)),
            "longLayers": sum(1 for s in scalper_state.long_slots if s.chase_id) if scalper_state else 0,
            "shortLayers": sum(1 for s in scalper_state.short_slots if s.chase_id) if scalper_state else 0,
        }

    async def handle_scalper_cancel(self, cmd: dict) -> dict:
        """Cancel scalper."""
        if not self._scalper_engine:
            return {"success": False, "error": "Scalper engine not available"}
        close_positions = bool(cmd.get("closePositions", False))
        ok = await self._scalper_engine.cancel_scalper(
            cmd.get("scalperId"),
            close_positions=close_positions,
        )
        return {"success": ok}

    async def handle_twap(self, cmd: dict) -> dict:
        """Start TWAP — delegates to TWAPEngine."""
        if not self._twap_engine:
            return {"success": False, "error": "TWAP engine not available"}
        twap_id = await self._twap_engine.start_twap(cmd)
        return {"success": True, "twapId": twap_id}

    async def handle_twap_cancel(self, cmd: dict) -> dict:
        """Cancel TWAP."""
        if not self._twap_engine:
            return {"success": False, "error": "TWAP engine not available"}
        ok = await self._twap_engine.cancel_twap(cmd.get("twapId"))
        return {"success": ok}

    async def handle_twap_basket(self, cmd: dict) -> dict:
        """Start TWAP basket — grouped multi-symbol TWAPs."""
        if not self._twap_engine:
            return {"success": False, "error": "TWAP engine not available"}
        result = await self._twap_engine.start_basket_twap(cmd)
        return {"success": True, **result}

    async def handle_twap_basket_cancel(self, cmd: dict) -> dict:
        """Cancel TWAP basket — cancels all child TWAPs."""
        if not self._twap_engine:
            return {"success": False, "error": "TWAP engine not available"}
        ok = await self._twap_engine.cancel_basket_twap(cmd.get("twapBasketId"))
        return {"success": ok}

    async def handle_trail_stop(self, cmd: dict) -> dict:
        """Start trail stop — delegates to TrailStopEngine."""
        if not self._trail_stop_engine:
            return {"success": False, "error": "Trail stop engine not available"}

        # Enrich from positionId — frontend sends only positionId + callbackPct
        if "positionId" in cmd and self._risk:
            pos = self._risk.position_book.get_position(cmd["subAccountId"], cmd["positionId"])
            if not pos:
                return {"success": False, "error": f"Position {cmd['positionId']} not found"}
            cmd.setdefault("symbol", pos.symbol)
            cmd.setdefault("quantity", pos.quantity)
            cmd.setdefault("positionSide", pos.side)

        # Accept callbackPct as alias for trailPct
        if "callbackPct" in cmd and "trailPct" not in cmd:
            cmd["trailPct"] = cmd["callbackPct"]

        ts_id = await self._trail_stop_engine.start_trail_stop(cmd)
        state = self._trail_stop_engine._active.get(ts_id)
        return {
            "success": True, "trailStopId": ts_id,
            "symbol": cmd.get("symbol", ""),
            "side": cmd.get("positionSide", "LONG"),
            "callbackPct": float(cmd.get("trailPct", cmd.get("callbackPct", 1))),
            "extremePrice": state.extreme_price if state else None,
            "triggerPrice": state.trigger_price if state else None,
            "activated": state.activated if state else False,
        }

    async def handle_trail_stop_cancel(self, cmd: dict) -> dict:
        """Cancel trail stop."""
        if not self._trail_stop_engine:
            return {"success": False, "error": "Trail stop engine not available"}
        ok = await self._trail_stop_engine.cancel_trail_stop(cmd.get("trailStopId"))
        return {"success": ok}

    async def handle_validate(self, cmd: dict) -> dict:
        """
        Pre-trade validation (dry run).
        Check risk limits without placing order.
        """
        if not self._risk:
            return {"success": True, "valid": True, "message": "No risk engine — pass-through"}

        try:
            validation = await self._risk.validate_order(
                sub_account_id=cmd["subAccountId"],
                symbol=cmd["symbol"],
                side=cmd["side"],
                quantity=float(cmd["quantity"]),
                leverage=int(cmd.get("leverage", 1)),
            )
            return {"success": True, **validation}
        except Exception as e:
            return {"success": False, "valid": False, "error": str(e)}
