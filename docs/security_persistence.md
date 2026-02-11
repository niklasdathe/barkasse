# Barkasse Hub — Sicherheit & Persistente Datenspeicherung

> Dokumentation aller getroffenen Maßnahmen zur Absicherung des Barkasse Hub Systems
> und zur Einrichtung persistenter Datenspeicherung auf dem eMMC.

---

## Übersicht der Maßnahmen

| #  | Maßnahme | Status | Anforderung |
|----|----------|--------|-------------|
| 1  | InfluxDB 2.x — Persistente Sensordatenspeicherung | ✅ | AF7, AF8, AS5 |
| 2  | MQTT-Authentifizierung (Passwort-basiert) | ✅ | AS3, AS6 |
| 3  | Node-RED Editor-Absicherung (adminAuth) | ✅ | AS3, AS6 |
| 4  | TLS/HTTPS für Node-RED (Port 8443) | ✅ | AS4 |
| 5  | MQTT über TLS (Port 8883) | ✅ | AS4 |
| 6  | MQTT nur auf localhost (Plain, Port 1883) | ✅ | AS6 |
| 7  | Selbstsignierte CA + Server-Zertifikate | ✅ | AS4 |
| 8  | Persistenter Node-RED Context (localfilesystem) | ✅ | AF7, AS5 |

---

## 1. Persistente Datenspeicherung (InfluxDB 2.x)

### Problem (vorher)
- Alle Sensordaten lagen nur im RAM (`global.get("HISTORY")`)
- Max. 20.000 Datenpunkte pro Sensor-Key
- **Datenverlust bei jedem Neustart** (Strom, Update, Crash)

### Lösung
- **InfluxDB 2.x** auf dem eMMC installiert (Debian-Paket)
- Jeder Sensor-Datenpunkt wird parallel in InfluxDB geschrieben
- In-Memory-Buffer bleibt für schnelle UI-Aktualisierung
- InfluxDB speichert mit **730 Tagen Retention** (2 Jahre), danach automatische Löschung

### Datenstruktur in InfluxDB

```
Measurement: sensor
Tags:        node, cluster, sensor, unit
Fields:      value (float)
Timestamp:   Original Sensor-Zeitstempel
```

### API-Endpoints

| Endpoint | Beschreibung |
|----------|-------------|
| `GET /history?key=...&period=1h` | In-Memory-Daten (schnell, letzte Stunden) |
| `GET /history/influx?key=...&period=7d` | InfluxDB-Daten (Langzeit, mit auto-Aggregation) |
| `GET /history/influx?key=...&period=30d&agg=15m` | InfluxDB mit explizitem Aggregationsintervall |

### Aggregation (automatisch)

| Zeitraum | Standard-Aggregation |
|----------|---------------------|
| 1h | Keine (Rohdaten) |
| 1d | 1 Minute Mittelwert |
| 7d | 5 Minuten Mittelwert |
| 30d | 15 Minuten Mittelwert |
| 365d | 1 Stunde Mittelwert |

### Node-RED Context Persistence

Zusätzlich ist der Node-RED `contextStorage` auf `localfilesystem` konfiguriert:
```js
contextStorage: {
    default: {
        module: "localfilesystem",
        config: {
            dir: path.join(__dirname, 'context'),
            flushInterval: 30  // Alle 30s auf Disk schreiben
        }
    }
}
```
→ `LATEST` und `HISTORY` (In-Memory-Buffer) überleben Node-RED-Neustarts.

---

## 2. MQTT-Authentifizierung

### Problem (vorher)
- `allow_anonymous true` → Jeder im Netzwerk konnte MQTT-Daten lesen/schreiben
- Kein Schutz gegen Manipulation von Sensordaten

### Lösung
- Passwort-Datei mit `mosquitto_passwd` generiert
- `allow_anonymous false` in der Mosquitto-Konfiguration
- Standard-User: `barkasse` (Passwort wird bei Setup abgefragt)

### Konfiguration (`/etc/mosquitto/conf.d/barkasse.conf`)
```
allow_anonymous false
password_file /etc/mosquitto/barkasse_passwd

# Listener 1: Plain MQTT nur auf localhost
listener 1883 127.0.0.1
protocol mqtt

# Listener 2: MQTT über TLS (alle Interfaces)
listener 8883
protocol mqtt
cafile   /etc/mosquitto/certs/ca.crt
certfile /etc/mosquitto/certs/server.crt
keyfile  /etc/mosquitto/certs/server.key
tls_version tlsv1.2

# Persistence — 'persistence true' und 'persistence_location' stehen bereits
# in /etc/mosquitto/mosquitto.conf. Hier nur autosave_interval ergänzen,
# um "Duplicate persistence_location"-Fehler zu vermeiden.
autosave_interval 60
```

