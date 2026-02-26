# Server → Frontend: All WebSocket Events & Updates

> Every event the server pushes to the frontend via WebSocket.  
> The frontend subscribes at `ws://host/ws` and receives JSON frames.

---

## Connection & Subscription

### Connect
```
ws://host/ws
```
Server sends on connect:
```json
{ "type": "connected", "timestamp": 1740547200000 }
```

### Subscribe to Account Updates
Frontend sends:
```json
{
  "type": "subscribe",
  "subAccountId": "uuid",
  "token": "jwt-token"
}
```
Server validates ownership (admin can subscribe to any account).  
Error:
```json
{ "type": "error", "message": "Not authorized for this account" }
```

---

## Event Envelope

All events follow this shape:
```json
{
  "type": "event_name",
  "data": { ... },
  "timestamp": 1740547200000
}
```

Events with `subAccountId` are **targeted** — only sent to clients subscribed to that account.  
Events without `subAccountId` are **broadcast** to all connected clients.

---

## 1. Risk & Position Updates (High Frequency)

### `pnl_update` — Live Unrealized PnL
**Source**: `LiquidationEngine._emitPnlUpdate()` — throttled at 50ms per position  
**Frequency**: Up to 20×/s per position (mark price driven)
```json
{
  "subAccountId": "uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "entryPrice": 65000,
  "quantity": 0.001,
  "markPrice": 65500,
  "unrealizedPnl": 0.50,
  "pnlPercent": 0.77,
  "liquidationPrice": 58500
}
```
**Frontend uses**: Updates `_positionMap`, refreshes equity/UPnL display, updates compact liq price

### `margin_update` — Live Margin/Equity
**Source**: `LiquidationEngine._emitMarginUpdate()` — throttled at 80ms per account  
**Frequency**: Up to ~12×/s per account
```json
{
  "subAccountId": "uuid",
  "update": {
    "subAccountId": "uuid",
    "balance": 1000,
    "equity": 1001.50,
    "marginUsed": 6.5,
    "availableMargin": 995,
    "maintenanceMargin": 0.325,
    "marginRatio": 0.0065,
    "positions": [
      {
        "id": "uuid",
        "symbol": "BTC/USDT:USDT",
        "side": "LONG",
        "unrealizedPnl": 0.50,
        "markPrice": 65500,
        "liquidationPrice": 58500
      }
    ]
  }
}
```
**Frontend uses**: Updates balance display, available margin, applies negative-balance lock on order form

---

## 2. Order Lifecycle Events

### `order_placed` — New Limit/Scale Order Created
**Source**: `limit-orders.js`, `twap.js` (via limit order placement)
```json
{
  "subAccountId": "uuid",
  "orderId": "db-uuid",
  "exchangeOrderId": "binance-id",
  "symbol": "BTC/USDT:USDT",
  "side": "buy",
  "type": "LIMIT",
  "price": 64000,
  "quantity": 0.001,
  "status": "PENDING"
}
```
**Frontend uses**: Refreshes open orders panel, adds chart price line

### `order_filled` — Order Filled (Market or Limit)
**Source**: `TradeExecutor._emitMarketFillEvent()`, `order-sync.handleOrderFilled()`
```json
{
  "subAccountId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "price": 65000,
  "quantity": 0.001,
  "exchangeOrderId": "binance-id",
  "orderType": "MARKET",
  "origin": "MANUAL",
  "suppressToast": false
}
```
**Frontend uses**: Plays fill sound (if not suppressed), removes chart price line, refreshes positions/orders/annotations/account

### `order_cancelled` — Order Cancelled
**Source**: `order-sync.handleOrderCancelled()`, `twap.js` (TWAP lot cancel)
```json
{
  "subAccountId": "uuid",
  "orderId": "db-uuid",
  "symbol": "BTC/USDT:USDT",
  "reason": "user_cancelled"
}
```
**Frontend uses**: Removes chart price line, refreshes open orders panel

---

## 3. Position Lifecycle Events

### `position_updated` — Position Created or Modified
**Source**: `scalper.js` (after fill creates/updates position), `order-sync.recordFilledOrder()`
```json
{
  "subAccountId": "uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "entryPrice": 65000,
  "quantity": 0.001,
  "notional": 65,
  "leverage": 10,
  "margin": 6.5,
  "liquidationPrice": 58500
}
```
**Frontend uses**: Updates `_positionMap`, creates/updates compact position row with live mark price, refreshes chart risk lines

