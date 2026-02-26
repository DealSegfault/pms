# user_stream_listener.py
import asyncio
import threading
import redis
import sys
from pathlib import Path

# Add parent directory to path to find config module
sys.path.append(str(Path(__file__).resolve().parent.parent))

# Import configuration from central config file
from config import (
    BINANCE_API_KEY, BINANCE_API_SECRET,
    REDIS_HOST, REDIS_PORT, REDIS_DB
)

# Importing the Binance classes from provided code
from exchanges.binance.binance_wss import BinanceWebsocket

def run_binance(binance_ws):
    asyncio.run(start_binance(binance_ws))

async def start_binance(binance_ws: BinanceWebsocket):
    await binance_ws.start()

async def main():
    
    redis_client = redis.StrictRedis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
    redis_client.flushdb()

    binance_ws = BinanceWebsocket(BINANCE_API_KEY, BINANCE_API_SECRET)

    binance_thread = threading.Thread(target=run_binance, args=(binance_ws,), daemon=True)
    binance_thread.start()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down user_stream_listener gracefully.")
