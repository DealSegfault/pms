---
description: Step 2 — Async ExchangeClient wrapping existing BinanceFutures REST
---

# Step 2: ExchangeClient Wrapper

## Goal
Create an async wrapper around the existing `BinanceFutures` REST client, adding rate limiting and retry with exponential backoff.

## Prerequisites
- Step 1 complete (OrderState, OrderTracker)
- Read `notes/08-python-executor-architecture-v2.md` → "ExchangeClient" section

## Source Patterns to Reuse

### BinanceFutures REST Client (ALREADY EXISTS — 469 lines)
**Read**: `trading_engine_python/oms/exchanges/binance/binance_futures.py`

This is a **complete, working** Binance Futures REST client using the official `binance-futures-connector` library (vanilla Python, NOT ccxt). It has:
- `create_order()`, `create_limit_order()`, `create_market_order()`
- `create_stop_market_order()`, `create_take_profit_market_order()`
- `cancel_order()`, `cancel_all_orders()`
- `get_order()`, `get_open_orders()`, `get_all_orders()`
- `get_position_risk()`, `get_balance()`, `get_account_info()`
- `change_leverage()`, `change_margin_type()`

It is **synchronous** (uses `binance.um_futures.UMFutures`). Wrap with `asyncio.to_thread()`.

### RateLimiter (ALREADY EXISTS)
**Read**: `logic-money/market_maker.py` lines 49–88 (`RateLimiter` class)

Sliding window algorithm. Copy and adapt.

### Retry Pattern (ALREADY EXISTS)
**Read**: `logic-money/market_maker.py` lines 456–494 (`_place_order_with_latency`)

Exponential backoff with max 3 retries, handles network errors and retryable HTTP codes.

## Files to Create

### `trading_engine_python/orders/exchange_client.py`

```python
class ExchangeClient:
    """Async wrapper around BinanceFutures with rate limiting and retry"""
    
    def __init__(self, api_key: str, api_secret: str):
        self._client = BinanceFutures(api_key, api_secret)
        self._rate_limiter = RateLimiter(max_requests=20, window_size=1.0)
    
    # ── Order Methods ──
    
    async def create_market_order(self, symbol, side, quantity, **kwargs) -> dict:
        """Place market order. Returns exchange response dict."""
        ...
    
    async def create_limit_order(self, symbol, side, quantity, price, **kwargs) -> dict:
        """Place limit order with GTC. Returns exchange response dict."""
        ...
    
    async def cancel_order(self, symbol, orderId=None, origClientOrderId=None) -> dict:
        ...
    
    async def cancel_all_orders(self, symbol) -> dict:
        ...
    
    async def get_order(self, symbol, orderId=None) -> dict:
        ...
    
    async def get_open_orders(self, symbol=None) -> list:
        ...
    
    async def get_position_risk(self, symbol=None) -> list:
        ...
    
    async def get_balance(self) -> list:
        ...
    
    # ── Internal ──
    
    async def _execute(self, fn, *args, **kwargs):
        """Rate limit → retry → execute in thread pool"""
        await self._rate_limiter.acquire()
        return await self._with_retry(fn, *args, **kwargs)
    
    async def _with_retry(self, fn, *args, max_retries=3, base_delay=0.5, **kwargs):
        """Exponential backoff retry (from market_maker pattern)"""
        for attempt in range(max_retries):
            try:
                return await asyncio.to_thread(fn, *args, **kwargs)
            except ClientError as e:
                if e.error_code in (-1003, -1015, 429) and attempt < max_retries - 1:
                    await asyncio.sleep(base_delay * (2 ** attempt))
                    continue
                raise
            except Exception as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(base_delay * (2 ** attempt))
                    continue
                raise
```

### Key Binance Error Codes to Handle
**Read**: `server/risk/errors.js` lines 1–44 for full list

| Code | Meaning | Action |
|------|---------|--------|
| -1003 | Too many requests | Retry with backoff |
| -1015 | Too many orders | Retry with backoff |
| -2019 | Margin insufficient | Fail immediately |
| -2022 | Reduce-only rejected | Fail immediately |
| -1111 | Bad precision | Fix quantity precision, retry |
| -4003 | Quantity too small | Fail immediately |

### Config
**Read**: `trading_engine_python/oms/config.py` or `logic-money/config.py`

Load from `.env`:
```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
HTTP_PROXY=...  (optional)
HTTPS_PROXY=... (optional)
```

### Symbol Format
**IMPORTANT**: All Python code uses Binance native format: `BTCUSDT` (NOT ccxt `BTC/USDT:USDT`).
- `OrderState.symbol` stores Binance native format
- Redis price keys: `pms:price:BTCUSDT`
- Frontend converts at boundary when needed
- Depth handler WS URL uses lowercase: `btcusdt@depth@100ms`

## Validation
```bash
cd /Users/mac/cgki/minimalte
python -c "from trading_engine_python.orders.exchange_client import ExchangeClient; print('OK')"
# With real keys (manual test):
# python -c "
# from trading_engine_python.orders.exchange_client import ExchangeClient
# import asyncio
# ec = ExchangeClient('key', 'secret')
# print(asyncio.run(ec.get_balance()))
# "
```
