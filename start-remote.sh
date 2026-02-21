#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  start-remote.sh — Start frontend + backend + reverse SSH tunnels
#
#  Usage:   ./start-remote.sh
#  Stop:    Ctrl-C  (kills everything cleanly)
#
#  Architecture:
#    ┌──────────────────────────────────────────────────┐
#    │  Remote server  185.243.115.79                   │
#    │   :80  ──► tunnel ──► localhost:5173  (Vite)     │
#    │   :81  ──► tunnel ──► localhost:3900  (Express)  │
#    └──────────────────────────────────────────────────┘
#
#  Vite already proxies /api, /fapi, /ws to :3900, so for
#  browser access you only need the :80 tunnel.
#  The :81 tunnel is for direct API / bot access.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Config ────────────────────────────────────────────────────
SSH_SERVER="nokey@185.243.115.79"
SSH_PORT=2222

# Remote port → local port mapping
FRONTEND_REMOTE_PORT=80     # exposed publicly on the server
FRONTEND_LOCAL_PORT=5173    # Vite dev server

BACKEND_REMOTE_PORT=81      # exposed publicly for direct API
BACKEND_LOCAL_PORT=3900     # Express server

# SSH options: auto-reconnect, no host key check, keep-alive
SSH_OPTS=(
  -o "StrictHostKeyChecking=no"
  -o "UserKnownHostsFile=/dev/null"
  -o "ServerAliveInterval=30"
  -o "ServerAliveCountMax=3"
  -o "ExitOnForwardFailure=yes"
  -o "LogLevel=ERROR"
)

# ── Colours ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

# ── Cleanup on exit ──────────────────────────────────────────
PIDS=()
cleanup() {
  echo -e "\n${YELLOW}🛑 Shutting down...${NC}"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo -e "${GREEN}✅ All processes stopped.${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# ── Helper: wait for port to be listening ─────────────────────
wait_for_port() {
  local port=$1
  local name=$2
  local max_wait=30
  local i=0
  while ! lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    sleep 1
    i=$((i + 1))
    if [ $i -ge $max_wait ]; then
      echo -e "${RED}✘ Timed out waiting for $name on port $port${NC}"
      exit 1
    fi
  done
  echo -e "${GREEN}✔ $name is up on port $port${NC}"
}

# ── Helper: start SSH tunnel with auto-reconnect ─────────────
start_tunnel() {
  local remote_port=$1
  local local_port=$2
  local label=$3

  while true; do
    echo -e "${CYAN}🔗 [$label] Connecting tunnel :${remote_port} → localhost:${local_port}${NC}"
    ssh -p "$SSH_PORT" \
      "${SSH_OPTS[@]}" \
      -N \
      -R "${remote_port}:localhost:${local_port}" \
      "$SSH_SERVER" 2>&1 | while read -r line; do
        echo -e "${CYAN}  [tunnel/$label] $line${NC}"
      done
    echo -e "${YELLOW}⚠  [$label] Tunnel disconnected, reconnecting in 5s...${NC}"
    sleep 5
  done
}

# ──────────────────────────────────────────────────────────────
#  1) Start the backend (Express) server
# ──────────────────────────────────────────────────────────────
echo -e "${GREEN}🚀 Starting backend server...${NC}"
cd "$PROJECT_DIR"
node server/index.js &
PIDS+=($!)

wait_for_port "$BACKEND_LOCAL_PORT" "Backend (Express)"

# ──────────────────────────────────────────────────────────────
#  2) Start the frontend (Vite) dev server
# ──────────────────────────────────────────────────────────────
echo -e "${GREEN}🚀 Starting frontend dev server...${NC}"
cd "$PROJECT_DIR"
npx vite --host 0.0.0.0 &
PIDS+=($!)

wait_for_port "$FRONTEND_LOCAL_PORT" "Frontend (Vite)"

# ──────────────────────────────────────────────────────────────
#  3) Open SSH reverse tunnels
# ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Servers are up! Opening SSH tunnels...${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

# Frontend tunnel  (remote :80 → local :5173)
start_tunnel "$FRONTEND_REMOTE_PORT" "$FRONTEND_LOCAL_PORT" "frontend" &
PIDS+=($!)

# Backend tunnel   (remote :81 → local :3900)
start_tunnel "$BACKEND_REMOTE_PORT" "$BACKEND_LOCAL_PORT" "backend" &
PIDS+=($!)

sleep 2
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🌐 Frontend:  http://185.243.115.79${NC}"
echo -e "${GREEN}  📡 API:       http://185.243.115.79:81/api${NC}"
echo -e "${GREEN}  🤖 Bot API:   http://185.243.115.79:81/api/bot${NC}"
echo -e "${GREEN}  🔌 FAPI:      http://185.243.115.79:81/fapi${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl-C to stop everything.${NC}"

# Wait forever (until Ctrl-C)
wait
