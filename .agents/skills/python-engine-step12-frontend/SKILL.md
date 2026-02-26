---
description: Step 12 — Frontend self-sufficiency with event-driven state updates
---

# Step 12: Frontend Self-Sufficiency

## Goal
Make the frontend fully self-sufficient for PnL/margin display using event-carried account state + local Binance WS streams. No server-pushed pnl_update or margin_update events.

## Prerequisites
- Steps 1–11 complete (Python engine running, JS cleaned up)
- Read `notes/07-frontend-websocket-events.md` (for current event shapes)
- Read `src/pages/trading/ws-handlers.js` lines 186–245 (current pnl_update/margin_update handlers)

## Architecture Change

### Before (server-driven PnL)
```
Python → pnl_update (20/s per position) → Redis → JS → WS → Frontend
Python → margin_update (12/s per account) → Redis → JS → WS → Frontend
```

### After (event-driven + local computation)
```
Python → order_filled { ..., account: { balance, equity, marginUsed } } → Redis → JS → WS → Frontend
Frontend: applies account snapshot from event → updates dashboard instantly
Frontend: subscribes to Binance @aggTrade / @kline → computes PnL locally per tick
Page refresh: fetches GET /margin → cold start bootstrap
```

## Event-Carried Account State

Every fill/position/close event from Python carries an `account` field:

```json
{
    "type": "order_filled",
    "subAccountId": "uuid",
    "symbol": "BTC/USDT:USDT",
    "side": "LONG",
    "price": 65000,
    "quantity": 0.001,
    "account": {
        "balance": 1000.00,
        "equity": 1001.50,
        "marginUsed": 6.50,
        "availableMargin": 995.00,
        "positions": [
            { "id": "uuid", "symbol": "BTCUSDT", "side": "LONG", "entryPrice": 65000, "quantity": 0.001, "margin": 6.5, "leverage": 10 }
        ]
    }
}
```

Events that carry `account`:
- `order_filled`
- `order_cancelled` (if it was a position-altering cancel)
- `position_updated`
- `position_closed`
- `position_reduced`
- `liquidation`

## Frontend Changes

### 1. Remove dead event listeners in `ws-handlers.js`

Remove:
```javascript
// REMOVE: these events no longer exist
mkHandler('pnl_update', handler);
mkHandler('margin_update', handler);
```

### 2. Add `account` state handler

When any event arrives with an `account` field, apply it:
```javascript
function applyAccountState(event) {
    if (!event.account) return;
    const { balance, equity, marginUsed, availableMargin, positions } = event.account;
    
    // Update cached margin info (displayed in dashboard)
    cachedMarginInfo = { balance, equity, marginUsed, availableMargin };
    
    // Sync position map from authoritative server state
    if (positions) {
        for (const pos of positions) {
            _positionMap.set(pos.id, {
                ...pos,
                markPrice: _positionMap.get(pos.id)?.markPrice || pos.entryPrice,
                unrealizedPnl: 0,  // Will be recomputed on next tick
            });
        }
        // Remove positions not in the server list
        for (const [id] of _positionMap) {
            if (!positions.find(p => p.id === id)) {
                _positionMap.delete(id);
            }
        }
    }
    
    // Trigger UI refresh
    refreshDashboard();
}
```

Wire into all event handlers:
```javascript
mkHandler('order_filled', (data) => {
    applyAccountState(data);
    // ... existing fill handling (sound, chart, etc.)
});

mkHandler('position_closed', (data) => {
    applyAccountState(data);
    // ... existing close handling
});
```

### 3. Local PnL computation (already exists, ensure it works)

```javascript
function computeLocalPnl() {
    for (const [, pos] of _positionMap) {
        if (!pos.markPrice) continue;
        pos.unrealizedPnl = pos.side === 'LONG'
            ? (pos.markPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - pos.markPrice) * pos.quantity;
        pos.pnlPercent = (pos.unrealizedPnl / pos.margin) * 100;
    }
    
    // Recompute equity
    const totalUpnl = Array.from(_positionMap.values()).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    cachedMarginInfo.equity = cachedMarginInfo.balance + totalUpnl;
    cachedMarginInfo.availableMargin = cachedMarginInfo.equity - cachedMarginInfo.marginUsed;
}
```

Run this on every price tick from the Binance @aggTrade or @kline stream (RAF-throttled).

### 4. Cold start bootstrap

On page load or account switch:
```javascript
async function loadAccountState() {
    const res = await api.get(`/api/trade/margin/${subAccountId}`);
    cachedMarginInfo = res;
    
    const posRes = await api.get(`/api/trade/positions/${subAccountId}`);
    for (const pos of posRes.positions) {
        _positionMap.set(pos.id, pos);
    }
    
    // Start mark price streams for all position symbols
    connectCompactMarkStreams();
}
```

### 5. Compact mark price streams (already exists)

`connectCompactMarkStreams()` in `positions-panel.js` already subscribes to Binance WS
for every position's symbol. Verify it triggers `computeLocalPnl()` on each tick.

## JS Backend Changes

### `server/ws.js` — Forward `account` field transparently

No changes needed — `broadcast()` already forwards the full event payload.
The `account` field is just another field in the JSON, forwarded as-is.

### `server/routes/trading/market-orders.js` — GET /margin endpoint

Keep this endpoint for cold start:
```javascript
router.get('/margin/:subAccountId', async (req, res) => {
    // Read from Redis snapshot (written by Python)
    const snapshot = await redis.get(`pms:risk:${req.params.subAccountId}`);
    if (snapshot) return res.json(JSON.parse(snapshot));
    // Fallback: compute from DB
    ...
});
```

## Validation

1. Place a market order → verify frontend dashboard updates WITHOUT refetching /margin
2. Close a position → verify balance/equity update instantly
3. Refresh page → verify cold start loads correct state from /margin
4. Price ticks → verify local PnL computation updates every position
5. Multiple accounts → verify account state isolation
