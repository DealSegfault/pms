#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — Interactive Deploy Script
# Run from your LOCAL machine (Mac):  bash deploy.sh
#
# Uses SSH ControlMaster — password is entered ONCE, then
# all subsequent SSH/SCP commands reuse that connection.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ──
VPS_USER="root"
VPS_HOST="89.187.28.51"
VPS_KEY="$HOME/.ssh/server_rsa"
VPS_PROJECT="/root/pms"
VPS_WEB_ROOT="/var/www/pms"

# ── SSH Multiplexing (one password for the whole deploy) ──
CONTROL_PATH="/tmp/pms-deploy-ssh-$$"
SSH_OPTS="-i ${VPS_KEY} -o ControlPath=${CONTROL_PATH} -o ControlMaster=auto -o ControlPersist=300"
SSH_CMD="ssh ${SSH_OPTS} ${VPS_USER}@${VPS_HOST}"
SCP_CMD="scp ${SSH_OPTS}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }
ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

cleanup_ssh() {
    ssh -O exit ${SSH_OPTS} ${VPS_USER}@${VPS_HOST} 2>/dev/null || true
}
trap cleanup_ssh EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║       MinimalTE — Deploy to VPS              ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

normalize_choice() {
    case "${1:-}" in
        1|full) echo "1" ;;
        2|update|frontend|frontend-only) echo "2" ;;
        3|backend) echo "3" ;;
        4|engine) echo "4" ;;
        5|logs) echo "5" ;;
        6|setup|init) echo "6" ;;
        *) echo "${1:-}" ;;
    esac
}

