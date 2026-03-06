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

# ─── 3. Nuke ALL default configs ───
print_step "Removing ALL default/conflicting nginx configs..."

# Remove default from sites-enabled
rm -f /etc/nginx/sites-enabled/default
rm -f /etc/nginx/sites-enabled/minimalte
rm -f /etc/nginx/sites-available/minimalte

# Remove default from conf.d
rm -f /etc/nginx/conf.d/default.conf
rm -f /etc/nginx/conf.d/minimalte.conf

print_ok "Cleared all default configs"

# ─── 4. Install config in BOTH locations (belt + suspenders) ───
print_step "Installing Nginx configuration..."

# Method 1: sites-available + sites-enabled (Debian/Ubuntu default)
if [[ -d /etc/nginx/sites-available ]]; then
    cp "$NGINX_CONF_SRC" /etc/nginx/sites-available/minimalte
    ln -sf /etc/nginx/sites-available/minimalte /etc/nginx/sites-enabled/minimalte
    print_ok "Installed in sites-available + sites-enabled"
fi

# Method 2: conf.d (some distros only use this)
if [[ -d /etc/nginx/conf.d ]]; then
    cp "$NGINX_CONF_SRC" /etc/nginx/conf.d/minimalte.conf
    print_ok "Installed in conf.d"
fi

# ─── 5. Verify main nginx.conf includes our config ───
print_step "Verifying nginx includes config directories..."
MAIN_CONF="/etc/nginx/nginx.conf"
if ! grep -q "include.*sites-enabled" "$MAIN_CONF" && ! grep -q "include.*conf.d" "$MAIN_CONF"; then
    print_warn "Main nginx.conf doesn't include sites-enabled or conf.d!"
    print_warn "Adding include directive..."
    # Add include before the last closing brace
    sed -i '/^}/i\    include /etc/nginx/conf.d/*.conf;' "$MAIN_CONF"
    print_ok "Added include directive to main nginx.conf"
else
    print_ok "Main nginx.conf already includes config directories"
fi

# ─── 6. Test Nginx config ───
print_step "Testing Nginx configuration..."
if nginx -t 2>&1; then
    print_ok "Nginx config OK"
else
    print_err "Nginx config test failed! Details above."
    exit 1
fi

# ─── 7. Open firewall ports ───
print_step "Configuring firewall (if ufw is active)..."
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow 80/tcp  >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    print_ok "Ports 80 and 443 opened"
else
    print_warn "ufw not active — make sure ports 80/443 are open in your VPS firewall"
fi

# ─── 8. Restart Nginx ───
print_step "Restarting Nginx..."
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx
print_ok "Nginx restarted and enabled on boot"

# ─── 9. Verification ───
print_step "Verifying setup..."
sleep 1

# Check nginx is actually running
if systemctl is-active --quiet nginx; then
    print_ok "Nginx is running"
else
    print_err "Nginx failed to start!"
    journalctl -u nginx --no-pager -n 10
    exit 1
fi

# Check ports are listening
if ss -tlnp | grep -q ':80 '; then
    print_ok "Port 80 is listening"
else
    print_warn "Port 80 not detected (check firewall)"
fi

if ss -tlnp | grep -q ':443 '; then
    print_ok "Port 443 is listening"
else
    print_warn "Port 443 not detected (check firewall)"
fi

# Quick test
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1/" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "301" ]]; then
    print_ok "HTTP→HTTPS redirect working (got 301)"
elif [[ "$HTTP_CODE" == "000" ]]; then
    print_warn "Could not connect to port 80 locally"
else
    print_warn "HTTP returned ${HTTP_CODE} (expected 301)"
fi

HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" "https://127.0.0.1/" 2>/dev/null || echo "000")
if [[ "$HTTPS_CODE" == "200" || "$HTTPS_CODE" == "502" ]]; then
    if [[ "$HTTPS_CODE" == "200" ]]; then
        print_ok "HTTPS is serving content (got 200)"
    else
        print_warn "HTTPS returns 502 — is your app running on port 5173?"
    fi
elif [[ "$HTTPS_CODE" == "000" ]]; then
    print_warn "Could not connect to port 443 locally"
else
    print_warn "HTTPS returned ${HTTPS_CODE}"
fi

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
echo -e "  ${CYAN}Debug:${NC} nginx -t && systemctl status nginx"
echo -e "  ${CYAN}Logs:${NC}  tail -f /var/log/nginx/error.log"
echo ""
