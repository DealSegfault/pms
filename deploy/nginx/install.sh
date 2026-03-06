#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — Nginx + Self-Signed SSL Install Script
# Usage: sudo ./install.sh
#
# This REPLACES /etc/nginx/nginx.conf entirely.
# A backup is saved as /etc/nginx/nginx.conf.bak
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}▸ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail()  { echo -e "  ${RED}✖ $1${NC}"; exit 1; }

[[ $EUID -ne 0 ]] && fail "Run as root: sudo ./install.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IP="89.187.28.51"
SSL_DIR="/etc/nginx/ssl"

# ─── 1. Install nginx ───
step "Installing Nginx..."
if command -v nginx &>/dev/null; then
    ok "Already installed"
else
    apt-get update -qq && apt-get install -y -qq nginx
    ok "Installed"
fi

# ─── 2. Stop nginx while we work ───
systemctl stop nginx 2>/dev/null || true

# ─── 3. SSL cert ───
step "Generating self-signed SSL cert for ${IP}..."
mkdir -p "$SSL_DIR"
openssl req -x509 -nodes -days 3650 \
    -newkey rsa:2048 \
    -keyout "${SSL_DIR}/minimalte.key" \
    -out "${SSL_DIR}/minimalte.crt" \
    -subj "/C=FR/ST=Paris/L=Paris/O=MinimalTE/CN=${IP}" \
    -addext "subjectAltName=IP:${IP}" \
    2>/dev/null
chmod 600 "${SSL_DIR}/minimalte.key"
chmod 644 "${SSL_DIR}/minimalte.crt"
ok "Cert: ${SSL_DIR}/minimalte.crt (valid 10yr)"

# ─── 4. Nuke EVERYTHING ───
step "Removing ALL existing nginx configs..."
# Backup original
[[ -f /etc/nginx/nginx.conf ]] && cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
# Kill all sites-enabled/conf.d entries
rm -f /etc/nginx/sites-enabled/*
rm -f /etc/nginx/conf.d/*.conf
ok "All old configs removed (backup: nginx.conf.bak)"

# ─── 5. Replace main nginx.conf ───
step "Installing new nginx.conf..."
cp "${SCRIPT_DIR}/nginx.conf" /etc/nginx/nginx.conf
ok "Replaced /etc/nginx/nginx.conf"

# ─── 6. Test config ───
step "Testing config..."
nginx -t 2>&1 || fail "Config test failed!"
ok "Config valid"

# ─── 7. Firewall ───
step "Firewall..."
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp  >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ok "Ports 80/443 opened"
else
    warn "ufw not active — check your VPS firewall"
fi

# ─── 8. Start nginx ───
step "Starting Nginx..."
systemctl enable nginx >/dev/null 2>&1
systemctl start nginx
ok "Nginx running"

# ─── 9. Verify ───
step "Verifying..."
sleep 1

systemctl is-active --quiet nginx && ok "Nginx process: running" || fail "Nginx not running!"

ss -tlnp | grep -q ':80 '  && ok "Port 80: listening"  || warn "Port 80 not listening"
ss -tlnp | grep -q ':443 ' && ok "Port 443: listening" || warn "Port 443 not listening"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ 2>/dev/null || echo "fail")
[[ "$HTTP" == "301" ]] && ok "HTTP→HTTPS redirect: working" || warn "HTTP returned: ${HTTP}"

HTTPS=$(curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/ 2>/dev/null || echo "fail")
[[ "$HTTPS" == "200" ]] && ok "HTTPS proxy: working" \
    || { [[ "$HTTPS" == "502" ]] && warn "HTTPS: 502 — is your app running on :5173?" \
    || warn "HTTPS returned: ${HTTPS}"; }

# ─── Done ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔ MinimalTE is live!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  http://${IP}  → auto-redirect"
echo -e "  https://${IP} → your app"
echo ""
echo -e "  ${YELLOW}Browser will warn about self-signed cert.${NC}"
echo -e "  ${YELLOW}Click Advanced → Proceed.${NC}"
echo ""
echo -e "  ${CYAN}Logs:${NC} tail -f /var/log/nginx/error.log"
echo -e "  ${CYAN}Undo:${NC} sudo ./uninstall.sh"
echo ""
