---
description: Step 4 — UserStreamService connecting Binance user data stream to OrderManager
---

# Step 4: UserStreamService

## Goal
Connect the Binance user data stream (ORDER_TRADE_UPDATE, ACCOUNT_UPDATE) to the OrderManager for feed-driven order state transitions.

## Prerequisites
- Step 3 complete (OrderManager with `on_order_update()`)
- Read `notes/03-exchange-sync-redis-behaviors.md` → "Proxy Stream" section

## Source Code to Reuse

### BinanceWebsocket (ALREADY EXISTS — 381 lines)
**Read**: `trading_engine_python/oms/exchanges/binance/binance_wss.py`

This file is a **complete, working** Binance user stream handler:
- `create_listen_key()` / `keep_alive_listen_key()` / `delete_listen_key()` — listen key lifecycle
- `start()` → `init_state()` → `handle_messages()` — connection loop
- `keepalive_listen_key_async()` — 30-min keepalive timer
- `handle_order_trade_update()` — parses ORDER_TRADE_UPDATE events
- `handle_account_update()` — parses ACCOUNT_UPDATE events
- `handle_trade_lite_update()` — parses TRADE_LITE events
- `map_order_data_ws()` — normalizes order data from WebSocket format
- `map_position_data_ws()` — normalizes position data
- `map_order_data_lite_ws()` — normalizes TRADE_LITE data
- `_map_order_status()` — maps Binance status strings

### Supervisor Pattern (ALREADY EXISTS)
**Read**: `trading_engine_python/market_data/main.py` → `supervise_pair()` function

Auto-reconnect with exponential backoff on disconnection.

## Architecture

```
BinanceWebsocket (existing)
    │
    ├── ORDER_TRADE_UPDATE → UserStreamService._on_order_update()
    │                             │
    │                             ▼
    │                      OrderManager.on_order_update(mapped_data)
    │
    ├── ACCOUNT_UPDATE     → UserStreamService._on_account_update()
    │                             │
    │                             ▼
    │                      RiskEngine.on_account_update(data)  [Step 7]
    │
    └── TRADE_LITE         → UserStreamService._on_trade_lite()
                                  │
                                  ▼
                           OrderManager.on_order_update(mapped_lite_data)
```

## Files to Create

### `trading_engine_python/feeds/__init__.py`
Empty `__init__.py`

### `trading_engine_python/feeds/user_stream.py`

```python
class UserStreamService:
    """
    Wraps BinanceWebsocket and routes events to OrderManager and RiskEngine.
    
    Key changes from existing binance_wss.py:
    - Instead of publishing directly to Redis, calls OrderManager callbacks
    - Adds supervisor pattern for auto-reconnect
    - Adds reconciliation fill cache (from JS proxy-stream.js)
    """
    
    def __init__(self, api_key, api_secret, order_manager, risk_engine=None):
        self._ws = BinanceWebsocket(api_key, api_secret)
        self._order_manager = order_manager
        self._risk_engine = risk_engine
        self._recent_fills = {}  # symbol → {price, timestamp, side} — bounded at 500
    
    async def start(self):
        """Start with supervisor (auto-reconnect)"""
        while True:
            try:
                await self._run()
            except Exception as e:
                logger.warning(f"User stream disconnected: {e}, reconnecting in 5s")
                await asyncio.sleep(5)
    
    async def _run(self):
        """Main connection and message loop"""
        # Override the BinanceWebsocket event handlers to route to our managers
        # Option A: Subclass BinanceWebsocket
        # Option B: Monkey-patch the handlers
        # Option C: Fork the class (recommended — it's only 381 lines)
```

### How to Integrate with Existing BinanceWebsocket

**Recommended approach**: Fork `binance_wss.py` into `feeds/user_stream.py` and modify the `handle_*` methods to call OrderManager instead of Redis. The class is only 381 lines, and you need to change ~30 lines:

1. `handle_order_trade_update()` → call `self._order_manager.on_order_update(mapped_data)`
2. `handle_account_update()` → call `self._risk_engine.on_account_update(data)` (Step 7)
3. `handle_trade_lite_update()` → call `self._order_manager.on_order_update(mapped_lite_data)`

### Fill Price Cache (from JS proxy-stream)
Maintains last fill price per symbol for reconciliation:
```python
self._recent_fills[symbol] = {
    "price": last_fill_price,
    "timestamp": time.time(),
    "side": side,
}
# Bounded at 500 entries — evict oldest when exceeded
# Entries older than 60s are stale
```

## Data Flow Verification

After this step, placing a limit order should flow:
1. `OrderManager.place_limit_order()` → REST call → state = "placing"
2. Binance sends ORDER_TRADE_UPDATE (status=NEW) via WebSocket
3. `UserStreamService._on_order_update()` → `OrderManager.on_order_update()` → state = "active"
4. When order fills: Binance sends ORDER_TRADE_UPDATE (status=FILLED)
5. `OrderManager.on_order_update()` → state = "filled" → calls `on_fill` callback

## Validation
```bash
python -c "from trading_engine_python.feeds.user_stream import UserStreamService; print('OK')"
```

Manual test (with real API keys):
```python
# Start user stream and place a test limit order far from market
# Verify: state transitions idle → placing → active → (cancel) → cancelled
```
