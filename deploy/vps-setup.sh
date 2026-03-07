#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — One-time VPS Setup
# Run ON the VPS:  sudo bash deploy/vps-setup.sh
#
# Sets up:
#   1. nginx with production config (static dist/ + API proxy)
#   2. systemd backend service (pms-backend)
#   3. Python engine in a named screen session (ENGINE)
#   4. Creates dist directory
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

[[ $EUID -ne 0 ]] && fail "Run as root: sudo bash deploy/vps-setup.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── 1. Install prerequisites ───
step "Installing prerequisites..."
apt-get update -qq
apt-get install -y -qq nginx screen python3 python3-pip python3-venv 2>/dev/null || true
ok "Prerequisites installed"

# ─── 2. Create dist directory ───
step "Creating dist directory..."
mkdir -p "$PROJECT_DIR/dist"
ok "dist/ directory ready"

# ─── 3. Install nginx config ───
step "Installing nginx config..."
bash "$SCRIPT_DIR/nginx/install.sh"
ok "nginx configured"

# ─── 4. Install pm2 + start backend ───
step "Installing pm2 and starting backend..."
npm install -g pm2 2>/dev/null || true
cd "$PROJECT_DIR"
npm install --omit=dev --ignore-scripts 2>&1 | tail -3
npx prisma generate 2>&1 | tail -2
pm2 stop pms-backend 2>/dev/null || true
pm2 delete pms-backend 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup 2>/dev/null || true
ok "pm2 backend running"

# ─── 5. Python virtual environment ───
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

# ─── 6. Kill old Vite/npm dev screens ───
step "Cleaning up old dev screens..."
screen -ls | grep -oP '\d+\.\S+' | while read s; do
    screen -S "$s" -X quit 2>/dev/null || true
done
ok "Old screens cleared"

# ─── 7. Start ENGINE screen ───
step "Starting Python engine in screen session 'ENGINE'..."
screen -dmS ENGINE bash -c "
    cd $PROJECT_DIR
    source trading_engine_python/.venv/bin/activate
    source .env 2>/dev/null || true
    export \$(grep -v '^#' .env | xargs) 2>/dev/null || true
    python -m trading_engine_python.main
"
ok "ENGINE screen started"

# ─── Done ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔ VPS Setup Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}Services:${NC}"
echo -e "    Backend:  sudo systemctl status pms-backend"
echo -e "    Engine:   screen -rd ENGINE"
echo -e "    Nginx:    sudo systemctl status nginx"
echo ""
echo -e "  ${CYAN}Useful:${NC}"
echo -e "    Attach engine:  screen -rd ENGINE"
echo -e "    Detach:         Ctrl+A, D"
echo -e "    Restart engine: screen -S ENGINE -X quit; (re-run setup or deploy)"
echo ""
