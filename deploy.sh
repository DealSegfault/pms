#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — Interactive Deploy Script
# Run from your LOCAL machine (Mac):  bash deploy.sh
#
# What it does:
#   1. Builds the frontend locally (vite build)
#   2. Tars the dist/ folder
#   3. SCPs it to VPS (will prompt for password)
#   4. SSHs to VPS to:
#      a. Unpack dist → /root/pms/dist/
#      b. git pull latest backend/engine code
#      c. Restart Python ENGINE screen
#      d. Restart backend service
#      e. Reload nginx
#
# SSH will prompt for your password — this is interactive!
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ──
VPS_USER="root"
VPS_HOST="89.187.28.51"
VPS_KEY="$HOME/.ssh/server_rsa"
VPS_PROJECT="/root/pms"
SSH_CMD="ssh ${VPS_USER}@${VPS_HOST} -i ${VPS_KEY}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }
ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║       MinimalTE — Deploy to VPS              ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ─── Menu ───
echo -e "${BOLD}What would you like to deploy?${NC}"
echo ""
echo -e "  ${CYAN}1)${NC} Full deploy        — Build frontend + upload dist + git pull + restart all"
echo -e "  ${CYAN}2)${NC} Frontend only      — Build frontend + upload dist + reload nginx"
echo -e "  ${CYAN}3)${NC} Backend only       — git pull + restart backend + restart engine"
echo -e "  ${CYAN}4)${NC} Engine only        — Restart Python ENGINE screen"
echo -e "  ${CYAN}5)${NC} Attach engine      — SSH + screen -rd ENGINE"
echo -e "  ${CYAN}6)${NC} First-time setup   — Run vps-setup.sh on VPS"
echo ""
read -rp "Choose [1-6]: " choice
echo ""

# ─── Step 1: Build frontend ───
build_frontend() {
    step "Building frontend locally..."
    npm run build
    ok "Vite build complete → dist/"
}

