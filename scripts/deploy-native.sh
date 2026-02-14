#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/hub/barkasse-hub"

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this as the normal user (it will use sudo when needed)." >&2
  exit 1
fi

cd "$REPO_DIR"

fetch_url() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url"
  else
    echo "Neither curl nor wget is installed; can't fetch $url" >&2
    return 1
  fi
}

fix_github_cli_apt_repo() {
  # If a GitHub CLI repo is configured but its signing key is missing, apt update
  # will fail and block unrelated installs (like Mosquitto). Repair it.
  if ! grep -R --no-messages -q 'cli\.github\.com/packages' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    return 0
  fi

  echo "Attempting to repair GitHub CLI apt repository key (cli.github.com)..." >&2

  sudo install -d -m 0755 /etc/apt/keyrings
  fetch_url "https://cli.github.com/packages/githubcli-archive-keyring.gpg" \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg

  local arch
  arch="$(dpkg --print-architecture)"

  # Normalize to the currently supported "stable" channel and a single source file.
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo rm -f /etc/apt/sources.list.d/github-cli2.list
}

apt_update_with_fixes() {
  if sudo apt-get update; then
    return 0
  fi

  fix_github_cli_apt_repo || true
  sudo apt-get update
}

echo "[1/6] Checking prerequisites..."
command -v node-red >/dev/null 2>&1 || {
  echo "node-red is not installed. Install it first (recommended installer):" >&2
  echo "  bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)" >&2
  exit 1
}

if ! command -v mosquitto >/dev/null 2>&1; then
  echo "[2/6] Installing Mosquitto..."
  apt_update_with_fixes
  sudo apt install -y mosquitto mosquitto-clients
else
  echo "[2/6] Mosquitto already installed."
fi

echo "[3/6] Installing Mosquitto config..."
sudo install -d /etc/mosquitto/conf.d
sudo install -m 0644 mosquitto/mosquitto.conf /etc/mosquitto/conf.d/barkasse.conf

echo "[4/6] Installing systemd services..."
sudo install -m 0644 systemd/barkasse-ui.service /etc/systemd/system/barkasse-ui.service
sudo install -m 0644 systemd/barkasse-fullscreen.service /etc/systemd/system/barkasse-fullscreen.service
sudo systemctl daemon-reload

echo "[5/6] Enabling and starting services (fullscreen autostart)..."

sudo systemctl enable --now mosquitto
sudo systemctl enable --now barkasse-ui.service
sudo systemctl enable --now barkasse-fullscreen.service

if [[ "${BARKASSE_SETUP_LAN_COORDINATOR:-}" == "1" ]]; then
  echo "[5b/6] Applying isolated LAN coordinator (DHCP+NTP on eth0)..."
  chmod +x scripts/setup-lan-coordinator.sh scripts/barkasse-dhcp-mqtt-hook.sh
  BARKASSE_LAN_IFACE="${BARKASSE_LAN_IFACE:-eth0}" \
  BARKASSE_LAN_IP="${BARKASSE_LAN_IP:-192.168.10.10}" \
  ./scripts/setup-lan-coordinator.sh
fi


echo "[6/6] Smoke checks..."
echo "- UI:        https://localhost:8443/"
echo "- Node-RED:  https://localhost:8443/admin"
echo "- MQTT:       localhost:1883"

curl -ksSf https://localhost:8443/ >/dev/null && echo "OK: UI reachable" || echo "WARN: UI not reachable yet (if setup-security.sh has not run yet, try http://localhost:1880/)"

systemctl --no-pager --full status mosquitto | head -n 20 || true
systemctl --no-pager --full status barkasse-ui.service | head -n 30 || true

echo "Done."
