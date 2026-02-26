# Order Types & Trading Routes — Complete Behavior Reference

> Source: `server/routes/trading/`  
> This document is the single source of truth for ALL order types and their behaviors.

---

## 1. Market Orders (`market-orders.js` — 461 lines)

### POST `/api/trade` — Place a New Trade
- **Params**: `subAccountId, symbol, side, quantity, leverage, fastExecution, fallbackPrice, reduceOnly`
- **Flow**:
  1. Validate required fields
  2. Normalize `fallbackPrice` from mark price or exchange latest price
  3. Delegate to `riskEngine.executeTrade()` — which handles validation, exchange order, DB mutations
  4. Options: `fastExecution` (default true), `fallbackPrice`, `origin: 'MANUAL'`, `reduceOnly`
- **Response**: Trade result with `serverLatencyMs` header

### POST `/api/trade/close/:positionId` — Close a Position
- **Flow**: Delegates directly to `riskEngine.closePosition(positionId)`
- **Perf**: Logs latency

### POST `/api/trade/close-all/:subAccountId` — Close All Positions
- **Flow**:
  1. Fetch all OPEN virtual positions for account
  2. Close each via `riskEngine.closePosition()`
  3. Collects successes/failures

### POST `/api/trade/limit-close/:positionId` — Reduce-Only Limit Close
- **Flow**:
  1. Fetch position from DB
  2. **Exchange Position Verification**: Fetches real Binance positions to confirm a matching position exists
  3. Checks side alignment (long → sell, short → buy)
  4. **Desync Detection**: If virtual side ≠ exchange side, reject with `desync: true`
  5. Place reduce-only limit order on exchange via `exchange.createLimitOrder()`
  6. Create `pendingOrder` record in DB (type: 'LIMIT', status: 'PENDING')

### POST `/api/trade/validate` — Dry-Run Validation
- Calls `riskEngine.validateTrade()` without executing

### GET `/api/trade/positions/:subAccountId` — Open Positions with Live PnL
- Tries Redis risk snapshot first (if <15s old)
- Falls back to DB query + live PnL calculation
- Returns positions with `unrealizedPnl, markPrice, liquidationPrice, pnlPercent`

### GET `/api/trade/history/:subAccountId` — Trade History
- Fetches from DB with pagination and optional date filters

### GET `/api/trade/chart-data/:subAccountId` — Equity Curve Data
- Returns balance/equity over time for charting

### GET `/api/trade/margin/:subAccountId` — Margin Info
- Returns margin details via `riskEngine.getMarginInfo()`

### GET `/api/trade/stats/:subAccountId` — Account Stats
- Win rate, total trades, PnL, Sharpe, drawdown, etc.

---

## 2. Limit Orders (`limit-orders.js` — 365 lines)

### POST `/api/trade/limit` — Place a Limit Order
- **Params**: `subAccountId, symbol, side, quantity, price, leverage, reduceOnly`
- **Flow**:
  1. Validate fields, normalize side → buy/sell
  2. Set leverage on exchange (disabled — manual only)
  3. Place limit order on exchange via `exchange.createLimitOrder()`
  4. Store in DB as `pendingOrder` (type: 'LIMIT', status: 'PENDING')
  5. Broadcast to WebSocket frontend
- **ClientOrderId**: `PMS{subAccountId[:8]}_L_{uuid}`

### POST `/api/trade/scale` — Scale/Grid Orders
- **Params**: `subAccountId, symbol, side, leverage, orders[]` (each with price + quantity)
- **Behaviors**:
  - Validates each order (no zero/negative, no duplicate prices)
  - Min 2 orders required
  - **Concurrency Control**: `SCALE_ORDER_CONCURRENCY` (env-configurable, default 3, max 6)
  - **Rate Limiting**: `SCALE_ORDER_RATE_LIMIT_MS` (default 110ms between orders)
  - **Backoff on Exchange Error**: Exponential backoff with jitter
  - **Retry**: Up to 2 retries for transient exchange errors
  - **Worker Pool**: Workers pull from shared cursor, each with inter-order delay
  - Uses `exchange.createLimitOrder()` per order (NOT batch API)

### GET `/api/trade/orders/:subAccountId` — List Pending Orders
- Returns all PENDING orders from DB (ordered by createdAt DESC)

### DELETE `/api/trade/orders/:orderId` — Cancel a Single Order
- Cancels on exchange via `exchange.cancelOrder()`
- Updates DB status to 'CANCELLED'

