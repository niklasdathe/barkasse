# Barkasse Hub — Systemübersicht

## Inhaltsverzeichnis

1. [Projektbeschreibung](#1-projektbeschreibung)
2. [Hardware-Plattform](#2-hardware-plattform)
3. [Software-Stack](#3-software-stack)
4. [Systemarchitektur](#4-systemarchitektur)
5. [Datenfluss](#5-datenfluss)
6. [MQTT-Topic-Schema](#6-mqtt-topic-schema)
7. [JSON-Payload-Format](#7-json-payload-format)
8. [Sensor-Key-Schema](#8-sensor-key-schema)
9. [Vollständige Topic-Referenz](#9-vollständige-topic-referenz)
10. [Port-Übersicht](#10-port-übersicht)

---

## 1. Projektbeschreibung

Das Barkasse-Hub-System ist eine Sensor-Infrastruktur zur Echtzeit-Erfassung, -Verarbeitung und -Visualisierung von Umgebungsdaten auf einer Barkasse (Motorboot). Das System besteht aus:

- **Sensor-Knoten** (ESP32-basiert), die per Ethernet/PoE oder WiFi Messwerte über MQTT publizieren
- **Einem zentralen Hub** (Raspberry Pi / Seeed reTerminal DM), der Daten empfängt, verarbeitet, speichert und auf einem 10-Zoll-Touchscreen visualisiert
- **Berechneten Sensoren** (z.B. Kondensationsrisiko), die aus physikalischen Rohdaten abgeleitet werden

Das System ist für den autonomen Betrieb ohne permanente Internetverbindung ausgelegt. Alle kritischen Dienste (MQTT, NTP, DHCP) laufen lokal auf dem Hub.

---

## 2. Hardware-Plattform

### Hub

| Komponente | Beschreibung |
|---|---|
| **SBC** | Seeed reTerminal DM (Raspberry Pi CM4, 4 GB RAM, 32 GB eMMC) |
| **Display** | Integrierter 10,1" IPS-Touchscreen (1280×800) |
| **RTC** | Batteriegepufferte Echtzeituhr (CR2032) |
| **Mobilfunk** | Quectel EC25-EUX LTE-Modem (USB, ECM-Mode → `usb0`) |
| **GNSS** | Quectel EC25 integrierter GNSS-Empfänger (GPS + Galileo) |
| **I²C-Sensoren** | AM2301B (Temperatur + Luftfeuchtigkeit) auf Bus 1, Adresse 0x38 |
| **Ethernet** | Integrierter RJ45 für isoliertes Sensor-LAN |
| **Serielle Ports** | `/dev/ttyUSB0-3` (Quectel EC25), `/dev/ttyACM0-1`, `/dev/ttyAMA0` |

### Sensor-Knoten (Beispiel-Implementierungen)

| Knoten | MCU | Anbindung | Sensoren |
|---|---|---|---|
| ESP32-P4 Weatherstation | ESP32-P4 | Ethernet (RMII/PoE) | Temperatur, Feuchte, Druck, Wind |
| ESP32 WROOM Waterstation | ESP32 WROOM | WiFi | Wassertemperatur, pH, Trübung, Leitfähigkeit, Pegel |

---

## 3. Software-Stack

```
┌────────────────────────────────────────────────────────────────┐
│                    Barkasse Hub (Raspberry Pi OS)              │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Mosquitto   │  │   Node-RED   │  │   InfluxDB 2.x       │  │
│  │  MQTT Broker │→ │  Flow Engine │→ │   Zeitreihenspeicher │  │
│  │  :1883/:8883 │  │  :8443       │  │   :8086 (localhost)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘  │
│         │                 │                                    │
│         │     ┌───────────┴────────────────┐                   │
│         │     │  Statische UI (ui/)        │                   │
│         │     │  WebSocket /ws             │                   │
│         │     │  REST API (/history, etc.) │                   │
│         │     └────────────┬───────────────┘                   │
│         │                  │                                   │
│  ┌──────┴──────────────────┴─────────────────────────────┐     │
│  │  Chromium (Vollbild, --start-fullscreen)              │     │
│  │  https://localhost:8443/                              │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐                │
│  │  chrony   │  │  dnsmasq  │  │  Tailscale   │                │
│  │  NTP-Srv  │  │  DHCP-Srv │  │  VPN-Zugang  │                │
│  └───────────┘  └───────────┘  └──────────────┘                │
└────────────────────────────────────────────────────────────────┘
```

### Dienste und ihre Rollen

| Dienst | Version | Rolle |
|---|---|---|
| **Mosquitto** | 2.x | MQTT-Broker: empfängt Sensordaten, leitet an Node-RED weiter |
| **Node-RED** | 4.x | Flow-basierte Verarbeitungsengine: MQTT-Subscription, Datenparsing, WebSocket-Broadcast, HTTP-API, InfluxDB-Schreiber |
| **InfluxDB** | 2.x | Persistente Zeitreihendatenbank auf eMMC |
| **Chromium** | 109+ | Kiosk-Browser für die Touchscreen-UI |
| **chrony** | — | NTP-Client (über LTE) + NTP-Server (für Sensor-LAN) |
| **dnsmasq** | — | DHCP-Server für das isolierte Sensor-LAN |
| **Tailscale** | — | WireGuard-basierter VPN-Zugang für Fernwartung |

### Node-RED-Pakete

| Paket | Zweck |
|---|---|
| `node-red-node-serialport` | Serielle Kommunikation (GNSS-NMEA, AT-Commands) |
| `node-red-contrib-influxdb` | InfluxDB 2.x Lesen/Schreiben |
| `node-red-contrib-i2c` | I²C-Bus-Zugriff (installiert, nicht primär genutzt) |
| `node-red-contrib-modbus` | Modbus-Protokoll (vorbereitet) |
| `node-red-contrib-reterminal-dm` | reTerminal-DM-spezifische Nodes |
| `bcryptjs` | Passwort-Hashing für adminAuth |

---

## 4. Systemarchitektur

```
  Sensor-Knoten (ESP32)              Hub (Raspberry Pi / reTerminal DM)
  ┌───────────────────┐              ┌──────────────────────────────────────────────┐
  │                   │              │                                              │
  │  Temperatur       │  MQTT/TLS    │  Mosquitto                                   │
  │  Feuchte          │────8883───▶  │    ├── :1883 (localhost, plain, für Node-RED)│
  │  Druck            │              │    └── :8883 (LAN, TLS + Auth)               │
  │  Wind             │              │         │                                    │
  │  Wasser           │              │         ▼                                    │
  │  ...              │              │  Node-RED                                    │
  └───────────────────┘              │    ├── MQTT Sub (barkasse/#)                 │
                                     │    ├── Parse & Expand                        │
  I²C-Sensor (AM2301B)               │    ├── LATEST / HISTORY (In-Memory)          │
  ┌───────────────────┐              │    ├── InfluxDB Write (persistent)           │
  │  Temperatur       │  I²C Bus 1   │    ├── WebSocket Broadcast (/ws)             │
  │  Feuchte          │────────────▶ │    ├── HTTP API (/history, /api/manual)      │
  └───────────────────┘  (am2301b    │    └── Kondensationsrisiko-Berechnung        │
                          _read.py)  │         │                                    │
                                     │         ▼                                    │
  GNSS (EC25 NMEA)                   │  Statische UI (ui/)                          │
  ┌───────────────────┐  Serial      │    ├── index.html                            │
  │  Position         │────────────▶ │    ├── styles.css                            │
  │  Geschwindigkeit  │              │    └── app.js                                │
  │  Satelliten       │              │         │                                    │
  └───────────────────┘              │         ▼                                    │
                                     │  Chromium (Vollbild)                         │
                                     │    https://localhost:8443/                   │
                                     └──────────────────────────────────────────────┘
```

---

## 5. Datenfluss

### Primärer Pfad: Sensor → Anzeige

```
1. Sensor-Knoten publiziert JSON auf MQTT-Topic (z.B. barkasse/sensors)
2. Mosquitto leitet an alle Subscriber weiter
3. Node-RED "MQTT IN barkasse/#" empfängt Nachricht
4. "Parse & expand sensors" extrahiert Einzelwerte aus Envelope-Format
5. "Update LATEST/HISTORY + broadcast":
   a) Speichert in global.LATEST (letzte Werte aller Sensoren)
   b) Speichert in global.HISTORY (Ring-Buffer, max. 20.000 Punkte/Sensor)
   c) Schreibt in InfluxDB (persistente Langzeitspeicherung)
   d) Sendet WebSocket-Broadcast an alle verbundenen Clients
6. Browser empfängt WebSocket-Update:
   a) Aktualisiert store (Map)
   b) Erstellt/aktualisiert Sensor-Kachel im DOM
   c) Aktualisiert Status-LED (grün/gelb/rot)
   d) Aktualisiert Graph falls betroffener Sensor angezeigt wird
```

### Sekundärer Pfad: Client-Verbindung (Snapshot)

```
1. Browser verbindet sich per WebSocket zu /ws
2. Node-RED erkennt "connect"-Event
3. Sendet snapshot mit allen LATEST-Werten an diesen Client
4. Browser erstellt Kacheln für alle bekannten Sensoren
5. Ab da: laufende Updates über den primären Pfad
```

### Tertiärer Pfad: Historische Daten

```
1. Benutzer zieht Sensor-Kachel auf Graph-Bereich (Drag & Drop)
2. Browser sendet HTTP GET /history?key=node/cluster/sensor&period=1h
3. Node-RED liest aus global.HISTORY (In-Memory-Ring-Buffer)
4. Alternativ: GET /history/influx?key=...&period=7d für Langzeitdaten aus InfluxDB
5. Browser rendert Daten als Canvas-Diagramm
```

---

## 6. MQTT-Topic-Schema

### Allgemeines Schema

```
barkasse/<subtopic>
```

Alle Sensor-Daten liegen unter dem Präfix `barkasse/`. Node-RED abonniert `barkasse/#`.

### Topic-Muster

| Muster | Beschreibung | Beispiel |
|---|---|---|
| `barkasse/sensors` | Hub-eigene Sensoren (I²C, GNSS, berechnete Werte) als Envelope | Enclosure-Temperatur, GNSS-Position |
| `barkasse/<node>/<cluster>/<sensor>` | Einzeltopic pro Sensor (ESP32-Knoten) | `barkasse/esp32p4-01/weather/temperature` |
| `barkasse/<node>/<cluster>/state` | Cluster-Zusammenfassung (Envelope mit `sensors`-Map) | `barkasse/esp32p4-01/weather/state` |
| `barkasse/<node>/net/presence` | DHCP-basierte Netzwerk-Präsenz | `barkasse/esp32p4-01/net/presence` |

---

## 7. JSON-Payload-Format

### Einzelwert-Format

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

### Envelope-Format (Sensoren-Map)

Wird bevorzugt für Hub-eigene Sensoren und Cluster-Zusammenfassungen verwendet. Ein einzelnes JSON-Objekt enthält mehrere Sensorwerte:

```json
{
  "node": "hub",
  "cluster": "enclosure",
  "ts": "2025-10-10T12:00:00Z",
  "sensors": {
    "temperature": { "value": 28.3, "unit": "°C" },
    "humidity":    { "value": 45.2, "unit": "%RH" }
  }
}
```

Der Node-RED-Knoten „Parse & expand sensors" zerlegt dieses Envelope-Format in Einzelwerte, sodass die weitere Verarbeitung einheitlich stattfindet.

### Felder

| Feld | Typ | Beschreibung |
|---|---|---|
| `node` | string | Identifikation des physischen Geräts (z.B. `hub`, `esp32p4-01`) |
| `cluster` | string | Logische Gruppierung von Sensoren (z.B. `weather`, `enclosure`, `gnss`) |
| `sensor` | string | Name des einzelnen Sensors (z.B. `temperature`, `humidity`) |
| `value` | number | Messwert |
| `unit` | string | Einheit (z.B. `°C`, `%RH`, `hPa`, `m/s`) |
| `ts` | string (ISO 8601) | Zeitstempel im UTC-Format mit `Z`-Suffix |
| `sensors` | object | (Nur Envelope) Map von Sensornamen auf `{value, unit}` |

---

## 8. Sensor-Key-Schema

Jeder Sensor wird intern über einen eindeutigen **Key** identifiziert:

```
Format:   <node>/<cluster>/<sensor>
Beispiel: esp32p4-01/weather/temperature
Fallback: esp32p4-01/weather/state   (wenn sensor fehlt)
```

Dieser Key wird verwendet in:
- **Node-RED**: global.LATEST und global.HISTORY als Schlüssel
- **Browser**: `store`-Map, Kachel-`data-k`-Attribut, Graph-Zuordnung
- **HTTP-API**: `?key=`-Parameter für `/history` und `/history/influx`

---

## 9. Vollständige Topic-Referenz

### ESP32-P4 Wetterstation (Mock)

| Key | Sensor | Einheit | Beschreibung |
|---|---|---|---|
| `esp32p4-01/weather/temperature` | temperature | °C | Außentemperatur |
| `esp32p4-01/weather/humidity` | humidity | % | Relative Luftfeuchtigkeit |
| `esp32p4-01/weather/pressure` | pressure | hPa | Luftdruck |
| `esp32p4-01/weather/wind_speed` | wind_speed | m/s | Windgeschwindigkeit |
| `esp32p4-01/weather/wind_dir` | wind_dir | ° | Windrichtung (0–360°) |

### ESP32 WROOM Wasserstation (Mock)

| Key | Sensor | Einheit | Beschreibung |
|---|---|---|---|
| `esp32wifi-01/water/water_temp` | water_temp | °C | Wassertemperatur |
| `esp32wifi-01/water/ph` | ph | pH | pH-Wert |
| `esp32wifi-01/water/turbidity` | turbidity | NTU | Trübung |
| `esp32wifi-01/water/conductivity` | conductivity | µS/cm | Leitfähigkeit |
| `esp32wifi-01/water/water_level` | water_level | cm | Wasserstand |

### Hub — Gehäuse (I²C AM2301B)

| Key | Sensor | Einheit | Beschreibung |
|---|---|---|---|
| `hub/enclosure/temperature` | temperature | °C | Gehäuse-Innentemperatur |
| `hub/enclosure/humidity` | humidity | %RH | Gehäuse-Luftfeuchtigkeit |

### Hub — Kondensationsrisiko (berechnet)

| Key | Sensor | Einheit | Beschreibung |
|---|---|---|---|
| `hub/enclosure/surface_temp` | surface_temp | °C | Geschätzte Oberflächentemperatur |
| `hub/enclosure/dew_point` | dew_point | °C | Taupunkt (Magnus-Formel) |
| `hub/enclosure/condensation_delta` | condensation_delta | °C | Differenz Taupunkt − Oberflächentemperatur |
| `hub/enclosure/condensation_risk` | condensation_risk | % | Kondensationsrisiko (0–100%) |
| `hub/enclosure/condensation` | condensation | — | Boolean-Flag (0 oder 1) |

### Hub — GNSS (Quectel EC25)

| Key | Sensor | Einheit | Beschreibung |
|---|---|---|---|
| `hub/gnss/fix_valid` | fix_valid | — | RMC-Gültigkeit (A=1, V=0) |
| `hub/gnss/fix_quality` | fix_quality | — | GGA-Fix-Qualität (0=kein Fix, 1=GPS, 2=DGPS) |
| `hub/gnss/fix_type` | fix_type | — | GSA-Fix-Typ (1=kein Fix, 2=2D, 3=3D) |
| `hub/gnss/sats_used` | sats_used | — | Genutzte Satelliten |
| `hub/gnss/hdop` | hdop | — | Horizontal Dilution of Precision |
| `hub/gnss/pdop` | pdop | — | Position Dilution of Precision |
| `hub/gnss/vdop` | vdop | — | Vertical Dilution of Precision |
| `hub/gnss/lat` | lat | deg | Breitengrad (Dezimalgrad) |
| `hub/gnss/lon` | lon | deg | Längengrad (Dezimalgrad) |
| `hub/gnss/alt` | alt | m | Höhe über Meeresniveau |
| `hub/gnss/speed` | speed | m/s | Geschwindigkeit über Grund |
| `hub/gnss/speed_kmh` | speed_kmh | km/h | Geschwindigkeit in km/h |
| `hub/gnss/course` | course | deg | Kurs über Grund |
| `hub/gnss/gps_sats_in_view` | gps_sats_in_view | — | GPS-Satelliten in Sicht |
| `hub/gnss/gps_snr_avg` | gps_snr_avg | dB | Mittleres GPS-SNR |
| `hub/gnss/galileo_sats_in_view` | galileo_sats_in_view | — | Galileo-Satelliten in Sicht |
| `hub/gnss/galileo_snr_avg` | galileo_snr_avg | dB | Mittleres Galileo-SNR |

---

## 10. Port-Übersicht

| Port | Protokoll | Bindung | Dienst | Zugang |
|---|---|---|---|---|
| 1883 | MQTT (plain) | `127.0.0.1` | Mosquitto | Nur localhost (Node-RED, lokale Scripts) |
| 8883 | MQTTS (TLS) | `0.0.0.0` | Mosquitto | LAN-Sensoren (mit Passwort-Authentifizierung) |
| 8443 | HTTPS | `0.0.0.0` | Node-RED | UI + API + Editor + Chromium-Kiosk |
| 8086 | HTTP | `127.0.0.1` | InfluxDB | Nur localhost (Node-RED Queries) |
| 123/udp | NTP | `0.0.0.0` (firewall-geschützt) | chrony | Sensor-LAN (`eth0`) + Tailscale |

> **Hinweis:** Im Basis-Deployment (ohne `setup-security.sh`) läuft Node-RED auf Port 8080 statt 8443, ohne TLS.
