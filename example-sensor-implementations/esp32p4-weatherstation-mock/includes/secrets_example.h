#pragma once
// Copy to secrets.h and fill in your broker credentials / ports.

#define MQTT_HOST "192.168.10.10"  // RPi CM5 address (or "mqtt.local" if mDNS)
#define MQTT_PORT 1883

#define MQTT_USER "barkasse"
#define MQTT_PASS "change-me"

// If using W5500 instead of RMII ETH:
// - Include <Ethernet.h> and initialize SPI pins per your PoE HAT.
// - Many PoE HATs expose CS on a labeled pin and use SPI @ 10–14 MHz.