### DELETE `/api/trade/orders/all/:subAccountId` — Cancel All Orders (Bulk)
- Groups orders by symbol
- Uses batch cancel API: `exchange.cancelBatchOrders(symbol, orderIds[])` (max 10/call)
- Falls back to individual cancellation on batch failure
- Updates DB status for each

---

## 3. Chase Limit Engine (`chase-limit.js` — 1040 lines)

### Core Concept
Chase the best bid/ask with continuous repricing. Adapts to market movement.

### POST `/api/trade/chase-limit` — Start a Chase Order
- **Params**: `subAccountId, symbol, side, quantity, leverage, stalkOffsetPct, stalkMode, maxDistancePct`

### Stalk Modes
| Mode | Behavior |
|------|----------|
| `none` | Always places at best bid/ask (aggressive fill) |
| `maintain` | Offsets by `stalkOffsetPct` from bid/ask, always follows |
| `trail` | Like maintain, but only moves TOWARD the market (LONG=up, SHORT=down) |

### Key Behaviors

#### `computeTargetPrice(side, bid, ask, stalkOffsetPct)`
- BUY: `bid × (1 - stalkOffset/100)`
- SELL: `ask × (1 + stalkOffset/100)`

#### `shouldReprice(ch, newTarget)`
- `maintain`: Always reprice to maintain offset distance
- `trail`: Only move if new target is MORE favorable (LONG: higher, SHORT: lower)
- `none`: Always reprice to best bid/ask

#### Repricing Loop
- Triggers on every exchange price tick
- **Throttle**: `REPRICE_THROTTLE_MS = 200ms` minimum between reprices
- **Redis persistence throttle**: `REDIS_SAVE_THROTTLE_MS = 1000ms`
- Cancels old exchange order, places new one at updated price
- If cancel fails (already filled?), checks order status

#### Price Clamping
- `roundToTickSize()`: rounds to exchange tick size (uses CCXT market info)
- `clampToMarketLimits()`: enforces PRICE_FILTER (static min/max) and PERCENT_PRICE (dynamic ±15% of mark)

#### Distance Cap
- `isDistanceBreached(ch, currentQuote)`: auto-cancels if price drifts > `maxDistancePct` from initial price

#### Fill Detection
- **Primary**: Real-time via exchange order status check after cancel attempt
- **Backup**: `startFillChecker()` polls active chases every 15s
- On fill → `handleChaseFilled()` → records position in DB, broadcasts to frontend

### Internal API (for Scalper)
- `startChaseInternal(opts)` — Start chase programmatically (no HTTP), returns `{ chaseId, cancel }`
- `cancelChaseInternal(chaseId)` — Cancel by ID
- `startChaseBatch(specs)` — Place multiple via **Binance batch API** (`createBatchLimitOrders`)
  - Used by scalper's `startLeg()` for placing all layers at once
  - Falls back one-by-one if batch fails

### Redis Persistence
- Prefix: `pms:chase:`
- TTL: 24h
- Resume on restart: scans Redis keys, reconnects price feeds, resumes chasing

---

## 4. Scalper Engine (`scalper.js` — 1509 lines)

### Core Concept
Dual-leg market-making: simultaneously places BUY layers below bid and SELL layers above ask. Captures the spread.

### POST `/api/trade/scalper` — Start a Scalper
- **Params**: `subAccountId, symbol, side, quantity, leverage, layers, baseOffsetPct, maxSpreadRatio, skew, maxDistancePct, scalpMode, maxFillsPerMinute, maxLossPerCloseBps`

### Scalp Modes
| Mode | Behavior |
|------|----------|
| `normal` | Open on one side, then reduce-only on the other |
| `neutral` | Both sides open simultaneously (market-making) |

### Layer Geometry — `generateLayerOffsets()`
- Exponentially-spread offsets centered on `baseOffset`
- With `count=3, maxSpread=2`: offsets at `[base/√2, base, base×√2]`
- Creates a fan of limit orders at different distances from the market

### Skew Weighting — `generateSkewWeights()`
- Distributes quantity across layers
- Positive skew → larger sizes on outer layers (stealth)
- Negative skew → larger sizes on inner layers (aggressive fill)

### Leg Management — `startLeg()`
- **Batch Order Placement**: Uses `startChaseBatch()` to place all layer orders in one Binance REST call
- Each layer gets its own chase state (onFill, onCancel callbacks)
- Layer slots auto-refill after fill with configurable delay

### Fill Handling
- **Opening fill** → Arms the reduce-only counterleg
- **Closing fill** → Records PnL, may restart the slot with backoff
- **Fill Spread Cooldown**: Time-decaying cooldown based on fill distance from current price
- **Fill Refill Delay**: Exponential backoff per slot per side (capped at 16× base)
- **Burst Rate Limiter**: `maxFillsPerMinute` enforced via sliding 60s window

