#!/usr/bin/env python3
"""
V7 BRIDGE API — FastAPI server embedded in the bot process.

Exposes real-time status, strategy events, config, and control
endpoints for the Node.js platform to consume.

Runs as an asyncio task inside MultiGridRunner.run().
Port: 7700 (configurable via BRIDGE_PORT env var).
"""
import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware

logger = logging.getLogger(__name__)

BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "7700"))


def create_bridge_app(runner) -> FastAPI:
    """
    Create a FastAPI app wired to a live MultiGridRunner instance.

    Args:
        runner: A running MultiGridRunner with .traders, .config, etc.

    Returns:
        FastAPI app ready to be served by uvicorn.
    """
    app = FastAPI(
        title="V7 Bridge API",
        version="1.0.0",
        description="Real-time bridge between Python v7 bot and Node.js platform",
    )

    # Allow connections from the Node.js dev server
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ─── Health ──────────────────────────────────────────────

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "uptime_sec": time.time() - runner.start_time if runner.start_time else 0,
            "session_id": runner.session_id,
            "user_scope": getattr(runner, "user_scope", "default"),
            "live": runner.config.live,
            "traders": len(runner.traders),
            "babysitter_enabled": bool(getattr(runner, "_babysitter_enabled", True)),
        }

    # ─── Aggregated Status ───────────────────────────────────

    @app.get("/status")
    def status():
        return _build_status(runner)

    # ─── Per-Symbol Status ───────────────────────────────────

    @app.get("/status/{symbol}")
    def symbol_status(symbol: str):
        symbol = symbol.upper()
        trader = runner.traders.get(symbol)
        if not trader:
            return {"error": f"Symbol {symbol} not found", "available": list(runner.traders.keys())}
        return {
            "source": "v7",
            "user_scope": getattr(runner, "user_scope", "default"),
            "symbol": symbol,
            **trader.status_dict(),
        }

    # ─── Strategy Events ─────────────────────────────────────

    @app.get("/events")
    def events(
        limit: int = Query(50, ge=1, le=500),
        symbol: Optional[str] = None,
    ):
        buf = list(runner._strategy_event_buffer)
        if symbol:
            symbol = symbol.upper()
            buf = [e for e in buf if e.get("symbol") == symbol]
        # Return most recent first
        return buf[-limit:][::-1]

    # ─── Config ──────────────────────────────────────────────

    @app.get("/config")
    def get_config():
        """Return current RunnerConfig as a dict (read-only view)."""
        from dataclasses import asdict
        cfg = runner.config
        d = {}
        for f in cfg.__dataclass_fields__:
            val = getattr(cfg, f)
            # Sets aren't JSON-serializable
            if isinstance(val, (set, frozenset)):
                val = list(val)
            d[f] = val
        return d

    # ─── Control Commands ────────────────────────────────────

    @app.post("/control")
    async def control(body: dict):
        """
        Control commands:
          {"action": "pause_symbol", "symbol": "XYZUSDT"}
          {"action": "resume_symbol", "symbol": "XYZUSDT"}
          {"action": "disable_babysitter"}
          {"action": "enable_babysitter"}
          {"action": "stop"}  — sets the stop event
        """
        action = body.get("action", "")
        symbol = body.get("symbol", "").upper()
        requested_scope = body.get("user_scope") or body.get("scope") or ""
        if requested_scope:
            req = runner._sanitize_scope(str(requested_scope))
            own = getattr(runner, "user_scope", "default")
            if req and req != own:
                return {"ok": False, "error": f"scope mismatch: requested={req} runner={own}"}

        if action == "pause_symbol":
            trader = runner.traders.get(symbol)
            if trader:
                trader._entry_enabled = False
                return {"ok": True, "symbol": symbol, "entry_enabled": False}
            return {"ok": False, "error": f"Symbol {symbol} not found"}

        elif action == "resume_symbol":
            trader = runner.traders.get(symbol)
            if trader:
                trader._entry_enabled = True
                return {"ok": True, "symbol": symbol, "entry_enabled": True}
            return {"ok": False, "error": f"Symbol {symbol} not found"}

        elif action == "stop":
            if hasattr(runner, 'stop_event') and runner.stop_event:
                runner.stop_event.set()
                return {"ok": True, "message": "Stop signal sent"}
            return {"ok": False, "error": "No stop event available"}
        elif action == "disable_babysitter":
            runner.set_babysitter_enabled(False, source="bridge_control")
            return {"ok": True, "babysitter_enabled": False}
        elif action == "enable_babysitter":
            runner.set_babysitter_enabled(True, source="bridge_control")
            return {"ok": True, "babysitter_enabled": True}

        return {"ok": False, "error": f"Unknown action: {action}"}

    # ─── WebSocket Stream ────────────────────────────────────

    @app.websocket("/ws/stream")
    async def ws_stream(ws: WebSocket):
        """
        Real-time push of status + events to connected clients.

        Pushes frames every 2s:
          {type: "status", data: {...}}
          {type: "event", data: {...}}  (when new events arrive)
        """
        await ws.accept()
        logger.info("🔌 Bridge WS client connected")
        last_event_count = len(runner._strategy_event_buffer)

        try:
            while True:
                # Build and send status
                status_data = _build_status(runner)
                await ws.send_json({"type": "status", "data": status_data})

                # Send any new strategy events since last push
                current_count = len(runner._strategy_event_buffer)
                if current_count > last_event_count:
                    new_events = list(runner._strategy_event_buffer)[last_event_count:]
                    for evt in new_events:
                        await ws.send_json({"type": "event", "data": evt})
                    last_event_count = current_count
                elif current_count < last_event_count:
                    # Buffer wrapped around
                    last_event_count = current_count

                await asyncio.sleep(2)
        except WebSocketDisconnect:
            logger.info("🔌 Bridge WS client disconnected")
        except Exception as e:
            logger.warning(f"Bridge WS error: {e}")

    return app


