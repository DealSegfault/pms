# Exchange Connector, User Stream, Sync Modules & Redis — Behavior Reference

> Source: `server/exchange.js`, `server/proxy-stream.js`, `server/order-sync.js`, `server/position-sync.js`, `server/redis.js`

---

## 1. Exchange Connector (`exchange.js` — 787 lines)

### Core: CCXT Binance Wrapper
- Singleton `ExchangeConnector extends EventEmitter`
- Binance Futures with rate limiting enabled
- Concurrency limiter: `MAX_CONCURRENT_ORDERS = 10` (queued)

### Initialization
- `loadMarkets()` — loads all Binance futures markets
- On failure: **degraded mode** (API stays up, trading fails)
- IP ban detection: auto-retry after ban expires
- Retry timer: 30s default, or ban expiry + 5s

### REST Trading Methods
| Method | Purpose |
|--------|---------|
| `createMarketOrder(symbol, side, qty, params)` | Market order with fast-ack option |
| `createLimitOrder(symbol, side, qty, price, params)` | Limit order |
| `fetchOrder(symbol, orderId)` | Check order status |
| `cancelOrder(symbol, orderId)` | Cancel single order |
| `cancelAllOrders(symbol)` | Cancel all for a symbol |
| `createBatchLimitOrders(orders[])` | Up to 5 limit orders in 1 REST call |
| `cancelBatchOrders(symbol, orderIds[])` | Up to 10 cancels in 1 REST call |
| `fetchPositions()` | All open positions |
| `fetchBalance()` | Account balance (USDT) |
| `setLeverage()` | **DISABLED** — manual only |

### Market Order Fast-Ack
- `__fastAck = true`: Return immediately with estimated fill data
- `__fallbackPrice`: Use as fill price if exchange doesn't return one
- Without fast-ack: Waits 200ms then re-fetches order for actual fill data + fees

### Batch APIs (Binance native)
- `createBatchLimitOrders()`: `/fapi/v1/batchOrders` — 5 orders max per call
- `cancelBatchOrders()`: `/fapi/v1/batchOrders` DELETE — 10 cancels max per call
- Each element in response can independently succeed or fail

### WS Price Streaming (TO BE REPLACED by Python)
- `subscribeToPrices(symbols)`: Combined WS streams
- Stream types per symbol: `{symbol}@markPrice@1s` + `{symbol}@bookTicker`
- Max 100 symbols per WS connection (200 streams)
- Heartbeat: ping every 30s, terminate after 2 missed pongs
- Auto-reconnect on close (3s delay)
- Emits `'price'` event: `{ symbol, mark, timestamp }`
- Writes to Redis: `setPriceCache(symbol, price, 'js')` throttled at 500ms
- Stale detection: `getStaleSymbols(10_000)` + `forceResubscribe(symbol)`

---

## 2. Proxy Stream — User Data Stream (`proxy-stream.js` — 382 lines)

### Purpose
Proxies Binance user data WebSocket events to the appropriate sub-accounts.

### Connection Management
- Creates Binance listen key via REST (`POST /fapi/v1/listenKey`)
- Connects to `wss://fstream.binance.com/ws/{listenKey}`
- Keepalive: PUT listenKey every 30 minutes
- Auto-reconnect on close (5s delay)
- Heartbeat: ping every 30s

### Event Routing — `routeEvent(event)`

#### ORDER_TRADE_UPDATE
1. Extract `clientOrderId`, `orderId`, `orderStatus`
2. Capture fill price for reconciliation (`recentFills` cache, max 500 entries)
3. Route by clientOrderId prefix:
   - If starts with `PMS` → extract 8-char sub-account prefix
   - Else → check Redis order mapping (`getOrderMapping(orderId)`)
4. Call `handleExchangeOrderUpdate()` for fast-path fill/cancel processing

#### ACCOUNT_UPDATE
- Handles position closes detected via account-level events
- If a position goes to zero on exchange but virtual positions exist:
  1. Acquire reconciliation lock (Redis)
  2. Find matching virtual positions by symbol
  3. Close them at last fill price or mark price
  4. Mark symbol as reconciled (debounce 30s)
  5. Trigger risk book refresh

### Fill Price Cache — `recentFills`
- `Map<ccxtSymbol, { price, timestamp, side }>` (bounded at 500 entries)
- Used for reconciliation: when exchange closes a position externally, we need the fill price
- Entries older than 60s are considered stale

### Client Connection Tracking
- Sub-accounts register with prefix
- Events are forwarded to the correct client WebSocket connection

---

## 3. Order Sync (`order-sync.js` — 487 lines)

### Purpose
Backup polling system for pending limit orders. Catches fills/cancels that the real-time stream might miss.

### Polling Loop — `startOrderSync(intervalMs = 60_000)`
- Every 60s: fetches ALL pending orders from DB, checks exchange status for each

### `checkOrder(order)`
1. Fetch order from exchange by orderId
2. Normalize status → FILLED / CANCELLED / EXPIRED / PENDING
3. Route to handler:
   - FILLED → `handleOrderFilled()`
   - CANCELLED/EXPIRED → `handleOrderCancelled()`
   - Still PENDING → no action

