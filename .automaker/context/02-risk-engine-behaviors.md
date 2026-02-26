# Risk Engine — Complete Behavior Reference

> Source: `server/risk/`  
> This engine is the core of the PMS — ALL trades flow through it.

---

## Architecture Overview

```
RiskEngine (facade)
  ├── PositionBook        — In-memory position tracking (Map-based)
  ├── PriceService        — Price resolution (WS → Redis → REST)
  ├── LiquidationEngine   — Risk evaluation and liquidation execution
  ├── TradeValidator       — Pre-trade margin/risk checks
  └── TradeExecutor        — Trade execution, DB mutations, exchange orders
```

---

## 1. RiskEngine Facade (`index.js` — 489 lines)

### Responsibilities
- Composes all sub-modules and wires their dependencies
- Drives the risk monitoring loop (price ticks + periodic sweeps)
- Exposes the public API that all trading routes consume

### Initialization Wiring
```
book = new PositionBook()
priceService = new PriceService(exchange)
liquidation = new LiquidationEngine(book, priceService)
executor = new TradeExecutor(exchange, book, priceService, liquidation)
validator = new TradeValidator({ prisma, exchange, priceService, liquidation })
// Inject trade actions into liquidation (breaks circular dep)
liquidation.setTradeActions({ closePosition, partialClose, liquidatePosition, takeoverPosition })
```

### Risk Monitoring Loop — `startMonitoring(intervalMs)`

**Two paths for risk evaluation:**

1. **Price-driven (real-time, ~50ms)** — `_onPriceTick({ symbol, mark })`
   - Fires on every exchange WS price event
   - Updates price cache
   - Looks up ALL accounts with positions on that symbol
   - Evaluates each account's risk
   - Throttled: MAX once per 2000ms per account (`EVAL_MIN_INTERVAL_MS`)

2. **Safety-net sweep (periodic, 30s)** — `_riskSweep()`
   - Reloads position book from DB
   - Evaluates ALL tracked accounts
   - Catches anything the tick-driven path missed

### Position Book Loading — `_loadPositionBook()`
- Queries DB for ALL open positions (grouped by subAccountId)
- Loads rules (risk limits per account)
- Subscribes to WS prices for all symbols that have open positions
- Called on startup + every safety-net sweep

### Account Summary — `getAccountSummary(subAccountId)`
- Returns comprehensive account snapshot:
  - Balance, equity, margin used/available, margin ratio
  - Open positions with live PnL, liquidation prices
  - Trade history, total PnL, performance metrics

### Margin Info — `getMarginInfo(subAccountId)`
- Returns margin details: used, available, ratio, maintenance margin

---

## 2. PositionBook (`position-book.js` — 176 lines)

### Data Structure
```
_entries: Map<subAccountId, { 
  account: { id, name, currentBalance, maintenanceRate, liquidationMode, status },
  positions: Map<posId, { id, symbol, side, entryPrice, quantity, notional, leverage, margin, liquidationPrice }>,
  rules: { maxLeverage, maxNotionalPerTrade, maxTotalExposure, liquidationThreshold, liquidationMode }
}>

_symbolAccounts: Map<symbol, Set<subAccountId>>  // reverse index for price-driven risk
```

### Key Operations
| Method | Description |
|--------|-------------|
| `load(byAccount)` | Bulk-load from DB query result |
| `add(position, account)` | Add single position (creates account entry if needed) |
| `remove(positionId, subAccountId)` | Remove position + cleanup empty accounts |
| `updateBalance(subAccountId, newBalance)` | Update cached balance |
| `updatePosition(positionId, subAccountId, updates)` | Patch position fields |
| `updateAccountStatus(subAccountId, status)` | Update status (e.g. after liquidation) |
| `getAccountsForSymbol(symbol)` | Get all accounts with positions on a symbol |

### Cleanup Behavior
- When a position is removed, checks if any other positions share the same symbol
- If not, removes account from `_symbolAccounts` reverse index
- If account has zero positions, removes the entire entry

---

## 3. PriceService (`price-service.js` — 116 lines)

### Price Resolution Cascade
```
1. WS cache (exchange.getLatestPrice) → if < 10s old → use
2. Redis price cache (getPriceCache) → if < 10s old → use + update local
3. REST fallback (exchange.fetchTicker) → use
4. null — no price available
```

### Staleness Threshold
`PRICE_STALE_MS = 10_000` (10 seconds)

### Functions
- `setPrice(symbol, mark)` — sync, called on every tick
- `getPrice(symbol)` — sync, fast path for risk checks
- `getFreshPrice(symbol)` — async, uses cascade with staleness check
- `getFreshPrices(symbols)` — async, de-duplicated multi-symbol resolution
- `calcPositionsUpnl(positions)` — async, total unrealized PnL using fresh prices