### Wichtig für Sensor-Nodes (ESP32)
ESP32-Sensoren müssen ihre MQTT-Verbindung aktualisieren:
```cpp
// Vorher:
mqttClient.connect("ESP32", NULL, NULL);

// Nachher:
mqttClient.connect("ESP32", "barkasse", "<passwort>");
// Für TLS (Port 8883):
wifiClientSecure.setCACert(ca_cert);
mqttClient.begin("192.168.10.10", 8883, wifiClientSecure);
```

Die CA-Datei (`certs/ca.crt`) muss auf die ESP32-Geräte kopiert werden.

---

## 3. Node-RED Editor-Absicherung

### Problem (vorher)
- Node-RED Editor unter `/admin` war ohne Login zugänglich
- Jeder im Netzwerk konnte Flows bearbeiten, löschen, Code ausführen

### Lösung
- `adminAuth` in `settings.js` konfiguriert
- bcrypt-gehashtes Passwort (10 rounds)
- Standard: User `admin`, Passwort wird bei Setup abgefragt
- Nicht-authentifizierte Benutzer haben nur Lese-Zugriff

### Konfiguration (`settings.js`)
```js
adminAuth: {
    type: "credentials",
    users: [{
        username: "admin",
        password: "$2a$10$...",  // bcrypt hash
        permissions: "*"
    }],
    default: {
        permissions: "read"  // Nicht-eingeloggte User: nur lesen
    }
}
```

### Passwort ändern
```bash
# Neuen Hash generieren:
node -e "console.log(require('bcryptjs').hashSync('NEUES_PASSWORT', 10))"
# Hash in settings.js eintragen, Node-RED neustarten
```

---

## 4. TLS/HTTPS

### Problem (vorher)
- Alle Kommunikation im Klartext (HTTP, WS, MQTT)
- Passwörter und Sensordaten lesbar bei Man-in-the-Middle

### Lösung
- **Selbstsignierte CA** mit 10 Jahren Gültigkeit generiert
- Server-Zertifikat mit SAN (Subject Alternative Names):
  - `localhost`, `barkasse`, `barkasse.local`
  - `127.0.0.1`, `192.168.10.10`, `::1`

### Zertifikat-Dateien

| Datei | Zweck | Berechtigung |
|-------|-------|-------------|
| `certs/ca.crt` | CA-Zertifikat (an Clients verteilen) | 644 |
| `certs/ca.key` | CA Private Key (geheim!) | 600 |
| `certs/server.crt` | Server-Zertifikat | 644 |
| `certs/server.key` | Server Private Key (geheim!) | 600 |

### Netzwerk-Topologie nach Absicherung

```
                        ┌──────────────────────────────────┐
                        │         Barkasse Hub             │
                        │                                  │
ESP32 Sensors ──TLS──→  │  :8883 Mosquitto (TLS+Auth)      │
  (LAN/PoE)             │      ↓                           │
                        │  :1883 Mosquitto (localhost only) │
                        │      ↓                           │
                        │  Node-RED (intern)                │
                        │      ↓                           │
Browser (LAN) ──TLS──→  │  :8443 HTTPS (UI + API + Editor) │
                        │                                  │
Chromium Kiosk ──TLS──→ │  :8443 HTTPS (localhost, self-    │
  (loopback)            │        signed, --allow-insecure-  │
                        │        localhost)                 │
                        │                                  │
Tailscale (VPN) ─────→  │  :8443 HTTPS (über WireGuard)    │
                        └──────────────────────────────────┘
```

### Port-Übersicht

| Port | Protokoll | Bindung | Zugang |
|------|-----------|---------|--------|
| 1883 | MQTT (plain) | `127.0.0.1` nur | Nur lokale Prozesse (Node-RED) |
| 8883 | MQTTS (TLS) | `0.0.0.0` | LAN-Sensoren (mit Auth) |
| 8443 | HTTPS | `0.0.0.0` | UI + API + Editor + Kiosk (mit TLS) |
| 8086 | HTTP | `127.0.0.1` nur | InfluxDB (nur lokal) |

