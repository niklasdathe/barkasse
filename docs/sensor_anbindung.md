# Barkasse Hub — Sensor-Anbindung

## Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [AM2301B — I²C Temperatur & Feuchte](#2-am2301b--ic-temperatur--feuchte)
3. [GNSS — Quectel EC25-EUX](#3-gnss--quectel-ec25-eux)
4. [Kondensationsrisiko (berechnet)](#4-kondensationsrisiko-berechnet)
5. [ESP32-P4 — Ethernet-Sensorknoten](#5-esp32-p4--ethernet-sensorknoten)
6. [ESP32 WROOM — WiFi-Sensorknoten](#6-esp32-wroom--wifi-sensorknoten)
7. [Eigene Sensoren hinzufügen](#7-eigene-sensoren-hinzufügen)

---

## 1. Übersicht

Das System unterstützt Sensoren über verschiedene Transportwege:

| Typ | Transport | Beispiel | Anbindung |
|---|---|---|---|
| Lokal (I²C) | I²C-Bus 1 | AM2301B | Python-Script via Node-RED exec |
| Lokal (Serial) | UART/USB | Quectel EC25 GNSS | Node-RED serial-port |
| Berechnet | — | Kondensationsrisiko | Node-RED function |
| Remote (Ethernet) | MQTT über LAN | ESP32-P4 | MQTT publish → Broker |
| Remote (WiFi) | MQTT über WLAN | ESP32 WROOM | MQTT publish → Broker |

Alle Sensordaten münden in den MQTT-Broker (`barkasse/#`) und werden von der zentralen Pipeline (Tab "Barkasse Hub") verarbeitet.

---

## 2. AM2301B — I²C Temperatur & Feuchte

### Hardware

| Eigenschaft | Wert |
|---|---|
| Sensor | AM2301B (AHT20-kompatibler IC) |
| Bus | I²C-1 (`/dev/i2c-1`) |
| Adresse | `0x38` |
| Messbereich Temperatur | -40 bis +85 °C |
| Messbereich Feuchte | 0–100 %RH |
| Genauigkeit | ±0.3 °C, ±2 %RH |
| Versorgung | 3.3V |

### Python-Script: `scripts/am2301b_read.py`

**Aufruf:**
```bash
python3 scripts/am2301b_read.py --bus 1 --addr 0x38 --node hub --cluster enclosure
```

**CLI-Parameter:**

| Parameter | Standard | Beschreibung |
|---|---|---|
| `--bus` | `1` | I²C-Bus-Nummer |
| `--addr` | `0x38` | I²C-Geräteadresse (hex) |
| `--node` | `hub` | Node-Feld im Output |
| `--cluster` | `enclosure` | Cluster-Feld im Output |
| `--wait-ms` | `80` | Wartezeit nach Measurement-Trigger |
| `--poll-ms` | `10` | Polling-Intervall für Busy-Check |
| `--round` | `1` | Nachkommastellen im Output |

### Messablauf

```
1. Status-Check
   └── i2ctransfer -y 1 r1@0x38
       └── Bit 3 (cal) muss gesetzt sein, sonst Warnung

2. Measurement-Trigger
   └── i2ctransfer -y 1 w3@0x38 0xAC 0x33 0x00

3. Warten (80 ms Standard)

4. Busy-Polling
   └── i2ctransfer -y 1 r1@0x38
       └── Bit 7 prüfen: 1 = busy → weiter pollen
                          0 = fertig → weiter

5. Rohdaten lesen (7 Bytes)
   └── i2ctransfer -y 1 r7@0x38
       └── [status, hum_hi, hum_mid, hum_lo|temp_hi, temp_mid, temp_lo, crc]

6. CRC8-Verifizierung
   └── Polynom: x⁸ + x⁵ + x⁴ + 1 (0x31), Init: 0xFF

7. Konvertierung
   └── humidity = (raw_20bit / 2²⁰) × 100
       temperature = (raw_20bit / 2²⁰) × 200 − 50
```

### CRC8-Implementierung

```python
def crc8(data, poly=0x31, init=0xFF):
    crc = init
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ poly) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc
```

Das CRC wird über die 6 Datenbytes (ohne CRC-Byte) berechnet und gegen das 7. Byte geprüft. Bei Mismatch wird auf stderr gewarnt, aber die Daten trotzdem ausgegeben.

### Output-Format

```json
{
  "node": "hub",
  "cluster": "enclosure",
  "ts": "2025-10-10T12:00:00.123456+00:00",
  "sensors": {
    "temperature": { "value": 28.3, "unit": "°C" },
    "humidity": { "value": 45.2, "unit": "%RH" }
  }
}
```

### Node-RED-Integration

In Tab "Sensor Inputs":
- **Inject** every 10s → **exec** `python3 am2301b_read.py ...` → stdout wird direkt als MQTT-Payload auf `barkasse/sensors` publiziert.

---

## 3. GNSS — Quectel EC25-EUX

### Hardware

| Eigenschaft | Wert |
|---|---|
| Modem | Quectel EC25-EUX (LTE Cat 4 + GNSS) |
| Anbindung | USB (CDC-ACM / ECM) |
| GNSS-Konstellationen | GPS, Galileo, GLONASS, BeiDou |
| AT-Port | `/dev/ttyUSB2` oder `/dev/serial/by-id/...-if02-port0` |
| NMEA-Port | `/dev/ttyUSB1` oder `/dev/serial/by-id/...-if01-port0` |
| Baudrate | 115.200 |

### Initialisierung

AT-Kommandos beim Deploy (einmalig):

```
AT+QGPSEND              ← Laufende GNSS-Session beenden
AT+QGPSCFG="gnssconfig",6  ← GPS + Galileo aktivieren (Bitmask: GPS=1 + Galileo=4 + GLONASS=2 ≠ hier: GPS+Galileo=5 ... konfigurierbar)
AT+QGPS=1               ← GNSS starten
```

Die Befehle werden per `split`-Node einzeln und über einen Rate-Limiter (max 2/s) zum seriellen Port gesendet.

### NMEA-Parser (Funktionsknoten)

Der Parser verarbeitet ~180 Zeilen und unterstützt folgende Sentence-Typen:

| Sentence | Talker | Daten |
|---|---|---|
| **GGA** | GP, GA, GN | Fix-Qualität, Position, Höhe, HDOP, Satelliten |
| **RMC** | GP, GA, GN | Geschwindigkeit (Knoten), Kurs, Datum, Fix-Validity |
| **GSA** | GP, GA, GN | Fix-Typ (2D/3D), PDOP, HDOP, VDOP |
| **VTG** | GP, GA, GN | Geschwindigkeit (km/h + Knoten), Kurs |
| **GSV** | GP, GA, GL, GB/BD | Sichtbare Satelliten pro Konstellation |

### Talker-ID-Klassifikation

| Talker | Konstellation | SV-ID-Bereich (GN-Heuristik) |
|---|---|---|
| GP | GPS | 1–32 |
| GA | Galileo | 301–336 |
| GL | GLONASS | 65–96 |
| GB / BD | BeiDou | 201–263 |
| GN | Mixed | Per SV-ID klassifiziert |

Bei `GN`-Talker (gemischte Meldungen) werden SV-IDs anhand ihrer Nummernbereiche den Konstellationen zugeordnet.

### GSV-Aggregation

GSV-Sentences kommen in Zyklen (z.B. 3 von 3). Der Parser speichert Zwischenergebnisse im Node-Context (`context.gnss_state._gsv`) und emittiert erst nach Abschluss eines vollständigen Zyklus.

### Throttling

- Standard-Emit: Max. 1 Hz (1 Nachricht pro Sekunde)
- Sofortiges Emit bei Statusänderungen: `fix_valid`, `fix_quality`, `fix_type` oder GSV-Zyklusende

### Output-Format

```json
{
  "node": "hub",
  "cluster": "gnss",
  "ts": "2025-10-10T12:00:00.000Z",
  "sensors": {
    "latitude":       { "value": 52.520008, "unit": "°" },
    "longitude":      { "value": 13.404954, "unit": "°" },
    "altitude":       { "value": 34.5, "unit": "m" },
    "speed_knots":    { "value": 0.3, "unit": "kn" },
    "speed_kmh":      { "value": 0.6, "unit": "km/h" },
    "course":         { "value": 180.0, "unit": "°" },
    "fix_valid":      { "value": 1, "unit": "" },
    "fix_quality":    { "value": 1, "unit": "" },
    "fix_type":       { "value": 3, "unit": "" },
    "hdop":           { "value": 1.2, "unit": "" },
    "pdop":           { "value": 2.1, "unit": "" },
    "vdop":           { "value": 1.7, "unit": "" },
    "satellites_used":{ "value": 12, "unit": "" },
    "sv_gps":         { "value": 8, "unit": "" },
    "sv_galileo":     { "value": 6, "unit": "" },
    "sv_glonass":     { "value": 4, "unit": "" },
    "sv_beidou":      { "value": 3, "unit": "" }
  }
}
```

### Fix-Quality-Werte

| Wert | Bedeutung |
|---|---|
| 0 | Invalid |
| 1 | GPS Fix |
| 2 | DGPS Fix |
| 6 | Estimated (Dead Reckoning) |

### Fix-Type-Werte

| Wert | Bedeutung |
|---|---|
| 1 | No Fix |
| 2 | 2D Fix |
| 3 | 3D Fix |

---

## 4. Kondensationsrisiko (berechnet)

### Eingangswerte

| Wert | Quelle | Standard-Config |
|---|---|---|
| $T_{innen}$ | `enclosure/temperature` | Cluster: `enclosure`, Sensor: `temperature` |
| $RH$ | `enclosure/humidity` | Cluster: `enclosure`, Sensor: `humidity` |
| $T_{außen}$ | `weather/temperature` | Cluster: `weather`, Sensor: `temperature` |

### Algorithmus

**Schritt 1 — Oberflächentemperatur (Näherung):**

$$T_{surface} = \frac{T_{innen} + T_{außen}}{2}$$

**Schritt 2 — Taupunkt (Magnus-Formel):**

Für $T \geq 0°C$: $a = 17.62$, $b = 243.12$

Für $T < 0°C$ (Eis): $a = 22.46$, $b = 272.62$

$$\gamma = \ln\left(\frac{RH}{100}\right) + \frac{a \cdot T_{innen}}{b + T_{innen}}$$

$$T_{dew} = \frac{b \cdot \gamma}{a - \gamma}$$

**Schritt 3 — Risiko-Mapping:**

$$\delta = T_{dew} - T_{surface}$$

$$risk = \text{clamp}\left(\frac{\delta - \delta_{low}}{\delta_{high} - \delta_{low}}, 0, 1\right) \times 100$$

Standard: $\delta_{low} = -2°C$, $\delta_{high} = +2°C$

**Sicherheits-Checks:**
- $RH$ wird auf $[\text{min\_rh\_pct}, 100]$ geclampt (verhindert $\ln(0)$)
- Alle Eingangswerte müssen jünger als `stale_s` (600s) sein
- Bei fehlenden Werten wird keine Berechnung durchgeführt

### Output-Format

```json
{
  "node": "hub",
  "cluster": "enclosure",
  "ts": "...",
  "sensors": {
    "dew_point":          { "value": 15.2, "unit": "°C" },
    "condensation_risk":  { "value": 23.5, "unit": "%" },
    "condensation":       { "value": 0, "unit": "" },
    "surface_temp":       { "value": 22.1, "unit": "°C" }
  }
}
```

| Sensor | Beschreibung |
|---|---|
| `dew_point` | Berechneter Taupunkt |
| `condensation_risk` | Risiko in Prozent (0–100%) |
| `condensation` | Boolean: 1 wenn $T_{surface} \leq T_{dew}$ |
| `surface_temp` | Geschätzte Oberflächentemperatur |

---

## 5. ESP32-P4 — Ethernet-Sensorknoten

### Hardware

| Eigenschaft | Wert |
|---|---|
| MCU | ESP32-P4 |
| Netzwerk | Ethernet (RMII) oder PoE |
| MQTT-Broker | `192.168.10.10:1883` |
| Publish-Intervall | 10 Sekunden |

### Konfiguration (`secrets.h`)

```cpp
#define WIFI_SSID     ""           // Leer bei Ethernet
#define WIFI_PASS     ""
#define MQTT_HOST     "192.168.10.10"
#define MQTT_PORT     1883
#define MQTT_USER     "sensor"
#define MQTT_PASS     "sensor-password"
#define NTP_SERVER    "192.168.10.10"
```

### MQTT-Topics

Das Gerät publiziert auf zwei Ebenen:

**Per-Sensor-Topics:**
```
barkasse/sensors/weather/temperature → {"value": 22.5, "unit": "°C", "ts": "..."}
barkasse/sensors/weather/humidity    → {"value": 55.0, "unit": "%RH", "ts": "..."}
barkasse/sensors/weather/pressure    → {"value": 1013.25, "unit": "hPa", "ts": "..."}
barkasse/sensors/weather/wind_speed  → {"value": 5.2, "unit": "m/s", "ts": "..."}
barkasse/sensors/weather/wind_dir    → {"value": 270, "unit": "°", "ts": "..."}
```

**Cluster-Envelope:**
```
barkasse/sensors → JSON-Envelope (alle Sensoren in einem Paket)
```

### Ethernet-Initialisierung (RMII)

```cpp
#define ETH_PHY_TYPE  ETH_PHY_LAN8720
#define ETH_PHY_ADDR  1
#define ETH_PHY_MDC   23
#define ETH_PHY_MDIO  18
#define ETH_PHY_POWER -1
#define ETH_CLK_MODE  ETH_CLOCK_GPIO17_OUT
```

### NTP-Synchronisation

Zeitstempel werden über NTP vom Hub bezogen (`configTime(0, 0, NTP_SERVER)`) und als ISO-8601-String in die MQTT-Payloads eingebettet. Ein Fallback auf `millis()` existiert, wenn NTP nicht verfügbar ist.

### Mock-Sensoren

Im Beispiel-Code werden die Sensorwerte simuliert:

| Sensor | Bereich | Einheit |
|---|---|---|
| temperature | 18.0–28.0 | °C |
| humidity | 40.0–70.0 | %RH |
| pressure | 1000.0–1025.0 | hPa |
| wind_speed | 0.0–15.0 | m/s |
| wind_dir | 0–359 | ° |

---

## 6. ESP32 WROOM — WiFi-Sensorknoten

### Hardware

| Eigenschaft | Wert |
|---|---|
| MCU | ESP32 WROOM-32 |
| Netzwerk | WiFi (WPA2) |
| MQTT-Broker | `192.168.10.10:1883` |
| Publish-Intervall | 10 Sekunden |

### Konfiguration (`secrets.h`)

```cpp
#define WIFI_SSID     "BarkasseNet"
#define WIFI_PASS     "wifi-password"
#define MQTT_HOST     "192.168.10.10"
#define MQTT_PORT     1883
#define MQTT_USER     "sensor"
#define MQTT_PASS     "sensor-password"
#define NTP_SERVER    "192.168.10.10"
```

### MQTT-Topics

**Per-Sensor-Topics:**
```
barkasse/sensors/water/temperature  → {"value": 18.5, "unit": "°C", "ts": "..."}
barkasse/sensors/water/depth        → {"value": 3.2, "unit": "m", "ts": "..."}
barkasse/sensors/water/salinity     → {"value": 15.0, "unit": "PSU", "ts": "..."}
```

**Cluster-Envelope:**
```
barkasse/sensors → JSON-Envelope
```

### Mock-Sensoren

| Sensor | Bereich | Einheit |
|---|---|---|
| temperature | 15.0–25.0 | °C |
| depth | 1.0–10.0 | m |
| salinity | 5.0–35.0 | PSU |

### WiFi-Reconnect

```cpp
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
}
```

---

## 7. Eigene Sensoren hinzufügen

### Option A: MQTT-Client (empfohlen für Remote-Sensoren)

1. **MQTT-Payload** im Standard-Envelope-Format publizieren:
   ```json
   {
     "node": "<gerätename>",
     "cluster": "<sensorgruppe>",
     "ts": "<ISO-8601>",
     "sensors": {
       "<sensorname>": { "value": <number>, "unit": "<einheit>" }
     }
   }
   ```

2. **Topic**: `barkasse/sensors` (Envelope) oder `barkasse/sensors/<cluster>/<sensor>` (per-Sensor)

3. **Broker**: `192.168.10.10:1883` (plain) oder `:8883` (TLS)

4. **Authentifizierung**: Benutzername + Passwort (siehe `sicherheit.md`)

### Option B: Lokaler I²C-Sensor

1. Python-Script nach dem Muster von `am2301b_read.py` erstellen
2. In Node-RED Tab "Sensor Inputs" einen neuen Inject → Exec → MQTT Publish-Flow anlegen
3. Die zentrale Pipeline erkennt neue Keys automatisch

### Option C: Serieller Sensor

1. In Node-RED Tab "Sensor Inputs" einen neuen Serial-In-Node anlegen
2. Parser-Funktionsknoten erstellen (Protokoll-spezifisch)
3. Output als MQTT-Publish oder direkt in die Pipeline einspeisen

### Automatische Erkennung

Das System erkennt neue Sensoren automatisch:
- **Backend**: Jeder neue Key in MQTT wird automatisch in LATEST/HISTORY aufgenommen und in InfluxDB geschrieben.
- **Frontend**: Neue Keys erzeugen automatisch neue Tiles im UI.
- **Keine Konfiguration nötig**: Weder im Backend noch im Frontend muss ein neuer Sensor registriert werden.
