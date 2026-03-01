#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
# PMS One-Shot Bootstrap
# Run once after git pull on a fresh Linux VPS (or anytime).
# Idempotent — safe to re-run.
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

info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*"; }

# ── 1. Check prerequisites ─────────────────────────────
if ! command -v docker &>/dev/null; then
    error "docker is not installed. Install Docker first."
    exit 1
fi

if ! command -v node &>/dev/null; then
    error "node is not installed. Install Node.js 18+ first."
    exit 1
fi

# ── 2. Start Docker containers ─────────────────────────
info "Starting Docker containers (PostgreSQL + Redis)..."
docker compose up -d

# ── 3. Wait for PostgreSQL to be ready ──────────────────
info "Waiting for PostgreSQL to be ready..."
MAX_WAIT=30
WAITED=0
until docker compose exec -T postgres pg_isready -U postgres &>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        error "PostgreSQL did not become ready within ${MAX_WAIT}s"
        exit 1
    fi
done
info "PostgreSQL is ready (waited ${WAITED}s)"

# ── 4. Wait for Redis to be ready ──────────────────────
info "Waiting for Redis to be ready..."
WAITED=0
until docker compose exec -T redis redis-cli ping &>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        error "Redis did not become ready within ${MAX_WAIT}s"
        exit 1
    fi
done
info "Redis is ready"

# ── 5. Install npm dependencies ────────────────────────
if [ ! -d "node_modules" ]; then
    info "Installing npm dependencies..."
    npm install
else
    info "node_modules/ exists, skipping npm install (run manually if needed)"
fi

# ── 6. Generate Prisma client ──────────────────────────
info "Generating Prisma client..."
npx prisma generate

# ── 7. Push schema to PostgreSQL (create tables) ───────
info "Pushing Prisma schema to PostgreSQL..."
npx prisma db push --accept-data-loss 2>/dev/null || npx prisma db push

# ── 8. Migrate SQLite data if pms.db exists ─────────────
SQLITE_DB="prisma/pms.db"
SENTINEL=".sqlite_migrated"

if [ -f "$SQLITE_DB" ] && [ ! -f "$SENTINEL" ]; then
    info "Found SQLite database — migrating data to PostgreSQL..."
    bash scripts/migrate-sqlite.sh
elif [ -f "$SENTINEL" ]; then
    info "SQLite migration already completed (sentinel found), skipping"
elif [ ! -f "$SQLITE_DB" ]; then
    info "No SQLite database found at $SQLITE_DB, starting fresh"
fi

# ── Done ────────────────────────────────────────────────
echo ""
info "════════════════════════════════════════════════════"
info "  ✅ PMS setup complete!"
info ""
info "  PostgreSQL: localhost:55432  (user: postgres)"
info "  Redis:      localhost:6379"
info ""
info "  Start the server:  npm run dev"
info "════════════════════════════════════════════════════"
