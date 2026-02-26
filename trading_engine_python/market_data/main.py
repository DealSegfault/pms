import asyncio
import sys
import uvloop
import logging
import websockets
import settings.config as config

sys.path.append('..')

import config as root_config
from exchanges.binance import BinanceFutures
from exchanges.exceptions import FeedCorrupted

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

async def start_handler(exchange_name, symbol):
    """Initialize a handler for a given symbol."""
    log.info(f"Connecting to {exchange_name} {symbol}...")
    
    if exchange_name == 'Binance':
        handler = BinanceFutures(symbol)
    else:
        raise ValueError(f"Unknown exchange: {exchange_name}")
        
    return handler

async def safe_close(handler):
    """Safely close a handler, catching any exceptions"""
    if handler:
        try:
            await handler.close()
        except Exception as e:
            log.error(f"Error closing handler: {e}")

async def supervise_pair(exchange: str, symbol: str) -> None:
    """Supervise a single exchange/symbol pair with automatic restart on failure"""
    backoff = 1  # seconds
    while True:
        handler = None
        try:
            handler = await start_handler(exchange, symbol)
            await handler.connect()
            
            try:
                await handler.run()  # This should block until an error occurs
            except NotImplementedError:
                # Handle the case where run() is not implemented
                log.error(f"{exchange}/{symbol}: run() method not implemented in {handler.__class__.__name__}")
                # Fall back to the old behavior - just keep connection open
                await asyncio.Event().wait()  # Wait forever
                
        except (FeedCorrupted, 
                ConnectionError,
                websockets.ConnectionClosedError,
                websockets.ConnectionClosedOK,
                websockets.WebSocketException,
                asyncio.TimeoutError) as exc:
            log.warning(f"{exchange}/{symbol} feed corrupted: {type(exc).__name__} - restarting in {backoff}s")
            if log.isEnabledFor(logging.DEBUG):
                log.debug(f"Detailed error for {exchange}/{symbol}: {exc}")
            await safe_close(handler)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)  # exponential back-off
        except Exception as e:
            # Don't log the full exception traceback for cleaner logs
            log.error(f"Unexpected failure for {exchange}/{symbol}: {type(e).__name__}: {e}")
            await safe_close(handler)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)  # More aggressive backoff for unexpected errors
        else:
            # Clean exit - unlikely but reset back-off
            backoff = 1

async def main():
    log.info("Starting market data supervision...")
    
    # Use TaskGroup for proper supervision (Python 3.11+)
    async with asyncio.TaskGroup() as tg:
        for exchange_name, symbols in config.TRADING_PAIRS.items():
            for symbol in symbols:
                tg.create_task(supervise_pair(exchange_name, symbol))

if __name__ == "__main__":
    try:
        uvloop.install()
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Keyboard interrupt received, shutting down...")
        sys.exit(0)