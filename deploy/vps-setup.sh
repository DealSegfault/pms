#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — One-time VPS Setup
# Run ON the VPS:  bash deploy/vps-setup.sh
#
# Sets up:
#   1. nginx with production config (static dist/ + API proxy)
#   2. pm2 for backend + python engine
#   3. Python venv + pip deps
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="/var/www/pms"

# ─── 1. Install prerequisites ───
step "Installing prerequisites..."
apt-get update -qq 2>/dev/null || true
apt-get install -y -qq nginx python3 python3-pip python3-venv 2>/dev/null || true
ok "Prerequisites installed"

# ─── 2. Create web root directory ───
step "Creating web root directory..."
install -d -m 755 "$WEB_ROOT/dist"
ok "web root directory ready"

# ─── 3. Install nginx config ───
step "Installing nginx config..."
cp "$SCRIPT_DIR/nginx/nginx.conf" /etc/nginx/nginx.conf
nginx -t 2>&1
systemctl reload nginx 2>/dev/null || systemctl start nginx
systemctl enable nginx 2>/dev/null || true
ok "nginx configured"

# ─── 4. Python virtual environment ───
step "Setting up Python virtual environment..."
if [ ! -d "$PROJECT_DIR/trading_engine_python/.venv" ]; then
    python3 -m venv "$PROJECT_DIR/trading_engine_python/.venv"
    ok "Virtual environment created"
else
    ok "Virtual environment already exists"
fi
source "$PROJECT_DIR/trading_engine_python/.venv/bin/activate"
pip install -q -r "$PROJECT_DIR/trading_engine_python/requirements.txt"
ok "Python dependencies installed"

# ─── 5. Kill old dev screens (keep PG!) ───
step "Cleaning up old dev screens..."
screen -S PMS -X quit 2>/dev/null && ok "Killed old PMS screen" || ok "No old PMS screen found"
screen -S ENGINE -X quit 2>/dev/null && ok "Killed old ENGINE screen" || ok "No old ENGINE screen found"

# ─── 6. Install pm2 + start all services ───
step "Setting up pm2 (backend + engine)..."
npm install -g pm2 2>/dev/null || true
cd "$PROJECT_DIR"
npm install --omit=dev --ignore-scripts 2>&1 | tail -3
npx prisma generate 2>&1 | tail -2
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup 2>/dev/null || true
sleep 3
pm2 list
ok "pm2 services running (backend + engine)"

# ─── Done ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔ VPS Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}Services (all pm2):${NC}"
echo -e "    pm2 status              — see all services"
echo -e "    pm2 logs pms-backend    — backend logs"
echo -e "    pm2 logs pms-engine     — engine logs"
echo -e "    pm2 logs                — all logs"
echo ""
echo -e "  ${CYAN}Restart:${NC}"
echo -e "    pm2 restart all         — restart everything"
echo -e "    pm2 restart pms-engine  — restart engine only"
echo ""
