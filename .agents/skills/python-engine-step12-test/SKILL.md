---
description: Step 13 — Integration testing and verification
---

# Step 13: Integration Testing

## Goal
Verify the complete system works end-to-end: Frontend → JS → Redis → Python → Exchange → Redis → JS → Frontend.

## Test Matrix

### 1. Order Lifecycle Tests

| Test | Action | Expected |
|------|--------|----------|
| Market order open | POST /api/trade | Position created, WS: order_filled + position_updated + account snapshot |
| Market order close | POST /api/trade/close/:id | Position closed, PnL calculated, WS: position_closed + account snapshot |
| Limit order place | POST /api/trade/limit | Order on exchange, WS: order_placed |
| Limit order fill | Wait for fill | Position created, WS: order_filled + account snapshot |
| Limit order cancel | DELETE /api/trade/orders/:id | Order cancelled, WS: order_cancelled |
| Scale orders | POST /api/trade/scale | Multiple orders, partial success handling |

### 2. Algo Engine Tests

| Test | Action | Expected |
|------|--------|----------|
| Chase start | POST /api/trade/chase-limit | Order placed, WS: chase_progress |
| Chase reprice | L1 bid/ask moves | Order cancelled + replaced, WS: chase_progress updated |
| Chase fill | Limit hit | Position created, WS: chase_filled + account snapshot |
| Chase cancel | DELETE /chase-limit/:id | Order cancelled, WS: chase_cancelled |
| Chase max distance | L1 mid drifts far | Auto-cancel, WS: chase_cancelled (distance_breached) |
| Scalper start | POST /api/trade/scalper | Layers placed both sides |
| Scalper fill | Layer hit | Backoff slot, place counter-leg, WS: scalper_filled |
| TWAP start | POST /api/trade/twap | First lot placed immediately |
| TWAP progress | Wait for lots | Lots fire at intervals, WS: twap_progress |
| Trail stop | POST /api/trade/trail-stop | Tracks HWM/LWM via L1, WS: trail_stop_progress |
| Trail trigger | L1 mid retraces | Market close, WS: trail_stop_triggered |

### 3. Risk Engine Tests (Virtual Sub-Account)

| Test | Action | Expected |
|------|--------|----------|
| Trade validation | Exceed sub-account limits | Rejection with specific error code |
| ADL tier 1 | L1-based marginRatio ≥ 0.90 | 30% of largest position closed |
| ADL tier 2 | L1-based marginRatio ≥ 0.925 | 50% of largest position closed |
| ADL tier 3 | L1-based marginRatio ≥ 0.95 | ALL sub-account positions closed |

### 4. Frontend Self-Sufficiency Tests

| Test | Action | Expected |
|------|--------|----------|
| Fill updates dashboard | Place market order | Balance/equity/margin update WITHOUT refetch |
| Event-carried state | Any fill event | `account` field applied to local state |
| Local PnL compute | Price ticks from Binance WS | PnL updates on every tick (RAF-throttled) |
| Cold start | Page refresh | GET /margin loads correct state |
| Multi-account | Switch sub-accounts | Account state isolated correctly |

### 5. Resilience Tests

| Test | Action | Expected |
|------|--------|----------|
| Python restart | Kill + restart | Algos resume from Redis state |
| WS disconnect | Drop Binance WS | Auto-reconnect, backoff, resume |
| JS restart | Kill + restart | Subscribes to Redis, resumes WS proxy |

## Acceptance Criteria

- [ ] Market order round-trip: < 500ms frontend → position visible
- [ ] Limit order state machine: all transitions confirmed by feed
- [ ] Chase reprice: reprices within 500ms of L1 change
- [ ] Frontend dashboard: updates on event WITHOUT refetching /margin
- [ ] No duplicate positions (trade signature dedup works)
- [ ] Python restart: all algos resume within 5s
- [ ] Frontend PnL: computed locally from Binance WS, not server-pushed
