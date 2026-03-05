---
name: subaccount-safe-tca
description: Design or modify TCA, telemetry, history, execution, or analytics features without mixing virtual sub-accounts, main-account activity, or order lifecycles. Use when touching order placement, fills, Redis events, risk snapshots, proxy routes, history, or analytics tables.
---

# Subaccount-Safe TCA

Use this skill whenever the task can change execution attribution, order lifecycle tracking, or analytics derived from orders/fills.

## Use When

- Adding a TCA, telemetry, reporting, or analytics module
- Touching `orders/manager.py`, `risk/engine.py`, `events/`, `server/routes/proxy.js`, `server/routes/history.js`, or `prisma/schema.prisma`
- Adding a new order type, bot path, proxy path, or reconciliation path
- Adding new DB/Redis/event fields that carry order or account identity

If the task changes DTOs or event/state shapes, also use `cross-system-dto-evaluation`.

## First Read

- `trading_engine_python/orders/manager.py`
- `trading_engine_python/risk/engine.py`
- `trading_engine_python/events/event_bus.py`
- `trading_engine_python/events/order_consumer.py`
- `trading_engine_python/events/risk_consumer.py`
- `server/routes/proxy.js`
- `server/routes/history.js`
- `trading_engine_python/tests/test_cross_system_integrity.py`
- `../../../refactor/subaccount-invariants.md`
- `../../../refactor/tca-module-design.md`

## Workflow

1. Classify the execution scope before writing code.
   - `SUB_ACCOUNT`: PMS-managed virtual execution with explicit `subAccountId`
   - `MAIN_ACCOUNT`: venue activity that belongs to the real exchange account but not one virtual sub-account
   - `EXTERNAL_UNKNOWN`: exchange activity seen by feed/snapshot but lacking hard ownership evidence

2. Preserve ownership truth.
   - Never promote `MAIN_ACCOUNT` or `EXTERNAL_UNKNOWN` to `SUB_ACCOUNT` from symbol, side, or UI-selected account.
   - Hard evidence is one of:
     - explicit `subAccountId` in a PMS command
     - PMS-tagged `clientOrderId`
     - trusted Redis/order mapping
     - persisted lifecycle row created from a prior hard-evidence event

3. Treat lifecycle events as primary truth.
   - Placement intent, exchange ack, working, partial fill, fill, cancel, expire, and reconciliation are separate events.
   - `trade_executions`, `pending_orders`, and `pms:risk:*` are read models or snapshots, not complete lifecycle truth.

4. When adding persistence, store identity and confidence explicitly.
   - Always include: `execution_scope`, `sub_account_id`, `venue`, `venue_account_key`, `client_order_id`, `exchange_order_id`, `origin_type`, `ownership_confidence`, and event timestamps.
   - Index by `sub_account_id + timestamp`, `client_order_id`, `exchange_order_id`, and `symbol + timestamp`.

5. Keep analytics read-only.
   - TCA consumers may write their own tables and caches.
   - They must not mutate OMS, RiskEngine, or order state as part of normal analytics flow.

6. Reconciliation is allowed to close gaps, not invent ownership.
   - Reconciliation may mark a lifecycle stale, missing, orphaned, or ambiguous.
   - Reconciliation must not assign a sub-account without hard evidence.

## Hard Rules

- Every cross-system order/event payload for `SUB_ACCOUNT` scope carries `subAccountId`.
- Use `clientOrderId`, `exchangeOrderId`, `parentId`, and strategy IDs. Do not introduce bare `id` for lifecycle payloads.
- Do not infer sub-account ownership from `ACCOUNT_UPDATE` alone.
- Do not use `trade_executions` as the sole source for TCA.
- Do not mix symbol formats inside one new data model. Pick one canonical format and convert only at boundaries.
- Do not reuse “filled trade” tables to store order intents or pending submissions.

## TCA-Specific Requirements

- Consume from Redis Streams with a dedicated consumer group so TCA can run independently.
- Dedupe at-least-once delivery using stream event ID plus a stable lifecycle key.
- Capture both `source_ts` and `ingested_ts`.
- Link child orders created by chase/scalper/reprice flows back to one parent strategy/session.
- Store ownership confidence so downstream reports can exclude ambiguous rows.

## Required Checks Before Finishing

- Confirm the feature still preserves `subAccountId` across command, stream, Redis, DB, and frontend boundaries.
- Confirm ambiguous exchange activity remains ambiguous instead of being silently attributed.
- Confirm analytics tables can separate virtual sub-account execution from raw main-account activity.
- Run `trading_engine_python/tests/test_cross_system_integrity.py` if DTOs or event shapes changed.

Canonical planning docs for this skill now live in `refactor/`.
