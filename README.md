# Barkasse Hub (PoE + MQTT)

A tiny, incredibly easy-to-extend sensor hub for the Barkasse project.

## Core Ideas
- Sensor nodes (ESP32/Arduino) publish JSON over MQTT via Ethernet/PoE.
- Central hub (Raspberry Pi CM5) runs Mosquitto and a small FastAPI app.
- The touch UI is a web page with your background image; new sensors appear automatically.

## Topics & Schema
- `barkasse/<node>/<cluster>/<sensor>`
- JSON: `{"node","cluster","sensor","value","unit","ts"}`
- Cluster summary (optional): `.../<cluster>/state` with `{"sensors": { ... }}`

## Folders
- `esp32p4-weather-mock` – Arduino demo firmware
- `pi/docker-compose.yml` – Mosquitto broker
- `pi/app` – FastAPI + WebSocket + UI (static)

## Getting Started
1. Bring up Mosquitto (`docker compose up -d` in `pi/`).
2. Start UI (`uvicorn main:app ...`).
3. Flash the ESP32-P4 with your MQTT credentials.
4. Open the UI on the Pi’s touchscreen; tiles will populate live.

## Extend
Add any new sensor/cluster by publishing to the topic contract. No UI edits required.
