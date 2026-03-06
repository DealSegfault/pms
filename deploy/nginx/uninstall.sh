#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# MinimalTE — Nginx Reverse Proxy Uninstall Script
# Usage: sudo ./uninstall.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}✖ Run as root: sudo ./uninstall.sh${NC}"
    exit 1
fi

echo -e "${CYAN}▸ Removing MinimalTE nginx config...${NC}"
rm -f /etc/nginx/sites-enabled/minimalte
rm -f /etc/nginx/sites-available/minimalte
echo -e "  ${GREEN}✔ Config removed${NC}"

echo -e "${CYAN}▸ Removing SSL certificates...${NC}"
rm -f /etc/nginx/ssl/minimalte.crt
rm -f /etc/nginx/ssl/minimalte.key
echo -e "  ${GREEN}✔ Certs removed${NC}"

echo -e "${CYAN}▸ Restoring default nginx site...${NC}"
if [[ -f /etc/nginx/sites-available/default ]]; then
    ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
fi

echo -e "${CYAN}▸ Restarting nginx...${NC}"
systemctl restart nginx
echo -e "  ${GREEN}✔ Done — nginx restored to default${NC}"
