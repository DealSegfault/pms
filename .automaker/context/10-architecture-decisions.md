# Finalized Architecture Decisions

> Decisions confirmed from the unknown-unknowns risk discussion.
> All skills and architecture docs are updated to reflect these.

---

## 1. Database: PostgreSQL via SQLAlchemy

- **PostgreSQL** already running at `localhost:55432` via `npx pg_here` in `pg_local/`
- **Connection**: `postgresql://postgres:postgres@localhost:55432/postgres?connection_limit=10&pool_timeout=10`
- **Python access**: SQLAlchemy (async) with models matching Prisma schema
- **JS access**: Prisma (unchanged) — both access the same DB concurrently
- No SQLite single-writer conflict

## 2. Symbol Format: Binance Native Only

- Python uses `BTCUSDT` everywhere — no ccxt, no `BTC/USDT:USDT`
- Vanilla Python REST calls to Binance API (no ccxt library)
- Redis price keys: `pms:price:BTCUSDT` (updated from ccxt format)
- Frontend converts at the boundary when needed
- Depth handler already uses native format (`btcusdt@depth@100ms`)

## 3. Redis: Selective Flush

Replace `flushdb()` with targeted price key cleanup:
```python
# INSTEAD OF: redis_client.flushdb()
# DO: only purge stale price keys
for key in redis_client.scan_iter("pms:price:*"):
    redis_client.delete(key)
```

This preserves:
- `pms:chase:*` — active chase orders
- `pms:twap:*` — active TWAPs
- `pms:trailstop:*` — active trail stops
- `pms:risk:*` — risk snapshots
- `pms:scalper:*` — active scalpers

## 4. User Stream: Python Exclusive

- Python creates and manages the Binance listen key
- JS **never** touches listen keys or user stream WebSocket
- JS reads order/position events purely from Redis pub/sub
- Hard cutover: when Python starts, `proxy-stream.js` must be stopped

## 5. Async Callbacks: Fire and Forget

All MarketDataService callbacks use `asyncio.create_task()`:
```python
# In MarketDataService._on_orderbook_update():
for cb in self._callbacks.get(symbol, []):
    asyncio.create_task(cb(symbol, bid, ask, mid))  # Non-blocking
```

This prevents slow algo operations (REST calls, DB writes) from blocking the depth handler.

## 6. Event Sequence Numbers

Every event carries a monotonic `seq` for frontend ordering:
```python
self._seq = 0
def next_seq(self):
    self._seq += 1
    return self._seq

# In _publish_event():
payload["seq"] = self.next_seq()
```

Frontend applies only if `event.seq > lastAppliedSeq`.

## 7. Callback Invalidation

Algo callbacks check liveness before acting:
```python
async def _on_fill(self, algo_state, order):
    if algo_state.id not in self._active:
        return  # Algo was cancelled, ignore fill
    # ... proceed with fill handling
```

## 8. Orphan Recovery on Startup

On Python process start:
1. Query exchange: `get_open_orders()` for all symbols
2. Load Redis algo states: `pms:chase:*`, `pms:twap:*`, etc.
3. Match exchange orders → algo states
4. Orphans (exchange order with no matching algo) → cancel
5. Dead algos (Redis state with no exchange order) → clean up
