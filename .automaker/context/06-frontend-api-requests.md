# Frontend → Server: All API Requests (Order Actions)

> Every HTTP endpoint the frontend can call to manage orders, positions, and algos.  
> All endpoints are prefixed with `/api`. Auth: `Authorization: Bearer {token}` header.

---

## 1. Trade Placement

### POST `/api/trade` — Market Order (Open Position)
```json
{
  "subAccountId": "uuid",          // Required — which sub-account to trade on
  "symbol": "BTC/USDT:USDT",      // Required — CCXT symbol format
  "side": "LONG",                  // Required — "LONG" or "SHORT"
  "quantity": 0.001,               // Required — order quantity (base asset)
  "leverage": 10,                  // Required — leverage multiplier (1-125)
  "fastExecution": true,           // Optional — skip re-fetch for faster ack (default: true)
  "fallbackPrice": 65000.0,        // Optional — estimated fill price for fast-ack PnL
  "reduceOnly": false              // Optional — only reduce existing position
}
```
**Response** `201`:
```json
{
  "success": true,
  "orderId": "exchange-order-id",
  "position": { "id": "uuid", "symbol": "...", "side": "LONG", "entryPrice": 65000, "quantity": 0.001, "notional": 65, "leverage": 10, "margin": 6.5 }
}
```

---

### POST `/api/trade/limit` — Limit Order
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "LONG",                  // Required — "LONG" or "SHORT"
  "quantity": 0.001,               // Required
  "price": 64000.0,               // Required — limit price
  "leverage": 10,                  // Required
  "reduceOnly": false              // Optional
}
```
**Response** `201`:
```json
{
  "success": true,
  "orderId": "db-order-uuid",
  "exchangeOrderId": "binance-order-id",
  "symbol": "BTC/USDT:USDT",
  "side": "buy",
  "price": 64000.0,
  "quantity": 0.001
}
```

---

### POST `/api/trade/scale` — Scale/Grid Orders (Multiple Limits)
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "LONG",                  // Required
  "leverage": 10,                  // Required
  "orders": [                      // Required — min 2 orders
    { "price": 63000.0, "quantity": 0.001 },
    { "price": 62000.0, "quantity": 0.002 },
    { "price": 61000.0, "quantity": 0.003 }
  ]
}
```
**Response** `201`:
```json
{
  "success": true,
  "results": [
    { "price": 63000, "quantity": 0.001, "success": true, "orderId": "uuid" },
    { "price": 62000, "quantity": 0.002, "success": true, "orderId": "uuid" },
    { "price": 61000, "quantity": 0.003, "success": false, "error": "..." }
  ],
  "successCount": 2,
  "failCount": 1
}
```

---

### POST `/api/trade/limit-close/:positionId` — Limit Close (Reduce-Only)
```json
{
  "subAccountId": "uuid",          // Required
  "price": 67000.0                 // Required — limit close price
}
```
**Response** `201`:
```json
{
  "success": true,
  "orderId": "db-order-uuid",
  "exchangeOrderId": "binance-order-id"
}
```

---

### POST `/api/trade/basket` — Multi-Leg Basket Trade
```json
{
  "subAccountId": "uuid",          // Required
  "basketName": "BTC+ETH Long",   // Optional — display name
  "legs": [                        // Required — array of trade legs
    { "symbol": "BTC/USDT:USDT", "side": "LONG",  "quantity": 0.001, "leverage": 10, "priceHint": 65000.0 },
    { "symbol": "ETH/USDT:USDT", "side": "LONG",  "quantity": 0.01,  "leverage": 10, "priceHint": 3500.0 },
    { "symbol": "SOL/USDT:USDT", "side": "SHORT", "quantity": 1.0,   "leverage": 5,  "priceHint": 150.0 }
  ]
}
```
- `priceHint` — Optional fallback price if WS cache has no price for this symbol
**Response** `201`:
```json
{
  "basketName": "BTC+ETH Long",
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "symbol": "BTC/USDT:USDT", "side": "LONG", "success": true, "orderId": "...", "position": { ... } },
    { "symbol": "ETH/USDT:USDT", "side": "LONG", "success": true, "orderId": "...", "position": { ... } },
    { "symbol": "SOL/USDT:USDT", "side": "SHORT", "success": false, "errors": [{ "code": "EXECUTION_ERROR", "message": "..." }] }
  ]
}
```

---