---

## 4. TradeValidator (`trade-validator.js` — 142 lines)

### Validation Checks (in order)
1. **Account exists** — DB lookup
2. **Account active** — status must be 'ACTIVE' (not FROZEN/LIQUIDATED)
3. **Price available** — WS → price service → REST fetch
4. **Rule checks**:
   - `leverage ≤ rules.maxLeverage`
   - `notional ≤ rules.maxNotionalPerTrade`
5. **Exposure check**: `currentExposure + newNotional ≤ rules.maxTotalExposure`
6. **Margin check**: `requiredMargin ≤ availableMargin`
7. **Margin ratio check**: `postTradeMarginRatio < 98%`

### Margin Calculation
```
equity = balance + totalUpnl + oppositePositionPnl
maintenanceMargin = (totalNotional - oppositeNotional) × maintenanceRate
availableMargin = equity - maintenanceMargin
marginUsageRatio = (currentMarginUsed + newMargin) / equity
```

### Error Codes
| Code | Description |
|------|-------------|
| `ACCOUNT_NOT_FOUND` | Sub-account doesn't exist |
| `ACCOUNT_FROZEN` | Account status ≠ ACTIVE |
| `INSUFFICIENT_MARGIN` | Not enough margin for trade |
| `MAX_LEVERAGE_EXCEEDED` | Leverage exceeds account limit |
| `MAX_NOTIONAL_EXCEEDED` | Trade size exceeds per-trade limit |
| `MAX_EXPOSURE_EXCEEDED` | Total exposure would exceed limit |
| `MARGIN_RATIO_EXCEEDED` | Post-trade margin ratio ≥ 98% |
| `NO_PRICE` | Cannot determine current price |

---

## 5. TradeExecutor (`trade-executor.js` — 1155 lines)

### Core Methods

#### `executeTrade(subAccountId, symbol, side, quantity, leverage, type, options)`
- Detects: is there an opposite position? → **FLIP** or **NORMAL**
- Options: `fastExecution, fallbackPrice, origin, reduceOnly`
- Returns: `{ success, orderId, position, ... }` or `{ success: false, errors }`

#### `_executeNormal()` — Open a New Position
1. Validate via `TradeValidator`
2. Place exchange market order (with clientOrderId `PMS{prefix}_{uuid}`)
3. **DB Transaction** (Prisma $transaction):
   - Create `VirtualPosition` (OPEN)
   - Create `Trade` record
   - Deduct margin from account balance
   - Apply `_applyBalanceDelta()` with reason
4. Update in-memory position book
5. Sync Redis risk snapshot
6. Schedule dynamic liquidation price refresh
7. Broadcast fill event to WebSocket frontend

#### `_executeFlip()` — Close Opposite + Open New
1. Close the opposite position (realizing PnL)
2. Open new position with remaining quantity
3. Single DB transaction for both operations
4. Net quantity: new quantity - opposite quantity
5. If new size > opposite: close old + open with remainder
6. If new size ≤ opposite: partial close only

#### `closePosition(positionId, action)`
- **Exchange Position Check**: Fetches real Binance positions
  - If real position exists and side matches → place market close order
  - If real position exists but side DOESN'T match → **virtual-only close** (desync protection)
  - If no real position (already closed on exchange) → **virtual-only close** (reconciliation)
- PnL calculation: `computePnl(side, entryPrice, closePrice, quantity)`
- DB transaction: close position + credit PnL + create trade record
- Post-close: removes from position book, syncs snapshot

#### `liquidatePosition(positionId)`
- Like closePosition but uses cached mark price
- Tries exchange order but **falls back to virtual-only** if exchange fails
- Always reads fresh balance from DB inside transaction
- Creates trade with `origin: 'LIQUIDATION'`

#### `partialClose(positionId, fraction, action)`
- Partially reduces a position by `fraction` (0.0 to 1.0)
- Reduces `quantity`, `notional`, `margin` proportionally
- PnL on the closed portion is realized
- Used by ADL tiers

#### `takeoverPosition(positionId, adminUserId)`
- Admin absorbs a user's position (house takes over)
- Virtually closes the position on the user's book
- Real exchange position stays open (admin manages manually)
- Creates trade with `origin: 'TAKEOVER'`

#### `reconcilePosition(symbol, closePrice)`
- Handles orphaned positions (exchange position closed externally)
- Finds ALL open virtual positions for the symbol (across all accounts)
- Closes each with PnL at the given closePrice
- Used by position-sync and proxy-stream reconciliation

