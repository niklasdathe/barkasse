# Barkasse Hub (PoE + MQTT)

A tiny, easy-to-extend sensor hub for the Barkasse project.

## Core Ideas
- Sensor nodes (ESP32/Arduino) publish JSON over MQTT via Ethernet/PoE.
- A Raspberry Pi acts as a central hub with Mosquitto and a FastAPI + WebSocket UI.
- The UI auto-discovers new sensors and displays them live on a 10-inch touch panel.

## MQTT Topics & JSON Schema
- Topic: `barkasse/<node>/<cluster>/<sensor>`
- Payload:
  ```json
  {
  "node": "esp32p4-01",
  "cluster": "weather",
  "sensor": "temperature",
  "value": 22.4,
  "unit": "°C",
  "ts": "2025-10-10T12:00:00Z"
  }
  ```
## Directory Overview

| Folder                  | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `esp32p4-weather-mock`  | ESP32-P4 demo firmware publishing MQTT weather data    |
| `pi/docker-compose.yml` | Mosquitto MQTT broker                                  |
| `pi/app/`               | FastAPI backend with WebSocket + static touchscreen UI |
| `systemd/`              | Auto-update, backend, and kiosk startup services       |


## Setup on Raspberry Pi

### 1. Setup Mosquitto
```bash
cd pi
docker compose up -d
```

### 2. Setup Python environment
```bash
cd app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Enable services
```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auto-git-update.service barkasse-ui.service chromium-kiosk.service
```

### Kiosk Mode

- Chromium launches automatically in fullscreen Wayland mode.  
- The UI is served at http://localhost:8080.  

## Extend
Add any new sensor/cluster by publishing to the topic contract. No UI edits required.
