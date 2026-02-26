---
description: Step 6 — CommandHandler consuming Redis commands from JS
---

# Step 6: CommandHandler (Redis BLPOP)

## Goal
Consume trade commands from JS via Redis queues and dispatch to OrderManager/AlgoEngines.

## Prerequisites
- Steps 1–5 complete
- Read `notes/08-python-executor-architecture-v2.md` → "Layer 5: Command Handler" section
- Read `notes/06-frontend-api-requests.md` — every field in every request body

## Architecture

```
JS Express ──LPUSH──▶ Redis Queue ──BLPOP──▶ CommandHandler ──dispatch──▶ OrderManager / AlgoEngine
                                                    │
                                                    ▼
                                              Redis SET pms:result:{requestId}
                                                    │
                                              JS ◀──GET──┘
```

## Files to Create

### `trading_engine_python/commands/__init__.py`
Empty

### `trading_engine_python/commands/handler.py`

```python
class CommandHandler:
    """
    Consumes commands from JS via Redis BLPOP.
    Each command has a requestId — result is written to pms:result:{requestId}.
    """
    
    QUEUES = [
        "pms:cmd:trade",          # Market order
        "pms:cmd:limit",          # Limit order
        "pms:cmd:scale",          # Scale/grid orders
        "pms:cmd:close",          # Close position
        "pms:cmd:close_all",      # Close all positions
        "pms:cmd:cancel",         # Cancel order
        "pms:cmd:cancel_all",     # Cancel all orders
        "pms:cmd:basket",         # Basket trade
        "pms:cmd:chase",          # Start chase
        "pms:cmd:chase_cancel",   # Cancel chase
        "pms:cmd:scalper",        # Start scalper
        "pms:cmd:scalper_cancel", # Stop scalper
        "pms:cmd:twap",           # Start TWAP
        "pms:cmd:twap_cancel",    # Cancel TWAP
        "pms:cmd:twap_basket",    # Start TWAP basket
        "pms:cmd:trail_stop",     # Start trail stop
        "pms:cmd:trail_stop_cancel", # Cancel trail stop
        "pms:cmd:validate",       # Pre-trade validation (dry run)
    ]
    
    async def run(self):
        """Main loop — BLPOP on all command queues"""
        while True:
            result = await self._redis.blpop(self.QUEUES, timeout=1)
            if not result:
                continue
            queue, raw = result
            queue = queue.decode() if isinstance(queue, bytes) else queue
            command = json.loads(raw)
            request_id = command.get("requestId", "unknown")
            
            try:
                handler_name = self._route(queue)
                handler = getattr(self, handler_name)
                result = await handler(command)
                await self._respond(request_id, result)
            except Exception as e:
                await self._respond(request_id, {"success": False, "error": str(e)})
    
    async def _respond(self, request_id: str, result: dict):
        """Write result to Redis for JS to read"""
        await self._redis.set(f"pms:result:{request_id}", json.dumps(result), ex=30)
    
    # ── Handlers ──
    
    async def handle_trade(self, cmd: dict) -> dict:
        """
        Handle market order.
        cmd fields (from notes/06-frontend-api-requests.md → POST /api/trade):
        - subAccountId (required)
        - symbol (required, ccxt format from frontend → convert to Binance)
        - side (required, LONG or SHORT → convert to BUY or SELL)
        - quantity (required)
        - leverage (required)
        - reduceOnly (optional)
        """
        # 1. Convert ccxt symbol → Binance symbol
        # 2. Convert LONG/SHORT → BUY/SELL
        # 3. Validate via risk engine (if available)
        # 4. Place via OrderManager
        # 5. Return result
    
    async def handle_limit(self, cmd: dict) -> dict: ...
    async def handle_close(self, cmd: dict) -> dict: ...
    async def handle_cancel(self, cmd: dict) -> dict: ...
    async def handle_chase(self, cmd: dict) -> dict: ...
    async def handle_scalper(self, cmd: dict) -> dict: ...
    async def handle_twap(self, cmd: dict) -> dict: ...
    async def handle_trail_stop(self, cmd: dict) -> dict: ...
    async def handle_validate(self, cmd: dict) -> dict: ...
```

### Symbol Format

**All Python code uses Binance native format: `BTCUSDT`.**

Frontend/JS may send ccxt format (`BTC/USDT:USDT`). The JS proxy layer should convert BEFORE pushing to Redis:
```javascript
// In JS thin proxy, before LPUSH:
const binanceSymbol = req.body.symbol.split('/')[0] + req.body.symbol.split('/')[1].split(':')[0];
// BTC/USDT:USDT → BTCUSDT
```

Python never needs to convert — it always receives `BTCUSDT` from Redis.

### Side Format
Frontend uses `LONG`/`SHORT`. JS proxy converts before LPUSH:
```javascript
const binanceSide = req.body.side === 'LONG' ? 'BUY' : 'SELL';
```
Python always receives `BUY`/`SELL`.

### JS Side Changes (for reference)

JS trading routes need to change from:
```javascript
// Before: direct risk engine call
const result = await riskEngine.executeTrade({ symbol, side, quantity, leverage });
```
To:
```javascript
// After: Redis command
const requestId = uuidv4();
await redis.lpush('pms:cmd:trade', JSON.stringify({ requestId, subAccountId, symbol, side, quantity, leverage }));
const result = await waitForResult(requestId, 5000);
```

The `waitForResult()` helper:
```javascript
async function waitForResult(requestId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await redis.get(`pms:result:${requestId}`);
        if (result) {
            await redis.del(`pms:result:${requestId}`);
            return JSON.parse(result);
        }
        await new Promise(r => setTimeout(r, 50));  // Poll every 50ms
    }
    return null;  // Timeout
}
```

## Validation
```bash
python -c "from trading_engine_python.commands.handler import CommandHandler; print('OK')"
```

Integration test:
```bash
# Terminal 1: Start command handler
# Terminal 2: Push a test command
redis-cli LPUSH pms:cmd:validate '{"requestId":"test1","subAccountId":"sub1","symbol":"BTC/USDT:USDT","side":"LONG","quantity":0.001,"leverage":10}'
# Terminal 2: Read result
redis-cli GET pms:result:test1
```