> **Hinweis:** Chromium verbindet sich direkt auf `https://localhost:8443/` mit
> dem Flag `--allow-insecure-localhost`, das selbstsignierte TLS-Zertifikate auf
> localhost akzeptiert. Ein separater HTTP-Proxy auf Port 8080 ist nicht nötig.

---

## 5. Chromium Vollbild-Modus

Chromium (Version 109) wird im normalen Vollbildmodus gestartet (`--start-fullscreen`),
**nicht** im Kiosk-Modus (`--kiosk` / `--app=`). Dadurch kann der Benutzer jederzeit:
- **F11** drücken → Vollbild verlassen
- **Ctrl+W** → Tab/Fenster schließen
- **Alt+Tab** → Zwischen Fenstern wechseln

Der `--app=` Flag wurde bewusst entfernt, da er die Adressleiste und Fenster-
Controls versteckt und ein Verlassen des Browsers erschwert.

### Chromium-Flags (Vollständig)

| Flag | Beschreibung |
|------|--------------|
| `--new-window` | Neues Fenster statt neuem Tab |
| `--start-fullscreen` | F11-Vollbild (einfach verlassbar) |
| `--allow-insecure-localhost` | Akzeptiert selbstsignierte TLS-Zertifikate auf localhost |
| `--no-first-run` | Kein "Willkommen"-Assistent |
| `--no-default-browser-check` | Keine Standardbrowser-Abfrage |
| `--noerrdialogs` | Keine Fehler-Dialoge |
| `--disable-logging` | Weniger Log-Spam |
| `--disable-dev-shm-usage` | Nutzt `/tmp` statt `/dev/shm` (ARM, wenig RAM) |
| `--disable-session-crashed-bubble` | Unterdrückt „Tabs wiederherstellen?"-Leiste |
| `--disable-infobars` | Unterdrückt sonstige Infoleisten |

### Crash-Recovery-Schutz

Systemd beendet Chromium beim Herunterfahren mit SIGTERM, was Chromium als
"Crashed" speichert. Beim nächsten Start würde eine "Sitzung wiederherstellen?"-
Leiste erscheinen. Dagegen sichert der Service mit einem `ExecStartPre`-Schritt
die Preferences-Datei ab:

```bash
# Vor jedem Start in barkasse-fullscreen.service:
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/g' \
  /home/hub/.config/chromium/Default/Preferences
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/g' \
  /home/hub/.config/chromium/Default/Preferences
```

Dies stellt sicher, dass Chromium immer „sauber" startet — auch nach einem
Stromausfall oder unerwarteten Neustart.

---

## 6. Firewall-Empfehlungen (nftables)

Ergänzend zu den bestehenden nftables-Regeln (aus `docs/time_sync.md`):

```bash
# Blockiere MQTT (plain) auf allen externen Interfaces
sudo nft add rule inet filter input iifname != "lo" tcp dport 1883 drop

# Blockiere InfluxDB auf allen externen Interfaces
sudo nft add rule inet filter input iifname != "lo" tcp dport 8086 drop

# Erlaube MQTTS nur aus dem Sensor-LAN
sudo nft add rule inet filter input iifname "eth0" tcp dport 8883 accept
sudo nft add rule inet filter input iifname != "eth0" tcp dport 8883 drop

# Erlaube HTTPS von LAN + Tailscale
sudo nft add rule inet filter input iifname "eth0" tcp dport 8443 accept
sudo nft add rule inet filter input iifname "tailscale0" tcp dport 8443 accept
sudo nft add rule inet filter input tcp dport 8443 drop
```

---

## Setup / Installation

```bash
# Einmalig ausführen (interaktiv — fragt Passwörter ab):
cd /home/hub/barkasse-hub
./scripts/setup-security.sh

# Oder mit Umgebungsvariablen:
MQTT_USER=barkasse \
MQTT_PASS=sicheres_passwort \
NODERED_PASS=admin_passwort \
INFLUX_PASS=influx_passwort \
./scripts/setup-security.sh
```

### Nach dem Setup

Das Setup-Script (`setup-security.sh`) konfiguriert Mosquitto und Node-RED
automatisch. Die MQTT- und InfluxDB-Credentials werden in der verschlüsselten
Datei `~/.node-red/flows_cred.json` gespeichert (AES-256-CTR, Schlüssel aus
`~/.node-red/.config.runtime.json`).

