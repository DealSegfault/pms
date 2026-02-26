# HFT & Order Management Strategies Inventory

> Extracted from `logic-money/market_maker.py`, `server/routes/trading/`, and `server/risk/`  
> This catalogs every technique used for high-performance order flow management.

---

## 1. Exchange Rate Limiting Strategies

### a) Token-Bucket Rate Limiter (from `market_maker.py`)
```python
class RateLimiter:
    def __init__(self, max_requests, time_window):
        self.max_requests = max_requests
        self.time_window = time_window
        self.tokens = max_requests
        self.last_refill = time.time()
    
    async def acquire(self):
        # Refill tokens based on elapsed time
        # Sleep if no tokens available
```
- Token bucket with automatic refill
- Time-window based request counting
- Async-aware (yields to event loop during backoff)

### b) Concurrency Limiter (`exchange.js`)
- `MAX_CONCURRENT_ORDERS = 10` — max parallel exchange REST calls
- Queue-based: excess requests wait for a slot
- Prevents Binance WebSocket frame overflow

### c) Per-Order Backoff with Jitter (`limit-orders.js:placeSingleOrder`)
```
SCALE_ORDER_RATE_LIMIT_MS = 110ms (between orders)
SCALE_ORDER_BACKOFF_MS = 220ms+ (on error)
SCALE_ORDER_BACKOFF_JITTER_MS = 80ms
```
- Exponential backoff on rate-limit errors (-1003, -1015)
- Random jitter prevents thundering herd
- Up to 2 retries for transient errors

### d) Reprice Throttle (`chase-limit.js`)
```
REPRICE_THROTTLE_MS = 500ms — min time between order reprices
REDIS_SAVE_THROTTLE_MS = 1000ms — min time between Redis state saves
```
- Prevents self-DOS on the exchange during volatile markets
- Coalesces rapid price changes into single reprice

---

## 2. Order Placement Strategies

### a) Batch Order API (Binance native)
- `createBatchLimitOrders()`: 5 orders per REST call
- `cancelBatchOrders()`: 10 cancels per REST call
- Used by scalper `startLeg()` for atomic multi-layer placement
- Falls back to individual calls on batch failure

### b) Fast-Ack Market Orders
- Return immediately without waiting for fill confirmation
- Use `fallbackPrice` for estimated fill data
- Estimate fees as 0.05% taker fee
- Saves 200ms+ per order (no re-fetch)

### c) ClientOrderId Routing
- Format: `PMS{subAccountId[:8]}_{type}_{uuid}`
- Enables instant routing of fill events to correct sub-account
- No Redis lookup needed for PMS-prefixed orders

### d) Sliding Window Fill Detector (`scalper.js`)
```
maxFillsPerMinute — burst rate limit per side
burstCooldownMs() — sliding 60s window of fill timestamps
```
- Prevents runaway fill loops in volatile markets
- Per-side tracking (long fills vs short fills)

---

## 3. Price Tracking Strategies

### a) Multi-Source Price Cascade
```
1. WS cache (exchange.getLatestPrice) — 0ms, <10s stale check
2. Redis price cache (getPriceCache) — 1-2ms
3. REST fallback (exchange.fetchTicker) — 100-500ms
```
- Falls through automatically
- Staleness threshold: 10 seconds

### b) Combined WS Stream (`exchange.js`)
- `{symbol}@markPrice@1s` — mark/index price every 1s
- `{symbol}@bookTicker` — bid/ask on every change
- Max 200 streams per WS connection (100 symbols)
- Mid-price: `(bid + ask) / 2`
- Separate throttles:
  - Event emission: 50ms per symbol
  - Redis write: 500ms per symbol

### c) Demand-Driven Subscriptions
- Only subscribe to symbols with open positions (`_loadPositionBook`)
- Unsubscribe when all positions on a symbol are closed
- Stale symbol detection + forced resubscribe

### d) Stale Symbol Recovery
```javascript
getStaleSymbols(thresholdMs = 10_000)  // symbols without a tick in 10s
forceResubscribe(symbol)               // tear down + reconnect WS for that symbol
```

---

## 4. Position Management Strategies

### a) Virtual Position System
- Exchange holds ONE aggregate position per symbol
- PMS maintains MANY virtual positions per symbol (different sub-accounts)
- Virtual PnL is tracked independently
- Exchange position is shared across all virtual positions

### b) Position Flip Detection
- If new order is opposite side to existing position → FLIP (close + open)
- Net quantity = new - existing
- Single DB transaction for atomicity

