# Barkasse Hub — Node-RED Flows

## Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [Tab: Barkasse Hub (Haupttab)](#2-tab-barkasse-hub-haupttab)
3. [Tab: Sensor Inputs](#3-tab-sensor-inputs)
4. [Tab: Condensation Risk](#4-tab-condensation-risk)
5. [Globale Konfigurationsobjekte](#5-globale-konfigurationsobjekte)
6. [In-Memory-Datenmodell](#6-in-memory-datenmodell)
7. [InfluxDB-Anbindung](#7-influxdb-anbindung)
8. [HTTP-API-Endpunkte](#8-http-api-endpunkte)

---

## 1. Übersicht

Die Flows befinden sich in `~/.node-red/flows.json` und sind in drei Tabs organisiert:

| Tab | ID | Funktion |
|---|---|---|
| **Barkasse Hub** | `barkasse-hub` | Zentrale Datenpipeline: MQTT → Parse → Store → WebSocket/InfluxDB + HTTP-API |
| **Sensor Inputs** | `sensor-inputs` | Sensor-Datenerfassung: I²C, GNSS (NMEA), Serial, GPIO, 1-Wire, SPI |
| **Condensation Risk** | `b1c2d3e4f5a6b7c8` | Berechnung von Taupunkt und Kondensationsrisiko |

### Gemeinsame Broker-Konfigurationen

| Node ID | Name | Client-ID | Zweck |
|---|---|---|---|
| `mqtt-broker-barkasse` | Mosquitto (authenticated) | `nodered-hub` | Hauptbroker für alle Tabs |
| `mqtt_broker_cond_local` | Mosquitto (local) | `nodered-cond` | Separater Client für Condensation-Tab |
| `mqtt_broker_cond` | Mosquitto (local) | `nodered-cond2` | Zusätzlicher Client |

> **Hinweis:** Alle Broker verbinden auf `127.0.0.1:1883` (plain, localhost). Credentials werden in `flows_cred.json` verschlüsselt gespeichert.

---

## 2. Tab: Barkasse Hub (Haupttab)

Dieser Tab bildet die zentrale Datenpipeline des Systems.

### 2.1 Datenfluss-Diagramm

```
MQTT IN (barkasse/#)
    │
    ├──▶ Debug (🔍 MQTT Raw) [deaktiviert]
    │
    └──▶ Parse & expand sensors
              │
              └──▶ Update LATEST/HISTORY + broadcast
                        │
                        ├──▶ Output 1: WebSocket /ws OUT (Broadcast)
                        │         └──▶ Debug (🔍 WS Broadcast) [deaktiviert]
                        │
                        └──▶ Output 2: InfluxDB Write (sensors)


WebSocket /ws IN (Client-Verbindungen)
    │
    └──▶ Send snapshot on connect
              │
              └──▶ WebSocket /ws OUT (nur an diesen Client)


HTTP Endpoints:
    GET /history        → Build history response    → HTTP Response
    GET /debug/stats    → Build stats               → HTTP Response
    POST /history/clear → Clear history             → HTTP Response
    POST /api/manual    → Format Manual Input       → MQTT Publish / HTTP Response
    GET /history/influx → Build Flux query → InfluxDB Query → Format result → HTTP Response
```

### 2.2 Funktionsknoten im Detail

#### Parse & expand sensors (`fn-parse-expand`)

**Aufgabe:** Empfängt rohe MQTT-Payloads und normiert sie in Einzelwerte.

**Eingabe:** `msg.payload` (String oder Objekt vom MQTT-Subscriber)

**Verarbeitung:**
1. Strings werden nur dann JSON-geparst, wenn sie mit `{` oder `[` beginnen. Nicht-JSON-Strings (z.B. MQTT-LWT `online`/`offline`) werden verworfen.
2. Envelope-Format (`payload.sensors`): Wird in einzelne Nachrichten expandiert, eine pro Sensor.
3. Flache Objekte: Werden direkt weitergeleitet.

**Ausgabe:** Array von `msg`-Objekten (ein Ausgang, fan-out über Array-Return).

```javascript
// Envelope-Beispiel (Eingabe):
{ "node": "hub", "cluster": "enclosure", "ts": "...",
  "sensors": { "temperature": {"value": 28, "unit": "°C"},
               "humidity": {"value": 45, "unit": "%RH"} } }

// Expandierte Ausgabe (2 Nachrichten):
[{ payload: { node: "hub", cluster: "enclosure", sensor: "temperature", value: 28, unit: "°C", ts: "..." } },
 { payload: { node: "hub", cluster: "enclosure", sensor: "humidity", value: 45, unit: "%RH", ts: "..." } }]
```

#### Update LATEST/HISTORY + broadcast (`fn-update-store`)

**Aufgabe:** Speichert Sensorwerte im In-Memory-Store und erzeugt WebSocket- und InfluxDB-Nachrichten.

**2 Ausgänge:**
- **Output 1 → WebSocket:** `{ type: "update", data: <payload> }` (ohne `_session`, wird an alle Clients gesendet)
- **Output 2 → InfluxDB:** InfluxDB-Batch-Format mit Tags und Fields

**Verarbeitung:**
1. Timestamp-Normalisierung: Akzeptiert ISO-String, Unix-Millisekunden, Unix-Sekunden; fällt auf `Date.now()` zurück.
2. Key-Generierung: `<node>/<cluster>/<sensor||'state'>`
3. LATEST: Speichert vollständiges Payload-Objekt unter dem Key
4. HISTORY: Ring-Buffer mit max. 20.000 Einträgen pro Key. Bei Überschreitung werden älteste Einträge entfernt (`splice`).
5. InfluxDB-Nachricht: Nur wenn `value` numerisch ist.

**InfluxDB-Datenstruktur:**
```javascript
{
  measurement: "sensor",
  tags: { node, cluster, sensor, unit },
  fields: { value: <float> },
  timestamp: new Date(ts)
}
```

#### Send snapshot on connect (`fn-ws-snapshot`)

**Aufgabe:** Sendet beim WebSocket-Connect alle aktuellen Sensorwerte an den neuen Client.

**Logik:** Reagiert nur auf `msg._event === "connect"`. Liest `global.get("LATEST")` und sendet als `{ type: "snapshot", data: [...] }`. Behält `_session` bei, damit nur der verbundene Client die Nachricht erhält.

#### Build history response (`fn-history`)

**Aufgabe:** HTTP-Endpoint `GET /history` — Liefert historische Daten aus dem In-Memory-Buffer.

**Parameter:**
- `key`: Sensor-Key (Pflicht)
- `period`: `1h`, `1d`, `7d`, `30d`, `max` (Standard: `1h`)

**Logik:** Filtert `global.HISTORY[key]` nach dem Zeitfenster, gemessen relativ zum neuesten Datenpunkt im Buffer (nicht `Date.now()`).

#### Build stats (`fn-stats`)

**Aufgabe:** HTTP-Endpoint `GET /debug/stats` — Lightweight-Statistiken.

**Response:**
```json
{
  "topics": 25,             // Anzahl Keys in LATEST
  "history_topics": 20,     // Anzahl Keys in HISTORY
  "history_points_total": 150000  // Gesamtzahl Datenpunkte im Ring-Buffer
}
```

#### Clear history (`fn-clear-history`)

**Aufgabe:** HTTP-Endpoint `POST /history/clear` — Löscht In-Memory-History.

**Parameter:**
- `key` (optional): Nur diesen Sensor löschen. Ohne Key: alles löschen.

#### Format Manual Input (`fn-manual-input`)

**Aufgabe:** HTTP-Endpoint `POST /api/manual` — Ermöglicht manuelle Werterfassung.

**2 Ausgänge:**
- **Output 1 → MQTT:** Publiziert als `barkasse/sensors/<cluster>/<sensor>`
- **Output 2 → HTTP:** Bestätigung oder Fehler (400 bei ungültigem Wert)

#### Build InfluxDB Flux query (`fn-influx-query`)

**Aufgabe:** HTTP-Endpoint `GET /history/influx` — Baut Flux-Query für InfluxDB.

**Parameter:**
- `key`: Sensor-Key (Format: `node/cluster/sensor`)
- `period`: Zeitraum (z.B. `7d`, `30d`, `365d`)
- `agg`: Explizites Aggregationsintervall (optional)

**Auto-Aggregation:**

| Zeitraum | Standard-Aggregation |
|---|---|
| 1h | Keine (Rohdaten) |
| 1d | 1 Minute Mittelwert |
| 7d | 5 Minuten Mittelwert |
| 30d | 15 Minuten Mittelwert |
| 365d | 1 Stunde Mittelwert |

---

## 3. Tab: Sensor Inputs

Dieser Tab sammelt Daten von allen physischen Sensorquellen des Hubs.

### 3.1 I²C-Sensoren (AM2301B)

```
⏱ Every 10s (Inject)
    │
    └──▶ Run AM2301B script (exec)
              │
              ├──▶ stdout → MQTT Publish Enclosure (barkasse/sensors)
              └──▶ stdout → JSON parse → Debug (🔍 I2C Parsed) [deaktiviert]
```

**Exec-Befehl:**
```bash
python3 /home/hub/barkasse-hub/scripts/am2301b_read.py \
  --bus 1 --addr 0x38 --node hub --cluster enclosure
```

Das Python-Script gibt ein Envelope-JSON auf stdout aus, das direkt als MQTT-Payload verwendet wird:
```json
{
  "node": "hub",
  "cluster": "enclosure",
  "ts": "2025-10-10T12:00:00Z",
  "sensors": {
    "temperature": {"value": 28.3, "unit": "°C"},
    "humidity": {"value": 45.2, "unit": "%RH"}
  }
}
```

### 3.2 GNSS-Modul (Quectel EC25)

```
GNSS Init (Inject, once on deploy)
    │
    └──▶ Build GNSS init AT sequence
              │ ["AT+QGPSEND", "AT+QGPSCFG=\"gnssconfig\",6", "AT+QGPS=1"]
              │
              └──▶ Split AT commands → AT rate limit (2/s) → EC25 AT OUT (Serial)


EC25 NMEA IN (Serial, 115200 Baud)
    │
    └──▶ Parse NMEA → Barkasse GNSS JSON (GPS+Galileo)
              │
              └──▶ GNSS rate limit (1 msg/s, drop) → MQTT Publish GNSS (barkasse/sensors)
```

**AT-Init-Sequenz:**
1. `AT+QGPSEND` — Beendet eventuell laufende GNSS-Session
2. `AT+QGPSCFG="gnssconfig",6` — Aktiviert GPS + Galileo
3. `AT+QGPS=1` — Startet GNSS

**NMEA-Parser** (Funktionsknoten, ~180 Zeilen):
- Verarbeitet: GGA, RMC, GSA, VTG, GSV
- Unterstützt Talker: GP (GPS), GA (Galileo), GL (GLONASS), GB/BD (BeiDou), GN (Mixed)
- GSV-Zyklen werden über `context.gnss_state._gsv` aggregiert
- Heuristik für GN-Talker: SV-IDs werden nach Bereich klassifiziert (1–32 = GPS, 301–336 = Galileo, etc.)
- Throttling: Emit max. 1 Hz, außer bei Statusänderungen (`fix_valid`, `fix_quality`, `fix_type`, GSV-Zyklusende)

**Serielle Ports:**
- AT-Kommando-Port: `/dev/serial/by-id/usb-Quectel_EC25-EUX_...-if02-port0` (115200 Baud)
- NMEA-Input-Port: `/dev/serial/by-id/usb-Quectel_EC25-EUX_...-if01-port0` (115200 Baud)

### 3.3 Vorbereitete Sektionen (Platzhalter)

| Sektion | Status | Hinweise |
|---|---|---|
| Serial/UART Sensors | Platzhalter | GPS, NMEA-Geräte |
| GPIO Sensors | Platzhalter | Buttons, Schalter |
| 1-Wire Sensors | Platzhalter | DS18B20 Temperatursonden |
| SPI Bus Sensors | Platzhalter | ADCs (`/dev/spidev0.1`) |

---

## 4. Tab: Condensation Risk

Berechnet das Kondensationsrisiko aus Innen-/Außentemperatur und Luftfeuchtigkeit.

### 4.1 Datenfluss

```
⚙️ Config (Inject, once on deploy)
    │
    └──▶ Set flow config (speichert in flow.cond_cfg)


MQTT IN (barkasse/#)
    │
    └──▶ Parse & expand sensors (Envelope + Per-Topic)
              │
              └──▶ Select inputs + store latest
                        │ (filtert auf konfigurierte Cluster/Sensoren,
                        │  prüft Aktualität, sammelt tin/rh/tout)
                        │
                        └──▶ Surface temp = (outside + inside) / 2
                                  │
                                  └──▶ Dew point (Magnus)
                                            │
                                            └──▶ Risk + build publish envelope
                                                      │
                                                      └──▶ Rate limit (1 msg/s)
                                                                │
                                                                ├──▶ MQTT OUT (barkasse/sensors)
                                                                └──▶ Debug (Condensation risk %)
```

### 4.2 Konfiguration

Die Konfiguration wird durch einen Inject-Knoten beim Deploy geladen:

```json
{
  "inside_cluster": "enclosure",
  "inside_temp_sensor": "temperature",
  "inside_rh_sensor": "humidity",
  "outside_cluster": "weather",
  "outside_temp_sensor": "temperature",
  "stale_s": 600,
  "min_rh_pct": 1,
  "risk_low_delta_c": -2,
  "risk_high_delta_c": 2,
  "output_node": "hub",
  "output_cluster": "enclosure",
  "publish_topic": "barkasse/sensors"
}
```

| Parameter | Typ | Beschreibung |
|---|---|---|
| `inside_cluster` | string | Cluster mit Innentemperatur und Feuchte |
| `inside_temp_sensor` | string | Sensor-Name für Innentemperatur |
| `inside_rh_sensor` | string | Sensor-Name für Innenluftfeuchtigkeit |
| `outside_cluster` | string | Cluster mit Außentemperatur |
| `outside_temp_sensor` | string | Sensor-Name für Außentemperatur |
| `stale_s` | number | Maximales Alter der Eingangswerte in Sekunden (Standard: 600 = 10 min) |
| `min_rh_pct` | number | Minimale RH für Taupunktberechnung (verhindert `ln(0)`) |
| `risk_low_delta_c` | number | Delta (°C) bei dem Risiko 0% wird |
| `risk_high_delta_c` | number | Delta (°C) bei dem Risiko 100% wird |
| `output_node` | string | Node-Feld im Output-Envelope |
| `output_cluster` | string | Cluster-Feld im Output-Envelope |
| `publish_topic` | string | MQTT-Topic für die Ausgabe |

### 4.3 Berechnung

**Oberflächentemperatur-Schätzung:**

$$T_{surface} = \frac{T_{inside} + T_{outside}}{2}$$

**Taupunkt (Magnus-Formel):**

$$\gamma = \ln\left(\frac{RH}{100}\right) + \frac{a \cdot T}{b + T}$$

$$T_d = \frac{b \cdot \gamma}{a - \gamma}$$

Konstanten:
- Wasser ($T \geq 0°C$): $a = 17.62$, $b = 243.12$
- Eis ($T < 0°C$): $a = 22.46$, $b = 272.62$

**Risiko-Mapping:**

$$\delta = T_d - T_{surface}$$

$$risk = \frac{\delta - \delta_{low}}{\delta_{high} - \delta_{low}} \times 100\%$$

Geclampt auf $[0\%, 100\%]$. Boolean-Flag: `condensation = 1` wenn $T_{surface} \leq T_d$.

### 4.4 Staleness-Prüfung

Vor jeder Berechnung wird geprüft, ob alle drei Eingangswerte (`tin`, `rh`, `tout`) innerhalb des konfigurierten `stale_s`-Fensters liegen. Ist ein Wert zu alt, wird keine Berechnung durchgeführt und keine Nachricht publiziert.

---

## 5. Globale Konfigurationsobjekte

### MQTT-Broker

| Eigenschaft | Wert |
|---|---|
| Host | `127.0.0.1` |
| Port | `1883` |
| Protokoll | MQTT v4 |
| Keepalive | 60s |
| Clean Session | true |
| TLS | Nein (localhost) |

### WebSocket-Listener

| Eigenschaft | Wert |
|---|---|
| Pfad | `/ws` |
| Nachrichtenmodus | Nicht-whole-message (`wholemsg: false`) |

### settings.js (Auszug)

```javascript
{
  flowFile: 'flows.json',
  uiPort: 8443,                    // HTTPS (8080 ohne TLS)
  https: httpsOptions,             // TLS-Zertifikate
  httpAdminRoot: '/admin',         // Node-RED Editor
  httpNodeRoot: '/',               // HTTP-In-Nodes
  httpStatic: '.../barkasse-hub/ui', // Statische UI-Dateien
  contextStorage: {
    default: { module: "localfilesystem", config: { flushInterval: 30 } },
    memory: { module: "memory" }
  }
}
```

---

## 6. In-Memory-Datenmodell

### global.LATEST

```javascript
// Map: Key → vollständiges Sensor-Payload-Objekt
{
  "hub/enclosure/temperature": { node: "hub", cluster: "enclosure", sensor: "temperature", value: 28.3, unit: "°C", ts: "..." },
  "esp32p4-01/weather/pressure": { ... },
  // ...
}
```

### global.HISTORY

```javascript
// Map: Key → Array von {ts, value, unit}
// Ring-Buffer: max. 20.000 Einträge pro Key
{
  "hub/enclosure/temperature": [
    { ts: "2025-10-10T11:00:00Z", value: 27.1, unit: "°C" },
    { ts: "2025-10-10T11:00:10Z", value: 27.2, unit: "°C" },
    // ... bis zu 20.000 Einträge
  ],
  // ...
}
```

### Persistenz

- In-Memory-Daten werden über Node-RED Context Storage (`localfilesystem`) periodisch auf Disk geschrieben (alle 30 Sekunden).
- Dadurch überleben LATEST und HISTORY einen Node-RED-Neustart.
- Zusätzlich werden alle numerischen Werte in InfluxDB geschrieben (unbegrenzte Retention).

---

## 7. InfluxDB-Anbindung

### Schreibpfad

```
Update LATEST/HISTORY (Output 2) → InfluxDB Batch Write
```

**Measurement:** `sensor`

**Tags:** `node`, `cluster`, `sensor`, `unit`

**Fields:** `value` (float)

**Timestamp:** Original-Sensor-Zeitstempel (ms-Präzision)

### Lesepfad

```
GET /history/influx → Flux Query Builder → InfluxDB In → Format Result → HTTP Response
```

**Flux-Query-Template:**
```flux
from(bucket: "sensors")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "sensor")
  |> filter(fn: (r) => r.node == "hub")
  |> filter(fn: (r) => r.cluster == "enclosure")
  |> filter(fn: (r) => r.sensor == "temperature")
  |> filter(fn: (r) => r._field == "value")
  |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
  |> sort(columns: ["_time"])
```

### InfluxDB-Konfiguration

| Eigenschaft | Wert |
|---|---|
| Host | `127.0.0.1:8086` |
| Protokoll | HTTP (kein TLS, nur localhost) |
| Version | 2.0 |
| Organisation | `barkasse` |
| Bucket | `sensors` |
| Retention | Unbegrenzt (Standard) |

---

## 8. HTTP-API-Endpunkte

| Endpunkt | Methode | Beschreibung |
|---|---|---|
| `/history` | GET | In-Memory-Historiendaten |
| `/history/influx` | GET | InfluxDB-Langzeitdaten |
| `/history/clear` | POST | History löschen (einzeln oder komplett) |
| `/api/manual` | POST | Manuellen Sensorwert einspeisen |
| `/debug/stats` | GET | Lightweight-Statistiken |

### GET /history

```
GET /history?key=hub/enclosure/temperature&period=1h
```

Response:
```json
{
  "key": "hub/enclosure/temperature",
  "unit": "°C",
  "data": [
    {"ts": "2025-10-10T11:00:00Z", "value": 27.1, "unit": "°C"},
    {"ts": "2025-10-10T11:00:10Z", "value": 27.2, "unit": "°C"}
  ],
  "source": "memory"
}
```

### GET /history/influx

```
GET /history/influx?key=hub/enclosure/temperature&period=7d&agg=5m
```

Response:
```json
{
  "key": "hub/enclosure/temperature",
  "unit": "°C",
  "data": [
    {"ts": "2025-10-03T12:00:00Z", "value": 26.8, "unit": "°C"},
    {"ts": "2025-10-03T12:05:00Z", "value": 26.9, "unit": "°C"}
  ],
  "source": "influxdb",
  "period": "7d"
}
```

### POST /api/manual

```
POST /api/manual
Content-Type: application/json

{"node": "manual", "cluster": "kitchen", "sensor": "temperature", "value": 22.5, "unit": "°C"}
```

Response (200):
```json
{"ok": true, "data": {"node": "manual", "cluster": "kitchen", "sensor": "temperature", "value": 22.5, "unit": "°C", "ts": "..."}}
```

Response (400, ungültiger Wert):
```json
{"error": "Invalid value"}
```
