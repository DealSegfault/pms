# Refactor Workstream

Audit notes and target patterns for the PMS trading engine refactor.
These docs mix implemented fixes, active gaps, and target architecture. Treat them as a working plan, not as proof that every cutover is already complete.

## Current Status

- Implemented in code: managed-account reconciliation guards, pending-order ownership fields, UserStream dual-write into Redis Streams.
- Still primary in production code: `UserStreamService -> OrderManager.on_order_update()` and direct `RiskEngine.on_account_update()`.
- Not wired yet: stream consumers in `main.py`, startup order backfill, full callback removal.

## Stop Doing

| # | File | Anti-Pattern | Status | Impact |
|---|---|---|---|---|
| 01 | [Stop fire-and-forget](01-stop-fire-and-forget.md) | `asyncio.ensure_future` for critical fills | Partial | Fast-path fill handling improved, but supervised background restarts still exist |
| 02 | [Stop lambda chains](02-stop-lambda-callback-chains.md) | 4-level closure callbacks | Partial | Event-driven path exists, callback path is still live in `chase.py` |
| 03 | [Stop mutex rejection](03-stop-mutex-rejection.md) | `_restarting` flag drops work | Done | `_restart_pending` catch-up logic is implemented in `scalper.py` |
| 04 | [Stop blind reconciliation](04-stop-blind-reconciliation.md) | `on_account_update` updates all accounts | Done | Managed-account filtering and fill hints exist in `risk/engine.py` |
| 05 | [Stop missing audit trail](05-stop-missing-order-audit-trail.md) | No clientOrderId in DB, no order at creation | Partial | Schema and ownership fields exist, but placement-time persistence is still incomplete |
| 08 | [Stop exchange-wide virtual closes](08-stop-exchange-wide-virtual-closes.md) | Reduce-only market closes without exchange-side scoping/clamping | Not started | Wrong exchange exposure closed or close rejected on drift/dust |

## Start Doing

| # | File | Pattern | Status |
|---|---|---|---|
| 06 | [Use event streams](06-use-event-streams-not-callbacks.md) | Redis Streams + independent consumer groups | Partial |
| 07 | [Persist everything](07-do-persist-everything.md) | DB audit trail from placement to fill | Partial |
