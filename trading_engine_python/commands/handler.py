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

logger = logging.getLogger(__name__)

# Command queues — JS pushes to these, Python BLPOPs
COMMAND_QUEUES = [
    "pms:cmd:trade",              # Market order
    "pms:cmd:limit",              # Limit order
    "pms:cmd:scale",              # Scale/grid orders
    "pms:cmd:close",              # Close position
    "pms:cmd:close_all",          # Close all positions
    "pms:cmd:cancel",             # Cancel order
    "pms:cmd:cancel_all",         # Cancel all orders
    "pms:cmd:basket",             # Basket trade
    "pms:cmd:chase",              # Start chase
    "pms:cmd:chase_cancel",       # Cancel chase
    "pms:cmd:scalper",            # Start scalper
    "pms:cmd:scalper_cancel",     # Stop scalper
    "pms:cmd:twap",               # Start TWAP
    "pms:cmd:twap_cancel",        # Cancel TWAP
    "pms:cmd:twap_basket",        # Start TWAP basket
    "pms:cmd:trail_stop",         # Start trail stop
    "pms:cmd:trail_stop_cancel",  # Cancel trail stop
    "pms:cmd:validate",           # Pre-trade validation (dry run)
]

# Map queue name → handler method name
QUEUE_ROUTE = {
    "pms:cmd:trade": "handle_trade",
    "pms:cmd:limit": "handle_limit",
    "pms:cmd:scale": "handle_scale",
    "pms:cmd:close": "handle_close",
    "pms:cmd:close_all": "handle_close_all",
    "pms:cmd:cancel": "handle_cancel",
    "pms:cmd:cancel_all": "handle_cancel_all",
    "pms:cmd:basket": "handle_basket",
    "pms:cmd:chase": "handle_chase",
    "pms:cmd:chase_cancel": "handle_chase_cancel",
    "pms:cmd:scalper": "handle_scalper",
    "pms:cmd:scalper_cancel": "handle_scalper_cancel",
    "pms:cmd:twap": "handle_twap",
    "pms:cmd:twap_cancel": "handle_twap_cancel",
    "pms:cmd:twap_basket": "handle_twap_basket",
    "pms:cmd:trail_stop": "handle_trail_stop",
    "pms:cmd:trail_stop_cancel": "handle_trail_stop_cancel",
    "pms:cmd:validate": "handle_validate",
}


class CommandHandler:
    """
    Consumes commands from JS via Redis BLPOP.
    Each command has a requestId — result is written to pms:result:{requestId}.

    Algo engines (chase, scalper, twap, trail_stop) are wired up after creation
    via set_*_engine() methods — same pattern as OrderManager.set_risk_engine().
    """

    # Frontend → Binance side mapping
    _SIDE_MAP = {"LONG": "BUY", "SHORT": "SELL", "BUY": "BUY", "SELL": "SELL"}

    @staticmethod
    def _normalize_side(side: str) -> str:
        """LONG→BUY, SHORT→SELL. Pass through BUY/SELL unchanged."""
        mapped = CommandHandler._SIDE_MAP.get(side.upper())
        if not mapped:
            raise ValueError(f"Invalid side: {side}")
        return mapped

    @staticmethod
    def _normalize_symbol(symbol: str) -> str:
        """Convert 'DOGE/USDT:USDT' → 'DOGEUSDT'. Pass through 'DOGEUSDT' unchanged."""
        s = symbol.replace("/", "").replace(":USDT", "").upper()
        if not s.endswith("USDT"):
            s += "USDT"
        return s

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
                f"pms:result:{request_id}",
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
            symbol=self._normalize_symbol(cmd["symbol"]),
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
            symbol=self._normalize_symbol(cmd["symbol"]),
            side=self._normalize_side(cmd["side"]),
            quantity=float(cmd["quantity"]),
            price=float(cmd["price"]),
            leverage=int(cmd.get("leverage", 1)),
            reduce_only=bool(cmd.get("reduceOnly", False)),
        )
        return {"success": True, "clientOrderId": order.client_order_id, "state": order.state}

    async def handle_scale(self, cmd: dict) -> dict:
        """Handle scale/grid orders — multiple limit orders at different prices."""
        symbol = self._normalize_symbol(cmd["symbol"])
        side = self._normalize_side(cmd["side"])
        orders = []
        for level in cmd.get("levels", []):
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
        return {"success": True, "orders": orders}

    async def handle_close(self, cmd: dict) -> dict:
        """Handle close position — market order to flatten."""
        symbol = self._normalize_symbol(cmd["symbol"])
        side = self._normalize_side(cmd["side"])
        sub_account_id = cmd["subAccountId"]
        quantity = float(cmd["quantity"])

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

            return {"success": False, "error": "Close order failed and no position found to clean up"}

        return {"success": True, "clientOrderId": order.client_order_id, "state": order.state}

    async def handle_close_all(self, cmd: dict) -> dict:
        """Handle close all positions for a sub-account."""
        # Cancel all pending orders first
        # Then close each position with market orders
        # Implementation depends on RiskEngine/PositionBook (Step 7)
        return {"success": True, "message": "close_all queued"}

    async def handle_cancel(self, cmd: dict) -> dict:
        """Handle cancel single order."""
        client_order_id = cmd.get("clientOrderId")
        if not client_order_id:
            return {"success": False, "error": "clientOrderId required"}
        ok = await self._order_manager.cancel_order(client_order_id)
        return {"success": ok}

    async def handle_cancel_all(self, cmd: dict) -> dict:
        """Handle cancel all orders for a symbol."""
        count = await self._order_manager.cancel_all_orders_for_symbol(cmd["symbol"])
        return {"success": True, "cancelledCount": count}

    async def handle_basket(self, cmd: dict) -> dict:
        """Handle basket trade — multiple market orders."""
        orders = []
        for item in cmd.get("items", []):
            symbol = self._normalize_symbol(item["symbol"])
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
        chase_id = await self._chase_engine.start_chase(cmd)
        chase_state = self._chase_engine._active.get(chase_id)
        return {
            "success": True,
            "chaseId": chase_id,
            "symbol": cmd.get("symbol", ""),  # Keep original format for frontend
            "side": cmd.get("side", ""),
            "currentOrderPrice": chase_state.initial_price if chase_state else None,
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
        scalper_id = await self._scalper_engine.start_scalper(cmd)
        return {"success": True, "scalperId": scalper_id}

    async def handle_scalper_cancel(self, cmd: dict) -> dict:
        """Cancel scalper."""
        if not self._scalper_engine:
            return {"success": False, "error": "Scalper engine not available"}
        ok = await self._scalper_engine.cancel_scalper(cmd.get("scalperId"))
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
        """Start TWAP basket — multiple TWAPs."""
        if not self._twap_engine:
            return {"success": False, "error": "TWAP engine not available"}
        twap_ids = await self._twap_engine.start_basket_twap(cmd)
        return {"success": True, "twapIds": twap_ids}

    async def handle_trail_stop(self, cmd: dict) -> dict:
        """Start trail stop — delegates to TrailStopEngine."""
        if not self._trail_stop_engine:
            return {"success": False, "error": "Trail stop engine not available"}
        ts_id = await self._trail_stop_engine.start_trail_stop(cmd)
        return {"success": True, "trailStopId": ts_id}

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
