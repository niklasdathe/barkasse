/*
  Barkasse Water Demo (ESP32 WROOM + WiFi + MQTT)
  - Emulates a small water sensor cluster (temp, pH, turbidity, conductivity, level)
  - Publishes per-sensor + cluster/state JSON
  - Matches topic and payload format of the ESP32-P4 Ethernet weather mock

  Arduino IDE:
    - Board: ESP32
    - Libraries: ArduinoJson, PubSubClient, WiFi
*/

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

#include "secrets.h"  // WIFI_SSID, WIFI_PASS, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS

// ------------------- Node identity -------------------
static const char* NODE_ID    = "esp32wifi-01";
static const char* CLUSTER_ID = "water";
// ------------------- MQTT setup ----------------------
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

static const uint16_t MQTT_BUFFER_SIZE = 1024;
static unsigned long nextMqttAttemptMs = 0;

static const char* TOPIC_BASE    = "barkasse/esp32wifi-01/water/";      // + <sensor>
static const char* TOPIC_CLUSTER = "barkasse/esp32wifi-01/water/state"; // summary

// ------------------- Emulation parameters -------------
unsigned long lastPublish = 0;
const unsigned long PUBLISH_MS = 2000; // 2s interval for demo

// Pseudo-water baseline
float waterTemp = 18.0;   // °C
float ph        = 7.2;    // pH
float turbidity = 3.0;    // NTU
float cond      = 550.0;  // µS/cm
float levelCm   = 120.0;  // cm

// ------------------- Time (for ISO timestamps) --------
bool isTimeValid() {
  time_t now; time(&now);
  return (now > 1672531200); // After 2023-01-01 means NTP synced
}

static unsigned long lastNtpAttemptMs = 0;

void ensureTimeSynced() {
  if (WiFi.status() != WL_CONNECTED) return;
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
  (void)n;
  mqtt.publish(topic.c_str(), retained, buf);
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
  s["water_temp"]["value"] = waterTemp; s["water_temp"]["unit"] = "°C";
  s["ph"]["value"]         = ph;        s["ph"]["unit"]         = "pH";
  s["turbidity"]["value"]  = turbidity; s["turbidity"]["unit"]  = "NTU";
  s["conductivity"]["value"] = cond;    s["conductivity"]["unit"] = "µS/cm";
  s["water_level"]["value"] = levelCm;  s["water_level"]["unit"] = "cm";
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
    nextMqttAttemptMs = nowMs + 5000UL;
    Serial.print("[MQTT] Connect failed, state=");
    Serial.println(mqtt.state());
    return;
  }

  nextMqttAttemptMs = nowMs;
}

// ------------------- WiFi connect ---------------------
void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(NODE_ID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WiFi] Connecting to AP");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 60) { // ~30s max
    Serial.print(".");
    delay(500);
    attempts++;
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] FAILED to connect.");
  }
}

// ------------------- Setup ----------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[Barkasse Water Mock] Starting...");

  // PubSubClient defaults to 256 bytes; our JSON can exceed that.
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);
  mqtt.setKeepAlive(60);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);

  // WiFi STA connect
  wifiConnect();

  // Time (for timestamps) via SNTP
  Serial.println("[NTP] Synchronizing time...");
  lastNtpAttemptMs = millis() - 30000UL;
  ensureTimeSynced();

  // Wait for NTP sync (up to 10 seconds)
  int attempts = 0;
  while (!isTimeValid() && attempts < 20) {
    Serial.print(".");
    delay(500);
    attempts++;
  }
  if (isTimeValid()) {
    Serial.println(" time synced!");
    Serial.print("[NTP] Current time: ");
    Serial.println(isoNow());
  } else {
    Serial.println(" WARNING: Time sync failed! Timestamps may be incorrect.");
  }
}

// ------------------- Loop -----------------------------
void loop() {
  // keep WiFi alive (simple)
  if (WiFi.status() != WL_CONNECTED) {
    wifiConnect();
    delay(500);
  }

  // Keep retrying until we have valid timestamps
  ensureTimeSynced();

  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected()) {
      mqttConnect();
    } else {
      mqtt.loop();

      if (isTimeValid()) {
        unsigned long now = millis();
        if (now - lastPublish > PUBLISH_MS) {
          lastPublish = now;

          // evolve demo values
          waterTemp = jitter(waterTemp, 0.06, -2.0, 45.0);
          ph        = jitter(ph,        0.02,  6.0,  9.0);
          turbidity = jitter(turbidity, 0.10,  0.0, 50.0);
          cond      = jitter(cond,      5.0,  100.0, 2000.0);
          levelCm   = jitter(levelCm,   0.8,   0.0, 500.0);

          // per-sensor topics
          publishSensor("water_temp",   waterTemp, "°C");
          publishSensor("ph",           ph,        "pH");
          publishSensor("turbidity",    turbidity, "NTU");
          publishSensor("conductivity", cond,      "µS/cm");
          publishSensor("water_level",  levelCm,   "cm");

          // cluster summary
          publishCluster();
        }
      }
    }
  }
  delay(10);
}


