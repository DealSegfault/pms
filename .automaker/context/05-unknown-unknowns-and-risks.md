# Unknown Unknowns, Edge Cases & Migration Risks

> This document captures risks, gotchas, and things that aren't obvious from code reading alone.

---

## 1. Critical Edge Cases (Must Preserve in Python)

### a) Virtual vs Exchange Position Desync
**Risk**: The PMS maintains virtual positions independently from the exchange. They can desync.
- **When**: Manual trades on exchange, external bot activity, API timeouts, partial fills
- **Current guards**:
  - `closePosition()` checks exchange side before sending order
  - If sides don't match → virtual-only close
  - If no exchange position → virtual-only close
  - `reconcilePosition()` sweeps orphans every 30s
- **Python must preserve**: ALL desync detection logic

### b) Race Conditions in Reconciliation
**Risk**: Multiple paths can try to reconcile the same symbol simultaneously.
- proxy-stream ACCOUNT_UPDATE (real-time)
- position-sync (30s periodic)
- order-sync (60s periodic)
- **Guard**: Redis reconcile lock (`NX EX 30`) + 30s debounce
- **Python must preserve**: Lock coordination between paths

### c) Exchange Order ID Divergence (Chase Orders)
**Risk**: Chase engine reprices by cancelling old order + placing new one. The exchangeOrderId changes, but the DB `pendingOrder` record keeps the ORIGINAL ID.
- `processChaseOrderFill()` has fallback: looks up by (subAccountId + type + symbol) when exchangeOrderId doesn't match
- **Python must preserve**: This fallback lookup path

### d) Batch API Partial Failures
**Risk**: Binance batch order API can have individual element failures while others succeed.
- `createBatchLimitOrders()`: Each element in response can independently succeed or fail
- `cancelBatchOrders()`: Same — partial success is normal
- **Python must preserve**: Per-element error handling in batch responses

### e) Margin Calculation During Flips
**Risk**: When flipping a position (LONG→SHORT), the margin calculation must account for:
- PnL from closing the opposite position
- Credit back the opposite position's margin
- Only deduct margin for the NET new position
- All in a single DB transaction
- **Python must preserve**: Atomic flip logic

---

## 2. Dependency Gotchas

### a) Prisma ORM (DB Layer)
- Currently JS-only via `@prisma/client`
- **Python migration**: Need Python Prisma client OR raw SQL OR SQLAlchemy
- Schema: `schema.prisma` defines `VirtualPosition`, `Trade`, `SubAccount`, `PendingOrder`, `BalanceLog`, etc.
- **Risk**: Schema mismatch between JS and Python clients

### b) CCXT Library Conventions
- JS uses `ccxt.binance` with `defaultType: 'future'`
- Symbol format: `BTC/USDT:USDT` (not `BTCUSDT`)
- The Python market_maker uses direct REST, NOT ccxt
- **Decision needed**: Use ccxt-python or raw Binance API in Python?

### c) Exchange Rate Limits
- Binance Futures: 2400 weight/minute for REST
- Each order = 1-5 weight depending on type
- Batch = 5 weight for 5 orders
- IP bans: detected by regex in exchange.js
- **Python must preserve**: Weight tracking and ban detection

### d) Listen Key Lifecycle
- Create: `POST /fapi/v1/listenKey` (weight: 1)
- Keepalive: `PUT /fapi/v1/listenKey` (every 30 min)
- Expires after 60 min without keepalive
- Only ONE active listen key per API key pair
- **Risk**: If both JS and Python try to create listen keys simultaneously

---

## 3. Data Flow Integrity

### a) Balance Consistency
- Every balance change goes through `_applyBalanceDelta()` which creates a `BalanceLog`
- Balance is NEVER directly updated — always delta-based
- Floor clamp at 0 prevents negative balances
- **Python must preserve**: Audit trail + floor clamp

### b) Trade Signature Uniqueness
- Every trade gets a SHA-256 signature
- Used for dedup detection in `handleOrderFilled()`
- Includes timestamp + UUID → probabilistically unique
- **Python must preserve**: Same signature scheme for cross-system compatibility

