# Barkasse Hub – Native (Non-Docker) Deployment

This repo is intended to run on the reTerminal / Raspberry Pi **without Docker**.

## Services

- **Mosquitto** (MQTT broker) on port `1883`
- **Node-RED** (serves the UI + HTTP API + WebSocket) on port `8080`
  - UI: `http://<device-ip>:8080/`
  - Node-RED editor: `http://<device-ip>:8080/admin`

## One-command deploy (recommended)

From the repo directory on the device:

```bash
chmod +x scripts/deploy-native.sh
./scripts/deploy-native.sh
```

If you want to (re-)install and enable only the system-level services:

```bash
chmod +x scripts/enable-system-services.sh
./scripts/enable-system-services.sh
```

The script:
- installs Mosquitto via `apt` (requires sudo password)
- copies Mosquitto config from `mosquitto/mosquitto.conf`
- installs + enables systemd services from `systemd/`
- enables `barkasse-fullscreen.service` (fullscreen Chromium autostart)


## Manual deploy (if you prefer)

### 1) Install packages

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
```

Node-RED is expected to already be installed. If it isn’t:

```bash
bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)
```

### 2) Configure Mosquitto

```bash
sudo install -d /etc/mosquitto/conf.d
sudo install -m 0644 mosquitto/mosquitto.conf /etc/mosquitto/conf.d/barkasse.conf
sudo systemctl enable --now mosquitto
```

### 3) Install and enable systemd services

```bash
sudo install -m 0644 systemd/barkasse-ui.service /etc/systemd/system/barkasse-ui.service
sudo systemctl daemon-reload
sudo systemctl enable --now barkasse-ui.service
```

### 4) Enable fullscreen UI autostart

```bash
sudo systemctl enable --now barkasse-fullscreen.service
```

## Troubleshooting

- Service logs: `journalctl -u barkasse-ui.service -f`
- Mosquitto check: `mosquitto_sub -h 127.0.0.1 -t 'barkasse/#' -v`
- Node-RED port: verify it’s on `8080` (repo sets `nodered_data/settings.js` to `8080`).
