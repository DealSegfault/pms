---
description: How to diagnose and fix bugs that spread across DB, Redis, Backend, Python, and Frontend
---

# Cross-System Debugging — Full-Stack Data Consistency

## Why This Skill Exists

Many bugs in PMS don't live in a single file — they live in the **seams** between
systems. A value gets written in one format by Python, stored differently in Redis,
read with yet another assumption in JS, and displayed wrongly in the frontend.
Fixing only the visible symptom creates whack-a-mole bugs. This skill teaches how
to trace a data field through every layer, find the **root cause**, and fix it
**everywhere at once**.

---

## The Five Layers

| # | Layer | Tech | Key Files |
|---|-------|------|-----------|
| 1 | **Database** | Prisma + SQLite | `prisma/schema.prisma`, `server/db.js` |
| 2 | **Redis** | ioredis (JS) / redis-py (Python) | `server/redis.js`, `server/redis-proxy.js`, `trading_engine_python/redis/` |
| 3 | **Backend (JS)** | Express + WS | `server/*.js` (routes, WebSocket handlers) |
| 4 | **Python Engine** | asyncio + ccxt | `trading_engine_python/` (main.py, risk/, orders/, position/) |
| 5 | **Frontend** | Vanilla JS + Vite | `src/*.js` (components, stores, API calls) |

---

## The Data Flow Map

```
┌──────────┐    REST / WS     ┌─────────────┐     Redis cmd      ┌──────────────┐
│ Frontend │ ◄──────────────► │  JS Backend  │ ◄───────────────► │ Python Engine│
│  (src/)  │                  │  (server/)   │   streams/pub-sub │  (trading_   │
└──────────┘                  └──────┬───────┘                   │  engine_py/) │
                                     │                           └──────┬───────┘
                                     │ Prisma ORM                       │ Redis
                                     ▼                                  ▼
                              ┌──────────────┐               ┌──────────────┐
                              │   SQLite DB  │               │    Redis     │
                              │ (prisma/     │               │  (price,     │
                              │  pms.db)     │               │   orders,    │
                              └──────────────┘               │   risk)      │
                                                             └──────────────┘
```

### Key Data Paths

1. **Order lifecycle**: Frontend → JS route → Redis `pms:cmd:trade` → Python BLPOP → process → `pms:result:{id}` → JS polls → Frontend
2. **Price feed**: Python WS → `pms:price:{symbol}` (Redis) → JS reads; also JS WS → same key
3. **Position sync**: Python fills → update DB via Redis event → JS persists → broadcast to Frontend
4. **Risk snapshot**: Python computes → `pms:risk:{subAccountId}` (Redis) → JS reads → Frontend polls

---

## Common Root Causes (Patterns We've Seen)

### 1. Symbol Format Mismatch
- **Symptom**: Charts/orders/positions show wrong or missing data
- **Root cause**: ccxt uses `BTC/USDT:USDT`, Binance uses `BTCUSDT`, DB stores one or the other inconsistently
- **Where it breaks**: Every boundary — Python↔Redis, Redis↔JS, JS↔Frontend, JS↔DB

**Fix pattern**: Pick a canonical format per layer and normalize at boundaries:
```
Internal (Python / JS logic)  →  ccxt format:    BTC/USDT:USDT
Redis keys                     →  ccxt format:    pms:price:BTC/USDT:USDT
Database storage               →  ccxt format:    BTC/USDT:USDT
Exchange API calls             →  Binance format: BTCUSDT  (convert at boundary only)
Frontend display               →  display format: BTCUSDT  (convert from ccxt at render)
```

### 2. Stale / Missing Data in Redis
- **Symptom**: Frontend shows old prices, risk snapshots lag, orders appear stuck
- **Root cause**: TTL expired, writer crashed, or key name mismatch between writer and reader
- **Layers involved**: Python (writer) → Redis (store) → JS (reader)

**Fix pattern**: Always check:
1. Is the writer still running? (Python logs)
2. Is the key name exactly the same? (`redis-cli KEYS 'pms:price:*'`)
3. Is the TTL appropriate? (30s for prices, 120s for risk)

### 3. Command Queue Desync
- **Symptom**: Actions from frontend timeout, "Python engine unavailable"
- **Root cause**: Python not consuming from the right queue, or result key mismatch
- **Layers involved**: JS (redis-proxy.js) → Redis (queue) → Python (BLPOP consumer)

**Fix pattern**: Verify the queue name in JS route matches the BLPOP key in Python.