### `handleOrderFilled(order, exchangeOrder)`
1. Determine fill price (avgPrice → lastPrice → order price)
2. Determine fill quantity (filled → amount → original qty)
3. Check if position already exists (duplicate detection via trade signature)
4. Route by order type:
   - `CLOSE` / `LIMIT_CLOSE` → `riskEngine.closePosition()`
   - `CHASE_LIMIT` with `parentScalperId` → delegate to scalper
   - `LIMIT` (open) → `recordFilledOrder()`
5. Mark order FILLED in DB

### `recordFilledOrder(order, fillPrice, fillQty)`
- Creates virtual position + trade record in DB transaction
- Calculates margin, notional
- Updates position book
- Broadcasts to frontend WebSocket
- Syncs Redis risk snapshot

### `handleExchangeOrderUpdate(update)` — Fast-Path
- Called directly from proxy-stream for real-time order updates
- Matches by exchangeOrderId (DB lookup)
- Skips if recently processed (dedup via `_recentlyProcessed` Set)
- Handles FILLED and CANCELLED statuses immediately

### `processChaseOrderFill()` — Chase-Specific
- Looks up pending order by exchangeOrderId OR by (subAccountId + type + symbol)
- Handles the case where exchangeOrderId in DB diverges from current (due to repricing)

### Stale Order Expiry
- `STALE_ORDER_AGE_MS = 48 hours`
- Orders older than this are auto-expired

---

## 4. Position Sync (`position-sync.js` — 135 lines)

### Purpose
Backup reconciliation — catches positions closed externally on the exchange.

### Reconciliation Loop — `reconcile()` (every 30s)
1. Fetch all OPEN virtual positions from DB
2. Fetch all real exchange positions
3. Find orphans: virtual positions whose symbol has NO real exchange position
4. For each orphan:
   - Skip if recently reconciled by proxy-stream (debounce 30s)
   - Get close price (WS cache → REST ticker)
   - Acquire Redis reconciliation lock
   - Call `riskEngine.reconcilePosition(symbol, closePrice)`
   - Mark as reconciled

### Coordination with Proxy-Stream
- `markReconciled(symbol)` — called by proxy-stream after ACCOUNT_UPDATE
- Prevents double-reconciliation within 30s window
- Redis lock (`acquireReconcileLock`) prevents racing between multiple paths

---

## 5. Redis Communication (`redis.js` — 289 lines)

### Connection
- Uses ioredis with env-configured host/port/retries
- Auto-reconnect with error logging

### Price Cache
```javascript
setPriceCache(symbol, price, source)  // SET pms:price:{symbol} → { mark, ts, source }  TTL 30s
getPriceCache(symbol)                 // GET pms:price:{symbol} → { mark, ts, source }
```

### Risk Snapshots
```javascript
setRiskSnapshot(subAccountId, data)   // SET pms:risk:{subAccountId} → JSON  TTL 30s
getRiskSnapshot(subAccountId)         // GET pms:risk:{subAccountId} → Object
```

### Order Mapping
```javascript
setOrderMapping(orderId, mapping)     // SET pms:order:{orderId} → { subAccountId, clientOrderId }  TTL 24h
getOrderMapping(orderId)              // GET pms:order:{orderId} → Object
```

### Reconciliation Locks
```javascript
acquireReconcileLock(symbol)          // SET pms:reconcile:{symbol} NX EX 30
releaseReconcileLock(symbol)          // DEL pms:reconcile:{symbol}
```

### Rate Limiting
```javascript
checkRateLimit(key, maxPerWindow, windowMs)  // Sliding window counter
```

### Redis Streams (for C++ engine integration)
```javascript
xadd(streamKey, data)                 // XADD
xreadgroup(groupName, consumerName, streamKey, count)  // XREADGROUP
```

---

## Complete Redis Key Space

| Key Pattern | Type | TTL | Writer | Reader | Purpose |
|------------|------|-----|--------|--------|---------|
| `pms:price:{ccxtSymbol}` | STRING | 30s | exchange.js / Python | risk, trading routes | Live mark price |
| `pms:risk:{subAccountId}` | STRING | 30s | trade-executor | GET /positions, risk | Cached risk snapshot |
| `pms:order:{exchangeOrderId}` | STRING | 24h | trade-executor | proxy-stream, order-sync | Order → sub-account mapping |
| `pms:reconcile:{symbol}` | STRING | 30s | position-sync, proxy-stream | position-sync, proxy-stream | Reconciliation lock |
| `pms:chase:{chaseId}` | STRING | 24h | chase-limit.js | chase-limit.js (resume) | Chase order state |
| `pms:scalper:{scalperId}` | STRING | 48h | scalper.js | scalper.js (resume) | Scalper state |
| `pms:twap:{twapId}` | STRING | 12h | twap.js | twap.js (resume) | TWAP state |
| `pms:twapb:{basketId}` | STRING | 12h | twap.js | twap.js (resume) | TWAP basket state |
| `pms:trailstop:{trailStopId}` | STRING | 24h | trail-stop.js | trail-stop.js (resume) | Trail stop state |


