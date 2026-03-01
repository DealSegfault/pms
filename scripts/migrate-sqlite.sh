#!/usr/bin/env bash
# SQLite -> PostgreSQL data migration using python3 + psql COPY.
# Idempotent: skips if .sqlite_migrated sentinel exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[migrate]${NC} $*"; }
error() { echo -e "${RED}[migrate]${NC} $*"; }

SQLITE_DB="$PROJECT_DIR/prisma/pms.db"
SENTINEL="$PROJECT_DIR/.sqlite_migrated"
TMP_DIR="$(mktemp -d /tmp/pms-sqlite-export-XXXXXX)"
COUNTS_FILE="$TMP_DIR/counts.txt"

TABLES=(
  users
  sub_accounts
  risk_rules
  virtual_positions
  trade_executions
  balance_logs
  pending_orders
  bot_configs
  webauthn_credentials
)

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ -f "$SENTINEL" ]; then
    info "Migration already completed (sentinel file exists). Skipping."
    exit 0
fi

if [ ! -f "$SQLITE_DB" ]; then
    warn "No SQLite database found at $SQLITE_DB. Nothing to migrate."
    exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
    error "python3 is required to read the SQLite database."
    exit 1
fi

info "Exporting SQLite tables from $SQLITE_DB"
python3 - "$SQLITE_DB" "$TMP_DIR" "$COUNTS_FILE" <<'PY'
import csv
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

db_path = Path(sys.argv[1])
tmp_dir = Path(sys.argv[2])
counts_path = Path(sys.argv[3])

table_columns = {
    "users": [
        "id", "username", "password_hash", "role", "status", "api_key",
        "current_challenge", "created_at", "updated_at",
    ],
    "sub_accounts": [
        "id", "user_id", "name", "type", "initial_balance", "current_balance",
        "status", "liquidation_mode", "maintenance_rate", "created_at", "updated_at",
    ],
    "risk_rules": [
        "id", "sub_account_id", "is_global", "max_leverage",
        "max_notional_per_trade", "max_total_exposure", "liquidation_threshold",
    ],
    "virtual_positions": [
        "id", "sub_account_id", "symbol", "side", "entry_price", "quantity",
        "notional", "leverage", "margin", "liquidation_price", "status",
        "realized_pnl", "taken_over", "taken_over_by", "taken_over_at",
        "opened_at", "closed_at",
    ],
    "trade_executions": [
        "id", "sub_account_id", "position_id", "exchange_order_id",
        "client_order_id", "symbol", "side", "type", "price", "quantity",
        "notional", "fee", "realized_pnl", "action", "origin_type", "status",
        "signature", "timestamp",
    ],
    "balance_logs": [
        "id", "sub_account_id", "balance_before", "balance_after",
        "change_amount", "reason", "trade_id", "timestamp",
    ],
    "pending_orders": [
        "id", "sub_account_id", "symbol", "side", "type", "price", "quantity",
        "leverage", "exchange_order_id", "status", "created_at", "filled_at",
        "cancelled_at",
    ],
    "bot_configs": [
        "id", "sub_account_id", "enabled", "tp_mode", "max_notional", "max_layers",
        "max_exposure", "vol_filter_enabled", "min_spread_bps", "max_spread_bps",
        "min_hold_sec", "min_profit_bps", "tp_decay_enabled", "tp_decay_half_life",
        "trailing_stop_enabled", "trailing_stop_bps", "inverse_tp_enabled",
        "inverse_tp_min_layers", "scaled_exit_enabled", "max_loss_bps",
        "loss_cooldown_sec", "symbols", "blacklist", "created_at", "updated_at",
    ],
    "webauthn_credentials": [
        "id", "user_id", "credential_id", "public_key", "counter", "device_type",
        "backed_up", "transports", "created_at",
    ],
}

datetime_columns = {
    "users": {"created_at", "updated_at"},
    "sub_accounts": {"created_at", "updated_at"},
    "virtual_positions": {"taken_over_at", "opened_at", "closed_at"},
    "trade_executions": {"timestamp"},
    "balance_logs": {"timestamp"},
    "pending_orders": {"created_at", "filled_at", "cancelled_at"},
    "bot_configs": {"created_at", "updated_at"},
    "webauthn_credentials": {"created_at"},
}


def normalize_value(table: str, column: str, value):
    if value is None:
        return None
    if column not in datetime_columns.get(table, set()):
        return value
    if isinstance(value, (int, float)):
        epoch = float(value)
    elif isinstance(value, str) and value.isdigit():
        epoch = float(value)
    else:
        return value

    if epoch > 10_000_000_000:
        epoch /= 1000.0
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")

conn = sqlite3.connect(str(db_path))
cur = conn.cursor()