1. **MQTT + InfluxDB Credentials** werden automatisch eingetragen:
   - MQTT: User `barkasse` für alle 3 Broker-Nodes
   - InfluxDB: Admin-Token für den InfluxDB-Server-Node
   - Falls Credentials verloren gehen, können sie manuell über den
     Node-RED Editor (`https://barkasse:8443/admin`) neu gesetzt oder per
     Script regeneriert werden (s.u.)

2. **ESP32-Sensoren** aktualisieren:
   - MQTT-Credentials eintragen
   - Optional: TLS mit `ca.crt` aktivieren

3. **CA-Zertifikat** im Browser importieren (optional):
   - `certs/ca.crt` herunterladen
   - Im Browser als vertrauenswürdige CA importieren
   - → Keine TLS-Warnung mehr bei `https://barkasse:8443`

### Credentials manuell zurücksetzen

Falls die MQTT- oder InfluxDB-Credentials in Node-RED verloren gehen:

```bash
# 1. Mosquitto-Passwort neu setzen:
sudo mosquitto_passwd -b -c /etc/mosquitto/barkasse_passwd barkasse <passwort>
sudo chown mosquitto:mosquitto /etc/mosquitto/barkasse_passwd
sudo systemctl restart mosquitto

# 2. InfluxDB Token auslesen:
influx auth list --json | python3 -c "import json,sys; \
  [print(a['token']) for a in json.load(sys.stdin)]"

# 3. Verschlüsselte Credential-Datei neu generieren:
node -e '
const crypto = require("crypto");
const fs = require("fs");
const rt = JSON.parse(fs.readFileSync(
  "/home/hub/.node-red/.config.runtime.json", "utf8"));
const key = crypto.createHash("sha256").update(rt._credentialSecret).digest();
const creds = {
  "mqtt-broker-barkasse":  { user: "barkasse", password: "<passwort>" },
  "mqtt_broker_cond_local":{ user: "barkasse", password: "<passwort>" },
  "mqtt_broker_cond":      { user: "barkasse", password: "<passwort>" },
  "influxdb-server":       { token: "<influxdb-token>" }
};
const iv = crypto.randomBytes(16);
const c = crypto.createCipheriv("aes-256-ctr", key, iv);
const enc = iv.toString("hex")
  + c.update(JSON.stringify(creds),"utf8","base64") + c.final("base64");
fs.writeFileSync("/home/hub/.node-red/flows_cred.json",
  JSON.stringify({"$": enc}));
console.log("OK");
'

# 4. Node-RED neustarten:
sudo systemctl restart barkasse-ui
```

---

## Verifikation

```bash
# MQTT Auth testen (sollte funktionieren):
mosquitto_pub -h 127.0.0.1 -p 1883 -u barkasse -P '<passwort>' -t test -m "hello"

# MQTT ohne Auth (sollte fehlschlagen):
mosquitto_pub -h 127.0.0.1 -p 1883 -t test -m "hello"
# → Connection Refused: not authorised

# MQTT TLS testen:
mosquitto_sub -h 192.168.10.10 -p 8883 \
  --cafile /home/hub/barkasse-hub/certs/ca.crt \
  -u barkasse -P '<passwort>' -t 'barkasse/#'

# Node-RED Editor (sollte Login verlangen):
curl -k https://localhost:8443/admin
# → Redirect zu Login-Seite

# InfluxDB Health:
curl http://localhost:8086/health

# Chromium-Service prüfen:
systemctl status barkasse-fullscreen
# → active (running), Main PID zeigt chromium-browser
```

---

## Zugehörige Dateien

| Datei | Beschreibung |
|-------|-------------|
| `scripts/setup-security.sh` | Automatisiertes Setup-Script |
| `mosquitto/mosquitto.conf` | Mosquitto-Konfiguration (TLS+Auth) → deployed nach `/etc/mosquitto/conf.d/barkasse.conf` |
| `mosquitto/passwd` | Mosquitto Passwort-Datei (nicht im Git!) |
| `certs/` | TLS-Zertifikate (nicht im Git!) |
| `systemd/barkasse-fullscreen.service` | Chromium Vollbild-Service (mit Crash-Recovery) → deployed nach `/etc/systemd/system/` |
| `~/.node-red/settings.js` | Node-RED Settings (HTTPS+adminAuth) |
| `~/.node-red/flows.json` | Flows mit InfluxDB-Anbindung |
| `~/.node-red/flows_cred.json` | Verschlüsselte Credentials (MQTT+InfluxDB, nicht im Git!) |
| `~/.node-red/.config.runtime.json` | System-generierter Credential-Schlüssel |
