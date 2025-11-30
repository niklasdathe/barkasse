# Architektur-Erklärung: Barkasse Sensor-System

## Überblick: Was macht das System?

Das System sammelt Daten von verschiedenen Sensortypen (z.B. Temperatur, Feuchtigkeit, Druck) und zeigt sie auf einem Dashboard an. Die Sensoren können über verschiedene Kommunikationsprotokolle verbunden sein:

- **WiFi/Ethernet** (ESP32) - direkte MQTT-Verbindung
- **LoRaWAN** - Langstrecken-Funk für Batteriebetrieb
- **RS485/RS232** - Serielle Schnittstellen für industrielle Anwendungen
- **CAN Bus** - Für Automatisierung und Fahrzeuge

**Das Besondere:** NodeRED kann direkt mit allen diesen Protokollen arbeiten - keine separaten Bridge-Services nötig! Alle Sensordaten werden in einheitliche MQTT-Nachrichten konvertiert und dann vom gleichen Flow verarbeitet.

---

## Die drei Hauptkomponenten

### 1. **Sensoren (verschiedene Typen)**
- **WiFi/Ethernet Sensoren (ESP32):** Kleine Computer mit Sensoren, senden direkt MQTT
- **LoRaWAN Sensoren:** Batteriebetriebene Sensoren mit großer Reichweite
- **RS485/RS232 Sensoren:** Industrielle Sensoren über serielle Schnittstellen
- **CAN Sensoren:** Sensoren für Automatisierung und Fahrzeuge
- **Aufgabe:** Messen Werte und senden sie regelmäßig an den Hub
- **Beispiel:** Ein ESP32 misst alle 5 Minuten die Temperatur und sendet "22.4°C"

### 2. **MQTT Broker (Mosquitto)**
- **Was:** Ein "Postbote" für Nachrichten im Netzwerk
- **Aufgabe:** Empfängt Nachrichten von Sensoren (direkt oder über NodeRED) und verteilt sie an Abonnenten
- **Warum MQTT?** 
  - Sehr effizient für IoT-Geräte (wenig Energie, wenig Daten)
  - Funktioniert auch bei instabilen Netzwerkverbindungen
  - Einfaches "Publish/Subscribe"-Prinzip: Sensoren "publizieren", NodeRED "abonniert"

### 3. **NodeRED Hub**
- **Was:** Eine visuelle Programmiersprache für IoT-Anwendungen
- **Aufgabe:** 
  - Liest Daten direkt von verschiedenen Protokollen (RS485, RS232, CAN, LoRaWAN)
  - Konvertiert sie in einheitliche MQTT-Nachrichten
  - Verarbeitet, speichert und stellt sie für das Dashboard bereit
- **Wichtig:** NodeRED kann direkt mit Hardware kommunizieren - keine separaten Bridge-Services nötig!

---

## Was ist NodeRED?

**NodeRED** ist eine visuelle Programmiersprache, bei der man keine Code-Zeilen schreibt, sondern "Knoten" (Nodes) auf einem Bildschirm verbindet. Jeder Knoten hat eine bestimmte Aufgabe:

- **MQTT IN/OUT:** Empfängt/sendet Nachrichten vom/zum MQTT Broker
- **Serial IN/OUT:** Liest/schreibt von seriellen Schnittstellen (RS485, RS232)
- **Modbus:** Kommuniziert mit Modbus-Geräten über RS485
- **CAN:** Liest/schreibt CAN-Bus-Nachrichten
- **HTTP IN/OUT:** Stellt Webseiten/APIs bereit oder ruft APIs ab
- **Function:** Führt eigenen JavaScript-Code aus
- **WebSocket OUT:** Sendet Daten an verbundene Browser

**Warum NodeRED?**
- Keine komplexe Programmierung nötig
- Visuelles Drag-and-Drop Interface
- Perfekt für IoT-Projekte
- **Native Hardware-Unterstützung:** Direkte Kommunikation mit RS485, RS232, CAN ohne separate Programme
- Einfach zu erweitern und zu warten