### Loss Protection
- `maxLossPerCloseBps`: Pauses reduce-only slots if position loss > threshold (avoids locking in drawdown)
- `isMaxLossExceeded()`: Compares entry price to current price in bps

### PnL Feedback Loop — `slotPnlScoreBps()`
- Tracks per-slot PnL performance using EMA (decay 0.85)
- Requires `MIN_FEEDBACK_FILLS = 3` before adapting
- (Designed for future adaptive offset tuning)

### Backoff Config
- Base: 2s, Max: 5min cap
- Exponential: `2^retryCount × base`

### Redis Persistence
- Prefix: `pms:scalper:`
- TTL: 48h

---

## 5. TWAP Engine (`twap.js` — 1094 lines)

### POST `/api/trade/twap` — Start a TWAP Order
- **Params**: `subAccountId, symbol, side, totalSize, lots, durationMinutes, leverage, jitter, irregular, priceLimit`
- **Validation**: 1-720 minutes, 2-100 lots, each lot ≥ $6 min notional

### Lot Sizing — `buildLotSizes()`
- **Regular**: Equal-sized lots
- **Irregular**: Randomize lot sizes (sum = totalSize, individual lots vary)

### Execution — `executeTwapTick()`
- Each tick places one market order via `riskEngine.executeTrade()`
- **Jitter**: `jitterInterval()` adds ±10% randomization to interval
- **Price Limit**: Checks mark price before execution
  - LONG: Skip if price > priceLimit
  - SHORT: Skip if price < priceLimit
- **Max Skip Tracking**: Cancels TWAP after too many consecutive price-limit skips

### TWAP Basket (`twap-basket`)
- Execute TWAP across multiple symbols simultaneously
- Each leg has: symbol, side, totalSize, lots, leverage
- Ticks fire in parallel for all legs
- Same jitter/irregular/priceLimit support per-leg

### Redis Persistence
- Single TWAP prefix: `pms:twap:`
- Basket prefix: `pms:twapb:`
- TTL: 12h

---

## 6. Trail Stop (`trail-stop.js` — 462 lines)

### POST `/api/trade/trail-stop` — Start a Trailing Stop
- **Params**: `subAccountId, positionId, callbackPct, activationPrice`
- Tied to a specific position

### Behavior
- Tracks price extremes:
  - LONG: HWM (high-water mark) — trigger = HWM × (1 - callback/100)
  - SHORT: LWM (low-water mark) — trigger = LWM × (1 + callback/100)
- `activationPrice`: Optional — only start tracking after price reaches this level
- On trigger → market close via `riskEngine.closePosition()`

### Redis Persistence
- Prefix: `pms:trailstop:`
- TTL: 24h

---

## 7. Basket Trades (`basket.js` — 221 lines)

### POST `/api/trade/basket` — Execute Multi-Leg Trade
- **Params**: `subAccountId, legs[], basketName`
- Each leg: `{ symbol, side, quantity, leverage, priceHint }`

### Pre-Execution Checks
1. **Concurrency Lock**: One basket per account at a time (`basketExecutionLocks`)
2. **Price Resolution**: WS cache → exchange latest → priceHint fallback
3. **Per-Leg Rule Checks**: maxLeverage, maxNotionalPerTrade
4. **Aggregate Checks**:
   - Total exposure vs maxTotalExposure
   - Post-trade margin usage ratio (<98%)
5. **Execution**: All legs via `riskEngine.executeTrade()` in parallel

---

## Common Patterns Across All Order Types

### ClientOrderId Format
`PMS{subAccountId[:8]}_{type}_{uuid}`
- Type codes: `L` (limit), `CL` (chase), `SC` (scalper), `TW` (TWAP), etc.

### Redis Persistence Pattern
- All active algo states saved to Redis with TTL
- On server restart: scan Redis keys → resume active instances
- Throttled saves (500ms–2s) to avoid Redis storm (This can be bottleneck we will need to discuss this point)

### Price Subscription Pattern
- Subscribe to `exchange.on('price', handler)` for real-time price ticks JS engine.
- Unsubscribe on finish/cancel
- Frontend progress broadcast via `ws.broadcast()`

### Fill Detection Pattern
- **Primary**: Real-time via proxy-stream `ORDER_TRADE_UPDATE` → `handleExchangeOrderUpdate()` (to deprecate)
- **Backup**: Periodic polling via `order-sync.js` (60s) or fill checkers (15s) (Unreliable at the moment front end get 15sec before any position update)
