# Barkasse Hub – Reliable Time Sync (RTC + chrony NTP server + nftables + Tailscale)

This document describes the working configuration on the Barkasse hub (reTerminal DM) to provide:

- **Accurate time when internet is available** (LTE uplink via `usb0`)
- **Sane time after reboot without internet** (battery-backed **RTC**)
- **A local NTP server** for sensor nodes (LAN/Wi‑Fi) and optional access over **Tailscale**
- **No NTP exposure on the LTE uplink** (firewalled on `usb0`)

---

## 1. System context

### Hardware
- **reTerminal DM** with **RTC** and pre-installed **CR2032** battery

### OS / stack
- Debian-based Raspberry Pi OS
- Tools used:
  - `timedatectl` / `hwclock`
  - **chrony** (NTP client + NTP server)
  - **nftables** (firewall)

### Interfaces (current / planned)
- `usb0` — LTE uplink (Quectel EC25 ECM mode)
- `tailscale0` — remote access & private networking
- `eth0` — (planned) sensor LAN
- `wlan0` — (planned) Wi‑Fi AP / hotspot


---

## 2. Goals / requirements

**Goal:** Every sensor reading should have an accurate timestamp.

Requirements:
1. **Accuracy**: Keep time as accurate as possible when internet exists.
2. **Offline robustness**: After reboot **without** internet, timestamps must still be sane (no “1970”).
3. **Reliability**: The hub should be the “time authority” and serve NTP to sensor nodes.
4. **Security**: Do **not** expose NTP on the LTE uplink (`usb0`).

---

## 3. High-level architecture

1. **RTC keeps time through power loss** (CR2032).
2. On boot, Linux sets the system clock from **RTC** (sane time even offline).
3. When LTE is up, **chrony** disciplines the system clock via upstream NTP.
4. The hub runs an **NTP server** (chrony) for sensors on `eth0`/`wlan0` and optional `tailscale0`.
5. **nftables** allows UDP/123 only on internal interfaces and drops it on `usb0`.

---

## 4. Time / timezone baseline (UTC RTC recommended)

### 4.1 Set timezone for UI (system still uses UTC internally)
```bash
sudo timedatectl set-timezone Europe/Berlin
```

### 4.2 Keep RTC in UTC (recommended)
```bash
sudo timedatectl set-local-rtc 0
```

### 4.3 Verify status
```bash
timedatectl status
ls -l /dev/rtc*
sudo hwclock -r
```

Expected good signs:
- `RTC in local TZ: no`
- `/dev/rtc -> rtc0` exists
- `hwclock -r` shows correct-ish time

---

## 5. Initialize RTC from a correct system time (one-time)

Once the system time is correct (e.g., already synced via NTP), write it to RTC:

```bash
sudo hwclock --systohc --utc
sudo hwclock -r
```

Notes:
- Do this after first successful sync.
- After that, `rtcsync` (chrony) keeps RTC updated automatically.

---

## 6. Install and configure chrony

### 6.1 Install chrony
```bash
sudo apt update
sudo apt install chrony
```

This removes `systemd-timesyncd` and replaces it with chrony.

### 6.2 Configure chrony

Edit:
```bash
sudo nano /etc/chrony/chrony.conf
```

Recommended config (merge into your file; keep Debian pool lines):

```conf
# Use Debian vendor pool (default)
pool 0.debian.pool.ntp.org iburst
pool 1.debian.pool.ntp.org iburst
pool 2.debian.pool.ntp.org iburst

# Step the clock quickly at boot if it's far off (important after offline reboot)
makestep 1 3

# Sync RTC from the system clock every ~11 minutes
rtcsync

# Leap seconds from tz database.
# NOTE: If you ever use leap-smeared time sources (e.g., Google time),
# comment this out.
leapsectz right/UTC

# Serve NTP to internal networks
allow 192.168.0.0/16
allow 10.0.0.0/8
allow 172.16.0.0/12

# Optional: serve NTP via Tailscale
allow 100.64.0.0/10

# Restrict chronyc command socket to local host only (good practice)
bindcmdaddress 127.0.0.1
bindcmdaddress ::1
```

Restart and verify:
```bash
sudo systemctl restart chrony
chronyc tracking
chronyc sources -v
```

Expected:
- `Leap status: Normal`
- Small offsets (ms)
- Reachability not zero for at least one source

---

## 7. Firewall (nftables): serve NTP only on internal interfaces

### 7.1 Enable nftables
```bash
sudo systemctl enable --now nftables
```

### 7.2 Configure NTP rules

Edit:
```bash
sudo nano /etc/nftables.conf
```

Minimal rule set for NTP protection:

```nft
table inet filter {
  chain input {
    type filter hook input priority 0; policy accept;

    # Never expose NTP on LTE uplink
    iifname "usb0" udp dport 123 drop

    # Allow NTP only on internal/private interfaces
    iifname { "eth0", "wlan0", "tailscale0" } udp dport 123 accept

    # Drop NTP on any other interface
    udp dport 123 drop
  }
}
```

Apply:
```bash
sudo systemctl restart nftables
sudo nft list ruleset
```

---

## 8. Verification / tests

### 8.1 Confirm chronyd is listening on UDP/123
```bash
sudo ss -ulnp | grep -E '(:123\b)'
```

Expected: `chronyd` bound to UDP/123 (often shown as `0.0.0.0:123`).

### 8.2 Confirm hub is synced
```bash
timedatectl status
chronyc tracking
sudo hwclock -r
```

### 8.3 Test NTP over Tailscale (from hub)
Observe requests on `tailscale0` while querying from another machine:
```bash
sudo apt install tcpdump
sudo tcpdump -ni tailscale0 udp port 123
```

You should see NTP client requests and server replies.

### 8.4 Test NTP from Windows (over Tailscale)

On Windows PowerShell/CMD (from a device in the same Tailnet):
```bat
w32tm /stripchart /computer:barkasse.tail158609.ts.net /samples:10 /dataonly
```

Expected: repeated lines with small offsets and no timeouts.

### 8.5 Verify active NTP clients on hub
Run as root:
```bash
sudo chronyc clients
# or
sudo chronyc -a clients
```

---

## 9. Offline reboot behavior test (LTE down)

To simulate “no internet” on the hub:
```bash
sudo nmcli dev disconnect usb0
timedatectl status
chronyc tracking
sudo hwclock -r
sudo nmcli dev connect usb0
```

Expected:
- System time remains sane (from RTC)
- Chrony may still show last good reference briefly; later it will resync when LTE returns
- RTC stays close to system time

---

## 10. Sensor node integration guidance

For best timestamps:
1. **Sync each sensor node to the hub via NTP**
   - Use hub IP on LAN (`eth0`/`wlan0`) as NTP server
   - Or use Tailscale DNS name if the node runs in the Tailnet

2. **Timestamp at the source** (recommended)
   - Node publishes `ts_node` (UTC ISO 8601, with `Z` suffix)
   - Hub may additionally append `ts_hub_rx` on receipt for auditing

3. **If a node can’t guarantee correct absolute time**
   - Include `uptime_ms` and a `boot_id` (random UUID per boot)
   - Hub can still append a best-effort receive timestamp

---

## 11. Known-good state checklist

Run these on the hub:

```bash
timedatectl status
chronyc tracking
chronyc sources -v
sudo hwclock -r
sudo ss -ulnp | grep -E '(:123\b)'
sudo nft list ruleset
```

Good signs:
- `System clock synchronized: yes`
- `Leap status: Normal`
- RTC time matches system time closely
- NTP UDP/123 is **dropped on usb0** and allowed only on internal interfaces

---

## 12. Troubleshooting

### Symptom: `chronyc tracking` shows `Stratum 0`, `1970`, `Not synchronised`
This can happen **immediately after restarting chrony** before it polls any source.
Wait ~10–30 seconds and check again:
```bash
chronyc tracking
```

### Symptom: NTP queries time out over Tailscale
- Ensure `allow 100.64.0.0/10` is present in `chrony.conf`
- Ensure nftables allows UDP/123 on `tailscale0`
- Verify traffic:
```bash
sudo tcpdump -ni tailscale0 udp port 123
```

### Symptom: Sensors can’t sync over LAN
- Ensure you have `allow <your subnet>` in `chrony.conf`
- Ensure nftables allows UDP/123 on `eth0`/`wlan0`
- Confirm chronyd is listening:
```bash
sudo ss -ulnp | grep -E '(:123\b)'
```

---

## 13. Notes / best practices

- **Store timestamps in UTC**, only convert to local time in UI.
- **RTC in UTC** avoids DST errors and ambiguity.
- Consider GNSS+PPS if you need “near-atomic” accuracy **fully offline** for long periods.
- Keep firewall config single-source: **nftables** recommended (avoid iptables persistence unless needed).

---

## Appendix: Useful commands

```bash
# Time status
timedatectl status
date -u
sudo hwclock -r

# Chrony status
chronyc tracking
chronyc sources -v
sudo chronyc clients

# Listening sockets
sudo ss -ulnp | grep -E '(:123\b)'

# Firewall rules
sudo nft list ruleset

# Offline test (drop LTE)
sudo nmcli dev disconnect usb0
sudo nmcli dev connect usb0
```