## 2. Position Management

### POST `/api/trade/close/:positionId` — Market Close Position
No body required. Closes the position at market price.  
**Response** `200`:
```json
{
  "success": true,
  "closedPosition": { "id": "uuid", "symbol": "...", "pnl": 12.50 }
}
```

### POST `/api/trade/close-all/:subAccountId` — Close All Positions
No body required.  
**Response** `200`:
```json
{
  "results": [
    { "positionId": "uuid", "success": true },
    { "positionId": "uuid", "success": false, "error": "..." }
  ]
}
```

### POST `/api/trade/validate` — Pre-Trade Validation (Dry Run)
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "LONG",                  // Required
  "quantity": 0.001,               // Required
  "leverage": 10                   // Required
}
```
**Response** `200`:
```json
{
  "valid": true,
  "errors": [],
  "computedValues": {
    "price": 65000,
    "notional": 65,
    "requiredMargin": 6.5,
    "availableBalance": 1000,
    "currentExposure": 500,
    "equity": 1050,
    "maintenanceMargin": 2.5
  }
}
```

---

## 3. Order Management

### GET `/api/trade/orders/:subAccountId` — List Pending Orders
**Response** `200`:
```json
[
  {
    "id": "uuid",
    "symbol": "BTC/USDT:USDT",
    "side": "buy",
    "type": "LIMIT",
    "quantity": 0.001,
    "price": 64000,
    "status": "PENDING",
    "exchangeOrderId": "binance-id",
    "createdAt": "2026-02-26T05:00:00Z"
  }
]
```

### DELETE `/api/trade/orders/:orderId` — Cancel Single Order
**Response** `200`:
```json
{ "success": true, "orderId": "uuid" }
```

### DELETE `/api/trade/orders/all/:subAccountId` — Cancel All Orders
**Response** `200`:
```json
{
  "total": 5,
  "cancelled": 4,
  "failed": 1,
  "results": [
    { "orderId": "uuid", "success": true },
    { "orderId": "uuid", "success": false, "error": "..." }
  ]
}
```

---

## 4. Chase Limit Order

### POST `/api/trade/chase-limit` — Start a Chase Order
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "LONG",                  // Required — "LONG" or "SHORT"
  "quantity": 0.001,               // Required
  "leverage": 10,                  // Required
  "stalkOffsetPct": 0.05,          // Optional — offset from best bid/ask in % (default: 0)
  "stalkMode": "maintain",         // Optional — "none", "maintain", "trail" (default: "none")
  "maxDistancePct": 2.0            // Optional — auto-cancel if price drifts > N% from initial
}
```
**Response** `201`:
```json
{
  "success": true,
  "chaseId": "chase-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "quantity": 0.001,
  "stalkMode": "maintain",
  "stalkOffsetPct": 0.05,
  "initialPrice": 65000
}
```

### GET `/api/trade/chase-limit/active/:subAccountId` — List Active Chases
### DELETE `/api/trade/chase-limit/:chaseId` — Cancel a Chase

---

## 5. Scalper (Dual-Leg Market Maker)

