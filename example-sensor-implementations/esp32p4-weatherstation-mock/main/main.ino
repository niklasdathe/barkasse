/*
  Barkasse Weather Demo (ESP32-P4 + PoE + MQTT over Ethernet)
  - Emulates a small weather cluster (temp, humidity, pressure, wind)
  - Publishes per-sensor + cluster/state JSON
  - Uses MQTT LWT (online/offline) + retained birth message
  - All values and intervals are easy to tweak

  Hardware:
    - ESP32-P4 DevKit with PoE + external Ethernet PHY (RMII)

  Arduino IDE:
    - Board: ESP32 family supporting Ethernet - https://www.waveshare.com/product/arduino/boards-kits/esp32-p4/esp32-p4-eth.htm?sku=32088
    - Libraries: ArduinoJson, PubSubClient, ETH.h
*/

#include <Arduino.h>
#include <ETH.h>             // ESP32 internal MAC + external RMII PHY
#include <WiFi.h>            // needed by ETH.h in Arduino core
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

#include "../includes/secrets.h"         // define MQTT broker/user/pass etc.

// ------------------- Node identity -------------------
static const char* NODE_ID    = "esp32p4-01";
static const char* CLUSTER_ID = "weather";

// ------------------- MQTT setup ----------------------
WiFiClient ethClient;
PubSubClient mqtt(ethClient);

static const uint16_t MQTT_BUFFER_SIZE = 1024;
static unsigned long nextMqttAttemptMs = 0;

static const char* TOPIC_BASE    = "barkasse/esp32p4-01/weather/";      // + <sensor>
static const char* TOPIC_CLUSTER = "barkasse/esp32p4-01/weather/state"; // summary

// ------------------- Emulation parameters -------------
unsigned long lastPublish = 0;
const unsigned long PUBLISH_MS = 2000; // 2s interval for demo

// Pseudo-weather baseline
float tC = 19.5, rh = 55.0, p = 1012.0, wind = 1.0, windDir = 180.0;

// ------------------- Time (for ISO timestamps) --------
bool isTimeValid() {
  time_t now; time(&now);
  return (now > 1672531200); // After 2023-01-01 means NTP synced
}

static unsigned long lastNtpAttemptMs = 0;

// Ethernet link state (set by WiFiEvent handler)
static bool eth_connected = false;

void ensureTimeSynced() {
  if (!eth_connected) return;
  if (isTimeValid()) return;
  const unsigned long nowMs = millis();
  // Retry periodically so it recovers after replug / hub boot order issues
  if (nowMs - lastNtpAttemptMs < 30000UL) return; // 30s
  lastNtpAttemptMs = nowMs;
  Serial.println("[NTP] Attempting time sync...");
  configTime(0, 0, NTP_HOST);
}

String isoNow() {
  time_t now; time(&now);
  struct tm t; gmtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

// ------------------- MQTT helpers ---------------------
void publishJson(const String& topic, const JsonDocument& doc, bool retained=false) {
  static char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topic.c_str(), (const uint8_t*)buf, n, retained);
}


void publishSensor(const char* sensor, float value, const char* unit) {
  StaticJsonDocument<256> doc;
  doc["node"] = NODE_ID;
  doc["cluster"] = CLUSTER_ID;
  doc["sensor"] = sensor;
  doc["value"] = value;
  doc["unit"] = unit;
  doc["ts"] = isoNow();
  publishJson(String(TOPIC_BASE) + sensor, doc, false);
}

void publishCluster() {
  StaticJsonDocument<512> doc;
  doc["node"] = NODE_ID;
  doc["cluster"] = CLUSTER_ID;
  doc["ts"] = isoNow();
  JsonObject s = doc.createNestedObject("sensors");
  s["temperature"]["value"] = tC;      s["temperature"]["unit"] = "°C";
  s["humidity"]["value"] = rh;         s["humidity"]["unit"] = "%";
  s["pressure"]["value"] = p;          s["pressure"]["unit"] = "hPa";
  s["wind_speed"]["value"] = wind;     s["wind_speed"]["unit"] = "m/s";
  s["wind_dir"]["value"] = windDir;    s["wind_dir"]["unit"] = "°";
  publishJson(TOPIC_CLUSTER, doc, false);
}

