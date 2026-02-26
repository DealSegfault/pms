-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "api_key" TEXT,
    "current_challenge" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'USER',
    "initial_balance" DOUBLE PRECISION NOT NULL,
    "current_balance" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "liquidation_mode" TEXT NOT NULL DEFAULT 'ADL_30',
    "maintenance_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.005,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sub_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_rules" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT,
    "is_global" BOOLEAN NOT NULL DEFAULT false,
    "max_leverage" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "max_notional_per_trade" DOUBLE PRECISION NOT NULL DEFAULT 200,
    "max_total_exposure" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "liquidation_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.90,

    CONSTRAINT "risk_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_positions" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entry_price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "notional" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION NOT NULL,
    "liquidation_price" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "realized_pnl" DOUBLE PRECISION,
    "babysitter_excluded" BOOLEAN NOT NULL DEFAULT false,
    "taken_over" BOOLEAN NOT NULL DEFAULT false,
    "taken_over_by" TEXT,
    "taken_over_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "virtual_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_executions" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT NOT NULL,
    "position_id" TEXT,
    "exchange_order_id" TEXT,
    "client_order_id" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "notional" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realized_pnl" DOUBLE PRECISION,
    "action" TEXT NOT NULL,
    "origin_type" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'FILLED',
    "signature" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_logs" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT NOT NULL,
    "balance_before" DOUBLE PRECISION NOT NULL,
    "balance_after" DOUBLE PRECISION NOT NULL,
    "change_amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "trade_id" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_orders" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LIMIT',
    "price" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "leverage" DOUBLE PRECISION NOT NULL,
    "exchange_order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "pending_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_configs" (
    "id" TEXT NOT NULL,
    "sub_account_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "babysitter_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tp_mode" TEXT NOT NULL DEFAULT 'auto',
    "max_notional" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "max_layers" INTEGER NOT NULL DEFAULT 8,
    "max_exposure" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "vol_filter_enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_spread_bps" DOUBLE PRECISION NOT NULL DEFAULT 7.0,
    "max_spread_bps" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "min_hold_sec" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "min_profit_bps" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "tp_decay_enabled" BOOLEAN NOT NULL DEFAULT true,
    "tp_decay_half_life" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "trailing_stop_enabled" BOOLEAN NOT NULL DEFAULT false,
    "trailing_stop_bps" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "inverse_tp_enabled" BOOLEAN NOT NULL DEFAULT true,
    "inverse_tp_min_layers" INTEGER NOT NULL DEFAULT 3,
    "scaled_exit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_loss_bps" DOUBLE PRECISION NOT NULL DEFAULT 500.0,
    "loss_cooldown_sec" DOUBLE PRECISION NOT NULL DEFAULT 8.0,
    "symbols" TEXT NOT NULL DEFAULT '',
    "blacklist" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "device_type" TEXT NOT NULL DEFAULT 'unknown',
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "transports" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tca_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "symbol" TEXT,
    "data" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tca_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_api_key_key" ON "users"("api_key");

-- CreateIndex
CREATE INDEX "sub_accounts_user_id_status_idx" ON "sub_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "sub_accounts_status_idx" ON "sub_accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "risk_rules_sub_account_id_key" ON "risk_rules"("sub_account_id");

-- CreateIndex
CREATE INDEX "risk_rules_is_global_idx" ON "risk_rules"("is_global");

-- CreateIndex
CREATE INDEX "virtual_positions_sub_account_id_status_idx" ON "virtual_positions"("sub_account_id", "status");

-- CreateIndex
CREATE INDEX "virtual_positions_symbol_status_idx" ON "virtual_positions"("symbol", "status");

-- CreateIndex
CREATE INDEX "virtual_positions_sub_account_id_symbol_side_status_idx" ON "virtual_positions"("sub_account_id", "symbol", "side", "status");

-- CreateIndex
CREATE INDEX "trade_executions_sub_account_id_timestamp_idx" ON "trade_executions"("sub_account_id", "timestamp");

-- CreateIndex
CREATE INDEX "trade_executions_sub_account_id_status_timestamp_idx" ON "trade_executions"("sub_account_id", "status", "timestamp");

-- CreateIndex
CREATE INDEX "trade_executions_sub_account_id_symbol_timestamp_idx" ON "trade_executions"("sub_account_id", "symbol", "timestamp");

-- CreateIndex
CREATE INDEX "trade_executions_exchange_order_id_idx" ON "trade_executions"("exchange_order_id");

-- CreateIndex
CREATE INDEX "balance_logs_sub_account_id_timestamp_idx" ON "balance_logs"("sub_account_id", "timestamp");

-- CreateIndex
CREATE INDEX "pending_orders_exchange_order_id_idx" ON "pending_orders"("exchange_order_id");

-- CreateIndex
CREATE INDEX "pending_orders_status_type_idx" ON "pending_orders"("status", "type");

-- CreateIndex
CREATE INDEX "pending_orders_sub_account_id_status_idx" ON "pending_orders"("sub_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bot_configs_sub_account_id_key" ON "bot_configs"("sub_account_id");

-- CreateIndex
CREATE INDEX "bot_configs_babysitter_enabled_idx" ON "bot_configs"("babysitter_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");

-- CreateIndex
CREATE INDEX "tca_events_type_created_at_idx" ON "tca_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "tca_events_symbol_created_at_idx" ON "tca_events"("symbol", "created_at");

-- CreateIndex
CREATE INDEX "tca_events_created_at_idx" ON "tca_events"("created_at");

-- AddForeignKey
ALTER TABLE "sub_accounts" ADD CONSTRAINT "sub_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_rules" ADD CONSTRAINT "risk_rules_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_positions" ADD CONSTRAINT "virtual_positions_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_executions" ADD CONSTRAINT "trade_executions_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_executions" ADD CONSTRAINT "trade_executions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "virtual_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_logs" ADD CONSTRAINT "balance_logs_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