with counts_path.open("w", encoding="utf-8") as counts_out:
    for table, target_cols in table_columns.items():
        cur.execute(f'PRAGMA table_info("{table}")')
        source_cols = {row[1] for row in cur.fetchall()}
        select_exprs = []
        for col in target_cols:
            if col in source_cols:
                select_exprs.append(f'"{col}"')
            else:
                select_exprs.append(f'NULL AS "{col}"')

        query = f'SELECT {", ".join(select_exprs)} FROM "{table}"'
        cur.execute(query)

        out_path = tmp_dir / f"{table}.csv"
        row_count = 0
        with out_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            for row in cur:
                normalized = [
                    normalize_value(table, col, value)
                    for col, value in zip(target_cols, row)
                ]
                writer.writerow(["\\N" if value is None else value for value in normalized])
                row_count += 1

        counts_out.write(f"{table}\t{row_count}\n")

conn.close()
PY

info "Preparing PostgreSQL target tables"
docker compose exec -T postgres psql -U postgres -d postgres <<'SQL'
TRUNCATE TABLE
  "trade_executions",
  "balance_logs",
  "pending_orders",
  "bot_configs",
  "risk_rules",
  "virtual_positions",
  "webauthn_credentials",
  "sub_accounts",
  "users"
RESTART IDENTITY CASCADE;
SQL

copy_table() {
    local table="$1"
    local cols="$2"
    local file="$TMP_DIR/${table}.csv"

    info "Loading ${table}"
    docker compose exec -T postgres psql -U postgres -d postgres \
      -c "\\copy \"${table}\" (${cols}) FROM STDIN WITH (FORMAT csv, NULL '\N')" < "$file" >/dev/null
}

copy_table "users" "\"id\", \"username\", \"password_hash\", \"role\", \"status\", \"api_key\", \"current_challenge\", \"created_at\", \"updated_at\""
copy_table "sub_accounts" "\"id\", \"user_id\", \"name\", \"type\", \"initial_balance\", \"current_balance\", \"status\", \"liquidation_mode\", \"maintenance_rate\", \"created_at\", \"updated_at\""
copy_table "risk_rules" "\"id\", \"sub_account_id\", \"is_global\", \"max_leverage\", \"max_notional_per_trade\", \"max_total_exposure\", \"liquidation_threshold\""
copy_table "virtual_positions" "\"id\", \"sub_account_id\", \"symbol\", \"side\", \"entry_price\", \"quantity\", \"notional\", \"leverage\", \"margin\", \"liquidation_price\", \"status\", \"realized_pnl\", \"taken_over\", \"taken_over_by\", \"taken_over_at\", \"opened_at\", \"closed_at\""
copy_table "trade_executions" "\"id\", \"sub_account_id\", \"position_id\", \"exchange_order_id\", \"client_order_id\", \"symbol\", \"side\", \"type\", \"price\", \"quantity\", \"notional\", \"fee\", \"realized_pnl\", \"action\", \"origin_type\", \"status\", \"signature\", \"timestamp\""
copy_table "balance_logs" "\"id\", \"sub_account_id\", \"balance_before\", \"balance_after\", \"change_amount\", \"reason\", \"trade_id\", \"timestamp\""
copy_table "pending_orders" "\"id\", \"sub_account_id\", \"symbol\", \"side\", \"type\", \"price\", \"quantity\", \"leverage\", \"exchange_order_id\", \"status\", \"created_at\", \"filled_at\", \"cancelled_at\""
copy_table "bot_configs" "\"id\", \"sub_account_id\", \"enabled\", \"tp_mode\", \"max_notional\", \"max_layers\", \"max_exposure\", \"vol_filter_enabled\", \"min_spread_bps\", \"max_spread_bps\", \"min_hold_sec\", \"min_profit_bps\", \"tp_decay_enabled\", \"tp_decay_half_life\", \"trailing_stop_enabled\", \"trailing_stop_bps\", \"inverse_tp_enabled\", \"inverse_tp_min_layers\", \"scaled_exit_enabled\", \"max_loss_bps\", \"loss_cooldown_sec\", \"symbols\", \"blacklist\", \"created_at\", \"updated_at\""
copy_table "webauthn_credentials" "\"id\", \"user_id\", \"credential_id\", \"public_key\", \"counter\", \"device_type\", \"backed_up\", \"transports\", \"created_at\""

info "Verifying migrated row counts"
while IFS=$'\t' read -r table expected; do
    actual="$(docker compose exec -T postgres psql -U postgres -d postgres -At -c "SELECT COUNT(*) FROM \"${table}\";" < /dev/null | tr -d '[:space:]')"
    info "  ${table}: ${actual} rows"
    if [ "$actual" != "$expected" ]; then
        error "Row count mismatch for ${table}: expected ${expected}, got ${actual}"
        exit 1
    fi
done < "$COUNTS_FILE"

touch "$SENTINEL"
info "Migration complete! Sentinel file created at $SENTINEL"