// ------------------- Random walk for demo -------------
float jitter(float v, float step, float minv, float maxv) {
  float delta = (random(-100, 101)/100.0f) * step;
  v += delta;
  if (v < minv) v = minv;
  if (v > maxv) v = maxv;
  return v;
}

// ------------------- MQTT connect ---------------------
void mqttConnect() {
  const unsigned long nowMs = millis();
  if (nowMs < nextMqttAttemptMs) return;

  const bool ok = mqtt.connect(NODE_ID, MQTT_USER, MQTT_PASS);
  if (!ok) {
    // Backoff: 5s between attempts
    nextMqttAttemptMs = nowMs + 5000UL;
    Serial.print("[MQTT] Connect failed, state=");
    Serial.println(mqtt.state());
    return;
  }
  nextMqttAttemptMs = nowMs; // reset
}

// ------------------- Ethernet events ------------------
void WiFiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_ETH_START:
      ETH.setHostname(NODE_ID);
      break;
    case ARDUINO_EVENT_ETH_CONNECTED:
      break;
    case ARDUINO_EVENT_ETH_GOT_IP:
      eth_connected = true;
      Serial.println("[ETH] Link up + got IP");
      Serial.print("[ETH] IP: ");
      Serial.println(ETH.localIP());
      Serial.print("[ETH] GW: ");
      Serial.println(ETH.gatewayIP());
      Serial.print("[ETH] DNS: ");
      Serial.println(ETH.dnsIP());
      break;
    case ARDUINO_EVENT_ETH_DISCONNECTED:
    case ARDUINO_EVENT_ETH_STOP:
      eth_connected = false;
      Serial.println("[ETH] Link down");
      break;
    default: break;
  }
}

// ------------------- Setup ----------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Barkasse Weather Mock] Starting...");

  // PubSubClient defaults to 256 bytes; our JSON can exceed that.
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);
  mqtt.setKeepAlive(60);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);

  // Starting Ethernet (RMII PHY). Adjust pins/PHY type for your board if needed.
  // Common defaults work for many ESP32 + LAN8720 boards.
  WiFi.onEvent(WiFiEvent);
  ETH.begin(); // If your board needs explicit PHY params: ETH.begin(ETH_PHY_ADDR, ETH_PHY_POWER, ETH_PHY_MDC, ETH_PHY_MDIO, ETH_PHY_TYPE, ETH_CLK_MODE);

  Serial.println("[ETH] Waiting for link (non-blocking)...");
  Serial.println("[NTP] Will sync from hub when link is up...");
}

// ------------------- Loop -----------------------------
void loop() {
  if (eth_connected) {
    ensureTimeSynced();
    if (!mqtt.connected()) {
      mqttConnect();
    } else {
      mqtt.loop();
      
      // Only publish if time is valid
      if (isTimeValid()) {
        unsigned long now = millis();
        if (now - lastPublish > PUBLISH_MS) {
          lastPublish = now;

          // evolve demo values
          tC      = jitter(tC,   0.08, -5.0, 40.0);
          rh      = jitter(rh,   0.5,   0.0, 100.0);
          p       = jitter(p,    0.6, 950.0, 1050.0);
          wind    = jitter(wind, 0.2,   0.0, 20.0);
          windDir = fmod(jitter(windDir, 8.0, 0.0, 360.0), 360.0);

          // per-sensor topics
          publishSensor("temperature", tC, "°C");
          publishSensor("humidity",    rh, "%");
          publishSensor("pressure",    p,  "hPa");
          publishSensor("wind_speed",  wind, "m/s");
          publishSensor("wind_dir",    windDir, "°");

          // cluster summary
          publishCluster();
        }
      }
    }
  }
  delay(10);
}
