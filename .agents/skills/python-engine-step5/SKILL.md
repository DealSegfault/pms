---
description: Step 5 — MarketDataService wrapping existing depth handler for L1 pricing
---

# Step 5: MarketDataService (L1 from Existing Depth Handler)

## Goal
Wrap the existing `BinanceFutures` depth handler to extract L1 (best bid/ask) for the trading engine. **No new markPrice/bookTicker streams needed** — the existing `@depth@100ms` handler already provides L1.

## Prerequisites
- Read `notes/03-exchange-sync-redis-behaviors.md` → "WS Price Streaming" section
- Read `notes/04-hft-strategies-inventory.md` → "Price Tracking Strategies" section

## Source Code to Reuse

### BinanceFutures Depth Handler (ALREADY EXISTS — 285 lines)
**Read**: `trading_engine_python/market_data/exchanges/binance.py`

This already:
- Connects to `{symbol}@depth@100ms` WebSocket stream
- Maintains full L2 orderbook in-memory via `OrderBook` class
- Processes incremental updates + snapshot reconciliation
- Has watchdog, heartbeat, auto-reconnect via supervisor

### OrderBookRedisStore (ALREADY EXISTS — 92 lines)
**Read**: `trading_engine_python/market_data/exchanges/reddis_store.py`

This already stores orderbook to Redis and publishes updates.
⚠️ **Fix line 20**: Remove `self.redis_client.flushdb()` — this wipes all Redis data!

### Supervisor Pattern (ALREADY EXISTS)
**Read**: `trading_engine_python/market_data/main.py` → `supervise_pair()`

Auto-reconnect with exponential backoff.

## Files to Create

### `trading_engine_python/feeds/market_data.py`

```python
class MarketDataService:
    """
    Wraps existing BinanceFutures depth handler to provide L1.
    L1 = orderbook.bids[0] (best bid) and orderbook.asks[0] (best ask).
    
    No new streams needed — existing @depth@100ms already provides L1.
    """
    
    def __init__(self, redis_client):
        self._redis = redis_client
        self._handlers: Dict[str, BinanceFutures] = {}  # symbol → existing depth handler
        self._callbacks: Dict[str, List[Callable]] = {}  # symbol → [callbacks]
        self._last_l1: Dict[str, dict] = {}              # symbol → {bid, ask, mid, ts}
    
    async def start(self):
        """Start supervised depth handlers for all subscribed symbols"""
    
    def subscribe(self, symbol: str, callback: Callable):
        """Register callback for L1 updates. Starts depth handler if needed."""
    
    def unsubscribe(self, symbol: str, callback: Callable):
        """Remove callback. Stops depth handler if no more subscribers."""
    
    def get_l1(self, symbol: str) -> Optional[dict]:
        """Get latest cached L1 {bid, ask, mid, timestamp}"""
        return self._last_l1.get(symbol)
    
    async def _on_orderbook_update(self, symbol: str, orderbook):
        """Called when depth handler processes an update. Extract L1."""
        if not orderbook.bids or not orderbook.asks:
            return
        bid = float(orderbook.bids[0][0])  # best bid price
        ask = float(orderbook.asks[0][0])  # best ask price
        mid = (bid + ask) / 2
        ts = time.time()
        
        self._last_l1[symbol] = {"bid": bid, "ask": ask, "mid": mid, "ts": ts}
        
        # Publish to Redis (throttled 500ms)
        await self._publish_l1(symbol, bid, ask, mid, ts)
        
        # Fire callbacks — MUST be fire-and-forget to not block depth handler
        for cb in self._callbacks.get(symbol, []):
            asyncio.create_task(cb(symbol, bid, ask, mid))
```

### Redis L1 Format
```python
key = f"pms:price:{symbol}"  # e.g., pms:price:BTCUSDT (Binance native format)
value = json.dumps({"bid": bid, "ask": ask, "mid": mid, "ts": timestamp_ms, "source": "l1"})
ttl = 30  # seconds
```

### Dynamic Subscription Manager
```python
class SubscriptionManager:
    """Tracks which symbols need L1 feeds based on active positions + algos"""
    
    def update_required_symbols(self, position_symbols: Set[str], algo_symbols: Set[str]):
        """Re-evaluate subscriptions. Start/stop depth handlers as needed."""
```

## Validation
```bash
python -c "from trading_engine_python.feeds.market_data import MarketDataService; print('OK')"
```

Integration test:
```python
# Connect existing depth handler for BTCUSDT
# Verify: L1 (bid/ask/mid) arrives in Redis with correct key format
# Verify: callbacks fire on each depth update
# Verify: no @markPrice stream — only @depth@100ms
```