### 4. DB Schema vs Runtime Shape Mismatch
- **Symptom**: Prisma errors on write, missing fields in API responses
- **Root cause**: Schema was migrated but JS/Python code still uses old field names
- **Layers involved**: Prisma schema → JS backend → Frontend expectations

**Fix pattern**: After any migration, grep all layers for the old field name.

### 5. WebSocket Event Shape Mismatch
- **Symptom**: Frontend doesn't update, or throws on incoming message
- **Root cause**: Python publishes event via `pms:events:{type}`, JS re-broadcasts, but frontend expects different field names
- **Layers involved**: Python (publisher) → Redis pub/sub → JS (subscriber/broadcaster) → Frontend (WS handler)

**Fix pattern**: Log the actual payload at each hop and compare shapes.

---

## Diagnostic Checklist

When you encounter a bug that might span systems, follow this trace:

### Step 1: Identify the data field(s)
What specific field is wrong? (e.g., `symbol`, `price`, `side`, `status`, `size`)

### Step 2: Trace it through every layer (bottom-up)

```
[ ] Database:   What format is stored? Check schema.prisma + actual DB rows
[ ] Redis:      What key pattern? What value format? `redis-cli GET/KEYS`
[ ] Python:     Where does Python read/write this field? What format?
[ ] JS Backend: Where does JS read/write this field? What format?
[ ] Frontend:   Where does the UI consume this field? What does it expect?
```

### Step 3: Find the mismatch boundary
The bug lives where **format A** meets **format B**. Common boundaries:
- Python → Redis: Python writes, Redis stores
- Redis → JS: JS reads from Redis
- JS → DB: Prisma writes/reads
- JS → Frontend: WebSocket or REST response
- Frontend → JS: API request body

### Step 4: Fix at the right level
- **Normalize at the boundary**, not deep inside business logic
- Create/use converter functions: `toCcxt()`, `toBinance()`, `toDisplay()`
- Fix in ALL directions (read and write)

### Step 5: Verify across ALL layers
Don't just check the layer you fixed. Verify end-to-end:

```bash
# DB
sqlite3 prisma/pms.db "SELECT symbol FROM VirtualPosition LIMIT 5;"

# Redis
redis-cli KEYS 'pms:price:*' | head -5
redis-cli GET 'pms:price:BTC/USDT:USDT'

# Python logs
grep -i 'symbol' /tmp/python-engine.log | tail -10

# JS backend — hit an API endpoint
curl -s http://localhost:3000/api/positions | jq '.[0].symbol'

# Frontend — check browser console / network tab
```

---

## Key Converter Functions to Know

### Python side
```python
# trading_engine_python/utils/symbol.py (or similar)
def to_binance(ccxt_symbol: str) -> str:
    """BTC/USDT:USDT → BTCUSDT"""
    return ccxt_symbol.split(':')[0].replace('/', '')

def to_ccxt(binance_symbol: str) -> str:
    """BTCUSDT → BTC/USDT:USDT"""
    # requires market info from ccxt exchange
    pass
```

### JS side
```javascript
// server/utils or inline
function toBinance(ccxtSymbol) {
    return ccxtSymbol.split(':')[0].replace('/', '');
}
```

### Frontend side
```javascript
// Display-only conversion
function displaySymbol(ccxtSymbol) {
    return ccxtSymbol.split(':')[0].replace('/', '');
}
```

---

## Anti-Patterns to Avoid

1. **Fixing only the visible layer** — If the frontend shows wrong data, don't just fix the frontend. Trace backward.
2. **Ad-hoc format conversions sprinkled everywhere** — Centralize in utility functions.
3. **Assuming Redis and DB agree** — They often diverge after crashes or partial writes.
4. **Testing only the happy path** — Test with symbols that have edge-case formats too (e.g., `1000PEPE/USDT:USDT`).
5. **Ignoring the Python↔JS boundary** — This is where most format bugs hide because two different languages/teams wrote the code.

---

## Related Files Quick Reference

| Purpose | JS File | Python File |
|---------|---------|-------------|
| Redis connection | `server/redis.js` | `trading_engine_python/redis/` |
| Redis proxy (cmd/result) | `server/redis-proxy.js` | `trading_engine_python/redis/command_consumer.py` |
| Price cache | `server/redis.js → setPriceCache` | `trading_engine_python/feeds/` |
| Order routing | `server/routes/trading.js` | `trading_engine_python/orders/` |
| Position management | `server/routes/positions.js` | `trading_engine_python/position/` |
| Risk engine | `server/risk.js` | `trading_engine_python/risk/engine.py` |
| DB access | `server/db.js` (Prisma) | via Redis events → JS persists |
| WS broadcast | `server/ws.js` | via Redis `pms:events:*` |
