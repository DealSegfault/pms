# JS Cleanup Plan — Thin Gateway

> After Python handles all trading logic, JS becomes a thin gateway.  
> This documents exactly what to KEEP, what to DELETE, and what to MODIFY.

---

## JS Role After Migration

```
JS = Auth + API routing + WebSocket proxy + Admin UI
     │
     ├── Receives HTTP requests from frontend
     ├── Forwards trade commands to Python via Redis LPUSH
     ├── Waits for results via Redis GET (pms:result:{requestId})
     ├── Subscribes to Redis PUB/SUB for live events
     ├── Forwards events to frontend via WebSocket
     └── Handles auth, subaccounts, admin rules, history queries
```

---

## Files to KEEP (unchanged)

| File | Reason |
|------|--------|
| `server/auth.js` | Authentication, JWT, session management |
| `server/routes/auth.js` | Login/register routes |
| `server/routes/webauthn.js` | WebAuthn registration/login |
| `server/routes/admin.js` | Admin panel routes |
| `server/routes/sub-accounts.js` | Sub-account CRUD |
| `server/routes/risk-rules.js` | Risk rules CRUD (Python reads these from DB) |
| `server/routes/history.js` | Trade history queries (reads DB) |
| `server/db/prisma.js` | Prisma client (still used for reads) |
| `server/ownership.js` | Auth middleware for sub-accounts |
| `server/sanitize.js` | Input sanitization |
| `server/ws.js` | WebSocket server (MODIFIED — see below) |
| `server/bounded-map.js` | Utility |
| `server/recent-close.js` | Utility |

---

## Files to DELETE

| File | Lines | Reason |
|------|-------|--------|
| `server/risk/index.js` | 489 | Entire risk engine → Python |
| `server/risk/trade-executor.js` | 1155 | Trade execution → Python |
| `server/risk/trade-validator.js` | 142 | Trade validation → Python |
| `server/risk/liquidation.js` | 671 | Liquidation logic → Python |
| `server/risk/position-book.js` | 176 | In-memory tracking → Python |
| `server/risk/price-service.js` | 116 | Price resolution → Python |
| `server/risk/risk-math.js` | 102 | Pure math → Python |
| `server/risk/errors.js` | 44 | Error codes → Python |
| `server/routes/trading/chase-limit.js` | 1040 | Chase engine → Python |
| `server/routes/trading/scalper.js` | 1509 | Scalper engine → Python |
| `server/routes/trading/twap.js` | 1094 | TWAP engine → Python |
| `server/routes/trading/trail-stop.js` | 462 | Trail stop → Python |
| `server/routes/trading/pump-chaser.js` | 1317 | SURF engine → Python |
| `server/routes/trading/helpers.js` | 284 | Smart index helpers → Python |
| `server/routes/trading/analytics.js` | ? | Analytics → Python or keep if read-only |
| `server/order-sync.js` | 487 | Order sync → Python (user stream handles this) |
| `server/position-sync.js` | 135 | Position sync → Python |
| `server/proxy-stream.js` | 382 | User stream → Python |
| `server/exchange.js` | 787 | Exchange connector → Python |
| **Total** | **~10,392** | **Lines of trading code removed from JS** |

---

## Files to MODIFY

### `server/routes/trading/market-orders.js` → Thin Proxy
**Before** (461 lines): Direct calls to `riskEngine.executeTrade()`, `riskEngine.closePosition()`, DB queries for positions/history.

**After** (~80 lines):
```javascript
// POST /api/trade — Forward to Python
router.post('/', requireOwnership('body'), async (req, res) => {
    const requestId = uuidv4();
    await redis.lpush('pms:cmd:trade', JSON.stringify({
        requestId,
        subAccountId: req.body.subAccountId,
        symbol: req.body.symbol,
        side: req.body.side,
        quantity: req.body.quantity,
        leverage: req.body.leverage,
        fallbackPrice: req.body.fallbackPrice,
        reduceOnly: req.body.reduceOnly,
    }));
    
    // Wait for Python to process (blocking GET with timeout)
    const result = await waitForResult(requestId, 5000);
    if (!result) return res.status(504).json({ error: 'Execution timeout' });
    
    res.status(result.success ? 201 : 400).json(result);
});

// GET /api/trade/positions/:subAccountId — Read from Redis snapshot
router.get('/positions/:subAccountId', requireOwnership(), async (req, res) => {
    const snapshot = await redis.get(`pms:risk:${req.params.subAccountId}`);
    if (snapshot) return res.json(JSON.parse(snapshot));
    // Fallback to DB query
    ...
});
```

