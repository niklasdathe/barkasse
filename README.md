# Barkasse Sensor Infrastructure

A simple, easy-to-extend sensor for the Barkasse project.

## 1. Hub

This section describes the setup and structure of the on board hub.

### 1.1 Core Ideas
- Sensor nodes (ESP32/Arduino) publish JSON over MQTT via Ethernet/PoE or WiFi.
- A Raspberry Pi / reTerminal acts as a central hub with Mosquitto + Node-RED (HTTP/WebSocket) serving a static UI.
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
| `mosquitto/`            | Mosquitto config for native install                    |
| `nodered_data/`         | Node-RED userDir (flows + settings)                    |
| `ui/`                   | Static touchscreen UI                                  |
| `systemd/`              | System services for hub + fullscreen UI                |


### 1.4 Setup on Raspberry Pi

This repo is designed to run **without Docker**.

**1. Install Mosquitto + Node-RED**
```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
```

Install Node-RED (if not already present):
```bash
bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)
```

**2. Configure Mosquitto**
```bash
sudo cp mosquitto/mosquitto.conf /etc/mosquitto/conf.d/barkasse.conf
sudo systemctl enable --now mosquitto
```

**3. Enable services**
```bash
sudo cp systemd/barkasse-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barkasse-ui.service
```

The UI is served at http://localhost:8080.

### 1.5 Isolated LAN (hub assigns IPs + NTP)

If the hub and ESP32 are the only devices on a switch, the hub must provide IP addresses.

This repo includes a small coordinator setup that configures:

- Static IP on `eth0` (default `192.168.10.10/24`)
- DHCP (dnsmasq) so the ESP32 gets an IP when plugged in
- NTP (chrony) served by the hub

Run:

```bash
chmod +x scripts/setup-lan-coordinator.sh scripts/barkasse-dhcp-mqtt-hook.sh
BARKASSE_LAN_IFACE=eth0 BARKASSE_LAN_IP=192.168.10.10 ./scripts/setup-lan-coordinator.sh
```

Details: see [docs/lan_coordinator.md](docs/lan_coordinator.md).

### 1.5 Implementation Examples

- **ESP32-P4 Weather (Ethernet)** (See `example-sensor-implementations/esp32p4-weatherstation-mock`)

- **ESP32 WROOM Water (WiFi)** (See `example-sensor-implementations/esp32-wroom-waterstation-mock`)

- **(LoRa)** TODO

### 1.6 Extend
Add any new sensor/cluster by publishing to the topic contract. No UI edits required.

### 1.7 Maintenance

- Check backend: systemctl status barkasse-ui.service
- Check browser: systemctl status barkasse-fullscreen.service
- Update manually: git pull && sudo systemctl restart barkasse-ui barkasse-fullscreen

### 1.8 UI menu (clear history & fullscreen)

The hub keeps recent datapoints in memory to render charts. You can delete this local history if needed:

- UI: Use the top-right menu (⋮) and choose "Clear history". All stored series are removed.
- API: Send a POST request to the hub:
  - Clear everything: POST /history/clear
  - Clear one series: POST /history/clear?key=<node>/<cluster>/<sensor>

This only affects the in-memory cache on the Pi; live updates continue as new datapoints arrive.

This setup does not require Chromium at all. If you want the UI to open automatically on boot
in fullscreen, enable `systemd/barkasse-fullscreen.service`.

## 2. Server

This section describes the setup and structure of the server side.  



