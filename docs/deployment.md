# Barkasse Hub — Deployment & Betrieb

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Initial-Deployment](#2-initial-deployment)
3. [Systemd-Services](#3-systemd-services)
4. [Node-RED-Konfiguration](#4-node-red-konfiguration)
5. [Plymouth Boot-Splash](#5-plymouth-boot-splash)
6. [Chromium Kiosk-Modus](#6-chromium-kiosk-modus)
7. [Updates & Wartung](#7-updates--wartung)
8. [Verzeichnisstruktur](#8-verzeichnisstruktur)

---

## 1. Voraussetzungen

### Hardware

| Komponente | Anforderung |
|---|---|
| Board | Seeed reTerminal DM (CM4, 4 GB RAM, 32 GB eMMC) |
| OS | Raspberry Pi OS (Bookworm, 64-bit) |
| Display | Integriert 10.1" IPS, 1280×800 |
| Netzwerk | Ethernet (eth0), optional WiFi, LTE (USB-Modem) |

### Software-Abhängigkeiten

| Paket | Version | Installiert durch |
|---|---|---|
| Node-RED | ≥ 4.x | `deploy-native.sh` |
| Mosquitto | ≥ 2.x | `deploy-native.sh` |
| InfluxDB | ≥ 2.x | `setup-security.sh` |
| Chromium | ≥ 109 | Vorinstalliert (Pi OS) |
| Python 3 | ≥ 3.9 | Vorinstalliert (Pi OS) |
| i2c-tools | ≥ 4.x | `deploy-native.sh` |
| chrony | ≥ 4.x | `setup-lan-coordinator.sh` |
| dnsmasq | ≥ 2.x | `setup-lan-coordinator.sh` |
| jq | ≥ 1.6 | `deploy-native.sh` |

---

## 2. Initial-Deployment

### Script: `scripts/deploy-native.sh`

**Aufruf:**
```bash
cd /home/hub/barkasse-hub
sudo bash scripts/deploy-native.sh
```

**Ablauf:**
1. **Voraussetzungsprüfung**: Prüft ob `node`, `npm`, `mosquitto`, `jq` installiert sind
2. **Mosquitto-Installation**: `apt install mosquitto mosquitto-clients`
3. **Mosquitto-Konfiguration**: Kopiert `mosquitto/mosquitto.conf` nach `/etc/mosquitto/conf.d/`
4. **Node-RED npm-Pakete**: Installiert Abhängigkeiten aus `~/.node-red/package.json`
5. **Systemd-Services**: Kopiert und aktiviert Service-Units
6. **Smoke-Tests**: Prüft ob Services starten und Ports erreichbar sind

### Reihenfolge der Setup-Scripts

Für ein vollständiges Setup werden die Scripts in dieser Reihenfolge ausgeführt:

```
1. deploy-native.sh          ← Basis-Installation
2. setup-security.sh         ← TLS, Auth, InfluxDB (siehe sicherheit.md)
3. setup-lan-coordinator.sh  ← Netzwerk, DHCP, NTP (siehe netzwerk.md)
4. enable-system-services.sh ← Services aktivieren
```

### Script: `scripts/enable-system-services.sh`

Aktiviert und startet alle Systemd-Services:

```bash
systemctl enable --now mosquitto
systemctl enable --now barkasse-ui.service
systemctl enable --now barkasse-fullscreen.service
```

---

## 3. Systemd-Services

### `barkasse-ui.service` — Node-RED

| Eigenschaft | Wert |
|---|---|
| Unit-Datei | `systemd/barkasse-ui.service` |
| Ziel | `/etc/systemd/system/barkasse-ui.service` |
| User | `hub` |
| ExecStart | `node-red` |
| Restart | `on-failure` (5s Delay) |
| Conflicting | `nodered.service` (Standard-Node-RED) |

```ini
[Unit]
Description=Barkasse Hub – Node-RED
After=network-online.target mosquitto.service
Wants=network-online.target
Conflicts=nodered.service

[Service]
Type=simple
User=hub
WorkingDirectory=/home/hub/.node-red
ExecStart=/usr/bin/env node-red
Restart=on-failure
RestartSec=5
Environment=NODE_RED_ENABLE_PROJECTS=false

[Install]
WantedBy=multi-user.target
```

**Hinweise:**
- `Conflicts=nodered.service` verhindert, dass der Standard-Node-RED-Dienst (z.B. von Pi OS) parallel läuft.
- `After=mosquitto.service` stellt sicher, dass der MQTT-Broker vor Node-RED startet.
- `Environment=NODE_RED_ENABLE_PROJECTS=false` deaktiviert das Node-RED-Projektfeature.

### `barkasse-fullscreen.service` — Chromium Kiosk

| Eigenschaft | Wert |
|---|---|
| Unit-Datei | `systemd/barkasse-fullscreen.service` |
| Ziel | `/etc/systemd/system/barkasse-fullscreen.service` |
| User | `hub` |
| ExecStartPre | Wartet auf X11, patcht Chromium Preferences |
| ExecStart | `chromium-browser --start-fullscreen ...` |
| Restart | `on-failure` (10s Delay) |

```ini
[Unit]
Description=Barkasse UI – Chromium Fullscreen
After=barkasse-ui.service display-manager.service
Wants=display-manager.service

[Service]
Type=simple
User=hub
Environment=DISPLAY=:0

# Wartet auf X11 und HTTPS-Verfügbarkeit
ExecStartPre=/bin/bash -c '\
  until [ -f /home/hub/.Xauthority ]; do sleep 1; done; \
  export XAUTHORITY=/home/hub/.Xauthority; \
  until xdpyinfo -display :0 >/dev/null 2>&1; do sleep 1; done; \
  until curl -sk https://localhost:8443 >/dev/null 2>&1; do sleep 2; done; \
  python3 -c "..." '

ExecStart=/usr/bin/chromium-browser \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  https://localhost:8443

Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical.target
```

**ExecStartPre-Logik:**
1. Wartet bis `.Xauthority` existiert (X11-Login abgeschlossen)
2. Wartet bis X-Display `:0` ansprechbar ist
3. Wartet bis Node-RED auf `https://localhost:8443` antwortet
4. Patcht Chromium Preferences: Setzt `exit_type: "Normal"` und `exited_cleanly: true`

---

## 4. Node-RED-Konfiguration

### `~/.node-red/settings.js`

Wird von `setup-security.sh` generiert. Wichtige Einstellungen:

```javascript
module.exports = {
  flowFile: 'flows.json',
  uiPort: 8443,

  // TLS
  https: {
    key:  fs.readFileSync('/home/hub/barkasse-hub/certs/server.key'),
    cert: fs.readFileSync('/home/hub/barkasse-hub/certs/server.crt'),
    ca:   fs.readFileSync('/home/hub/barkasse-hub/certs/ca.crt')
  },

  // Editor unter /admin
  httpAdminRoot: '/admin',

  // HTTP-In-Nodes unter /
  httpNodeRoot: '/',

  // UI-Dateien
  httpStatic: '/home/hub/barkasse-hub/ui',

  // Editor-Authentifizierung
  adminAuth: {
    type: "credentials",
    users: [{
      username: "admin",
      password: "$2b$08$...",  // bcrypt-Hash
      permissions: "*"
    }]
  },

  // Persistenter Context-Storage
  contextStorage: {
    default: {
      module: "localfilesystem",
      config: { flushInterval: 30 }  // Alle 30s auf Disk schreiben
    },
    memory: { module: "memory" }
  }
};
```

### `~/.node-red/package.json`

```json
{
  "name": "node-red-project",
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "node-red-contrib-i2c": "~0.7.5",
    "node-red-contrib-influxdb": "~0.7.0",
    "node-red-contrib-modbus": "~5.42.0",
    "node-red-contrib-reterminal-dm": "~0.0.2",
    "node-red-node-serialport": "~2.0.4"
  }
}
```

| Paket | Funktion |
|---|---|
| `bcryptjs` | Passwort-Hashing für adminAuth |
| `node-red-contrib-i2c` | I²C-Bus-Zugriff (alternativ zu exec) |
| `node-red-contrib-influxdb` | InfluxDB 2.x Read/Write |
| `node-red-contrib-modbus` | Modbus RTU/TCP (vorbereitet) |
| `node-red-contrib-reterminal-dm` | reTerminal DM Hardware-Nodes |
| `node-red-node-serialport` | Serieller Port (GNSS, AT-Kommandos) |

---

## 5. Plymouth Boot-Splash

### Dateien

| Datei | Zweck |
|---|---|
| `plymouth/barkasse.plymouth` | Theme-Metadaten |
| `plymouth/barkasse.script` | Animationslogik (Plymouth Script) |
| `plymouth/README.md` | Installationsanleitung |

### Installation

```bash
sudo cp -r plymouth /usr/share/plymouth/themes/barkasse
sudo plymouth-set-default-theme barkasse
sudo update-initramfs -u
```

### Theme-Konfiguration (`barkasse.plymouth`)

```ini
[Plymouth Theme]
Name=Barkasse
Description=Barkasse Hub boot splash
ModuleName=script

[script]
ImageDir=/usr/share/plymouth/themes/barkasse
ScriptFile=/usr/share/plymouth/themes/barkasse/barkasse.script
```

### Animationslogik (`barkasse.script`)

Das Script zeigt ein zentriertes Logo (`logo.png`) während des Bootvorgangs und blendet Boot-Meldungen transparent ein. Fortschrittsbalken und Passwort-Eingabe werden über Callbacks implementiert.

---

## 6. Chromium Kiosk-Modus

### Flags

| Flag | Zweck |
|---|---|
| `--start-fullscreen` | Vollbild ohne Taskbar |
| `--noerrdialogs` | Keine Fehlerdialoge |
| `--disable-infobars` | Keine Info-Leisten |
| `--disable-session-crashed-bubble` | Keine Absturz-Warnung |
| `--no-first-run` | Keine Willkommensseite |
| `--autoplay-policy=no-user-gesture-required` | Media-Autoplay |

### Crash-Recovery

Chromium zeigt nach hartem Shutdown (z.B. Stromausfall) eine "Chrome didn't shut down correctly"-Warnung. Der systemd-Service patcht vor jedem Start die Preferences-Datei:

```python
import json, os
prefs_path = os.path.expanduser(
  "~/.config/chromium/Default/Preferences"
)
if os.path.exists(prefs_path):
    with open(prefs_path, 'r') as f:
        prefs = json.load(f)
    prefs.get("profile", {})["exit_type"] = "Normal"
    prefs.get("profile", {})["exited_cleanly"] = True
    with open(prefs_path, 'w') as f:
        json.dump(prefs, f)
```

### Selbstsignierte Zertifikate

Chromium akzeptiert standardmäßig keine selbstsignierten Zertifikate. Da der Service auf `https://localhost:8443` zeigt, muss das CA-Zertifikat im System-Trust oder in Chromiums NSS-DB registriert sein:

```bash
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," \
  -n "Barkasse CA" -i /home/hub/barkasse-hub/certs/ca.crt
```

---

## 7. Updates & Wartung

### Node-RED-Flows aktualisieren

```bash
cd /home/hub/barkasse-hub
git pull
# Flows werden aus dem Git-Repository geladen
sudo systemctl restart barkasse-ui
```

### UI aktualisieren

```bash
cd /home/hub/barkasse-hub
git pull
# Chromium Cache leeren und neu laden
sudo systemctl restart barkasse-fullscreen
```

Alternativ: Im UI-Menü „Neu laden" klicken.

### Mosquitto-Konfiguration aktualisieren

```bash
sudo cp mosquitto/mosquitto.conf /etc/mosquitto/conf.d/barkasse.conf
sudo systemctl restart mosquitto
```

### Logs prüfen

```bash
# Node-RED
journalctl -u barkasse-ui -f

# Chromium
journalctl -u barkasse-fullscreen -f

# Mosquitto
journalctl -u mosquitto -f

# Alle Barkasse-Services
journalctl -u 'barkasse-*' --since '1 hour ago'
```

### Service-Status

```bash
systemctl status barkasse-ui barkasse-fullscreen mosquitto
```

### InfluxDB-Wartung

```bash
# Bucket-Statistiken
influx bucket list --org barkasse

# Daten exportieren
influx query 'from(bucket:"sensors") |> range(start:-30d)' \
  --org barkasse --raw
```

---

## 8. Verzeichnisstruktur

```
/home/hub/barkasse-hub/
├── ui/                        # Frontend (statisch, von Node-RED ausgeliefert)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── scripts/                   # Setup- und Utility-Scripts
│   ├── deploy-native.sh       # Basis-Deployment
│   ├── setup-security.sh      # TLS, Auth, InfluxDB
│   ├── setup-lan-coordinator.sh # Netzwerk, DHCP, NTP
│   ├── enable-system-services.sh # Services aktivieren
│   ├── barkasse-dhcp-mqtt-hook.sh # DHCP→MQTT-Hook
│   └── am2301b_read.py        # I²C-Sensor-Reader
├── systemd/                   # Systemd Service-Units
│   ├── barkasse-ui.service
│   └── barkasse-fullscreen.service
├── mosquitto/                 # Mosquitto-Konfiguration
│   └── mosquitto.conf
├── plymouth/                  # Boot-Splash-Theme
│   ├── barkasse.plymouth
│   ├── barkasse.script
│   └── README.md
├── esp32/                     # ESP32 Sensorknoten-Beispiele
│   ├── esp32-p4-ethernet/
│   └── esp32-wroom-wifi/
├── certs/                     # TLS-Zertifikate (generiert)
│   ├── ca.key, ca.crt
│   ├── server.key, server.crt
│   └── client.key, client.crt
├── docs/                      # Dokumentation
└── ~/.node-red/               # Node-RED Runtime
    ├── settings.js
    ├── package.json
    ├── flows.json
    └── flows_cred.json
```