### `position_closed` — Position Fully Closed
**Source**: `TradeExecutor.closePosition()`
```json
{
  "subAccountId": "uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "pnl": 12.50,
  "closePrice": 66250
}
```
**Frontend uses**: Removes position row from DOM, clears chart price lines, refreshes equity

### `position_reduced` — Position Partially Closed (ADL)
**Source**: `TradeExecutor.partialClose()`
```json
{
  "subAccountId": "uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "reducedQuantity": 0.0003,
  "remainingQuantity": 0.0007,
  "realizedPnl": 3.75
}
```
**Frontend uses**: Refreshes positions, annotations, account summary

### `liquidation` — Position Liquidated
**Source**: `LiquidationEngine` (via `TradeExecutor.liquidatePosition`)
```json
{
  "subAccountId": "uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "mode": "ADL_30",
  "tier": 1,
  "pnl": -50.00
}
```
**Frontend uses**: Same handling as `position_closed` — removes row, clears chart, refreshes equity

---

## 4. Chase Order Events

### `chase_progress` — Chase Order Price Tracking
**Source**: `chase-limit.js` — emitted on every reprice
```json
{
  "subAccountId": "uuid",
  "chaseId": "chase-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "currentOrderPrice": 64985,
  "repriceCount": 42,
  "status": "active",
  "stalkMode": "maintain",
  "stalkOffsetPct": 0.05,
  "elapsed": 30000
}
```
**Frontend uses**: Draws live chase line on chart, updates chase row in open orders panel (price + reprice count), adds chase price tag to position row

### `chase_filled` — Chase Order Filled
**Source**: `chase-limit.js`
```json
{
  "subAccountId": "uuid",
  "chaseId": "chase-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "fillPrice": 65000,
  "fillQty": 0.001,
  "repriceCount": 42,
  "elapsed": 30000
}
```
**Frontend uses**: Plays fill sound, removes chase chart lines, removes chase row from panel

### `chase_cancelled` — Chase Order Cancelled/Timed Out
**Source**: `chase-limit.js`
```json
{
  "subAccountId": "uuid",
  "chaseId": "chase-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "reason": "user_cancelled | distance_breached | timeout",
  "repriceCount": 42
}
```
**Frontend uses**: Removes chase chart lines, shows toast with reason, removes chase row

---

## 5. Scalper Events

### `scalper_progress` — Scalper Fill Count Update
**Source**: `scalper.js`
```json
{
  "subAccountId": "uuid",
  "scalperId": "scalper-uuid",
  "symbol": "BTC/USDT:USDT",
  "fillCount": 15,
  "longSlots": [
    { "layerIdx": 0, "active": true, "retryAt": null, "retryCount": 0, "paused": false },
    { "layerIdx": 1, "active": false, "retryAt": 1740547260000, "retryCount": 2, "paused": false },
    { "layerIdx": 2, "active": true, "retryAt": null, "retryCount": 0, "paused": true }
  ],
  "shortSlots": [
    { "layerIdx": 0, "active": true, "retryAt": null, "retryCount": 0, "paused": false }
  ]
}
```
**Frontend uses**: Updates parent row fill count, updates per-slot badges (active ●, paused ⏸, retry countdown ⟳ Ns)

### `scalper_filled` — Individual Scalper Fill
**Source**: `scalper.js`
```json
{
  "subAccountId": "uuid",
  "scalperId": "scalper-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "fillPrice": 65000,
  "fillQty": 0.001,
  "layerIdx": 0,
  "legType": "OPENING",
  "pnl": null
}
```

### `scalper_cancelled` — Scalper Stopped
**Source**: `scalper.js`
```json
{
  "subAccountId": "uuid",
  "scalperId": "scalper-uuid",
  "symbol": "BTC/USDT:USDT",
  "reason": "user_cancelled | distance_breached | max_fills",
  "totalFills": 15,
  "netPnl": 5.25
}
```

---

## 6. TWAP Events

