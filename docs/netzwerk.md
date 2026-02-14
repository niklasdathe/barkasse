# Barkasse Hub — Netzwerk

## Inhaltsverzeichnis

1. [Übersicht](#1-übersicht)
2. [LAN-Koordinator](#2-lan-koordinator)
3. [DHCP-Server (dnsmasq)](#3-dhcp-server-dnsmasq)
4. [DHCP→MQTT-Hook](#4-dhcpmqtt-hook)
5. [Zeitsynchronisation (chrony)](#5-zeitsynchronisation-chrony)
6. [LTE-Modem (Quectel EC25-EUX)](#6-lte-modem-quectel-ec25-eux)
7. [Tailscale VPN](#7-tailscale-vpn)
8. [DNS-Konfiguration](#8-dns-konfiguration)
9. [Firewall-Empfehlungen](#9-firewall-empfehlungen)
10. [Netzwerk-Topologie](#10-netzwerk-topologie)

---

## 1. Übersicht

Der Barkasse Hub betreibt ein isoliertes LAN für Sensorknoten und verbindet sich über LTE/Tailscale mit dem Internet und Remote-Management.

```
Internet ← LTE (usb0) ← Quectel EC25 ← USB
                │
                └── Tailscale (tailscale0) ← VPN-Tunnel
                         │
                         └── Remote-Zugriff (SSH, Node-RED Editor)

Sensor-LAN (192.168.10.0/24) ← eth0 (statisch: 192.168.10.10)
    │
    ├── ESP32-P4 (Ethernet/PoE)  → 192.168.10.50-150 (DHCP)
    ├── ESP32 WROOM (WiFi→Bridge) → 192.168.10.50-150 (DHCP)
    └── Weitere Geräte            → 192.168.10.50-150 (DHCP)
```

| Interface | Funktion | IP-Adresse |
|---|---|---|
| `eth0` | Sensor-LAN (isoliert) | `192.168.10.10/24` (statisch) |
| `usb0` | LTE-Uplink (ECM-Mode) | DHCP vom Provider |
| `tailscale0` | VPN-Tunnel | Tailscale IP (100.x.x.x) |
| `wlan0` | Optional, nicht standardmäßig genutzt | — |

---

## 2. LAN-Koordinator

### Script: `scripts/setup-lan-coordinator.sh`

**Aufruf:**
```bash
sudo bash scripts/setup-lan-coordinator.sh
```

**Umgebungsvariablen (Anpassung):**

| Variable | Standard | Beschreibung |
|---|---|---|
| `BARKASSE_LAN_IFACE` | `eth0` | LAN-Interface |
| `BARKASSE_LAN_IP` | `192.168.10.10` | Statische IP des Hubs |
| `BARKASSE_LAN_CIDR` | `24` | Subnetz-Maske |
| `BARKASSE_DHCP_START` | `192.168.10.50` | Erster DHCP-Lease |
| `BARKASSE_DHCP_END` | `192.168.10.150` | Letzter DHCP-Lease |

### NetworkManager-Konfiguration

Das Script erstellt ein statisches NetworkManager-Profil:

```bash
nmcli connection add type ethernet \
  con-name barkasse-lan \
  ifname eth0 \
  ipv4.addresses 192.168.10.10/24 \
  ipv4.method manual \
  ipv4.never-default yes \        # Keine Default-Route über LAN
  ipv6.method disabled

nmcli connection up barkasse-lan
```

**`ipv4.never-default yes`** ist kritisch: Es verhindert, dass das isolierte Sensor-LAN als Internet-Gateway genutzt wird. Der Internetverkehr läuft ausschließlich über `usb0` (LTE).

---

## 3. DHCP-Server (dnsmasq)

### Konfiguration

```ini
# /etc/dnsmasq.d/barkasse-lan.conf
interface=eth0
bind-interfaces
dhcp-range=192.168.10.50,192.168.10.150,255.255.255.0,24h
dhcp-option=option:ntp-server,192.168.10.10    # NTP-Server = Hub
dhcp-option=option:dns-server,192.168.10.10    # DNS-Server = Hub (optional)
dhcp-leasefile=/var/lib/misc/dnsmasq.leases
dhcp-script=/home/hub/barkasse-hub/scripts/barkasse-dhcp-mqtt-hook.sh
```

| Eigenschaft | Wert |
|---|---|
| Interface | `eth0` (nur Sensor-LAN) |
| DHCP-Range | 192.168.10.50 – 192.168.10.150 |
| Lease-Dauer | 24 Stunden |
| NTP-Server (Option 42) | 192.168.10.10 (Hub) |

### Lease-Dauer

24h ist ein guter Kompromiss:
- Kurz genug, um IP-Adressen bei Gerätewechsel freizugeben
- Lang genug, um Renewals bei instabilen Verbindungen zu vermeiden

---

## 4. DHCP→MQTT-Hook

### Script: `scripts/barkasse-dhcp-mqtt-hook.sh`

Dieses Script wird von dnsmasq bei jedem DHCP-Event aufgerufen (`dhcp-script`).

**Events:**

| Event | Trigger | Aktion |
|---|---|---|
| `add` | Neuer Lease | MQTT-Publish mit Client-Info |
| `old` | Lease-Renewal | MQTT-Publish mit Client-Info |
| `del` | Lease läuft ab | MQTT-Publish mit Removal |

**MQTT-Topic:** `barkasse/network/dhcp`

**Payload-Beispiel:**
```json
{
  "event": "add",
  "mac": "aa:bb:cc:dd:ee:ff",
  "ip": "192.168.10.51",
  "hostname": "esp32p4-01",
  "ts": "2025-10-10T12:00:00Z"
}
```

**Nutzung:** Ermöglicht dem System, angeschlossene Geräte automatisch zu erkennen und im UI darzustellen (z.B. Netzwerk-Status-Tile).

---

## 5. Zeitsynchronisation (chrony)

### Architektur

Der Hub fungiert als NTP-Server für das isolierte LAN:

```
Internet ← NTP Pool (pool.ntp.org) ← LTE (usb0)
    │
    └──▶ chrony (Hub)
              │
              ├──▶ RTC (Battery-backed, CR2032)
              │
              └──▶ NTP-Server (Stratum 2/3)
                        │
                        ├──▶ ESP32-P4 (configTime)
                        ├──▶ ESP32 WROOM (configTime)
                        └──▶ Weitere Clients
```

### chrony-Konfiguration

```ini
# /etc/chrony/chrony.conf (Ergänzungen durch setup-lan-coordinator.sh)

# Upstream-Quellen
pool pool.ntp.org iburst

# RTC als Fallback-Quelle
refclock SHM 0 offset 0.0 delay 0.0 refid RTC stratum 10

# NTP-Server für LAN-Clients
allow 192.168.10.0/24

# Zeitsprünge beim Boot erlauben
makestep 1.0 3

# RTC-Synchronisation
rtcsync
```

| Einstellung | Bedeutung |
|---|---|
| `pool pool.ntp.org iburst` | Upstream NTP mit schnellem Initial-Sync |
| `allow 192.168.10.0/24` | LAN-Clients dürfen NTP abfragen |
| `makestep 1.0 3` | Bei Abweichung >1s: springe (max 3× nach Boot) |
| `rtcsync` | Systemzeit in Hardware-RTC schreiben |
| `refclock SHM 0 ... stratum 10` | RTC als Fallback (hoher Stratum = niedrige Priorität) |

### DHCP-NTP-Integration

Über `dhcp-option=option:ntp-server,192.168.10.10` erhalten alle DHCP-Clients automatisch den Hub als NTP-Server. ESP32-Geräte verwenden diese Adresse in `configTime()`.

### RTC (Battery-backed)

| Eigenschaft | Wert |
|---|---|
| Typ | Hardware-RTC auf reTerminal DM |
| Batterie | CR2032 |
| Device | `/dev/rtc0` |
| Funktion | Zeitquelle bei fehlendem Internet |

Bei Stromausfall hält die RTC die aktuelle Zeit. Chrony liest die RTC beim Boot und verwendet sie als Fallback, bis ein NTP-Upstream verfügbar ist.

### NTP-Schutz (nftables)

Um NTP-Spoofing im isolierten LAN zu verhindern, kann optional eine Firewall-Regel gesetzt werden:

```bash
# Nur der Hub darf NTP anbieten
nft add rule inet filter input iifname "eth0" udp dport 123 accept
nft add rule inet filter input iifname "eth0" udp sport 123 drop
```

Siehe `sicherheit.md` für vollständige Firewall-Konfiguration.

---

## 6. LTE-Modem (Quectel EC25-EUX)

### Hardware-Anbindung

| Eigenschaft | Wert |
|---|---|
| Modem | Quectel EC25-EUX (Cat 4 LTE) |
| Anbindung | USB (CDC-ACM + ECM) |
| Modus | ECM (Ethernet Control Model) |
| Interface | `usb0` |
| IP-Vergabe | DHCP vom Provider |

### USB-Devices

Das Modem erzeugt mehrere USB-Devices:

| Device | Funktion |
|---|---|
| `/dev/ttyUSB0` | Diagnostik-Port |
| `/dev/ttyUSB1` | NMEA-Port (GNSS-Ausgabe) |
| `/dev/ttyUSB2` | AT-Kommando-Port |
| `/dev/ttyUSB3` | Modem-Port |
| `usb0` | ECM Ethernet-Interface |

### ECM-Modus konfigurieren

```bash
# USB-Composition auf ECM setzen (persistent über Reboot)
echo 'AT+QCFG="usbnet",1' > /dev/ttyUSB2

# Modem neustarten für Änderung
echo 'AT+CFUN=1,1' > /dev/ttyUSB2
```

ECM-Modus erzeugt ein `usb0`-Interface, das sich wie ein normaler Ethernet-Adapter verhält. NetworkManager verwaltet es automatisch per DHCP.

### APN-Konfiguration

```bash
# APN setzen (Provider-abhängig)
AT+CGDCONT=1,"IP","internet"

# Datenverbindung starten
AT+QIACT=1
```

### SIM-PIN (falls nötig)

```bash
AT+CPIN="1234"
```

### Verbindungsstatus prüfen

```bash
# Registrierungsstatus
AT+CREG?       # +CREG: 0,1 = registriert (Home)
AT+CEREG?      # +CEREG: 0,1 = LTE registriert

# Signalstärke
AT+CSQ          # +CSQ: 20,99 → RSSI ~-73 dBm

# IP-Adresse
AT+CGPADDR=1    # +CGPADDR: 1,"10.x.x.x"
```

---

## 7. Tailscale VPN

### Installation

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --advertise-routes=192.168.10.0/24
```

### Konfiguration

| Eigenschaft | Wert |
|---|---|
| Interface | `tailscale0` |
| IP-Bereich | `100.x.x.x/32` (Tailscale CGNAT) |
| SSH | Aktiviert (`--ssh`) |
| Route-Advertising | `192.168.10.0/24` (Sensor-LAN) |

### Subnet-Router

Mit `--advertise-routes=192.168.10.0/24` wird das Sensor-LAN über den VPN-Tunnel erreichbar. Remote-Geräte können dann direkt auf Sensor-Knoten zugreifen (z.B. für Firmware-Updates).

> **Wichtig:** Subnet-Routes müssen im Tailscale Admin-Panel genehmigt werden.

### Remote-Zugriff

Über Tailscale sind folgende Dienste erreichbar:

| Dienst | Port | Adresse |
|---|---|---|
| SSH | 22 | `barkasse.tailnet-name.ts.net` |
| Node-RED Editor | 8443 | `https://barkasse.tailnet-name.ts.net:8443/admin` |
| Node-RED UI | 8443 | `https://barkasse.tailnet-name.ts.net:8443/` |
| MQTT (TLS) | 8883 | `barkasse.tailnet-name.ts.net:8883` |

### MagicDNS

Tailscale stellt automatisch DNS-Namen bereit:
- `barkasse` (kurz, innerhalb des Tailnets)
- `barkasse.tailnet-name.ts.net` (FQDN)

---

## 8. DNS-Konfiguration

### Lokales DNS (dnsmasq)

dnsmasq fungiert auch als DNS-Cache für das LAN:

```ini
# /etc/dnsmasq.d/barkasse-lan.conf (Ergänzung)
address=/barkasse/192.168.10.10
address=/hub/192.168.10.10
```

Damit können Sensorknoten den Hub unter `barkasse` oder `hub` erreichen statt nur per IP.

### Split-DNS mit Tailscale

Wenn Tailscale MagicDNS aktiviert ist, wird der Tailscale-DNS-Resolver für `*.ts.net`-Domains verwendet. Alle anderen DNS-Anfragen gehen an den konfigurierten Upstream (z.B. dnsmasq → `8.8.8.8`).

---

## 9. Firewall-Empfehlungen

### nftables-Grundkonfiguration

```nft
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;

    # Loopback
    iifname "lo" accept

    # Established/Related
    ct state established,related accept

    # SSH (Tailscale + LAN)
    tcp dport 22 accept

    # MQTT (LAN + Tailscale)
    iifname { "eth0", "tailscale0" } tcp dport { 1883, 8883 } accept

    # Node-RED HTTPS
    tcp dport 8443 accept

    # NTP-Server (nur LAN)
    iifname "eth0" udp dport 123 accept

    # DHCP-Server (nur LAN)
    iifname "eth0" udp dport { 67, 68 } accept

    # DNS (nur LAN)
    iifname "eth0" udp dport 53 accept
    iifname "eth0" tcp dport 53 accept

    # ICMP
    icmp type { echo-request, echo-reply } accept
    icmpv6 type { echo-request, echo-reply, nd-neighbor-solicit, nd-neighbor-advert } accept

    # Log & Drop
    log prefix "nft-drop: " counter drop
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    # Kein Routing zwischen LAN und Internet
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
```

### Offene Ports (Zusammenfassung)

| Port | Protokoll | Interface | Dienst |
|---|---|---|---|
| 22 | TCP | alle | SSH |
| 53 | TCP/UDP | eth0 | DNS (dnsmasq) |
| 67-68 | UDP | eth0 | DHCP (dnsmasq) |
| 123 | UDP | eth0 | NTP (chrony) |
| 1883 | TCP | eth0, tailscale0 | MQTT (plain) |
| 8443 | TCP | alle | Node-RED HTTPS |
| 8883 | TCP | eth0, tailscale0 | MQTT (TLS) |

---

## 10. Netzwerk-Topologie

### Physische Topologie

```
                    ┌──────────────────────┐
                    │    Barkasse Hub       │
                    │  (Seeed reTerminal DM)│
                    │                      │
  ┌─ USB ──────────┤  usb0 (LTE → ISP)    │
  │                 │  eth0 (192.168.10.10) ├── Ethernet ──┐
  │                 │  tailscale0 (VPN)     │              │
  │                 └──────────────────────┘              │
  │                                                       │
  │  ┌──────────────┐                    ┌──────────────┐ │
  └──┤ Quectel EC25 │                    │   Switch/Hub │─┘
     │ (LTE-Modem)  │                    └──────┬───────┘
     └──────────────┘                           │
                                    ┌───────────┼───────────┐
                                    │           │           │
                              ┌─────┴─────┐ ┌──┴──┐  ┌─────┴─────┐
                              │ ESP32-P4  │ │ ... │  │ ESP32-P4  │
                              │ (sensor)  │ │     │  │ (sensor)  │
                              └───────────┘ └─────┘  └───────────┘
```

### Logische Datenflüsse

```
ESP32 Sensoren ──MQTT──▶ Mosquitto (1883) ──▶ Node-RED
                                                  │
                                                  ├──▶ WebSocket → Chromium UI
                                                  ├──▶ InfluxDB (8086)
                                                  └──▶ MQTT Publish (berechnete Werte)

Remote Admin ──Tailscale──▶ Node-RED Editor (8443/admin)
                        ──▶ SSH (22)
                        ──▶ MQTT Explorer (8883)
```
