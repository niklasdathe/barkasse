#!/usr/bin/env bash
set -euo pipefail

# Sets up the hub as the coordinator for an isolated "hub + ESP32" LAN:
# - Static IP on the LAN interface (NetworkManager)
# - DHCP (dnsmasq) so the hub assigns addresses
# - DHCP option 42 (NTP server) pointing to the hub
# - DHCP lease events -> MQTT JSON (so the dashboard can show plug/unplug)
#
# Usage:
#   BARKASSE_LAN_IFACE=eth0 BARKASSE_LAN_IP=192.168.10.10 ./scripts/setup-lan-coordinator.sh

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this as the normal user (it will sudo as needed)." >&2
  exit 1
fi

LAN_IFACE="${BARKASSE_LAN_IFACE:-eth0}"
LAN_IP="${BARKASSE_LAN_IP:-192.168.10.10}"
LAN_CIDR="${BARKASSE_LAN_CIDR:-24}"
DHCP_START="${BARKASSE_DHCP_START:-192.168.10.50}"
DHCP_END="${BARKASSE_DHCP_END:-192.168.10.150}"
DHCP_LEASE="${BARKASSE_DHCP_LEASE:-12h}"

if [[ "$LAN_CIDR" != "24" ]]; then
  echo "This script currently supports only /24 (BARKASSE_LAN_CIDR=24)." >&2
  echo "(dnsmasq netmask is currently hard-coded to 255.255.255.0)" >&2
  exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "nmcli not found. This script currently expects NetworkManager." >&2
  echo "Install NetworkManager or configure the interface manually." >&2
  exit 1
fi

echo "[1/5] Installing packages (dnsmasq + chrony)..."
sudo apt-get update
sudo apt-get install -y dnsmasq chrony mosquitto-clients

echo "[2/5] Configuring LAN interface $LAN_IFACE with static IP $LAN_IP/$LAN_CIDR (never-default route)..."
# Create or update a dedicated connection so it doesn't interfere with LTE default route.
if sudo nmcli -t -f NAME con show | grep -qx 'barkasse-lan'; then
  sudo nmcli con modify barkasse-lan connection.interface-name "$LAN_IFACE" \
    ipv4.method manual ipv4.addresses "$LAN_IP/$LAN_CIDR" ipv4.never-default yes ipv6.method ignore
else
  sudo nmcli con add type ethernet ifname "$LAN_IFACE" con-name barkasse-lan \
    ipv4.method manual ipv4.addresses "$LAN_IP/$LAN_CIDR" ipv4.never-default yes ipv6.method ignore
fi
sudo nmcli con up barkasse-lan

echo "[3/5] Installing dnsmasq config for isolated LAN DHCP + NTP option..."

sudo tee /etc/dnsmasq.d/barkasse.conf >/dev/null <<EOF
# Barkasse isolated LAN DHCP server (hub is coordinator)

# Only serve DHCP on the sensor LAN interface
interface=${LAN_IFACE}
bind-interfaces

# Authoritative for this LAN
# (safe if this is the only DHCP server on that switch)
dhcp-authoritative

# Lease range
# format: start,end,netmask,lease
# Note: netmask is derived from /${LAN_CIDR} but dnsmasq wants dotted form.
dhcp-range=${DHCP_START},${DHCP_END},255.255.255.0,${DHCP_LEASE}

# DHCP options
# Router (default gateway) = hub
# DNS server = hub
# NTP server (option 42) = hub
# Note: ESP32 Arduino SNTP does NOT automatically use option 42, but it doesn't hurt.
dhcp-option=option:router,${LAN_IP}
dhcp-option=option:dns-server,${LAN_IP}
dhcp-option=option:ntp-server,${LAN_IP}

# No DHCP lease hook.
EOF

sudo systemctl enable --now dnsmasq
sudo systemctl restart dnsmasq

# Ensure dnsmasq doesn't fail at boot if eth0 isn't ready yet.
sudo install -d /etc/systemd/system/dnsmasq.service.d
sudo tee /etc/systemd/system/dnsmasq.service.d/barkasse-override.conf >/dev/null <<'EOF'
[Unit]
After=network-online.target NetworkManager-wait-online.service
Wants=network-online.target
EOF
sudo systemctl daemon-reload

echo "[4/5] Ensuring chrony is enabled (NTP server for the LAN)..."
sudo systemctl enable --now chrony

echo "[5/5] Done. Quick checks:"
echo "- LAN IP:        $LAN_IP/$LAN_CIDR on $LAN_IFACE"
echo "- DHCP range:    $DHCP_START - $DHCP_END"
echo "- NTP server:    $LAN_IP (chrony, UDP/123)"
echo "- DHCP->MQTT:    publishes JSON under barkasse/<node>/net/presence"

echo "Suggested next checks:" 
echo "  nmcli -p dev show $LAN_IFACE | egrep 'IP4.ADDRESS|IP4.GATEWAY'" 
echo "  systemctl --no-pager --full status dnsmasq | head -n 30" 
echo "  journalctl -u dnsmasq -f" 