# ─── Menu ───
echo -e "${BOLD}What would you like to deploy?${NC}"
echo ""
echo -e "  ${CYAN}1)${NC} Full deploy        — Build frontend + upload dist + git pull + restart all"
echo -e "  ${CYAN}2)${NC} Update frontend    — Build frontend + upload dist + reload nginx"
echo -e "  ${CYAN}3)${NC} Backend only       — git pull + restart backend + restart engine"
echo -e "  ${CYAN}4)${NC} Engine only        — Restart Python engine (pm2)"
echo -e "  ${CYAN}5)${NC} View logs          — SSH + pm2 logs"
echo -e "  ${CYAN}6)${NC} First-time setup   — Run vps-setup.sh on VPS"
echo ""
if [[ $# -gt 0 ]]; then
    choice="$(normalize_choice "$1")"
    echo -e "${CYAN}Selected:${NC} $choice (from CLI argument: $1)"
else
    read -rp "Choose [1-6 or update]: " raw_choice
    choice="$(normalize_choice "$raw_choice")"
fi
echo ""

# ─── Establish SSH connection (password entered ONCE here) ───
if [[ "$choice" != "5" ]]; then
    step "Connecting to VPS... (enter password once)"
    $SSH_CMD "echo '  Connected to VPS successfully'"
    ok "SSH session established (reused for all commands)"
fi

# ─── Step 1: Build frontend ───
build_frontend() {
    step "Building frontend locally..."
    npm run build
    ok "Vite build complete → dist/"
}

# ─── Step 2: Upload dist ───
upload_dist() {
    step "Packaging dist/..."
    COPYFILE_DISABLE=1 tar czf /tmp/pms-dist.tar.gz --exclude='._*' -C dist .
    local size
    size=$(du -sh /tmp/pms-dist.tar.gz | cut -f1)
    ok "Packaged dist ($size)"

    step "Uploading to VPS..."
    $SCP_CMD /tmp/pms-dist.tar.gz "${VPS_USER}@${VPS_HOST}:/tmp/pms-dist.tar.gz"
    ok "Upload complete"
    rm -f /tmp/pms-dist.tar.gz

    step "Unpacking dist on VPS..."
    $SSH_CMD "
        install -d -m 755 ${VPS_WEB_ROOT}/dist
        find ${VPS_WEB_ROOT}/dist -mindepth 1 -depth -delete 2>/dev/null || true
        tar xzf /tmp/pms-dist.tar.gz --no-same-owner --no-same-permissions -C ${VPS_WEB_ROOT}/dist/
        find ${VPS_WEB_ROOT}/dist -name '._*' -delete 2>/dev/null || true
        find ${VPS_WEB_ROOT}/dist -type d -exec chmod 755 {} +
        find ${VPS_WEB_ROOT}/dist -type f -exec chmod 644 {} +
        chown -R root:root ${VPS_WEB_ROOT}/dist
        rm -f /tmp/pms-dist.tar.gz
        echo '  ✔ dist/ replaced on VPS'
    "
    ok "dist/ deployed"
}

# ─── Step 3: Git pull ───
git_pull() {
    step "Pulling latest code on VPS..."
    $SSH_CMD "
        cd ${VPS_PROJECT}
        git pull --ff-only 2>&1 || git pull 2>&1
        echo '  ✔ git pull complete'
    "
    ok "Code updated"
}

# ─── Step 4: Restart all services (pm2) ───
restart_backend() {
    step "Restarting all services via pm2 on VPS..."
    $SSH_CMD "
        cd ${VPS_PROJECT}
        npm install --omit=dev --ignore-scripts 2>&1 | tail -3
        npx prisma generate 2>&1 | tail -2
        # Kill old PMS/ENGINE screens if any
        screen -S PMS -X quit 2>/dev/null || true
        screen -S ENGINE -X quit 2>/dev/null || true
        # Restart or start all pm2 services (backend + engine)
        pm2 restart ecosystem.config.cjs --update-env 2>/dev/null || pm2 start ecosystem.config.cjs
        sleep 3
        pm2 list
    "
    ok "All services restarted (pm2)"
}

# ─── Step 5: Restart engine only (pm2) ───
restart_engine() {
    step "Restarting Python engine via pm2 on VPS..."
    $SSH_CMD "
        cd ${VPS_PROJECT}
        pm2 restart pms-engine 2>/dev/null || pm2 start ecosystem.config.cjs --only pms-engine
        sleep 3
        pm2 list
        echo ''
        echo '  --- engine log (last 10 lines) ---'
        pm2 logs pms-engine --nostream --lines 10 2>/dev/null || true
    "
    ok "Python engine restarted (pm2)"
}

# ─── Step 6: Deploy nginx config + reload ───
reload_nginx() {
    step "Deploying nginx config to VPS..."
    $SCP_CMD deploy/nginx/nginx.conf "${VPS_USER}@${VPS_HOST}:/etc/nginx/nginx.conf"
    ok "nginx.conf copied"

    step "Reloading nginx on VPS..."
    $SSH_CMD "
        nginx -t 2>&1 && systemctl reload nginx && echo '  ✔ nginx reloaded' || echo '  ✖ nginx config error!'
    "
    ok "nginx reloaded"
}

# ─── Step 7: Install pip deps ───
install_pip_deps() {
    step "Installing Python dependencies on VPS..."
    $SSH_CMD "
        cd ${VPS_PROJECT}
        source trading_engine_python/.venv/bin/activate 2>/dev/null || true
        pip install -q -r trading_engine_python/requirements.txt
        echo '  ✔ pip install complete'
    "
    ok "Python deps updated"
}

# ─── Verify all services ───
verify_services() {
    step "Verifying all services on VPS..."
    $SSH_CMD bash <<'VERIFY_EOF'
        PASS=0
        FAIL=0
        RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

        # 1. nginx
        if systemctl is-active --quiet nginx; then
            echo -e "  ${GREEN}✔ nginx:       running${NC}"
            ((PASS++))
        else
            echo -e "  ${RED}✖ nginx:       NOT running${NC}"
            ((FAIL++))
        fi

        # 2. pms-backend (pm2)
        if pm2 pid pms-backend > /dev/null 2>&1 && [ "$(pm2 pid pms-backend)" != "" ]; then
            echo -e "  ${GREEN}✔ pms-backend: running (pm2)${NC}"
            ((PASS++))
        else
            echo -e "  ${RED}✖ pms-backend: NOT running (pm2)${NC}"
            ((FAIL++))
        fi

        # 3. pms-engine (pm2)
        if pm2 pid pms-engine > /dev/null 2>&1 && [ "$(pm2 pid pms-engine)" != "" ]; then
            echo -e "  ${GREEN}✔ pms-engine:  running (pm2)${NC}"
            ((PASS++))
        else
            echo -e "  ${RED}✖ pms-engine:  NOT running (pm2)${NC}"
            ((FAIL++))
        fi

        # 4. Port checks
        if ss -tlnp | grep -q ':443 '; then
            echo -e "  ${GREEN}✔ Port 443:    listening${NC}"
            ((PASS++))
        else
            echo -e "  ${RED}✖ Port 443:    NOT listening${NC}"
            ((FAIL++))
        fi

        if ss -tlnp | grep -q ':3900 '; then
            echo -e "  ${GREEN}✔ Port 3900:   listening (backend)${NC}"
            ((PASS++))
        else
            echo -e "  ${YELLOW}⚠ Port 3900:   not yet listening (backend may still be starting)${NC}"
        fi

        # 5. HTTPS health check
        HTTP_CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ 2>/dev/null || echo 'fail')
        if [ "$HTTP_CODE" = "200" ]; then
            echo -e "  ${GREEN}✔ HTTPS:       200 OK${NC}"
            ((PASS++))
        else
            echo -e "  ${YELLOW}⚠ HTTPS:       returned $HTTP_CODE${NC}"
        fi

        # 6. API health check
        API_CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health 2>/dev/null || echo 'fail')
        if [ "$API_CODE" = "200" ]; then
            echo -e "  ${GREEN}✔ API /health: 200 OK${NC}"
            ((PASS++))
        else
            echo -e "  ${YELLOW}⚠ API /health: returned $API_CODE (backend may still be starting)${NC}"
        fi

        # 7. dist/ check
        if [ -f /var/www/pms/dist/index.html ]; then
            FCOUNT=$(find /var/www/pms/dist -type f | wc -l)
            echo -e "  ${GREEN}✔ dist/:       ${FCOUNT} files deployed${NC}"
            ((PASS++))
        else
            echo -e "  ${RED}✖ dist/:       index.html MISSING${NC}"
            ((FAIL++))
        fi

        echo ''
        if [ $FAIL -eq 0 ]; then
            echo -e "  ${GREEN}━━━ All $PASS checks passed ━━━${NC}"
        else
            echo -e "  ${RED}━━━ $FAIL check(s) FAILED, $PASS passed ━━━${NC}"
        fi
VERIFY_EOF
}

