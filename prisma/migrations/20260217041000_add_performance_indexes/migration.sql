-- Performance indexes for high-frequency filters and sort patterns.

CREATE INDEX IF NOT EXISTS "sub_accounts_user_id_status_idx"
ON "sub_accounts"("user_id", "status");

CREATE INDEX IF NOT EXISTS "sub_accounts_status_idx"
ON "sub_accounts"("status");

CREATE INDEX IF NOT EXISTS "risk_rules_is_global_idx"
ON "risk_rules"("is_global");

CREATE INDEX IF NOT EXISTS "virtual_positions_sub_account_id_status_idx"
ON "virtual_positions"("sub_account_id", "status");

CREATE INDEX IF NOT EXISTS "virtual_positions_symbol_status_idx"
ON "virtual_positions"("symbol", "status");

CREATE INDEX IF NOT EXISTS "virtual_positions_sub_account_id_symbol_side_status_idx"
ON "virtual_positions"("sub_account_id", "symbol", "side", "status");

CREATE INDEX IF NOT EXISTS "trade_executions_sub_account_id_timestamp_idx"
ON "trade_executions"("sub_account_id", "timestamp");

CREATE INDEX IF NOT EXISTS "trade_executions_sub_account_id_status_timestamp_idx"
ON "trade_executions"("sub_account_id", "status", "timestamp");

CREATE INDEX IF NOT EXISTS "trade_executions_sub_account_id_symbol_timestamp_idx"
ON "trade_executions"("sub_account_id", "symbol", "timestamp");

CREATE INDEX IF NOT EXISTS "trade_executions_exchange_order_id_idx"
ON "trade_executions"("exchange_order_id");

CREATE INDEX IF NOT EXISTS "balance_logs_sub_account_id_timestamp_idx"
ON "balance_logs"("sub_account_id", "timestamp");

CREATE INDEX IF NOT EXISTS "bot_configs_babysitter_enabled_idx"
ON "bot_configs"("babysitter_enabled");
