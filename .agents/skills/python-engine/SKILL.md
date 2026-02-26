---
description: Master guide for implementing the Python trading engine — step-by-step with resource references
---

# Python Trading Engine — Implementation Guide

> **Rule**: Never wipe the DB.
> **Branch**: `python-engine`
> **Root**: `/Users/mac/cgki/minimalte/trading_engine_python/`

---

## Key Architecture Decisions

Read `notes/10-architecture-decisions.md` for full rationale on each.

1. **PostgreSQL** — `postgresql://postgres:postgres@localhost:55432/postgres` via `pg_local/`
2. **SQLAlchemy (async)** — Python DB access, models in `trading_engine_python/db/models/`
3. **Binance-native symbols** — `BTCUSDT` everywhere, no ccxt. Vanilla Python REST.
4. **L1 orderbook** — Single price source from existing depth handler, no `@markPrice`
5. **Feed-driven order state** — Transitions from exchange feed, not REST responses
6. **Event-carried account state** — `{ balance, equity, marginUsed, positions }` in every fill/close event
7. **Frontend computes PnL locally** — No server-pushed `pnl_update`/`margin_update`
8. **Python owns user stream exclusively** — JS never touches listen keys
9. **Selective Redis flush** — Only purge price keys on startup, preserve algo state
10. **Async fire-and-forget callbacks** — `asyncio.create_task()` for all price tick callbacks
11. **Event sequence numbers** — Monotonic `seq` for frontend ordering
12. **SURF/Pump Chaser deprecated** — Removed entirely

---

## Pre-Read: Documentation Files

| Doc | Path | Content |
|-----|------|---------|
| Architecture | `notes/08-python-executor-architecture-v2.md` | Component design, OrderManager, Redis contract |
| Decisions | `notes/10-architecture-decisions.md` | All confirmed arch decisions with rationale |
| Order types | `notes/01-order-types-and-trading-routes.md` | All order types, behaviors, params |
| Risk engine | `notes/02-risk-engine-behaviors.md` | Position book, margin, liquidation, ADL |
| Sync & Redis | `notes/03-exchange-sync-redis-behaviors.md` | Exchange connector, sync, Redis keys |
| API requests | `notes/06-frontend-api-requests.md` | Every JSON POST body from frontend |
| WS events | `notes/07-frontend-websocket-events.md` | Every WS event shape frontend expects |
| JS cleanup | `notes/09-js-cleanup-plan.md` | What to keep, delete, modify in JS |

---

## Implementation Order (by dependency)

| Step | Skill | Description |
|------|-------|-------------|
| 1 | `.agents/skills/python-engine-step1/SKILL.md` | OrderState + OrderTracker |
| 2 | `.agents/skills/python-engine-step2/SKILL.md` | ExchangeClient (vanilla Binance REST) |
| 3 | `.agents/skills/python-engine-step3/SKILL.md` | OrderManager core |
| 4 | `.agents/skills/python-engine-step4/SKILL.md` | UserStreamService (Python-exclusive) |
| 5 | `.agents/skills/python-engine-step5/SKILL.md` | MarketDataService (L1 from depth handler) |
| 6 | `.agents/skills/python-engine-step6/SKILL.md` | CommandHandler (Redis) |
| 7 | `.agents/skills/python-engine-step7/SKILL.md` | RiskEngine + PositionBook + SQLAlchemy models |
| 8-10 | `.agents/skills/python-engine-step8-algos/SKILL.md` | Chase, Scalper, TWAP, TrailStop |
| 11 | `.agents/skills/python-engine-step11-js/SKILL.md` | JS cleanup |
| 12 | `.agents/skills/python-engine-step12-frontend/SKILL.md` | Frontend self-sufficiency |
| 13 | `.agents/skills/python-engine-step12-test/SKILL.md` | Integration testing |

---

## Validation After Each Step

1. `python -m py_compile <file>` — No syntax errors
2. `python -c "from <module> import <class>"` — Imports work
3. Run step-specific tests from the skill
4. Commit: `git add -A && git commit -m "feat(python-engine): step N — <description>"`