# ─── Step 2: Upload dist ───
upload_dist() {
    step "Packaging dist/..."
    tar czf /tmp/pms-dist.tar.gz -C dist .
    local size
    size=$(du -sh /tmp/pms-dist.tar.gz | cut -f1)
    ok "Packaged dist ($size)"

    step "Uploading to VPS... (password required)"
    scp -i "${VPS_KEY}" /tmp/pms-dist.tar.gz "${VPS_USER}@${VPS_HOST}:/tmp/pms-dist.tar.gz"
    ok "Upload complete"
    rm -f /tmp/pms-dist.tar.gz

    step "Unpacking dist on VPS..."
    $SSH_CMD "
        rm -rf ${VPS_PROJECT}/dist/*
        mkdir -p ${VPS_PROJECT}/dist
        tar xzf /tmp/pms-dist.tar.gz -C ${VPS_PROJECT}/dist/
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

# ─── Step 4: Restart backend (pm2) ───
restart_backend() {
    step "Restarting backend via pm2 on VPS..."
    $SSH_CMD "
        cd ${VPS_PROJECT}
        npm install --omit=dev --ignore-scripts 2>&1 | tail -3
        npx prisma generate 2>&1 | tail -2
        pm2 restart ecosystem.config.cjs --update-env 2>/dev/null || pm2 start ecosystem.config.cjs
        sleep 3
        pm2 list
    "
    ok "Backend restarted (pm2)"
}

# ─── Step 5: Restart ENGINE screen ───
restart_engine() {
    step "Restarting Python engine on VPS..."
    $SSH_CMD "
        # Kill existing ENGINE screen
        screen -S ENGINE -X quit 2>/dev/null || true
        sleep 1

        # Start fresh ENGINE screen
        cd ${VPS_PROJECT}
        screen -dmS ENGINE bash -c '
            cd ${VPS_PROJECT}
            source trading_engine_python/.venv/bin/activate 2>/dev/null || true
            set -a; source .env 2>/dev/null; set +a
            python -m trading_engine_python.main 2>&1 | tee /tmp/engine.log
        '
        sleep 2

        if screen -ls | grep -q ENGINE; then
            echo '  ✔ ENGINE screen running'
        else
            echo '  ✖ ENGINE screen failed to start!'
            echo '  Check: screen -ls and /tmp/engine.log'
        fi
    "
    ok "Python engine restarted"
}

# ─── Step 6: Reload nginx ───
reload_nginx() {
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
    $SSH_CMD "
        PASS=0
        FAIL=0
        RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

        # 1. nginx
        if systemctl is-active --quiet nginx; then
            echo -e \"  \${GREEN}✔ nginx:       running\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${RED}✖ nginx:       NOT running\${NC}\"
            ((FAIL++))
        fi

        # 2. pms-backend (pm2)
        if pm2 pid pms-backend > /dev/null 2>&1 && [ \"\$(pm2 pid pms-backend)\" != \"\" ]; then
            echo -e \"  \${GREEN}✔ pms-backend: running (pm2)\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${RED}✖ pms-backend: NOT running (pm2)\${NC}\"
            ((FAIL++))
        fi

        # 3. ENGINE screen
        if screen -ls 2>/dev/null | grep -q ENGINE; then
            echo -e \"  \${GREEN}✔ ENGINE:      screen running\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${RED}✖ ENGINE:      screen NOT found\${NC}\"
            ((FAIL++))
        fi

        # 4. Port checks
        if ss -tlnp | grep -q ':443 '; then
            echo -e \"  \${GREEN}✔ Port 443:    listening\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${RED}✖ Port 443:    NOT listening\${NC}\"
            ((FAIL++))
        fi

        if ss -tlnp | grep -q ':3900 '; then
            echo -e \"  \${GREEN}✔ Port 3900:   listening (backend)\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${YELLOW}⚠ Port 3900:   not yet listening (backend may still be starting)\${NC}\"
        fi

        # 5. HTTPS health check
        HTTP_CODE=\$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ 2>/dev/null || echo 'fail')
        if [ \"\$HTTP_CODE\" = \"200\" ]; then
            echo -e \"  \${GREEN}✔ HTTPS:       200 OK\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${YELLOW}⚠ HTTPS:       returned \$HTTP_CODE\${NC}\"
        fi

        # 6. API health check
        API_CODE=\$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health 2>/dev/null || echo 'fail')
        if [ \"\$API_CODE\" = \"200\" ]; then
            echo -e \"  \${GREEN}✔ API /health: 200 OK\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${YELLOW}⚠ API /health: returned \$API_CODE (backend may still be starting)\${NC}\"
        fi

        # 7. dist/ check
        if [ -f ${VPS_PROJECT}/dist/index.html ]; then
            FCOUNT=\$(find ${VPS_PROJECT}/dist -type f | wc -l)
            echo -e \"  \${GREEN}✔ dist/:       \${FCOUNT} files deployed\${NC}\"
            ((PASS++))
        else
            echo -e \"  \${RED}✖ dist/:       index.html MISSING\${NC}\"
            ((FAIL++))
        fi

        echo ''
        if [ \$FAIL -eq 0 ]; then
            echo -e \"  \${GREEN}━━━ All \$PASS checks passed ━━━\${NC}\"
        else
            echo -e \"  \${RED}━━━ \$FAIL check(s) FAILED, \$PASS passed ━━━\${NC}\"
        fi
    "
}

# ─── Execute chosen option ───
case "$choice" in
    1)
        build_frontend
        upload_dist
        echo ""
        echo -e "${YELLOW}The next SSH commands will each prompt for your password.${NC}"
        echo ""
        git_pull
        install_pip_deps
        restart_engine
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
        echo -e "${CYAN}Attaching to ENGINE screen... (Ctrl+A, D to detach)${NC}"
        $SSH_CMD -t "screen -rd ENGINE"
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
echo -e "  ${CYAN}Engine:${NC}    ${BOLD}screen -rd ENGINE${NC} (via SSH)"
echo -e "  ${CYAN}Backend:${NC}   pm2 status / pm2 logs pms-backend"
echo -e "  ${CYAN}Logs:${NC}      pm2 logs pms-backend --lines 50"
echo ""