### `twap_progress` — TWAP Execution Status
**Source**: `twap.js`
```json
{
  "subAccountId": "uuid",
  "twapId": "twap-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "completed": 5,
  "total": 10,
  "filledSize": 0.05,
  "totalSize": 0.1,
  "nextLotTime": 1740547260000,
  "skippedLots": 0,
  "status": "running"
}
```
**Frontend uses**: Refreshes positions, open orders, account; refreshes chart if same symbol

### `twap_completed` — TWAP Finished All Lots
```json
{
  "subAccountId": "uuid",
  "twapId": "twap-uuid",
  "symbol": "BTC/USDT:USDT",
  "completed": 10,
  "total": 10,
  "filledSize": 0.1,
  "avgPrice": 65250
}
```

### `twap_cancelled` — TWAP Cancelled
```json
{
  "subAccountId": "uuid",
  "twapId": "twap-uuid",
  "symbol": "BTC/USDT:USDT",
  "reason": "user_cancelled | price_limit_exceeded"
}
```

### `twap_basket_progress` — Multi-Symbol TWAP Status
```json
{
  "subAccountId": "uuid",
  "basketId": "basket-uuid",
  "completed": 5,
  "total": 10,
  "legs": [
    { "symbol": "BTC/USDT:USDT", "filledLots": 5, "filledSize": 0.005 },
    { "symbol": "ETH/USDT:USDT", "filledLots": 4, "filledSize": 0.08 }
  ]
}
```

### `twap_basket_completed` / `twap_basket_cancelled`
Same shape as single TWAP but with `basketId` and per-leg status.

---

## 7. Trail Stop Events

### `trail_stop_progress` — Trail Stop Price Tracking
**Source**: `trail-stop.js` — emitted on every price tick while trailing
```json
{
  "subAccountId": "uuid",
  "trailStopId": "ts-uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "extremePrice": 66200,
  "triggerPrice": 65207,
  "currentPrice": 66000,
  "callbackPct": 1.5,
  "activated": true,
  "status": "tracking"
}
```
**Frontend uses**: Draws live trail stop lines on chart, updates open orders row (HWM/LWM, trigger price, status badge)

### `trail_stop_triggered` — Trail Stop Fired
**Source**: `trail-stop.js`
```json
{
  "subAccountId": "uuid",
  "trailStopId": "ts-uuid",
  "positionId": "uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "triggeredPrice": 65207,
  "extremePrice": 66200,
  "pnl": 15.00
}
```
**Frontend uses**: Shows toast notification, removes position row, clears chart trail stop lines, refreshes all panels

### `trail_stop_cancelled` — Trail Stop Cancelled
```json
{
  "subAccountId": "uuid",
  "trailStopId": "ts-uuid",
  "reason": "user_cancelled | position_closed"
}
```

---


## Event Summary Table

| Event | Direction | Frequency | Source |
|-------|-----------|-----------|--------|
| `pnl_update` | Targeted | ~1/s per position | LiquidationEngine |
| `margin_update` | Targeted | ~5/s per account | LiquidationEngine |
| `order_placed` | Targeted | On order | limit-orders, twap |
| `order_filled` | Targeted | On fill | TradeExecutor, order-sync |
| `order_cancelled` | Targeted | On cancel | order-sync, twap |
| `position_updated` | Targeted | On fill | scalper, order-sync |
| `position_closed` | Targeted | On close | TradeExecutor |
| `position_reduced` | Targeted | On ADL | TradeExecutor |
| `liquidation` | Targeted | On liq | LiquidationEngine |
| `chase_progress` | Targeted | ~1/s | chase-limit |
| `chase_filled` | Targeted | On fill | chase-limit |
| `chase_cancelled` | Targeted | On cancel | chase-limit |
| `scalper_progress` | Targeted | On fill | scalper |
| `scalper_filled` | Targeted | On fill | scalper |
| `scalper_cancelled` | Targeted | On stop | scalper |
| `twap_progress` | Targeted | Per lot | twap |
| `twap_completed` | Targeted | On finish | twap |
| `twap_cancelled` | Targeted | On cancel | twap |
| `twap_basket_progress` | Targeted | Per lot | twap |
| `trail_stop_progress` | Targeted | ~1/s | trail-stop |
| `trail_stop_triggered` | Targeted | On trigger | trail-stop |
| `trail_stop_cancelled` | Targeted | On cancel | trail-stop |

