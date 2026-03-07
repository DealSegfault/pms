#!/bin/bash
# ── PMS Backend Service Installer ──
# Run as root on the VPS: sudo bash deploy/install-service.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/pms-backend.service"
DEST="/etc/systemd/system/pms-backend.service"

if [ ! -f "$SERVICE_FILE" ]; then
    echo "❌ Service file not found: $SERVICE_FILE"
    exit 1
fi

echo "📦 Installing PMS Backend service..."

# Update WorkingDirectory based on actual project location
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
sed "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|g" "$SERVICE_FILE" > /tmp/pms-backend.service
sed -i "s|EnvironmentFile=.*|EnvironmentFile=-$PROJECT_DIR/.env|g" /tmp/pms-backend.service

# Detect node path
NODE_PATH=$(which node 2>/dev/null || echo "/usr/bin/node")
sed -i "s|ExecStart=.*|ExecStart=$NODE_PATH --max-old-space-size=384 server/index.js|g" /tmp/pms-backend.service

# Detect current user if not root
CURRENT_USER=$(whoami)
sed -i "s|User=.*|User=$CURRENT_USER|g" /tmp/pms-backend.service

cp /tmp/pms-backend.service "$DEST"
rm -f /tmp/pms-backend.service

systemctl daemon-reload
systemctl enable pms-backend
systemctl restart pms-backend

echo ""
echo "✅ PMS Backend service installed and started!"
echo ""
echo "  📊 Status:   sudo systemctl status pms-backend"
echo "  📝 Logs:     sudo journalctl -u pms-backend -f"
echo "  🔄 Restart:  sudo systemctl restart pms-backend"
echo "  ⛔ Stop:     sudo systemctl stop pms-backend"
echo ""

systemctl status pms-backend --no-pager || true
