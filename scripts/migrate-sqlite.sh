#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# SQLite → PostgreSQL data migration via pgloader
# Idempotent: skips if .sqlite_migrated sentinel exists.
# ─────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[migrate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[migrate]${NC} $*"; }
error() { echo -e "${RED}[migrate]${NC} $*"; }

SQLITE_DB="$PROJECT_DIR/prisma/pms.db"
SENTINEL="$PROJECT_DIR/.sqlite_migrated"
PG_URL="postgresql://postgres:postgres@localhost:55432/postgres"

# ── Guard checks ────────────────────────────────────────
if [ -f "$SENTINEL" ]; then
    info "Migration already completed (sentinel file exists). Skipping."
    exit 0
fi

if [ ! -f "$SQLITE_DB" ]; then
    warn "No SQLite database found at $SQLITE_DB. Nothing to migrate."
    exit 0
fi

# ── Install pgloader if missing ─────────────────────────
if ! command -v pgloader &>/dev/null; then
    info "pgloader not found, installing..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq pgloader
    elif command -v brew &>/dev/null; then
        brew install pgloader
    else
        error "Cannot install pgloader automatically. Install it manually and re-run."
        exit 1
    fi
fi

info "pgloader version: $(pgloader --version 2>&1 | head -1)"

# ── Create pgloader command file ────────────────────────
PGLOADER_CMD=$(mktemp /tmp/pms-pgloader-XXXXXX.load)

cat > "$PGLOADER_CMD" <<EOF
LOAD DATABASE
    FROM sqlite://$SQLITE_DB
    INTO postgresql://postgres:postgres@localhost:55432/postgres

WITH include no drop,
     create no tables,
     create no indexes,
     reset no sequences,
     data only,
     batch rows = 1000,
     prefetch rows = 1000

SET work_mem to '64MB',
    maintenance_work_mem to '128MB'

CAST type integer to integer drop typemod,
     type real to double precision,
     type text to text

-- Map all tables (Prisma uses @@map names)
INCLUDING ONLY TABLE NAMES MATCHING
    'users',
    'sub_accounts',
    'risk_rules',
    'virtual_positions',
    'trade_executions',
    'balance_logs',
    'pending_orders',
    'bot_configs',
    'webauthn_credentials'

BEFORE LOAD DO
    \$\$ ALTER TABLE IF EXISTS users DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS sub_accounts DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS risk_rules DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS virtual_positions DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS trade_executions DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS balance_logs DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS pending_orders DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS bot_configs DISABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS webauthn_credentials DISABLE TRIGGER ALL; \$\$

AFTER LOAD DO
    \$\$ ALTER TABLE IF EXISTS users ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS sub_accounts ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS risk_rules ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS virtual_positions ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS trade_executions ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS balance_logs ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS pending_orders ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS bot_configs ENABLE TRIGGER ALL; \$\$,
    \$\$ ALTER TABLE IF EXISTS webauthn_credentials ENABLE TRIGGER ALL; \$\$
;
EOF

info "Running pgloader..."
pgloader "$PGLOADER_CMD" 2>&1 | tee /tmp/pms-pgloader.log

# Check exit status
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
    info "pgloader completed successfully"
    
    # Verify row counts
    info "Verifying migrated data..."
    TABLES=("users" "sub_accounts" "risk_rules" "virtual_positions" "trade_executions" "balance_logs" "pending_orders" "bot_configs" "webauthn_credentials")
    
    for TABLE in "${TABLES[@]}"; do
        COUNT=$(docker compose exec -T postgres psql -U postgres -t -c "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null | tr -d ' ' || echo "?")
        info "  $TABLE: $COUNT rows"
    done
    
    # Mark as done
    touch "$SENTINEL"
    info "Migration complete! Sentinel file created at $SENTINEL"
else
    error "pgloader failed — check /tmp/pms-pgloader.log for details"
    exit 1
fi

# Cleanup
rm -f "$PGLOADER_CMD"
