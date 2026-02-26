#!/usr/bin/env python3
"""
subscription_api.py - Dynamic Market Data Subscription Manager with REST API

================================================================================
LLM MANUAL - SUBSCRIPTION_API SERVICE
================================================================================

PURPOSE:
    This service provides a REST API to dynamically start/stop WebSocket 
    subscriptions to market data feeds (orderbook, trades) from various 
    cryptocurrency exchanges without restarting the service.

ENDPOINTS:
    POST /subscribe
        Start subscription to a trading pair.
        Body: {"symbol": "BTCUSDT", "exchange": "Binance"}
        Returns: {"status": "subscribed", "key": "Binance:BTCUSDT"}
    
    POST /unsubscribe  
        Stop subscription to a trading pair.
        Body: {"symbol": "BTCUSDT", "exchange": "Binance"}
        Returns: {"status": "unsubscribed", "key": "Binance:BTCUSDT"}
    
    GET /subscriptions
        List all active subscriptions.
        Returns: {"subscriptions": ["Binance:BTCUSDT", "Binance:ETHUSDT"]}
    
    GET /health
        Health check endpoint.
        Returns: {"status": "healthy", "active_count": 2}

SUPPORTED EXCHANGES:
    - Binance (BinanceFutures): Format "{TICKER}USDT" e.g. "BTCUSDT"
    - Coincall: Format "{TICKER}USD" e.g. "BTCUSD"
    - HyperLiquid: Format "{TICKER}USD" e.g. "BTCUSD"
    - Orderly: Format "{TICKER}USD" e.g. "BTCUSD"

USAGE EXAMPLES:
    # Start the service
    python subscription_api.py
    
    # Subscribe to BTCUSDT on Binance
    curl -X POST http://localhost:8888/subscribe \
         -H "Content-Type: application/json" \
         -d '{"symbol": "BTCUSDT", "exchange": "Binance"}'
    
    # Unsubscribe
    curl -X POST http://localhost:8888/unsubscribe \
         -H "Content-Type: application/json" \
         -d '{"symbol": "BTCUSDT", "exchange": "Binance"}'
    
    # List active subscriptions
    curl http://localhost:8888/subscriptions

ARCHITECTURE:
    - Uses aiohttp for async HTTP server (lightweight, no external deps beyond std)
    - Each subscription runs as a supervised asyncio.Task with auto-reconnect
    - Thread-safe subscription dict with asyncio locks
    - Graceful shutdown on SIGINT/SIGTERM

CONFIGURATION:
    - API_HOST: Host to bind (default: "0.0.0.0")
    - API_PORT: Port to listen (default: 8888)

================================================================================
"""

import asyncio
import sys
import signal
import logging
from typing import Dict, Optional
from dataclasses import dataclass, field

# aiohttp for lightweight async REST server
from aiohttp import web

# Import exchange handlers
sys.path.insert(0, '..')
try:
    import config as root_config
except ImportError:
    root_config = None

from exchanges.coincall import Coincall
from exchanges.binance import BinanceFutures
from exchanges.hyperliquid import HyperLiquid
from exchanges.orderly import Orderly
from exchanges.exceptions import FeedCorrupted

# Configuration
API_HOST = "0.0.0.0"
API_PORT = 8888

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
log = logging.getLogger("subscription_api")


@dataclass
class Subscription:
    """Represents an active subscription with its handler and task."""
    exchange: str
    symbol: str
    task: Optional[asyncio.Task] = None
    handler: Optional[object] = None
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)


