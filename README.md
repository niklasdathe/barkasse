# Barkasse Sensor Infrastructure

A simple, easy-to-extend sensor for the Barkasse project.

## 1. Hub

This section describes the setup and structure of the on board hub.

### 1.1 Core Ideas
- Sensor nodes (ESP32/Arduino) publish JSON over MQTT via Ethernet/PoE or WiFi.
- A Raspberry Pi acts as a central hub with Mosquitto and a FastAPI + WebSocket UI.
- The UI auto-discovers new sensors and displays them live on a 10-inch touch panel.

### 1.2 MQTT Topics & JSON Schema
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
### 1.3 Directory Overview

| Folder                  | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `example-sensor-implementations/esp32p4-weatherstation-mock`  | ESP32-P4 (Ethernet) demo publishing weather data |
| `example-sensor-implementations/esp32-wroom-waterstation-mock`| ESP32 WROOM (WiFi) demo publishing water data    |
| `pi/docker-compose.yml` | Mosquitto MQTT broker                                  |
| `pi/app/`               | FastAPI backend with WebSocket + static touchscreen UI |
| `systemd/`              | Auto-update, backend, and kiosk startup services       |


### 1.4 Setup on Raspberry Pi

**1. Setup Mosquitto**
```bash
cd pi
docker compose up -d
```

**2. Setup Python environment**
```bash
cd app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**3. Enable services**
```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auto-git-update.service barkasse-ui.service chromium-kiosk.service
```

**Kiosk Mode**

- Chromium launches automatically in fullscreen Wayland mode.  
- The UI is served at http://localhost:8080.  

### 1.5 Implementation Examples

- **ESP32-P4 Weather (Ethernet)** (See `example-sensor-implementations/esp32p4-weatherstation-mock`)

- **ESP32 WROOM Water (WiFi)** (See `example-sensor-implementations/esp32-wroom-waterstation-mock`)

- **(LoRa)** TODO

### 1.6 Extend
Add any new sensor/cluster by publishing to the topic contract. No UI edits required.

### 1.7 Maintenance

- Check backend: systemctl status barkasse-ui.service
- Check kiosk: systemctl status chromium-kiosk.service
- Update manually: git pull && sudo systemctl restart barkasse-ui chromium-kiosk

### 1.8 Clear local history

The hub keeps recent datapoints in memory to render charts. You can delete this local history if needed:

- UI: Click the "Clear history" button in the top right and confirm. All stored series are removed.
- API: Send a POST request to the hub:
  - Clear everything: POST /history/clear
  - Clear one series: POST /history/clear?key=<node>/<cluster>/<sensor>

This only affects the in-memory cache on the Pi; live updates continue as new datapoints arrive.

### 1.9 Kiosk mode toggle

The device should always boot into kiosk mode for a simple, locked-down UI. Sometimes you may want to temporarily exit kiosk mode on the Pi to configure Wi‑Fi or other settings using the touch screen. The UI provides a "Toggle kiosk mode" item in the top-right menu.

Recommended wiring:

- Keep `kiosk-chromium.service` enabled so the device boots into kiosk by default.
- Expose a local endpoint on the hub (e.g., with FastAPI or Node‑RED) at `POST /system/kiosk` with JSON `{ "mode": "on" | "off" }`.
- Implement the endpoint to:
  - `mode=off`: stop `kiosk-chromium.service`, and optionally start a normal Chromium session without `--kiosk` or provide a desktop/terminal.
  - `mode=on`: (re)start `kiosk-chromium.service` to return to full kiosk.

Example with Node‑RED:

- Add an HTTP-In node for `POST /system/kiosk`.
- Use an exec node to run `sudo systemctl stop kiosk-chromium.service` when `mode=off` and `sudo systemctl start kiosk-chromium.service` when `mode=on`.
- Return 200 OK on success.

Frontend behavior:

- The menu button sends `POST /system/kiosk` and also stores a local preference in `localStorage` (`kioskMode = on|off`) as a hint.
- If the endpoint is not available, the UI will still set the local flag and inform the user, but the actual system kiosk state must be changed via service control.

## 2. Server

This section describes the setup and structure of the server side.  