# ─── Execute chosen option ───
case "$choice" in
    1)
        build_frontend
        upload_dist
        git_pull
        install_pip_deps
        restart_backend
        reload_nginx
        verify_services
        ;;
    2)
        build_frontend
        upload_dist
        reload_nginx
        verify_services
        ;;
    3)
        git_pull
        install_pip_deps
        restart_engine
        restart_backend
        verify_services
        ;;
    4)
        restart_engine
        verify_services
        ;;
    5)
        echo -e "${CYAN}Viewing pm2 logs... (Ctrl+C to stop)${NC}"
        ssh -i "${VPS_KEY}" -t "${VPS_USER}@${VPS_HOST}" "pm2 logs"
        exit 0
        ;;
    6)
        echo -e "${CYAN}Running first-time VPS setup...${NC}"
        echo -e "${YELLOW}This will git pull first, then run the setup script.${NC}"
        $SSH_CMD "cd ${VPS_PROJECT} && git pull && bash deploy/vps-setup.sh"
        exit 0
        ;;
    *)
        fail "Invalid choice: $choice"
        ;;
esac

# ─── Done ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔ Deploy complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}  https://89.187.28.51"
echo -e "  ${CYAN}Backend:${NC}   pm2 logs pms-backend"
echo -e "  ${CYAN}Engine:${NC}    pm2 logs pms-engine"
echo -e "  ${CYAN}All logs:${NC}  bash deploy.sh → option 5"
echo ""
