# Barkasse Hub — Sicherheit & Persistenz

## Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [TLS-Zertifikate (PKI)](#2-tls-zertifikate-pki)
3. [Mosquitto-Authentifizierung](#3-mosquitto-authentifizierung)
4. [Node-RED-Absicherung](#4-node-red-absicherung)
5. [InfluxDB-Setup](#5-influxdb-setup)
6. [Daten-Persistenz](#6-daten-persistenz)
7. [Credential-Management](#7-credential-management)
8. [Härtung](#8-härtung)

---

## 1. Übersicht

Das Sicherheitskonzept basiert auf mehreren Schichten:

| Schicht | Maßnahme |
|---|---|
| Transport | TLS 1.2+ (selbstsignierte CA) |
| MQTT | Benutzername/Passwort + ACL |
| Node-RED Editor | bcrypt-basiertes adminAuth |
| InfluxDB | Token-basierte API-Authentifizierung |
| Netzwerk | Isoliertes LAN, kein Routing ins Internet |
| VPN | Tailscale (WireGuard) für Remote-Zugriff |

### Setup-Script

Alle Sicherheitskonfigurationen werden durch ein einziges Script eingerichtet:

```bash
sudo bash scripts/setup-security.sh
```

Das Script ist interaktiv und fragt Passwörter ab. Es kann wiederholt ausgeführt werden (idempotent für die meisten Operationen).

---

## 2. TLS-Zertifikate (PKI)

### Zertifikats-Hierarchie

```
CA (barkasse-ca)
├── Server-Zertifikat (barkasse-server)
│   └── SAN: localhost, barkasse, 192.168.10.10, 127.0.0.1
└── Client-Zertifikat (barkasse-client) [optional]
```

### Generierung (`setup-security.sh`)

**1. Certificate Authority (CA):**
```bash
openssl genrsa -out certs/ca.key 4096
openssl req -x509 -new -nodes \
  -key certs/ca.key \
  -sha256 -days 3650 \
  -subj "/CN=Barkasse CA" \
  -out certs/ca.crt
```
- RSA 4096-Bit
- Gültigkeit: 10 Jahre
- Selbstsigniert

**2. Server-Zertifikat:**
```bash
openssl genrsa -out certs/server.key 2048
openssl req -new \
  -key certs/server.key \
  -subj "/CN=barkasse" \
  -out certs/server.csr

# SAN-Erweiterung (Subject Alternative Names)
openssl x509 -req \
  -in certs/server.csr \
  -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 3650 -sha256 \
  -extfile <(printf "subjectAltName=\
    DNS:localhost,DNS:barkasse,\
    IP:192.168.10.10,IP:127.0.0.1") \
  -out certs/server.crt
```
- RSA 2048-Bit
- SAN enthält alle erreichbaren Namen/IPs
- Gültigkeit: 10 Jahre

**3. Client-Zertifikat (optional):**
```bash
openssl genrsa -out certs/client.key 2048
openssl req -new \
  -key certs/client.key \
  -subj "/CN=barkasse-client" \
  -out certs/client.csr
openssl x509 -req \
  -in certs/client.csr \
  -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 3650 -sha256 \
  -out certs/client.crt
```

### Dateispeicherort

```
/home/hub/barkasse-hub/certs/
├── ca.key          # CA Private Key (GEHEIM, nur Root)
├── ca.crt          # CA Zertifikat (öffentlich, an Clients verteilen)
├── server.key      # Server Private Key (GEHEIM)
├── server.crt      # Server Zertifikat
├── server.csr      # Certificate Signing Request (kann gelöscht werden)
├── client.key      # Client Private Key (optional)
├── client.crt      # Client Zertifikat (optional)
└── client.csr      # CSR (kann gelöscht werden)
```

### Dateiberechtigungen

```bash
chmod 600 certs/ca.key certs/server.key certs/client.key
chmod 644 certs/ca.crt certs/server.crt certs/client.crt
chown hub:hub certs/*
```

### Zertifikat erneuern

```bash
# Neues Server-Zertifikat mit bestehender CA
openssl req -new -key certs/server.key -subj "/CN=barkasse" -out certs/server.csr
openssl x509 -req -in certs/server.csr \
  -CA certs/ca.crt -CAkey certs/ca.key \
  -CAcreateserial -days 3650 -sha256 \
  -extfile <(printf "subjectAltName=DNS:localhost,DNS:barkasse,IP:192.168.10.10,IP:127.0.0.1") \
  -out certs/server.crt

# Services neustarten
sudo systemctl restart mosquitto barkasse-ui barkasse-fullscreen
```

---

## 3. Mosquitto-Authentifizierung

### Konfiguration

```ini
# /etc/mosquitto/conf.d/barkasse.conf (generiert aus mosquitto/mosquitto.conf)

# Listener 1: Localhost (plain, keine Auth)
listener 1883 127.0.0.1
allow_anonymous true

# Listener 2: Alle Interfaces (TLS + Auth)
listener 8883

# TLS
cafile   /home/hub/barkasse-hub/certs/ca.crt
certfile /home/hub/barkasse-hub/certs/server.crt
keyfile  /home/hub/barkasse-hub/certs/server.key
tls_version tlsv1.2

# Authentifizierung
allow_anonymous false
password_file /etc/mosquitto/passwd

# Logging
log_type warning
log_type error
connection_messages true
```

### Zwei-Listener-Architektur

| Listener | Port | Interface | TLS | Auth | Zweck |
|---|---|---|---|---|---|
| 1 | 1883 | `127.0.0.1` | Nein | Nein | Interne Node-RED ↔ Mosquitto |
| 2 | 8883 | `0.0.0.0` | Ja | Ja | Externe Clients (ESP32, Remote) |

**Rationale:**
- Port 1883 ist nur auf localhost gebunden → kein Zugriff von außen möglich
- Node-RED verbindet auf localhost ohne TLS (kein Performance-Overhead)
- Externe Clients müssen TLS + Username/Password verwenden

### Benutzer anlegen

```bash
# Passwort-Datei erstellen
sudo mosquitto_passwd -c /etc/mosquitto/passwd sensor
# Weitere Benutzer hinzufügen (ohne -c!)
sudo mosquitto_passwd /etc/mosquitto/passwd admin

sudo systemctl restart mosquitto
```

### Verbindungstest

```bash
# Lokal (plain, ohne Auth)
mosquitto_pub -h 127.0.0.1 -p 1883 -t test -m hello

# Remote (TLS + Auth)
mosquitto_pub -h 192.168.10.10 -p 8883 \
  --cafile certs/ca.crt \
  -u sensor -P sensor-password \
  -t test -m hello
```

---

## 4. Node-RED-Absicherung

### HTTPS

Node-RED läuft auf Port 8443 mit TLS:

```javascript
// ~/.node-red/settings.js
https: {
  key:  fs.readFileSync('/home/hub/barkasse-hub/certs/server.key'),
  cert: fs.readFileSync('/home/hub/barkasse-hub/certs/server.crt'),
  ca:   fs.readFileSync('/home/hub/barkasse-hub/certs/ca.crt')
}
```

### Editor-Authentifizierung (adminAuth)

Der Node-RED-Editor (`/admin`) ist passwortgeschützt:

```javascript
// ~/.node-red/settings.js
adminAuth: {
  type: "credentials",
  users: [{
    username: "admin",
    password: "$2b$08$...",   // bcrypt-Hash
    permissions: "*"
  }]
}
```

**Passwort-Hash generieren:**
```bash
node -e "require('bcryptjs').hash('mein-passwort', 8, (e,h) => console.log(h))"
```

### httpAdminRoot

```javascript
httpAdminRoot: '/admin'
```

Der Editor ist unter `/admin` erreichbar, nicht unter `/`. Das UI belegt den Root-Pfad `/`.

### Credentials-Verschlüsselung

Node-RED verschlüsselt Credentials (MQTT-Passwörter, API-Tokens) in `flows_cred.json` mit einem automatisch generierten Schlüssel.

---

## 5. InfluxDB-Setup

### Installation (`setup-security.sh`)

```bash
# InfluxDB 2.x Repository hinzufügen
wget -q https://repos.influxdata.com/influxdata-archive_compat.key
echo '...' | gpg --dearmor | sudo tee /etc/apt/trusted.gpg.d/influxdata.gpg
echo 'deb [signed-by=...] https://repos.influxdata.com/debian stable main' \
  | sudo tee /etc/apt/sources.list.d/influxdata.list
sudo apt update && sudo apt install -y influxdb2

# Initial-Setup
influx setup \
  --org barkasse \
  --bucket sensors \
  --username admin \
  --password <password> \
  --token <generated-token> \
  --force
```

### Konfiguration

| Eigenschaft | Wert |
|---|---|
| Host | `127.0.0.1:8086` |
| Protokoll | HTTP (kein TLS, nur localhost) |
| Organisation | `barkasse` |
| Bucket | `sensors` |
| Retention | Unbegrenzt (Standard) |
| Auth | Token-basiert |

### Token-Verwaltung

```bash
# Token anzeigen
influx auth list --org barkasse

# Neuen Token erstellen (read+write auf sensors)
influx auth create \
  --org barkasse \
  --read-bucket sensors \
  --write-bucket sensors \
  --description "Node-RED Zugriff"
```

Der Token wird in Node-RED als InfluxDB-Konfigurationsknoten gespeichert und in `flows_cred.json` verschlüsselt.

---

## 6. Daten-Persistenz

### Persistenz-Schichten

| Schicht | Speicher | Retention | Zweck |
|---|---|---|---|
| In-Memory (LATEST) | RAM | Unbegrenzt (solange laufend) | Aktuelle Sensorwerte |
| In-Memory (HISTORY) | RAM | Max. 20.000 Punkte/Key | Kurzzeit-Graphen (1h, 1d) |
| Context Storage | eMMC (Filesystem) | Unbegrenzt | Persistenz über Neustarts |
| InfluxDB | eMMC (DB) | Unbegrenzt | Langzeit-Archiv |

### Node-RED Context Storage

```javascript
// ~/.node-red/settings.js
contextStorage: {
  default: {
    module: "localfilesystem",
    config: {
      flushInterval: 30    // Alle 30 Sekunden auf Disk schreiben
    }
  },
  memory: {
    module: "memory"        // Schneller In-Memory-Store
  }
}
```

**Funktionsweise:**
1. `global.set("LATEST", ...)` und `global.set("HISTORY", ...)` werden im Default-Store (localfilesystem) gespeichert
2. Alle 30 Sekunden wird der aktuelle Stand als JSON auf die eMMC geschrieben
3. Beim Node-RED-Neustart werden die Daten automatisch geladen
4. Speicherort: `~/.node-red/context/global/` (JSON-Dateien)

**Trade-off:**
- 30s Flush-Intervall = max. 30s Datenverlust bei Crash
- Häufigeres Flushen erhöht eMMC-Write-Wear
- InfluxDB-Daten sind davon nicht betroffen (sofort persistiert)

### InfluxDB-Persistenz

Alle numerischen Sensorwerte werden zusätzlich in InfluxDB geschrieben:
- **Sofortige Persistenz**: Jeder Datenpunkt wird synchron geschrieben
- **Unbegrenzte Retention**: Standard-Policy behält alle Daten
- **Aggregation**: Lesezugriffe verwenden `aggregateWindow()` für Performance

### eMMC-Wear-Leveling

Der Hub verwendet 32 GB eMMC-Speicher. Bei 30s Flush-Intervall und ~100 KB Context-Daten:

$$\text{Writes/Tag} = \frac{86400}{30} \times 100\,\text{KB} \approx 288\,\text{MB/Tag}$$

Modern eMMC mit Wear-Leveling verträgt typischerweise > 3.000 P/E-Zyklen. Bei 32 GB:

$$\text{Lebensdauer} = \frac{32\,\text{GB} \times 3000}{288\,\text{MB/Tag}} \approx 91\,\text{Jahre}$$

Der Context-Storage ist also kein eMMC-Lebensdauer-Problem.

---

## 7. Credential-Management

### Übersicht aller Credentials

| Credential | Speicherort | Format |
|---|---|---|
| MQTT-Passwörter | `/etc/mosquitto/passwd` | Mosquitto-Hash (PBKDF2-SHA512) |
| Node-RED Admin-Passwort | `~/.node-red/settings.js` | bcrypt ($2b$) |
| Node-RED Flow-Credentials | `~/.node-red/flows_cred.json` | AES-256-CTR verschlüsselt |
| InfluxDB Admin-Passwort | InfluxDB-interne DB | bcrypt |
| InfluxDB API-Token | InfluxDB-interne DB | Plaintext im Auth-Store |
| ESP32 MQTT-Credentials | `secrets.h` (auf Gerät) | Plaintext (nicht committet) |
| CA Private Key | `certs/ca.key` | PEM (unverschlüsselt) |
| Server Private Key | `certs/server.key` | PEM (unverschlüsselt) |

### Sicherheitshinweise

- **`secrets.h`** und **`flows_cred.json`** sind in `.gitignore` aufgenommen und werden nicht committeted
- **`certs/*.key`**: Private Keys sollten `chmod 600` und nur für User `hub` lesbar sein
- **Passwort-Rotation**: `mosquitto_passwd` für MQTT, `bcryptjs` für Node-RED, `influx auth` für InfluxDB

---

## 8. Härtung

### System-Ebene

```bash
# SSH-Schlüssel statt Passwort
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Automatische Sicherheitsupdates
sudo apt install unattended-upgrades
sudo dpkg-reconfigure unattended-upgrades

# Unnötige Services deaktivieren
sudo systemctl disable bluetooth avahi-daemon
```

### Netzwerk-Isolation

- **eth0**: Nur Sensor-LAN (192.168.10.0/24), kein Default-Gateway
- **usb0**: LTE-Uplink, NAT durch Provider
- **Kein IP-Forwarding**: `net.ipv4.ip_forward = 0` (außer bei Tailscale Subnet-Router)
- **Firewall**: Siehe `netzwerk.md` → Firewall-Empfehlungen

### Mosquitto-Härtung

```ini
# Maximale Verbindungen begrenzen
max_connections 50

# Maximale Paketgröße
message_size_limit 65536

# Keine Retained Messages von anonymen Clients
# (Port 1883 ist ohnehin localhost-only)
```

### Node-RED-Härtung

```javascript
// settings.js Ergänzungen
functionGlobalContext: {},          // Kein globaler Zugriff auf OS-Module
httpNodeCors: false,               // Kein CORS
```

### Monitoring-Empfehlung

```bash
# Mosquitto-Verbindungen überwachen
mosquitto_sub -t '$SYS/broker/clients/connected'

# Node-RED Health-Check
curl -sk https://localhost:8443/debug/stats | jq .

# InfluxDB Health
curl -s http://localhost:8086/health | jq .
```
