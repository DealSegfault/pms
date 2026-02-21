-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "api_key" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sub_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'USER',
    "initial_balance" REAL NOT NULL,
    "current_balance" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "liquidation_mode" TEXT NOT NULL DEFAULT 'ADL_30',
    "maintenance_rate" REAL NOT NULL DEFAULT 0.005,
    "binance_api_key" TEXT,
    "binance_secret" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "sub_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "risk_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT,
    "is_global" BOOLEAN NOT NULL DEFAULT false,
    "max_leverage" REAL NOT NULL DEFAULT 100,
    "max_notional_per_trade" REAL NOT NULL DEFAULT 200,
    "max_total_exposure" REAL NOT NULL DEFAULT 500,
    "liquidation_threshold" REAL NOT NULL DEFAULT 0.90,
    CONSTRAINT "risk_rules_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "virtual_positions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entry_price" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "notional" REAL NOT NULL,
    "leverage" REAL NOT NULL,
    "margin" REAL NOT NULL,
    "liquidation_price" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "realized_pnl" REAL,
    "babysitter_excluded" BOOLEAN NOT NULL DEFAULT false,
    "taken_over" BOOLEAN NOT NULL DEFAULT false,
    "taken_over_by" TEXT,
    "taken_over_at" DATETIME,
    "opened_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" DATETIME,
    CONSTRAINT "virtual_positions_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "trade_executions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT NOT NULL,
    "position_id" TEXT,
    "exchange_order_id" TEXT,
    "client_order_id" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "notional" REAL NOT NULL,
    "fee" REAL NOT NULL DEFAULT 0,
    "realized_pnl" REAL,
    "action" TEXT NOT NULL,
    "origin_type" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'FILLED',
    "signature" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trade_executions_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "trade_executions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "virtual_positions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "balance_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT NOT NULL,
    "balance_before" REAL NOT NULL,
    "balance_after" REAL NOT NULL,
    "change_amount" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "trade_id" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "balance_logs_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pending_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'LIMIT',
    "price" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "leverage" REAL NOT NULL,
    "exchange_order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_at" DATETIME,
    "cancelled_at" DATETIME,
    CONSTRAINT "pending_orders_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bot_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sub_account_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "babysitter_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_notional" REAL NOT NULL DEFAULT 50,
    "max_layers" INTEGER NOT NULL DEFAULT 8,
    "max_exposure" REAL NOT NULL DEFAULT 500,
    "vol_filter_enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_spread_bps" REAL NOT NULL DEFAULT 7.0,
    "max_spread_bps" REAL NOT NULL DEFAULT 40.0,
    "min_hold_sec" REAL NOT NULL DEFAULT 5.0,
    "min_profit_bps" REAL NOT NULL DEFAULT 10.0,
    "tp_decay_enabled" BOOLEAN NOT NULL DEFAULT true,
    "tp_decay_half_life" REAL NOT NULL DEFAULT 30.0,
    "trailing_stop_enabled" BOOLEAN NOT NULL DEFAULT false,
    "trailing_stop_bps" REAL NOT NULL DEFAULT 15.0,
    "inverse_tp_enabled" BOOLEAN NOT NULL DEFAULT true,
    "inverse_tp_min_layers" INTEGER NOT NULL DEFAULT 3,
    "scaled_exit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_loss_bps" REAL NOT NULL DEFAULT 500.0,
    "loss_cooldown_sec" REAL NOT NULL DEFAULT 8.0,
    "symbols" TEXT NOT NULL DEFAULT '',
    "blacklist" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "bot_configs_sub_account_id_fkey" FOREIGN KEY ("sub_account_id") REFERENCES "sub_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_api_key_key" ON "users"("api_key");

-- CreateIndex
CREATE UNIQUE INDEX "risk_rules_sub_account_id_key" ON "risk_rules"("sub_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_configs_sub_account_id_key" ON "bot_configs"("sub_account_id");
