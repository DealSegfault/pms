-- 1) TEXT → JSONB for tca_events.data (cast existing rows in-place)
ALTER TABLE "tca_events"
  ALTER COLUMN "data" TYPE JSONB USING "data"::jsonb;

-- 2) Partial indexes — only index the hot rows (OPEN / PENDING)
CREATE INDEX IF NOT EXISTS "idx_positions_open"
  ON "virtual_positions" ("sub_account_id", "symbol")
  WHERE "status" = 'OPEN';

CREATE INDEX IF NOT EXISTS "idx_orders_pending"
  ON "pending_orders" ("sub_account_id")
  WHERE "status" = 'PENDING';

-- 3) Partial index for non-excluded babysitter positions (used by reconcile + babysitter)
CREATE INDEX IF NOT EXISTS "idx_positions_babysitter"
  ON "virtual_positions" ("sub_account_id")
  WHERE "status" = 'OPEN' AND "babysitter_excluded" = false;
