#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/hub/barkasse-hub"

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this as the normal user (it will use sudo when needed)." >&2
  exit 1
fi

cd "$REPO_DIR"

echo "[0/5] Checking prerequisites..."
command -v node-red >/dev/null 2>&1 || {
  echo "node-red is not installed. Install it first (recommended installer):" >&2
  echo "  bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)" >&2
  exit 1
}

echo "[1/5] Installing systemd units (system-wide)..."
sudo install -m 0644 systemd/barkasse-ui.service /etc/systemd/system/barkasse-ui.service
sudo install -m 0644 systemd/barkasse-fullscreen.service /etc/systemd/system/barkasse-fullscreen.service
sudo systemctl daemon-reload

echo "[2/5] Disabling user-level services (to avoid duplicates)..."
# best-effort: only works if a user systemd is running
systemctl --user disable --now barkasse-fullscreen.service >/dev/null 2>&1 || true
systemctl --user disable --now barkasse-ui.service >/dev/null 2>&1 || true

echo "[2b/5] Disabling default Node-RED service (if installed)..."
sudo systemctl disable --now nodered.service >/dev/null 2>&1 || true
sudo systemctl mask nodered.service >/dev/null 2>&1 || true




echo "[3/5] Enabling system services..."
sudo systemctl enable --now barkasse-ui.service
sudo systemctl enable --now barkasse-fullscreen.service

echo "[4/5] Status..."
systemctl --no-pager --full status barkasse-ui.service | head -n 30 || true
systemctl --no-pager --full status barkasse-fullscreen.service | head -n 40 || true

echo "[5/5] Endpoints"
echo "- UI:      http://localhost:8080/"
echo "- Editor:  http://localhost:8080/admin/"
