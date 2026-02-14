#pragma once

// MQTT broker settings for Barkasse Hub
//
// IMPORTANT:
// - This ESP32 publishes to topics under "barkasse/...".
// - The Barkasse Hub Node-RED flow subscribes to "barkasse/#".
//
// Set MQTT_HOST to the IP/hostname of the machine running Mosquitto.
// The example deployment assumes the hub is reachable as 192.168.10.10
// on the PoE-switch network.

#define MQTT_HOST "192.168.10.10"
#define MQTT_PORT 1883

// NTP server for SNTP time synchronization.
// The hub runs chrony and serves NTP on eth0 (UDP/123).
#define NTP_HOST "192.168.10.10"

// Mosquitto on the hub requires authentication (allow_anonymous false).
// Set these to the credentials configured in the Mosquitto password file.
#define MQTT_USER "barkasse"
#define MQTT_PASS "change-me"