### c) Desync Protection
- Before every close order: verify real exchange position exists AND matches side
- If sides don't match → virtual-only close (no exchange order)
- If no exchange position → virtual-only close (reconciliation)

### d) Multi-Path Reconciliation
```
Path 1: Real-time via ACCOUNT_UPDATE (proxy-stream) — <100ms
Path 2: Real-time via ORDER_TRADE_UPDATE (order-sync fast-path) — <100ms  
Path 3: Periodic position-sync (30s) — backup
Path 4: Periodic order-sync (60s) — backup
```
- Redis lock prevents races between paths
- 30s debounce prevents duplicate reconciliations

### e) Orphan Position Detection
- Compare all virtual positions against real exchange positions
- Virtual position with no matching exchange position = orphan
- Auto-close orphans at mark price

---

## 5. Risk Management Strategies

### a) Tick-Driven Risk Evaluation
- Every price tick evaluates all accounts holding that symbol
- 2s minimum interval per account (`EVAL_MIN_INTERVAL_MS`)
- No periodic polling needed for actively-traded symbols

### b) Progressive ADL (Auto-Deleverage)
```
Tier 1 (marginRatio ≥ 0.90): Close 30% of largest position
Tier 2 (marginRatio ≥ 0.925): Close 50% of largest position  
Tier 3 (marginRatio ≥ 0.95): Close ALL positions
```
- Gradual deleveraging avoids flash cascades
- Targets the highest-impact position first

### c) Dynamic Liquidation Prices
- Re-calculated after every trade
- Cross-position: considers all positions together
- Account-level: single price that would breach the whole account

### d) Redis Risk Snapshots
- Written after every trade mutation (sync)
- Read by GET /positions for fast response (<5ms vs 50ms+ DB query)
- TTL 30s — auto-expire if risk engine goes down

---

## 6. uvloop and Async Strategies (Python `market_maker.py`)

### a) uvloop Event Loop
```python
import uvloop
asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
```
- Drop-in replacement for asyncio event loop
- 2-4x faster than default asyncio on syscalls
- Critical for WebSocket message processing throughput

### b) Direct WebSocket (Skip HTTP)
- Uses `websockets` library directly → raw WS frames
- No HTTP overhead for market data (vs polling REST)
- No CCXT overhead for price feeds

### c) Redis Pub/Sub for Inter-Process Communication
```python
pubsub = redis.pubsub()
await pubsub.subscribe('quote_update', 'trade_update')
async for message in pubsub.listen():
    # Process immediately in event loop
```
- Zero HTTP overhead between components
- Sub-millisecond latency for event delivery
- Native async iteration

### d) asyncio.TaskGroup Supervisor Pattern
```python
async with asyncio.TaskGroup() as tg:
    for pair in trading_pairs:
        tg.create_task(supervise_pair(pair))
```
- All feeds run concurrently in single event loop
- Automatic restart on failure with exponential backoff
- Graceful shutdown via signal handlers

---

## 7. Order State Management Strategies

### a) In-Memory + Redis Persistence
- Active algo states (chase, scalper, TWAP, etc.) live in `Map` in memory
- Periodically serialized to Redis (throttled)
- On restart: scan Redis → restore state → resume

### b) Fill Deduplication
- `_recentlyProcessed` Set tracks recently handled exchange order IDs
- Trade signatures prevent duplicate DB records
- Chase ID tracking prevents double-processing

### c) Graceful Degradation
- If exchange order fails → fall back to virtual-only close
- If price unavailable → skip tick, retry next
- If Redis down → continue with in-memory only
- If DB transaction fails → rollback, no partial state

---

## 8. Scalper-Specific Strategies

### a) Exponential Layer Offsets
- Spread orders at exponentially-increasing distances from mid-price
- Outer layers catch bigger moves but fill less often
- `generateLayerOffsets(base, count, maxSpread)`

### b) Skew-Weighted Size Allocation
- Positive skew: larger orders further from mid (stealth)
- Negative skew: larger orders closer to mid (aggressive)
- Sum always equals total requested quantity

### c) Fill-Adaptive Backoff
- Per-slot, per-side exponential backoff
- Capped at 16× base delay
- Prevents runaway fills in trending markets

### d) PnL Feedback Loop (EMA)
- Tracks per-slot realized PnL
- Uses exponential moving average (decay 0.85)
- Designed for future adaptive offset adjustment

### e) Max Loss Per Close Protection
- Compares closing position's entry vs current mark
- If unrealized loss in bps exceeds threshold → pause slot
- Prevents locking in catastrophic drawdowns