### Redis Snapshot — `_syncSnapshot(subAccountId)`
- Writes fresh risk snapshot to Redis after every trade mutation
- Includes: balance, equity, margin, positions with live PnL, liquidation prices
- Used by GET /positions endpoint as fast cache

### Balance Delta — `_applyBalanceDelta(tx, subAccountId, delta, reason)`
- Writes a `BalanceLog` entry alongside every balance change
- Tracks reason: 'OPEN_TRADE', 'CLOSE_TRADE', 'LIQUIDATION', 'FUNDING', etc.
- Prevents balance from going negative (clamps to 0 floor)

---

## 6. LiquidationEngine (`liquidation.js` — 671 lines)

### Risk Evaluation — `evaluateAccount(subAccountId)`

Computes margin ratio for an account using in-memory data:
```
equity = balance + totalUpnl
maintenanceMargin = totalNotional × maintenanceRate
marginRatio = maintenanceMargin / equity  (≥ 1.0 = insolvent)
```

### Liquidation Modes (per-account configurable)

| Mode | Behavior at Threshold |
|------|----------------------|
| `INSTANT_CLOSE` | Close ALL positions immediately |
| `ADL_30` | Progressive Auto-Deleverage (3 tiers) |
| `TAKEOVER` | Admin absorbs positions |

### ADL Tiers (ADL_30 mode)

| Tier | Trigger | Action |
|------|---------|--------|
| Tier 1 | `marginRatio ≥ T` | Partial close 30% of largest position |
| Tier 2 | `marginRatio ≥ T + 0.025` | Partial close 50% of largest position |
| Tier 3 | `marginRatio ≥ T + 0.05` | Full close of ALL positions |

Where `T = liquidationThreshold` (default 0.90).

### Liquidation Price Calculation

#### Position-Level — `calculateLiquidationPrice()`
```
LONG:  liqPrice = entryPrice × (1 - balance / (notional × effective_threshold))
SHORT: liqPrice = entryPrice × (1 + balance / (notional × effective_threshold))
```

#### Account-Level — `calculateAccountLiqPrice()`
- Considers ALL positions and their combined margin impact
- Finds the price at which the dominant position would cause account margin breach

#### Dynamic Liq Prices — `calculateDynamicLiquidationPrices()`
- Re-calculates liquidation prices considering cross-position effects
- Uses current mark prices for all other positions
- Refreshed after every trade + periodically

### WebSocket Emission
- **PnL Updates**: Throttled at 50ms per position, sent to frontend
- **Margin Updates**: Throttled at 80ms per account
- Uses bounded throttle with coalescing (latest value wins)

### Constants
```
DEFAULT_LIQUIDATION_THRESHOLD = 0.90
INSOLVENCY_MARGIN_RATIO = 1.0
PNL_EMIT_MIN_INTERVAL_MS = 50
MARGIN_EMIT_MIN_INTERVAL_MS = 80
```

---

## 7. Risk Math (`risk-math.js` — 102 lines)

Pure, zero-dependency functions:

```python
computePnl(side, entryPrice, closePrice, quantity)
  LONG:  (close - entry) × quantity
  SHORT: (entry - close) × quantity

computeAvailableMargin({ balance, maintenanceRate, totalUpnl, totalNotional, oppositeNotional, oppositePnl })
  equity = balance + totalUpnl + oppositePnl
  maintenanceMargin = (totalNotional - oppositeNotional) × maintenanceRate
  availableMargin = equity - maintenanceMargin

computeMarginUsageRatio({ equity, currentMarginUsed, newMargin })
  ratio = (currentMarginUsed + newMargin) / equity
  if equity ≤ 0: return 999

createTradeSignature(subAccountId, action, positionId)
  SHA-256 of "{subAccountId}:{action}:{positionId}:{timestamp}:{uuid}"

createOpenTradeSignature(subAccountId, symbol, side, quantity)
  SHA-256 of "{subAccountId}:{symbol}:{side}:{quantity}:{timestamp}:{uuid}"
```

---

## 8. Risk Errors (`errors.js` — 44 lines)

Structured error codes + Binance error parser:

### Binance Error Mapping
| Code | Internal Code | Description |
|------|--------------|-------------|
| -4164 | `EXCHANGE_MIN_NOTIONAL` | Min notional not met |
| -2019 | `EXCHANGE_MARGIN_INSUFFICIENT` | Margin insufficient |
| -1111 | `EXCHANGE_PRECISION` | Quantity precision error |
| -1116 | `EXCHANGE_INVALID_ORDER` | Invalid order type |
| -4003 | `EXCHANGE_QTY_TOO_SMALL` | Quantity too small |
| (other) | `EXCHANGE_REJECTED` | Generic exchange error |