### POST `/api/trade/scalper` — Start a Scalper
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "neutral",              // Required — "neutral" (both sides) or "LONG"/"SHORT"
  "quantity": 0.001,               // Required — total quantity per side
  "leverage": 10,                  // Required
  "layers": 3,                     // Optional — number of order layers (default: 1)
  "baseOffsetPct": 0.05,           // Optional — distance from bid/ask in % (default: 0.05)
  "maxSpreadRatio": 2.0,           // Optional — spread ratio between layers (default: 2)
  "skew": 0,                       // Optional — size distribution skew (-1 to +1)
  "maxDistancePct": 3.0,           // Optional — auto-cancel if price drifts > N%
  "scalpMode": "normal",           // Optional — "normal" or "neutral"
  "maxFillsPerMinute": 10,         // Optional — burst rate limit (default: unlimited)
  "maxLossPerCloseBps": 50         // Optional — max allowed loss in bps before pausing slot
}
```
**Response** `201`:
```json
{
  "success": true,
  "scalperId": "scalper-uuid",
  "symbol": "BTC/USDT:USDT",
  "layers": 3,
  "baseOffsetPct": 0.05
}
```

### GET `/api/trade/scalper/active/:subAccountId` — List Active Scalpers
### DELETE `/api/trade/scalper/:scalperId` — Stop a Scalper

---

## 6. TWAP (Time-Weighted Average Price)

### POST `/api/trade/twap` — Start a TWAP Order
```json
{
  "subAccountId": "uuid",          // Required
  "symbol": "BTC/USDT:USDT",      // Required
  "side": "LONG",                  // Required
  "totalSize": 0.1,                // Required — total quantity across all lots
  "lots": 10,                      // Required — number of execution slices (2-100)
  "durationMinutes": 60,           // Required — total execution window (1-720)
  "leverage": 10,                  // Required
  "jitter": true,                  // Optional — randomize interval timing (default: false)
  "irregular": true,               // Optional — randomize lot sizes (default: false)
  "priceLimit": 66000.0            // Optional — max price for LONG / min price for SHORT
}
```
**Response** `201`:
```json
{
  "success": true,
  "twapId": "twap-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "totalSize": 0.1,
  "lots": 10,
  "intervalMs": 360000
}
```

### POST `/api/trade/twap-basket` — Start a TWAP Basket (Multi-Symbol)
```json
{
  "subAccountId": "uuid",          // Required
  "lots": 10,                      // Required
  "durationMinutes": 60,           // Required
  "jitter": true,                  // Optional
  "irregular": true,               // Optional
  "legs": [                        // Required
    { "symbol": "BTC/USDT:USDT", "side": "LONG",  "totalSize": 0.01, "leverage": 10, "priceLimit": 66000 },
    { "symbol": "ETH/USDT:USDT", "side": "LONG",  "totalSize": 0.1,  "leverage": 10 },
    { "symbol": "SOL/USDT:USDT", "side": "SHORT", "totalSize": 5.0,  "leverage": 5 }
  ]
}
```

### GET `/api/trade/twap/active/:subAccountId` — List Active TWAPs
### DELETE `/api/trade/twap/:twapId` — Cancel a TWAP
### DELETE `/api/trade/twap-basket/:basketId` — Cancel a TWAP Basket

---

## 7. Trail Stop

### POST `/api/trade/trail-stop` — Start a Trailing Stop
```json
{
  "subAccountId": "uuid",          // Required
  "positionId": "uuid",            // Required — which position to protect
  "callbackPct": 1.5,              // Required — callback percentage (trigger when retraces N% from extreme)
  "activationPrice": 67000.0       // Optional — only start trailing after price reaches this level
}
```
**Response** `201`:
```json
{
  "success": true,
  "trailStopId": "ts-uuid",
  "symbol": "BTC/USDT:USDT",
  "side": "LONG",
  "callbackPct": 1.5,
  "activationPrice": 67000,
  "activated": false,
  "extremePrice": 65000,
  "triggerPrice": 64025,
  "currentPrice": 65000
}
```

### GET `/api/trade/trail-stop/active/:subAccountId` — List Active Trail Stops
### DELETE `/api/trade/trail-stop/:trailStopId` — Cancel a Trail Stop

---

## 8. Data Queries

### GET `/api/trade/positions/:subAccountId` — Open Positions with Live PnL
**Response** `200`:
```json
{
  "positions": [
    {
      "id": "uuid",
      "symbol": "BTC/USDT:USDT",
      "side": "LONG",
      "entryPrice": 65000,
      "quantity": 0.001,
      "notional": 65,
      "leverage": 10,
      "margin": 6.5,
      "liquidationPrice": 58500,
      "unrealizedPnl": 1.50,
      "markPrice": 66500,
      "pnlPercent": 2.31,
      "openedAt": "2026-02-26T05:00:00Z"
    }
  ],
  "accountSummary": {
    "balance": 1000,
    "equity": 1001.50,
    "marginUsed": 6.5,
    "availableMargin": 995,
    "marginRatio": 0.0065
  }
}
```

### GET `/api/trade/history/:subAccountId` — Trade History
Query params: `?page=1&limit=50&from=2026-01-01&to=2026-02-26`

### GET `/api/trade/chart-data/:subAccountId` — Equity Curve

### GET `/api/trade/margin/:subAccountId` — Margin Info
**Response** `200`:
```json
{
  "balance": 1000,
  "equity": 1001.50,
  "marginUsed": 6.5,
  "availableMargin": 995,
  "maintenanceMargin": 0.325,
  "marginRatio": 0.0065
}
```

### GET `/api/trade/stats/:subAccountId` — Account Performance Stats
