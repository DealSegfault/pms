#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — Nginx + Self-Signed SSL Install Script
# Usage: sudo ./install.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_step()  { echo -e "\n${CYAN}▸ $1${NC}"; }
print_ok()    { echo -e "  ${GREEN}✔ $1${NC}"; }
print_warn()  { echo -e "  ${YELLOW}⚠ $1${NC}"; }
print_err()   { echo -e "  ${RED}✖ $1${NC}"; }

# ─── Root check ───
if [[ $EUID -ne 0 ]]; then
    print_err "This script must be run as root (sudo ./install.sh)"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_IP="89.187.28.51"
SSL_DIR="/etc/nginx/ssl"
NGINX_CONF_SRC="${SCRIPT_DIR}/nginx.conf"
NGINX_CONF_DST="/etc/nginx/sites-available/minimalte"
NGINX_ENABLED="/etc/nginx/sites-enabled/minimalte"

# ─── 1. Install Nginx ───
print_step "Installing Nginx..."
if command -v nginx &>/dev/null; then
    print_ok "Nginx already installed ($(nginx -v 2>&1 | cut -d'/' -f2))"
else
    apt-get update -qq
    apt-get install -y -qq nginx
    print_ok "Nginx installed"
fi

# ─── 2. Generate self-signed SSL certificate ───
print_step "Generating self-signed SSL certificate for ${SERVER_IP}..."
mkdir -p "$SSL_DIR"

if [[ -f "${SSL_DIR}/minimalte.crt" && -f "${SSL_DIR}/minimalte.key" ]]; then
    print_warn "SSL cert already exists. Regenerating..."
fi

openssl req -x509 -nodes -days 3650 \
    -newkey rsa:2048 \
    -keyout "${SSL_DIR}/minimalte.key" \
    -out "${SSL_DIR}/minimalte.crt" \
    -subj "/C=FR/ST=Paris/L=Paris/O=MinimalTE/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" \
    2>/dev/null

chmod 600 "${SSL_DIR}/minimalte.key"
chmod 644 "${SSL_DIR}/minimalte.crt"
print_ok "SSL certificate generated (valid 10 years)"
print_ok "  Cert: ${SSL_DIR}/minimalte.crt"
print_ok "  Key:  ${SSL_DIR}/minimalte.key"

# ─── 3. Install Nginx config ───
print_step "Installing Nginx configuration..."
cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
print_ok "Config copied to ${NGINX_CONF_DST}"

# Remove default site if it exists
if [[ -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
    print_ok "Removed default site"
fi

# Create symlink
ln -sf "$NGINX_CONF_DST" "$NGINX_ENABLED"
print_ok "Symlinked to sites-enabled"

# ─── 4. Test Nginx config ───
print_step "Testing Nginx configuration..."
if nginx -t 2>&1; then
    print_ok "Nginx config OK"
else
    print_err "Nginx config test failed!"
    exit 1
fi

# ─── 5. Open firewall ports ───
print_step "Configuring firewall (if ufw is active)..."
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp  >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    print_ok "Ports 80 and 443 opened"
else
    print_warn "ufw not active — make sure ports 80/443 are open in your VPS firewall"
fi

# ─── 6. Restart Nginx ───
print_step "Restarting Nginx..."
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx
print_ok "Nginx restarted and enabled on boot"

# ─── Done ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔ MinimalTE is now live!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${CYAN}HTTP  →${NC} http://${SERVER_IP}   (auto-redirects to HTTPS)"
echo -e "  ${CYAN}HTTPS →${NC} https://${SERVER_IP}  (self-signed cert)"
echo ""
echo -e "  ${YELLOW}Note: Your browser will show a security warning${NC}"
echo -e "  ${YELLOW}because the certificate is self-signed.${NC}"
echo -e "  ${YELLOW}Click 'Advanced' → 'Proceed' to continue.${NC}"
echo ""
