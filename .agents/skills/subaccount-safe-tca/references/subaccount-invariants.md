# Subaccount Invariants

These rules define what must stay true as PMS grows.

## Core Identity Rules

1. The exchange account is real; PMS sub-accounts are virtual partitions on top of it.
2. A virtual sub-account must only be assigned when ownership evidence is explicit or previously persisted from explicit evidence.
3. `subAccountId` is a business identity, not a UI convenience field.
4. `clientOrderId` is an ownership hint and correlation key, but not the only source of truth.
5. `ACCOUNT_UPDATE` is exchange truth for net position, not ownership truth for virtual attribution.

## Current Hard-Evidence Sources

- PMS command payloads with `subAccountId`
- PMS-tagged `clientOrderId` (`PMS{sub8}_...`)
- Redis order mappings from the proxy path
- Existing tracked `OrderState` records
- Existing persisted lifecycle rows created from one of the items above

## Current Soft / Ambiguous Sources

- `ACCOUNT_UPDATE`
- Exchange open-order snapshots without a DB/order-tracker match
- Historical backfills
- Raw user-stream events for orders placed outside PMS tracking

Soft evidence may help reconciliation. It must not create new sub-account ownership on its own.

## Boundary Rules

### Command Boundary

- Every PMS trade/limit/algo command must carry `subAccountId`.
- The command handler must not “default” to another account in Python.

### Order Boundary

- OMS-generated orders must embed the sub-account prefix in `clientOrderId`.
- New analytics or storage layers must also keep the full `subAccountId`, not only the prefix.

### Risk Boundary

- `RiskEngine.on_account_update()` may reconcile quantities for a known sub-account.
- It must not create ownership for a symbol purely from aggregate exchange state.

### Proxy Boundary

- Bot/proxy routes must tag or map ownership before forwarding to the venue.
- Raw exchange history fetched later is lower-confidence than live PMS lifecycle events.

### History Boundary

- Backfilled rows must be flagged as backfilled/derived.
- They cannot be treated as first-class lifecycle truth for latency, decision, or markout TCA.

## Known Repo Hazards

1. `trade_executions` is overloaded.
   - Python RiskEngine writes actual fills there.
   - `server/routes/proxy.js` also writes order submissions there, including non-filled states.

2. Symbol format is mixed today.
   - Python execution/risk paths mostly use Binance-native symbols.
   - Proxy/history paths may write ccxt-style symbols.

3. `pending_orders` is incomplete for lifecycle analytics.
   - It mainly tracks Python-managed limit orders.
   - Bot/external paths can bypass it.

4. Redis Streams are at-least-once.
   - Any analytics consumer must dedupe and tolerate replays.

## Required Review Questions

- What is the exact ownership source for every row/event this change creates?
- Can the new logic misattribute raw main-account activity to a virtual sub-account?
- Does the change store or emit both `subAccountId` and the venue-level identifiers?
- Does the change accidentally treat a snapshot table as an append-only event log?
- If a child order is repriced/replaced, is the parent strategy/session still recoverable?

## Files To Inspect Before Changing Ownership Logic

- `trading_engine_python/orders/manager.py`
- `trading_engine_python/risk/engine.py`
- `trading_engine_python/events/`
- `server/routes/proxy.js`
- `server/routes/history.js`
- `prisma/schema.prisma`

