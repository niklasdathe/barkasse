#!/usr/bin/env bash
set -euo pipefail

# dnsmasq dhcp-script hook
# Called as: <add|old|del> <mac> <ip> <hostname>
# We publish a retained JSON message so the Barkasse UI can show "plugged in" state.

ACTION="${1:-}"
MAC="${2:-}"
IP="${3:-}"
HOSTNAME="${4:-}"

# Normalize node id
node="${HOSTNAME}"
if [[ -z "$node" || "$node" == "*" ]]; then
  # fallback: mac without ':'
  node="${MAC//:/}"
  if [[ -z "$node" ]]; then
    node="unknown"
  else
    node="mac-${node}"
  fi
fi

# Map dnsmasq events to presence
presence="online"
if [[ "$ACTION" == "del" ]]; then
  presence="offline"
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

payload=$(cat <<JSON
{"node":"${node}","cluster":"net","sensor":"presence","value":"${presence}","ip":"${IP}","mac":"${MAC}","event":"${ACTION}","ts":"${ts}"}
JSON
)

# Local mosquitto on the hub (Node-RED subscribes barkasse/#)
# Best-effort: do not fail dnsmasq if MQTT is temporarily unavailable.
mosquitto_pub -h 127.0.0.1 -p 1883 -t "barkasse/${node}/net/presence" -r -m "$payload" >/dev/null 2>&1 || true
