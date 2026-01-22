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



| MQTT topic (barkasse/node)                               | node         | cluster     | sensor                 | unit     | What it means                                                                      | Source / where it comes from                                                |
| ----------------------------------------- | ------------ | ----------- | ---------------------- | -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `barkasse/esp32p4-01` | `esp32p4-01` | `weather`   | `temperature`          | `°C`     | Ambient/outside temperature (mock)                                                 | ESP32-P4 weather mock (`publishSensor("temperature", ...)`)                 |
| `barkasse/esp32p4-01`    | `esp32p4-01` | `weather`   | `humidity`             | `%`      | Relative humidity (mock)                                                           | ESP32-P4 weather mock                                                       |
| `barkasse/esp32p4-01`    | `esp32p4-01` | `weather`   | `pressure`             | `hPa`    | Air pressure (mock)                                                                | ESP32-P4 weather mock                                                       |
| `barkasse/esp32p4-01`  | `esp32p4-01` | `weather`   | `wind_speed`           | `m/s`    | Wind speed (mock)                                                                  | ESP32-P4 weather mock                                                       |
| `barkasse/esp32p4-01`    | `esp32p4-01` | `weather`   | `wind_dir`             | `°`      | Wind direction (0–360°) (mock)                                                     | ESP32-P4 weather mock                                                       |
| `barkasse/esp32p4-01`       | `esp32p4-01` | `weather`   | *(summary envelope)*   | —        | One JSON message containing **all weather sensors** under `sensors{...}`           | ESP32-P4 weather mock (`publishCluster()`)                                  |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `temperature`          | `°C`     | Enclosure internal air temperature                                                 | Hub I2C script AM2301B (`am2301b_read.py` → MQTT Publish Enclosure)         |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `humidity`             | `%`      | Enclosure internal relative humidity                                               | Hub I2C script AM2301B (`am2301b_read.py` → MQTT Publish Enclosure)         |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `surface_temp`         | `°C`     | Estimated “cold surface” temperature inside enclosure (used for condensation risk) | Node-RED “Condensation Risk” flow: `T_surface = (T_inside + T_outside)/2`   |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `dew_point`            | `°C`     | Dew point temperature computed from inside T + RH (Magnus formula)                 | Node-RED “Condensation Risk” flow                                           |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `condensation_delta`   | `°C`     | `dew_point - surface_temp` (positive ⇒ condensation likely)                        | Node-RED “Condensation Risk” flow                                           |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `condensation_risk`    | `%`      | Risk mapped from `condensation_delta` using linear low/high thresholds             | Node-RED “Condensation Risk” flow (`risk_low_delta_c`, `risk_high_delta_c`) |
| `barkasse/sensors`                        | `hub`        | `enclosure` | `condensation`         | *(none)* | Boolean flag: `1` if `surface_temp <= dew_point`, else `0`                         | Node-RED “Condensation Risk” flow                                           |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `fix_valid`            | *(none)* | RMC validity (A=1 / V=0)                                                           | Node-RED GNSS parser (EC25 NMEA → JSON)                                     |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `fix_quality`          | *(none)* | GGA fix quality (0=no fix, 1=GPS, 2=DGPS, …)                                       | Node-RED GNSS parser (from GGA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `fix_type`             | *(none)* | GSA fix type (1=no fix, 2=2D, 3=3D)                                                | Node-RED GNSS parser (from GSA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `sats_used`            | *(none)* | Satellites used in solution                                                        | Node-RED GNSS parser (from GGA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `hdop`                 | *(none)* | Horizontal dilution of precision                                                   | Node-RED GNSS parser (GGA/GSA)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `pdop`                 | *(none)* | Position dilution of precision                                                     | Node-RED GNSS parser (from GSA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `vdop`                 | *(none)* | Vertical dilution of precision                                                     | Node-RED GNSS parser (from GSA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `lat`                  | `deg`    | Latitude in decimal degrees                                                        | Node-RED GNSS parser (RMC/GGA)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `lon`                  | `deg`    | Longitude in decimal degrees                                                       | Node-RED GNSS parser (RMC/GGA)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `alt`                  | `m`      | Altitude above mean sea level                                                      | Node-RED GNSS parser (from GGA)                                             |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `speed`                | `m/s`    | Ground speed (converted from knots if needed)                                      | Node-RED GNSS parser (RMC/VTG)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `speed_kmh`            | `km/h`   | Ground speed in km/h                                                               | Node-RED GNSS parser (RMC/VTG)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `course`               | `deg`    | Course over ground                                                                 | Node-RED GNSS parser (RMC/VTG)                                              |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `gps_sats_in_view`     | *(none)* | GPS satellites in view (from GSV aggregation)                                      | Node-RED GNSS parser (GSV cycle)                                            |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `gps_snr_avg`          | `dB`     | Average SNR of GPS sats in view                                                    | Node-RED GNSS parser (GSV cycle)                                            |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `galileo_sats_in_view` | *(none)* | Galileo satellites in view (from GSV aggregation)                                  | Node-RED GNSS parser (GSV cycle)                                            |
| `barkasse/sensors`                        | `hub`        | `gnss`      | `galileo_snr_avg`      | `dB`     | Average SNR of Galileo sats in view                                                | Node-RED GNSS parser (GSV cycle)                                            |