---

## Unterstützte Sensortypen und Protokolle

Das System unterstützt verschiedene Sensortypen mit unterschiedlichen Kommunikationsprotokollen. **Das Besondere:** NodeRED kann direkt mit allen diesen Protokollen arbeiten - keine separaten Bridge-Services nötig! Alle Sensordaten werden innerhalb von NodeRED in einheitliche MQTT-Nachrichten konvertiert.

### Das Einheitsprinzip

**Alle Sensordaten landen letztendlich als MQTT-Nachrichten im Format:**
```
Topic: barkasse/<node>/<cluster>/<sensor>
Payload: {
  "node": "sensor-name",
  "cluster": "weather",
  "sensor": "temperature",
  "value": 22.4,
  "unit": "°C",
  "ts": "2025-01-10T12:00:00Z"
}
```

Der bestehende Flow (MQTT IN → Parse → Store → WebSocket) funktioniert für **alle** Sensortypen gleich!

---

### 1. WiFi/Ethernet Sensoren (ESP32) - Direkt MQTT

**Wie funktioniert es?**
- ESP32-Sensoren haben WiFi oder Ethernet
- Sie senden direkt MQTT-Nachrichten an den Mosquitto Broker
- **NodeRED Flow:** Einfach `[MQTT IN]` Node verwenden

**NodeRED Setup:**
```
[MQTT IN] → [Parse & expand sensors] → [Update LATEST/HISTORY] → [WebSocket OUT]
```

**Warum WiFi/Ethernet?**
- Einfachste Lösung
- Direkte Verbindung zum Netzwerk
- Geringe Latenz
- **Nachteil:** Benötigt Netzwerkzugang, höherer Energieverbrauch

---

### 2. RS485 Sensoren - Modbus über NodeRED

**Was ist RS485?**
- Serielles Kommunikationsprotokoll für industrielle Anwendungen
- Robust gegen Störungen (isolierte Signale)
- Kann viele Geräte an einem Bus verbinden (bis zu 32)
- Oft verwendet mit **Modbus RTU** Protokoll

**Hardware:** reTerminal DM hat RS485 Port auf `/dev/ttyACM1` (oder `/dev/ttyCH340USB1`)

**NodeRED Setup:**

1. **Modbus Node installieren:**
   - In NodeRED: Settings → Manage palette → Install
   - Suche nach: `node-red-contrib-modbus`
   - Oder per Kommandozeile: `cd ~/.node-red && npm install node-red-contrib-modbus`
   - NodeRED neu starten: `node-red-restart`

2. **Flow erstellen:**
   ```
   [Modbus Read] → [Function: Convert to Barkasse Format] → [MQTT OUT] → [MQTT IN] → [Parse] → ...
   ```

3. **Modbus Read Node konfigurieren:**
   - Serial Port: `/dev/ttyACM1` oder `/dev/ttyCH340USB1`
   - Baudrate: 9600 (oder wie Sensor konfiguriert)
   - Unit ID: 1 (Modbus Geräte-ID)
   - Register Type: Input Register
   - Address: 1 (Start-Adresse)
   - Quantity: 3 (Anzahl Register)
   - Rate: 5000ms (alle 5 Sekunden lesen)

4. **Function Node konvertiert zu Barkasse-Format:**
   ```javascript
   // Modbus liefert Register-Werte als Array
   let registers = msg.payload;
   
   // Konvertiere zu Barkasse-Format
   msg.payload = {
     node: "rs485-sensor-01",
     cluster: "industrial",
     sensor: "pressure",
     value: registers[0] / 10.0,  // Beispiel: Register-Wert durch 10
     unit: "bar",
     ts: new Date().toISOString()
   };
   
   // Sende als MQTT
   msg.topic = "barkasse/rs485-sensor-01/industrial/pressure";
   return msg;
   ```

5. **MQTT OUT Node:** Sendet an lokalen Broker (mosquitto)

**Vorteil:** Alles in NodeRED - keine separaten Python-Skripte nötig!