### `server/routes/trading/limit-orders.js` → Thin Proxy
**After** (~60 lines):
- `POST /limit` → `redis.lpush('pms:cmd:limit', ...)`
- `POST /scale` → `redis.lpush('pms:cmd:scale', ...)`
- `DELETE /orders/:id` → `redis.lpush('pms:cmd:cancel', ...)`
- `GET /orders/:subAccountId` → DB query (Prisma, read-only)

### `server/routes/trading/basket.js` → Thin Proxy
**After** (~20 lines):
- `POST /basket` → `redis.lpush('pms:cmd:basket', ...)`

### `server/ws.js` → Add Redis Subscriber
**Before**: Receives broadcast calls from risk engine directly.
**After**: Subscribes to Redis pub/sub channels and forwards to frontend.

```javascript
// Add Redis subscriber alongside existing WebSocket server
import { createClient } from 'redis';

const sub = createClient({ url: process.env.REDIS_URL });
await sub.connect();

// Subscribe to all PMS event channels
await sub.pSubscribe('pms:events:*', (message, channel) => {
    const data = JSON.parse(message);
    const type = channel.replace('pms:events:', '');
    broadcast(type, data);
});
```

### `server/routes/trading/index.js` → Simplified Hub
```javascript
import marketOrdersRouter from './market-orders.js';
import limitOrdersRouter from './limit-orders.js';
import basketRouter from './basket.js';
// All algo routes become simple proxies
import algoRouter from './algos.js';   // single file for chase/scalper/twap/trail/surf

const router = Router();
router.use(marketOrdersRouter);
router.use(limitOrdersRouter);
router.use(basketRouter);
router.use(algoRouter);

export default router;
```

### `server/routes/trading/algos.js` — NEW single file for all algo proxies
```javascript
// ~60 lines total — all algo routes are just Redis LPUSH + wait for result
router.post('/chase-limit', requireOwnership('body'), proxyToRedis('pms:cmd:chase'));
router.delete('/chase-limit/:id', proxyToRedis('pms:cmd:chase_cancel'));
router.get('/chase-limit/active/:subAccountId', async (req, res) => { ... });

router.post('/scalper', requireOwnership('body'), proxyToRedis('pms:cmd:scalper'));
router.delete('/scalper/:id', proxyToRedis('pms:cmd:scalper_cancel'));

router.post('/twap', requireOwnership('body'), proxyToRedis('pms:cmd:twap'));
router.post('/twap-basket', requireOwnership('body'), proxyToRedis('pms:cmd:twap_basket'));
router.delete('/twap/:id', proxyToRedis('pms:cmd:twap_cancel'));

router.post('/trail-stop', requireOwnership('body'), proxyToRedis('pms:cmd:trail_stop'));
router.delete('/trail-stop/:id', proxyToRedis('pms:cmd:trail_stop_cancel'));

router.post('/pump-chaser', requireOwnership('body'), proxyToRedis('pms:cmd:surf'));
router.delete('/pump-chaser/:id', proxyToRedis('pms:cmd:surf_cancel'));
```

### `server/index.js` → Remove Trading Engine Init
**Remove**:
- `import riskEngine from './risk/index.js'`
- `riskEngine.startMonitoring()`
- `startOrderSync()`
- `startPositionSync()`
- `startProxyStream()`
- `resumeActiveTwaps()`
- `resumeActiveTrailStops()`

**Add**:
- Redis subscriber initialization
- Health check for Python process availability

---

## Migration Safety: Running Both Systems

During migration, we can run both systems in parallel:

1. **Phase A**: Python handles feeds + publishes prices to Redis (JS stops its WS streams)
2. **Phase B**: Python handles trade execution (JS forwards via Redis instead of calling risk engine directly)
3. **Phase C**: Python handles all algos (JS algo routes become proxies)
4. **Phase D**: Delete JS trading code

Each phase:
- Deploy Python component
- Verify via Redis monitoring that events flow correctly
- Switch JS to use Redis instead of direct calls
- Monitor for 24h
- Move to next phase

---

## Result: JS Server Size

| Metric | Before | After |
|--------|--------|-------|
| Total JS trading code | ~10,400 lines | ~200 lines (proxies) |
| Files in `server/risk/` | 8 files | 0 files |
| Files in `server/routes/trading/` | 12 files | 4 files |
| External dependencies (ccxt, ws) | Exchange heavy | None (Redis only) |
| Process responsibility | Everything | Auth + routing + WS proxy |
