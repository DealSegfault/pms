#!/usr/bin/env bash
# Uninstall — Restore original nginx.conf
set -euo pipefail
[[ $EUID -ne 0 ]] && echo "Run as root" && exit 1

echo "▸ Restoring original nginx.conf..."
if [[ -f /etc/nginx/nginx.conf.bak ]]; then
    cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf
    echo "  ✔ Restored from backup"
else
    echo "  ⚠ No backup found — reinstall nginx: apt install --reinstall nginx-common"
fi

echo "▸ Removing SSL certs..."
rm -f /etc/nginx/ssl/minimalte.crt /etc/nginx/ssl/minimalte.key

echo "▸ Restarting nginx..."
systemctl restart nginx
echo "  ✔ Done"
