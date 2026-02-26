---
description: Step 11 — JS cleanup to thin gateway
---

# Step 11: JS Cleanup

## Goal
Strip JS server to thin gateway: auth, routing, WS proxy, admin. Remove all trading logic.

## Prerequisites
- Steps 1–10 complete (Python engine handles all trading)
- Read `notes/09-js-cleanup-plan.md` — complete file-by-file plan

## Changes Summary

### 1. Add Redis Event Subscriber to `server/ws.js`

Replace direct `broadcast()` calls with Redis PUB/SUB subscriber:

```javascript
import { createClient } from 'redis';

const sub = createClient({ url: process.env.REDIS_URL });
await sub.connect();

// Subscribe to all PMS event channels from Python
await sub.pSubscribe('pms:events:*', (message, channel) => {
    const data = JSON.parse(message);
    const type = channel.replace('pms:events:', '');
    broadcast(type, data);
});
```

### 2. Convert Trading Routes to Redis Proxies

Each route becomes a thin proxy:
```javascript
async function proxyToRedis(queue, req, res, extractFields) {
    const requestId = uuidv4();
    const command = { requestId, ...extractFields(req) };
    await redis.lpush(queue, JSON.stringify(command));
    
    const result = await waitForResult(requestId, 5000);
    if (!result) return res.status(504).json({ error: 'Execution timeout' });
    res.status(result.success ? 201 : 400).json(result);
}
```

### 3. Files to DELETE
**Read**: `notes/09-js-cleanup-plan.md` → "Files to DELETE" table

All files in `server/risk/` (8 files, ~2,895 lines)
All engine files in `server/routes/trading/` (chase, scalper, twap, trail-stop, pump-chaser, helpers)
`server/exchange.js`, `server/order-sync.js`, `server/position-sync.js`, `server/proxy-stream.js`

### 4. Files to MODIFY
**Read**: `notes/09-js-cleanup-plan.md` → "Files to MODIFY" section

- `server/routes/trading/market-orders.js` → thin proxy (~80 lines)
- `server/routes/trading/limit-orders.js` → thin proxy (~60 lines)
- `server/routes/trading/basket.js` → thin proxy (~20 lines)
- `server/routes/trading/index.js` → simplified hub
- `server/index.js` → remove risk engine init, add Redis subscriber

### 5. Update `server/index.js` — Remove:
```diff
- import riskEngine from './risk/index.js';
- import exchange from './exchange.js';
- import { startOrderSync } from './order-sync.js';
- import { startPositionSync } from './position-sync.js';
- import { startProxyStream } from './proxy-stream.js';
- riskEngine.startMonitoring();
- startOrderSync();
- startPositionSync();
- startProxyStream();
```

## Testing After Cleanup

1. Start Python engine
2. Start JS server
3. Verify: place a market order from frontend → arrives in Python via Redis → executes → result comes back
4. Verify: WS events arrive on frontend (pnl_update, margin_update, order_filled)
5. Verify: auth, admin, sub-accounts still work (unchanged)

## Rollback Plan

Keep deleted files in a `server/_archived/` directory for 1 week.
If issues arise, restore by:
1. Adding archived files back
2. Reverting `server/index.js` to import risk engine directly
3. Removing Redis subscriber from `ws.js`
