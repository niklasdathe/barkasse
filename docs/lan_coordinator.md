# Barkasse Hub – Isolated LAN Coordinator (DHCP + MQTT discovery + NTP)

Goal: In a 2-device network (hub + one ESP32 on the same switch), the hub should:

- Provide **IP addresses** (DHCP)
- Be the **time authority** (NTP via chrony)
- Provide reliable networking so the ESP32 can publish sensor data to MQTT

This is designed to work reliably even if the ESP32 is unplugged and replugged.

---

## 1. Why this is needed

The repo already has:

- Mosquitto (MQTT broker)
- Node-RED flow subscribing to `barkasse/#`
- Web UI that renders JSON sensor messages

But a plain Ethernet switch does **not** assign IP addresses by itself.
So we add a minimal DHCP server on the hub (dnsmasq).

---

## 2. What gets installed/configured

- **NetworkManager**: static IP on the LAN interface (default `eth0`)
- **dnsmasq**: DHCP server on that interface
  - DHCP option 42: points NTP at the hub
- **chrony**: already documented in [docs/time_sync.md](docs/time_sync.md)

---

## 3. One-command setup

From the repo folder:

```bash
chmod +x scripts/setup-lan-coordinator.sh
BARKASSE_LAN_IFACE=eth0 BARKASSE_LAN_IP=192.168.10.10 ./scripts/setup-lan-coordinator.sh
```

Defaults (if you don’t set env vars):

- Interface: `eth0`
- Hub IP: `192.168.10.10/24`
- DHCP range: `192.168.10.50`–`192.168.10.150`

---

## 4. Discovery behavior

The dashboard shows devices when they publish JSON sensor readings under `barkasse/<node>/<cluster>/<sensor>`.

---

## 5. Quick verification

- Check DHCP server:
  - `systemctl status dnsmasq`
  - `journalctl -u dnsmasq -f`

- Check that the ESP32 got a lease:
  - `sudo cat /var/lib/misc/dnsmasq.leases`

- Check NTP server:
  - `chronyc tracking`
  - `sudo ss -ulnp | grep ':123'`

---

## 6. Notes on ESP32 NTP reliability

Arduino’s `configTime()` uses SNTP but (depending on core) does not always retry forever.
The example sketches in this repo retry NTP periodically until time is valid, so replug works.

---

## 7. Recommended firewalling (avoid accidental exposure on LTE)

If the hub also has an LTE uplink (`usb0`) and/or Tailscale, it’s usually a bad idea to expose:

- MQTT `1883` (especially with `allow_anonymous true`)
- The UI/API `8080`

The repo already documents nftables for NTP in [docs/time_sync.md](docs/time_sync.md). You can extend it with rules like:

```nft
table inet filter {
  chain input {
    type filter hook input priority 0; policy accept;

    # Never expose MQTT / UI on LTE
    iifname "usb0" tcp dport { 1883, 8080 } drop

    # Allow MQTT / UI only on internal interfaces
    iifname { "eth0", "wlan0" } tcp dport { 1883, 8080 } accept
  }
}
```