class SubscriptionManager:
    """
    Manages dynamic market data subscriptions.
    
    Thread-safe async manager that tracks active WebSocket subscriptions
    to various exchanges. Supports dynamic start/stop of subscriptions
    via REST API without service restart.
    
    Attributes:
        subscriptions: Dict mapping "Exchange:Symbol" keys to Subscription objects
        lock: Asyncio lock for thread-safe subscription modification
    """
    
    def __init__(self):
        self.subscriptions: Dict[str, Subscription] = {}
        self.lock = asyncio.Lock()
    
    def _make_key(self, exchange: str, symbol: str) -> str:
        """Create unique subscription key from exchange and symbol."""
        return f"{exchange}:{symbol}"
    
    async def _create_handler(self, exchange: str, symbol: str):
        """
        Factory method to create exchange-specific handler.
        
        Args:
            exchange: Exchange name (Binance, Coincall, HyperLiquid, Orderly)
            symbol: Trading pair symbol (e.g., BTCUSDT)
            
        Returns:
            Exchange handler instance
            
        Raises:
            ValueError: If exchange is not supported
        """
        if exchange == 'Binance':
            return BinanceFutures(symbol)
        elif exchange == 'Coincall':
            if not root_config:
                raise ValueError("Coincall requires API credentials in root config")
            return Coincall(symbol, root_config.COINCALL_API_KEY, root_config.COINCALL_API_SECRET)
        elif exchange == 'HyperLiquid':
            return HyperLiquid(symbol)
        elif exchange == 'Orderly':
            return Orderly(symbol)
        else:
            raise ValueError(f"Unknown exchange: {exchange}")
    
    async def _supervise_subscription(self, sub: Subscription) -> None:
        """
        Supervisor coroutine for a single subscription.
        
        Runs the exchange handler with automatic reconnection on failure.
        Uses exponential backoff between reconnection attempts.
        Exits cleanly when stop_event is set.
        
        Args:
            sub: Subscription object to supervise
        """
        backoff = 1
        key = self._make_key(sub.exchange, sub.symbol)
        
        while not sub.stop_event.is_set():
            try:
                sub.handler = await self._create_handler(sub.exchange, sub.symbol)
                log.info(f"[{key}] Connecting...")
                await sub.handler.connect()
                
                try:
                    await sub.handler.run()
                except NotImplementedError:
                    # Handler doesn't implement run(), keep connection alive
                    log.debug(f"[{key}] run() not implemented, holding connection")
                    await sub.stop_event.wait()
                    
            except asyncio.CancelledError:
                log.info(f"[{key}] Subscription cancelled")
                break
            except Exception as e:
                if sub.stop_event.is_set():
                    break
                log.warning(f"[{key}] Error: {type(e).__name__} - reconnecting in {backoff}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
        
        # Cleanup
        if sub.handler:
            try:
                await sub.handler.close()
            except Exception:
                pass
        log.info(f"[{key}] Subscription stopped")
    
    async def subscribe(self, exchange: str, symbol: str) -> tuple[bool, str]:
        """
        Start a new subscription.
        
        Args:
            exchange: Exchange name
            symbol: Trading pair symbol
            
        Returns:
            Tuple of (success, message)
        """
        key = self._make_key(exchange, symbol)
        
        async with self.lock:
            if key in self.subscriptions:
                return False, f"Already subscribed to {key}"
            
            sub = Subscription(exchange=exchange, symbol=symbol)
            sub.task = asyncio.create_task(self._supervise_subscription(sub))
            self.subscriptions[key] = sub
            
        log.info(f"Started subscription: {key}")
        return True, key
    
    async def unsubscribe(self, exchange: str, symbol: str) -> tuple[bool, str]:
        """
        Stop an existing subscription.
        
        Args:
            exchange: Exchange name
            symbol: Trading pair symbol
            
        Returns:
            Tuple of (success, message)
        """
        key = self._make_key(exchange, symbol)
        
        async with self.lock:
            if key not in self.subscriptions:
                return False, f"Not subscribed to {key}"
            
            sub = self.subscriptions.pop(key)
            sub.stop_event.set()
            if sub.task:
                sub.task.cancel()
                try:
                    await asyncio.wait_for(sub.task, timeout=5.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
        
        log.info(f"Stopped subscription: {key}")
        return True, key
    
    async def list_subscriptions(self) -> list[str]:
        """
        Get list of active subscription keys.
        
        Returns:
            List of "Exchange:Symbol" strings
        """
        async with self.lock:
            return list(self.subscriptions.keys())
    
    async def shutdown(self) -> None:
        """Stop all subscriptions gracefully."""
        log.info("Shutting down all subscriptions...")
        async with self.lock:
            for key, sub in list(self.subscriptions.items()):
                sub.stop_event.set()
                if sub.task:
                    sub.task.cancel()
            
            tasks = [sub.task for sub in self.subscriptions.values() if sub.task]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self.subscriptions.clear()


# Global manager instance
manager = SubscriptionManager()


# ============================================================================
# REST API Handlers
# ============================================================================

async def handle_subscribe(request: web.Request) -> web.Response:
    """
    POST /subscribe - Start subscription to a trading pair.
    
    Request body:
        {"symbol": "BTCUSDT", "exchange": "Binance"}
    
    Response:
        200: {"status": "subscribed", "key": "Binance:BTCUSDT"}
        400: {"error": "Missing required fields"}
        409: {"error": "Already subscribed to Binance:BTCUSDT"}
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    symbol = data.get("symbol")
    exchange = data.get("exchange")
    
    if not symbol or not exchange:
        return web.json_response(
            {"error": "Missing required fields: symbol, exchange"},
            status=400
        )
    
    success, result = await manager.subscribe(exchange, symbol)
    
    if success:
        return web.json_response({"status": "subscribed", "key": result})
    else:
        return web.json_response({"error": result}, status=409)


async def handle_unsubscribe(request: web.Request) -> web.Response:
    """
    POST /unsubscribe - Stop subscription to a trading pair.
    
    Request body:
        {"symbol": "BTCUSDT", "exchange": "Binance"}
    
    Response:
        200: {"status": "unsubscribed", "key": "Binance:BTCUSDT"}
        400: {"error": "Missing required fields"}
        404: {"error": "Not subscribed to Binance:BTCUSDT"}
    """
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    symbol = data.get("symbol")
    exchange = data.get("exchange")
    
    if not symbol or not exchange:
        return web.json_response(
            {"error": "Missing required fields: symbol, exchange"},
            status=400
        )
    
    success, result = await manager.unsubscribe(exchange, symbol)
    
    if success:
        return web.json_response({"status": "unsubscribed", "key": result})
    else:
        return web.json_response({"error": result}, status=404)


async def handle_list_subscriptions(request: web.Request) -> web.Response:
    """
    GET /subscriptions - List all active subscriptions.
    
    Response:
        200: {"subscriptions": ["Binance:BTCUSDT", "Binance:ETHUSDT"]}
    """
    subs = await manager.list_subscriptions()
    return web.json_response({"subscriptions": subs})


async def handle_health(request: web.Request) -> web.Response:
    """
    GET /health - Health check endpoint.
    
    Response:
        200: {"status": "healthy", "active_count": 2}
    """
    subs = await manager.list_subscriptions()
    return web.json_response({
        "status": "healthy",
        "active_count": len(subs)
    })


# ============================================================================
# Application Setup
# ============================================================================

def create_app() -> web.Application:
    """
    Create and configure the aiohttp application.
    
    Returns:
        Configured web.Application instance
    """
    app = web.Application()
    
    app.router.add_post('/subscribe', handle_subscribe)
    app.router.add_post('/unsubscribe', handle_unsubscribe)
    app.router.add_get('/subscriptions', handle_list_subscriptions)
    app.router.add_get('/health', handle_health)
    
    return app


async def run_server() -> None:
    """
    Run the HTTP server and handle graceful shutdown.
    """
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    
    site = web.TCPSite(runner, API_HOST, API_PORT)
    await site.start()
    
    log.info(f"🚀 Subscription API running on http://{API_HOST}:{API_PORT}")
    log.info("Endpoints: POST /subscribe, POST /unsubscribe, GET /subscriptions, GET /health")
    
    # Wait for shutdown signal
    stop_event = asyncio.Event()
    
    def signal_handler():
        log.info("Shutdown signal received")
        stop_event.set()
    
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)
    
    await stop_event.wait()
    
    # Graceful shutdown
    await manager.shutdown()
    await runner.cleanup()
    log.info("Server stopped")


if __name__ == "__main__":
    try:
        import uvloop
        uvloop.install()
    except ImportError:
        pass
    
    asyncio.run(run_server())