**Warum RS485?**
- Robust in industriellen Umgebungen
- Isoliert gegen elektrische Störungen
- Kann viele Sensoren an einem Bus verbinden
- **Nachteil:** Kabelgebunden, begrenzte Reichweite (~1200m)

**Referenz:** [reTerminal DM RS485 mit Node-RED](https://wiki.seeedstudio.com/reTerminal-DM-Node-Red-RS485/)

---

### 3. RS232 Sensoren - Serial Node in NodeRED

**Was ist RS232?**
- Älteres serielles Protokoll
- Einfacher als RS485
- Nicht isoliert (weniger robust)
- Typisch für direkte Punkt-zu-Punkt-Verbindungen

**Hardware:** reTerminal DM hat RS232 Port auf `/dev/ttyACM0` (oder `/dev/ttyCH340USB0`)

**NodeRED Setup:**

1. **Serial Node verwenden (bereits in NodeRED enthalten):**
   ```
   [Serial In] → [Function: Parse & Convert] → [MQTT OUT] → [MQTT IN] → [Parse] → ...
   ```

2. **Serial In Node konfigurieren:**
   - Serial Port: `/dev/ttyACM0` oder `/dev/ttyCH340USB0`
   - Baudrate: 9600
   - Databits: 8
   - Parity: None
   - Stopbits: 1

3. **Function Node parst und konvertiert:**
   ```javascript
   // RS232 liefert rohe Bytes/String
   let raw = msg.payload.toString();
   
   // Parse Sensor-Daten (abhängig vom Sensor-Format)
   // Beispiel: "TEMP:22.4,HUM:65"
   let parts = raw.split(',');
   let temp = parseFloat(parts[0].split(':')[1]);
   
   // Konvertiere zu Barkasse-Format
   msg.payload = {
     node: "rs232-sensor-01",
     cluster: "simple",
     sensor: "temperature",
     value: temp,
     unit: "°C",
     ts: new Date().toISOString()
   };
   
   msg.topic = "barkasse/rs232-sensor-01/simple/temperature";
   return msg;
   ```

**Vorteil:** Direkte Serial-Kommunikation in NodeRED!

**Warum RS232?**
- Einfach und günstig
- Gut für einfache Sensoren
- **Nachteil:** Nicht isoliert, begrenzte Reichweite (~15m)

---

### 4. CAN Bus Sensoren - CAN Node in NodeRED

**Was ist CAN?**
- Controller Area Network - ursprünglich für Autos entwickelt
- Sehr robust, fehlerkorrigierend
- Kann viele Geräte an einem Bus verbinden
- Unterstützt CAN FD (höhere Datenraten)

**Hardware:** reTerminal DM hat CAN Interface (`can0`)

**Vorbereitung (einmalig):**
```bash
sudo apt install can-utils
sudo ip link set can0 up type can bitrate 500000
sudo ifconfig can0 txqueuelen 1000
```

**NodeRED Setup:**

1. **CAN Node installieren:**
   - Suche nach: `node-red-contrib-socketcan` (für Linux SocketCAN)
   - Oder: `node-red-contrib-canbus`
   - Installieren über Manage palette

2. **Flow erstellen:**
   ```
   [CAN In] → [Function: Parse CAN Message] → [MQTT OUT] → [MQTT IN] → [Parse] → ...
   ```

3. **CAN In Node konfigurieren:**
   - Interface: `can0`
   - CAN ID Filter: Optional (z.B. nur bestimmte IDs)

4. **Function Node konvertiert:**
   ```javascript
   // CAN-Nachrichten haben ID und Daten
   let canId = msg.payload.id;
   let canData = msg.payload.data;  // Buffer/Array
   
   // Parse CAN-Daten (abhängig vom Sensor-Format)
   // Beispiel: 2 Bytes = Temperatur * 100
   let tempValue = (canData[0] << 8 | canData[1]) / 100.0;
   
   // Konvertiere zu Barkasse-Format
   msg.payload = {
     node: `can-${canId.toString(16)}`,
     cluster: "vehicle",
     sensor: "temperature",
     value: tempValue,
     unit: "°C",
     ts: new Date().toISOString()
   };
   
   msg.topic = `barkasse/can-${canId.toString(16)}/vehicle/temperature`;
   return msg;
   ```

**Vorteil:** Direkte CAN-Kommunikation in NodeRED!

**Warum CAN?**
- Sehr robust und fehlerkorrigierend
- Standard in Automatisierung und Fahrzeugen
- Kann viele Sensoren an einem Bus
- **Nachteil:** Komplexeres Protokoll, benötigt spezielle Hardware

**Referenz:** [reTerminal DM CAN BUS mit Node-RED](https://wiki.seeedstudio.com/reTerminal-DM-CANBUS-with-Node-RED/)

---

### 5. LoRaWAN Sensoren - HTTP API Integration

**Was ist LoRaWAN?**
- Funkprotokoll für sehr große Reichweiten (bis zu 15 km)
- Sehr energieeffizient (Batterien halten Monate/Jahre)
- Perfekt für Sensoren in abgelegenen Gebieten

**Hardware Setup (auf reTerminal DM):**
1. WM1302 LoRaWAN Module in Mini PCIe Slot installieren
2. SPI aktivieren: `sudo raspi-config` → Interface Options → SPI → Yes
3. Packet Forwarder kompilieren und starten:
   ```bash
   cd ~/
   git clone https://github.com/Lora-net/sx1302_hal
   cd sx1302_hal
   sudo make
   cp tools/reset_lgw.sh packet_forwarder/
   cd packet_forwarder
   sed -i 's/spidev0.0/spidev0.1/g' global_conf.json.sx1250.US915
   ./lora_pkt_fwd -c global_conf.json.sx1250.US915
   ```

**Architektur:**
```
LoRaWAN Sensor → Funk → LoRaWAN Gateway (WM1302) → 
Packet Forwarder → LoRaWAN Network Server → HTTP API → NodeRED
```

**NodeRED Setup:**

1. **LoRaWAN Network Server einrichten:**
   - Wähle einen LoRaWAN Network Server (z.B. TTN, ChirpStack, etc.)
   - Registriere Gateway mit EUI ID (wird beim Start von lora_pkt_fwd angezeigt)
   - Registriere Sensoren

2. **HTTP Request Node verwenden:**
   ```
   [Inject: Timer] → [HTTP Request: Get Sensor Data] → 
   [Function: Convert to Barkasse Format] → [MQTT OUT] → [MQTT IN] → [Parse] → ...
   ```

3. **Inject Node (Timer):**
   - Wiederholt alle 60 Sekunden
   - Löst HTTP-Request aus

4. **HTTP Request Node:**
   - Method: GET
   - URL: `https://your-lorawan-server.com/api/devices/{device-id}/data`
   - Headers: Authorization Token

5. **Function Node konvertiert:**
   ```javascript
   // LoRaWAN Server liefert JSON
   let lorawanData = msg.payload;
   
   // Konvertiere zu Barkasse-Format
   msg.payload = {
     node: lorawanData.device_id,
     cluster: "lorawan",
     sensor: lorawanData.sensor_type,
     value: lorawanData.value,
     unit: lorawanData.unit,
     ts: lorawanData.timestamp
   };
   
   msg.topic = `barkasse/${lorawanData.device_id}/lorawan/${lorawanData.sensor_type}`;
   return msg;
   ```

**Alternative:** Webhook von LoRaWAN Server zu NodeRED
- LoRaWAN Server kann HTTP-Webhooks senden
- NodeRED `[HTTP IN]` Node empfängt Webhook
- Konvertiert direkt zu Barkasse-Format

**Warum LoRaWAN?**
- Extrem große Reichweite
- Sehr energieeffizient
- Ideal für Batteriebetrieb
- **Nachteil:** Langsamere Datenübertragung, benötigt Gateway und Network Server

---

## Erweiterte Architektur mit allen Sensortypen

```
┌─────────────────┐
│  WiFi/ESP32     │ ────┐
│  Sensoren       │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│  LoRaWAN        │     │
│  Sensoren       │ ────┤
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│ LoRaWAN Gateway │     │
│  (WM1302)       │     │
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│ LoRaWAN Network │     │
│     Server      │     │
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│  HTTP Request   │ ────┤
│     Node        │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│  RS485 Sensoren │     │
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│  Modbus Read    │ ────┤
│     Node        │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│  RS232 Sensoren │     │
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│  Serial In      │ ────┤
│     Node        │     │
└─────────────────┘     │
                        │
┌─────────────────┐     │
│  CAN Sensoren   │     │
└─────────────────┘     │
         │              │
         ▼              │
┌─────────────────┐     │
│   CAN In        │ ────┤
│     Node        │     │
└─────────────────┘     │
                        │
                        ▼
                ┌───────────────┐
                │ MQTT Broker   │
                │  (Mosquitto)  │
                └───────────────┘
                        │
                        ▼
                ┌───────────────┐
                │  NodeRED Hub  │
                │               │
                │  [MQTT IN]    │  ← Einheitlicher Eingang!
                │       │       │
                │  [Parse]      │
                │       │       │
                │  [Store]      │
                │       │       │
                │  [WebSocket]  │
                └───────────────┘
                        │
                        ▼
                ┌───────────────┐
                │   Dashboard   │
                └───────────────┘
```

**Wichtig:** Alle Sensortypen konvertieren ihre Daten zu MQTT-Nachrichten. Der bestehende Flow (MQTT IN → Parse → Store → WebSocket) funktioniert für **alle** Sensortypen gleich!

---

## Warum native NodeRED-Integration?

### **Vorteile:**

1. **Alles in einem Tool:**
   - Keine separaten Python/Node.js-Skripte nötig
   - Alle Flows sichtbar im NodeRED-Editor
   - Einfacher zu debuggen und warten

2. **Visuelle Programmierung:**
   - Hardware-Kommunikation per Drag-and-Drop
   - Keine komplexe Programmierung nötig
   - Einfach zu erweitern

3. **Einheitliches Format:**
   - Alle Sensoren senden MQTT im Format `barkasse/<node>/<cluster>/<sensor>`
   - Bestehender Flow funktioniert für alle Sensortypen
   - Dashboard zeigt automatisch alle Sensoren

4. **Einfache Erweiterung:**
   - Neuer Sensortyp = neuer Flow-Tab in NodeRED
   - Bestehender Flow bleibt unverändert
   - Keine Code-Änderungen nötig

5. **Weniger Abhängigkeiten:**
   - Keine separaten Services zu starten
   - Alles läuft in NodeRED
   - Einfacher zu deployen

---

## Der NodeRED Flow im Detail

Der Flow funktioniert wie eine Pipeline mit mehreren Stationen:

```
Sensoren → MQTT → NodeRED Flow → WebSocket → Browser Dashboard
```

### Station 1: MQTT Empfang
```
[MQTT IN] - Hört auf alle Nachrichten unter "barkasse/#"
```
- Abonniert alle Sensordaten, die mit "barkasse/" beginnen
- Empfängt z.B. `barkasse/esp32-01/weather/temperature`

### Station 2: Daten Parsen & Aufteilen
```
[Parse & expand sensors] - JavaScript Funktion
```
**Was passiert hier?**
- Sensoren senden manchmal mehrere Messwerte in einer Nachricht:
  ```json
  {
    "node": "esp32-01",
    "cluster": "weather",
    "sensors": {
      "temperature": {"value": 22.4, "unit": "°C"},
      "humidity": {"value": 65, "unit": "%"}
    }
  }
  ```
- Diese Funktion teilt das in einzelne Nachrichten auf:
  - Eine für Temperatur
  - Eine für Feuchtigkeit
- **Warum?** Jeder Sensorwert kann dann einzeln verarbeitet und angezeigt werden

### Station 3: Speichern & Broadcasten
```
[Update LATEST/HISTORY + broadcast] - JavaScript Funktion
```
**Was passiert hier?**

1. **LATEST speichern:**
   - Speichert den neuesten Wert jedes Sensors im Arbeitsspeicher
   - Format: `"esp32-01/weather/temperature" → {value: 22.4, unit: "°C", ts: "2025-01-10T12:00:00Z"}`

2. **HISTORY speichern:**
   - Speichert alle numerischen Werte mit Zeitstempel für Diagramme
   - Begrenzt auf maximal 20.000 Datenpunkte pro Sensor (älteste werden gelöscht)
   - Format: `[{ts: "...", value: 22.4}, {ts: "...", value: 22.5}, ...]`

3. **Broadcast vorbereiten:**
   - Erstellt eine Nachricht für alle verbundenen Browser
   - Format: `{type: "update", data: {...}}`

### Station 4: WebSocket Ausgabe
```
[WebSocket OUT] - Sendet an alle verbundenen Browser
```
- Sendet die Broadcast-Nachricht an alle Browser, die mit `/ws` verbunden sind
- Browser erhalten sofort Updates, ohne ständig nachfragen zu müssen

### Zusatz-Flows:

#### **WebSocket Verbindung (Snapshot)**
Wenn ein Browser sich verbindet:
1. Browser öffnet WebSocket-Verbindung zu `/ws`
2. NodeRED sendet sofort einen "Snapshot" aller aktuellen Werte
3. Browser zeigt alle Sensoren sofort an, auch wenn er gerade erst gestartet wurde

#### **HTTP Endpunkte**

**GET /history**
- Browser fragt historische Daten für Diagramme ab
- Parameter: `?key=esp32-01/weather/temperature&period=1h`
- Gibt Daten für die letzten 1 Stunde, 1 Tag oder alle Daten zurück

**GET /debug/stats**
- Zeigt Statistiken: Wie viele Sensoren, wie viele Datenpunkte gespeichert

---

## Was sind WebSockets?

**Normale HTTP-Anfragen:**
- Browser fragt: "Gib mir die Daten"
- Server antwortet: "Hier sind die Daten"
- Browser muss immer wieder fragen (alle paar Sekunden)

**WebSockets:**
- Browser öffnet eine dauerhafte Verbindung
- Server kann jederzeit Daten senden, ohne dass der Browser fragt
- **Vorteil:** Echtzeit-Updates ohne ständiges Abfragen
- **Warum hier?** Sensordaten ändern sich unregelmäßig - WebSocket sendet nur bei Änderungen

---

## Die Frontend-Architektur (UI)

### Vanilla JavaScript (kein Framework)
- **Warum kein React/Vue/Angular?**
  - Für dieses Projekt zu komplex
  - Weniger Abhängigkeiten = einfacher zu warten
  - Schnellerer Start, weniger Code

### Hauptfunktionen:

1. **WebSocket-Verbindung**
   - Verbindet sich mit `/ws`
   - Empfängt "snapshot" beim Start
   - Empfängt "update" bei neuen Sensordaten

2. **Live-Tiles**
   - Zeigt jeden Sensor als "Kachel" an
   - Aktualisiert sich automatisch bei neuen Daten
   - Farbcodierung: Grün (< 3 Min alt), Gelb (3-60 Min), Rot (> 60 Min)

3. **Drag & Drop Diagramme**
   - Zwei feste Diagramm-Bereiche
   - Benutzer zieht eine Sensor-Kachel in ein Diagramm
   - Diagramm zeigt historische Daten (1h, 1d, max)
   - Lädt Daten über HTTP `/history` Endpunkt

4. **Canvas-basierte Diagramme**
   - Zeichnet Diagramme direkt im Browser (keine externe Bibliothek)
   - Warum Canvas statt Chart.js/D3.js?
     - Keine Abhängigkeiten
     - Volle Kontrolle über Darstellung
     - Leichtgewichtiger

---

## Datenfluss-Diagramm

```
┌─────────────┐
│   ESP32     │  misst Temperatur
│  Sensoren   │  ──────────────────┐
└─────────────┘                    │
                                   ▼
                          ┌─────────────────┐
                          │  Mosquitto MQTT │  "Postbote"
                          │     Broker      │  Port 1883
                          └─────────────────┘
                                   │
                                   │ MQTT Topic: barkasse/#
                                   ▼
                          ┌─────────────────┐
                          │   NodeRED Hub   │
                          │                 │
                          │  [MQTT IN]      │  Empfängt Nachricht
                          │       │         │
                          │  [Parse]        │  Teilt auf
                          │       │         │
                          │  [Store]        │  Speichert LATEST/HISTORY
                          │       │         │
                          │  [WebSocket OUT]│  Sendet Update
                          └─────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                    ▼              ▼              ▼
            ┌───────────┐  ┌───────────┐  ┌───────────┐
            │ Browser 1 │  │ Browser 2 │  │ Browser 3 │
            │ Dashboard │  │ Dashboard │  │ Dashboard │
            └───────────┘  └───────────┘  └───────────┘
                    │              │              │
                    └──────────────┼──────────────┘
                                   │
                                   ▼ HTTP GET /history
                          ┌─────────────────┐
                          │   NodeRED Hub   │
                          │  [HTTP IN]      │
                          │  [History]      │  Gibt Daten zurück
                          └─────────────────┘
```

---

## Warum diese Architektur?

### **MQTT statt direkter HTTP-Verbindung:**
- Sensoren können offline gehen und später nachsenden
- MQTT ist sehr energieeffizient (wichtig für Batteriebetrieb)
- Einfach neue Sensoren hinzufügen (nur MQTT konfigurieren)

### **NodeRED statt Python FastAPI:**
- Visuelle Programmierung = einfacher zu verstehen
- Keine komplexe Backend-Entwicklung nötig
- Einfach erweiterbar durch neue Knoten

### **WebSocket statt Polling:**
- Echtzeit-Updates ohne Server-Belastung
- Weniger Netzwerk-Traffic
- Bessere User Experience

### **In-Memory Storage (LATEST/HISTORY):**
- Sehr schnell (keine Datenbank nötig)
- Für dieses Projekt ausreichend (Raspberry Pi)
- Bei Neustart gehen Daten verloren, aber Sensoren senden ja kontinuierlich

---

## Zusammenfassung

**Das System funktioniert wie ein Nachrichtensystem:**

1. **Sensoren** senden Messwerte über verschiedene Protokolle:
   - **WiFi/Ethernet:** Direkt MQTT (ESP32)
   - **RS485:** Modbus Node → MQTT
   - **RS232:** Serial Node → MQTT
   - **CAN:** CAN Node → MQTT
   - **LoRaWAN:** HTTP Request Node → MQTT

2. **NodeRED konvertiert** alle Protokolle in einheitliche MQTT-Nachrichten

3. **MQTT Broker** sammelt alle Nachrichten (wie ein Briefkasten)

4. **NodeRED Flow** (MQTT IN → Parse → Store → WebSocket) verarbeitet **alle** Sensoren gleich

5. **Browser** verbinden sich über **WebSocket** und erhalten sofort alle Updates

6. **Diagramme** laden historische Daten über **HTTP** bei Bedarf

**Alle Technologien wurden gewählt, weil sie:**
- Einfach zu verstehen und zu warten sind
- Für IoT-Projekte optimiert sind
- Minimal Abhängigkeiten haben
- Auf einem Raspberry Pi/reTerminal DM gut laufen
- **Native NodeRED-Integration:** Alles in einem Tool, keine separaten Services

**Das Kernprinzip:**
- **Einheitliches Format:** Alle Sensoren senden MQTT-Nachrichten im Format `barkasse/<node>/<cluster>/<sensor>`
- **Protokoll-Abstraktion:** NodeRED konvertiert verschiedene Protokolle zu MQTT
- **Einfache Erweiterung:** Neuer Sensortyp = neuer Flow-Tab in NodeRED, bestehender Flow bleibt unverändert


