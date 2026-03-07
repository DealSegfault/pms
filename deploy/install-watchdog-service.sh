#!/bin/bash
# ── PMS Watchdog Service Installer ──
# Run as root on the VPS: sudo bash deploy/install-watchdog-service.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/pms-watchdog.service"
DEST="/etc/systemd/system/pms-watchdog.service"

if [ ! -f "$SERVICE_FILE" ]; then
    echo "❌ Service file not found: $SERVICE_FILE"
    exit 1
fi

echo "📦 Installing PMS watchdog service..."

PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_PATH="$(which node 2>/dev/null || echo "/usr/bin/node")"
CURRENT_USER="$(whoami)"

sed "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|g" "$SERVICE_FILE" > /tmp/pms-watchdog.service
sed -i "s|ExecStart=.*|ExecStart=$NODE_PATH scripts/pm2-watchdog.mjs|g" /tmp/pms-watchdog.service
sed -i "s|User=.*|User=$CURRENT_USER|g" /tmp/pms-watchdog.service

cp /tmp/pms-watchdog.service "$DEST"
rm -f /tmp/pms-watchdog.service

systemctl daemon-reload
systemctl enable pms-watchdog
systemctl restart pms-watchdog

echo ""
echo "✅ PMS watchdog service installed and started!"
echo ""
echo "  📊 Status:   sudo systemctl status pms-watchdog"
echo "  📝 Logs:     sudo journalctl -u pms-watchdog -f"
echo "  🔄 Restart:  sudo systemctl restart pms-watchdog"
echo ""

systemctl status pms-watchdog --no-pager || true
