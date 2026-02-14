# Barkasse Hub — Technische Dokumentation

Dieses Verzeichnis enthält die vollständige technische Dokumentation des Barkasse-Hub-Projekts.

## Dokumentenübersicht

| Dokument | Inhalt |
|----------|--------|
| [Systemübersicht](systemuebersicht.md) | Architektur, Hardware, Software-Stack, Datenfluss, MQTT-Schema |
| [Node-RED Flows](nodered_flows.md) | Alle Tabs, Funktionsknoten, Daten-Pipeline, InfluxDB-Anbindung |
| [UI-Architektur](ui_architektur.md) | Frontend-Aufbau, WebSocket-Protokoll, Drag&Drop, Canvas-Graphen |
| [Sensor-Anbindung](sensor_anbindung.md) | I²C (AM2301B), GNSS (EC25 NMEA), Kondensationsrisiko, ESP32-Mocks |
| [Deployment & Betrieb](deployment.md) | Native Installation, systemd-Services, Plymouth, Chromium-Kiosk |
| [Netzwerk & Konnektivität](netzwerk.md) | LAN-Coordinator (DHCP/NTP), LTE (Quectel EC25), Tailscale, DNS |
| [Sicherheit & Persistenz](sicherheit.md) | TLS, MQTT-Auth, Node-RED adminAuth, InfluxDB, Zertifikate, Firewall |

## Projektstruktur

```
barkasse-hub/
├── docs/                        ← Diese Dokumentation
├── ui/                          ← Frontend (HTML + CSS + JS, kein Build-Schritt)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── assets/background.png
├── scripts/                     ← Setup- und Hilfs-Skripte
│   ├── deploy-native.sh
│   ├── enable-system-services.sh
│   ├── setup-security.sh
│   ├── setup-lan-coordinator.sh
│   ├── barkasse-dhcp-mqtt-hook.sh
│   └── am2301b_read.py
├── mosquitto/                   ← Mosquitto-Konfiguration
│   ├── mosquitto.conf
│   └── passwd                   (nicht im Git)
├── certs/                       ← TLS-Zertifikate (nicht im Git)
├── systemd/                     ← systemd-Service-Units
│   ├── barkasse-ui.service
│   └── barkasse-fullscreen.service
├── plymouth/                    ← Boot-Splash-Theme
│   └── barkasse/
├── example-sensor-implementations/
│   ├── esp32p4-weatherstation-mock/   ← ESP32-P4 Ethernet-Demo
│   └── esp32-wroom-waterstation-mock/ ← ESP32 WROOM WiFi-Demo
├── README.md
└── TODO.md
```

## Schnellstart

```bash
# 1. Repository klonen
git clone <repo-url> /home/hub/barkasse-hub

# 2. Basis-Deployment (Mosquitto + Node-RED + systemd)
cd /home/hub/barkasse-hub
./scripts/deploy-native.sh

# 3. Optional: Sicherheit (TLS + Auth + InfluxDB)
./scripts/setup-security.sh

# 4. Optional: LAN-Coordinator (DHCP + NTP für isoliertes Netz)
BARKASSE_LAN_IFACE=eth0 ./scripts/setup-lan-coordinator.sh
```