def _build_status(runner) -> Dict[str, Any]:
    """
    Build the aggregated status payload from all GridTrader instances.
    Mirrors the _display_loop dashboard data structure.
    """
    now = time.time()
    elapsed = now - runner.start_time if runner.start_time else 0

    total_trades = 0
    total_pnl_bps = 0.0
    total_pnl_usd = 0.0
    total_fees = 0.0
    total_wins = 0
    active_grids = 0
    portfolio_notional = 0.0

    engines: List[Dict[str, Any]] = []

    for sym in sorted(runner.traders):
        t = runner.traders[sym]
        s = t.status_dict()

        total_trades += s["trades"]
        total_pnl_bps += s["realized_bps"]
        total_pnl_usd += s.get("realized_usd", 0)
        total_fees += s.get("total_fees", 0)
        total_wins += t.wins
        portfolio_notional += s["total_notional"]

        if s["layers"] > 0:
            active_grids += 1

        engines.append({
            "source": "v7",
            **s,
        })

    win_pct = total_wins / max(1, total_trades) * 100

    return {
        "source": "v7",
        "session_id": runner.session_id,
        "user_scope": getattr(runner, "user_scope", "default"),
        "live": runner.config.live,
        "babysitter_enabled": bool(getattr(runner, "_babysitter_enabled", True)),
        "uptime_sec": elapsed,
        "active": True,
        "pairs": len(runner.traders),
        "active_grids": active_grids,
        "portfolio_notional": portfolio_notional,
        "max_total_notional": runner.config.max_total_notional,
        "portfolio_utilization_pct": portfolio_notional / runner.config.max_total_notional * 100 if runner.config.max_total_notional > 0 else 0,
        "total_trades": total_trades,
        "total_pnl_bps": total_pnl_bps,
        "total_pnl_usd": total_pnl_usd,
        "total_fees": total_fees,
        "win_pct": win_pct,
        "engines": engines,
    }


async def start_bridge_server(runner, port: int = None):
    """
    Start the bridge API server as an asyncio task.
    Call from MultiGridRunner.run() after traders are spawned.
    """
    import uvicorn

    port = port or BRIDGE_PORT
    app = create_bridge_app(runner)

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    logger.info(f"🌉 Bridge API starting on port {port}")
    await server.serve()