### c) WebSocket Frontend Events
- `broadcast()` sends events to all connected frontend clients
- Event types: `market_fill`, `pnl_update`, `margin_update`, `position_update`, `chase_progress`, `scalper_progress`, `twap_progress`, etc.
- **Python must preserve**: Same event structure — frontend depends on exact shape

### d) Redis Key Format Compatibility
- JS and Python MUST use identical Redis key formats
- Price cache: `pms:price:BTC/USDT:USDT` (ccxt format, NOT `BTCUSDT`)
- Risk snapshot: `pms:risk:{uuid}` (uses Prisma-generated UUIDs)
- **Critical**: Any format inconsistency breaks cross-system communication

---

## 4. Performance Constraints

### a) Price Tick Processing Budget
- Mark price ticks: every 1s per symbol
- Book ticker: on every bid/ask change (could be 100+/s per symbol)
- Risk evaluation: ≤ 2s per account (throttled)
- PnL broadcast: ≤ 50ms per position
- **Target**: < 10ms per tick processing in Python

### b) Order Placement Latency
- Fast-ack market order: ~50ms (exchange REST)
- Batch limit orders: ~100ms for 5 orders
- Chase reprice: 500ms minimum throttle (by design, not bottleneck)
- **Target**: < 100ms for exchange REST calls in Python

### c) Memory Pressure
- `recentFills`: bounded at 500 entries
- `activeChaseOrders`: bounded at 500
- `activeScalpers`: bounded at 50
- `activeTwaps`: bounded at 500
- `activeTrailStops`: bounded at 500
- All Map-based with explicit limits
- **Python must preserve**: Bounded state containers

---

## 5. Migration Ordering — What MUST Move Together

### Phase 1 (Standalone, low risk):
- Market data WS (replace `exchange.js` combined streams)
- Price cache writes (same Redis keys)
- Nothing in JS breaks — just reads from different source

### Phase 2 (Requires coordination):
- User stream WS (replace `proxy-stream.js` WS connection)
- proxy-stream.js becomes Redis consumer (reads from Python)
- Order routing logic stays in JS during transition

### Phase 3 (High risk, requires careful testing):
- Risk engine (replace `server/risk/`)
- Trade execution (replace `trade-executor.js`)
- DB mutations move to Python
- JS becomes pure API gateway

### Phase 4 (Complex, lots of state):
- Chase engine, Scalper, TWAP, Trail stop
- These depend on trade execution + price feeds + Redis persistence
- Move AFTER risk engine is stable in Python

### Phase 5 (Cleanup):
- Remove JS exchange WS code
- Remove JS risk engine code
- Remove JS trading logic
- JS = Express API + WebSocket gateway + Auth

---

## 6. Testing Gaps (Unknown Unknowns)

### Things that aren't explicitly tested:
1. **Concurrent liquidation + manual close** — What if a user closes a position while ADL is running?
2. **Batch order + individual cancel race** — Batch placement returns while individual cancel arrives
3. **Redis failover** — What happens if Redis goes down mid-trade?
4. **DB transaction timeout** — Prisma transaction timeout during heavy load
5. **Exchange maintenance** — Binance 502s during planned maintenance windows
6. **Listen key rotation** — What if the key expires mid-session?
7. **Multi-symbol cascade** — Liquidation of position A affects margin for position B
8. **Scalper in trending market** — One leg fills repeatedly, other never fills → directional exposure
9. **TWAP during flash crash** — Price limit skips all remaining lots
10. **Chase during liquidity gap** — Order placed at stale bid/ask, immediate adverse fill

### Things that ARE robustly handled:
1. Server restarts (Redis state persistence + resume)
2. Exchange WS disconnection (auto-reconnect with backoff)
3. Duplicate fill processing (signature dedup)
4. Partial exchange failures (graceful degradation)
5. Rate limiting (multiple layers of protection)
