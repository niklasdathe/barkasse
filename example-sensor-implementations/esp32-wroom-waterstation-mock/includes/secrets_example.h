#pragma once
// Copy to secrets.h and fill in your WiFi and MQTT credentials.

// --- WiFi AP (provided by the Raspberry Pi hub) ---
#define WIFI_SSID "barkasse-hub"
#define WIFI_PASS "barkasse1234"

// --- MQTT broker (Mosquitto on the hub) ---
#define MQTT_HOST "192.168.10.10"
#define MQTT_PORT 1883

// --- NTP server (chrony on the hub) ---
// On an isolated LAN without internet, sensors should sync time from the hub.
#define NTP_HOST "192.168.10.10"

#define MQTT_USER "barkasse"
#define MQTT_PASS "change-me"


