# Barkasse Hub – UI-Architektur

## Inhaltsverzeichnis

1. [Überblick](#1-überblick)
2. [Technologie-Stack](#2-technologie-stack)
3. [Systemarchitektur-Diagramm](#3-systemarchitektur-diagramm)
4. [Dateistruktur](#4-dateistruktur)
5. [Datenfluss](#5-datenfluss)
6. [WebSocket-Protokoll](#6-websocket-protokoll)
7. [HTTP-API-Endpunkte](#7-http-api-endpunkte)
8. [Sensor-Key-Schema](#8-sensor-key-schema)
9. [In-Memory-Datenmodell](#9-in-memory-datenmodell)
10. [Lifecycle & Initialisierung](#10-lifecycle--initialisierung)

---

## 1. Überblick

Die Barkasse-Hub-UI ist ein **Single-Page-Dashboard** zur Echtzeit-Visualisierung von Sensordaten. Sie wurde speziell für den Einsatz auf einem **10-Zoll-Touchscreen** (Seeed reTerminal / Raspberry Pi) optimiert und läuft als Vollbild-Chromium-Kiosk-Anwendung.

### Kernfähigkeiten

| Feature | Beschreibung |
|---|---|
| **Live-Sensor-Kacheln** | Automatische Anzeige und Aktualisierung für jeden erkannten Sensor |
| **Drag & Drop** | Kacheln auf Graph-Bereiche ziehen für historische Daten |
| **Zwei fixe Graphen** | Canvas-basierte Diagramme ohne externe Libraries |
| **Touch-optimiert** | Long-Press-Drag, angepasste Scrollbars, keine nativen Context-Menüs |
| **Auto-Discovery** | Neue Sensoren erscheinen automatisch ohne UI-Änderungen |
| **Manuelle Eingabe** | Modal-Dialog zur manuellen Werterfassung |

### Design-Philosophie

- **Keine Build-Tools**: Kein Webpack, kein Bundler, kein npm – reine Browser-APIs
- **Keine externe Libraries**: Kein Chart.js, kein D3 – Canvas-Rendering in Eigenimplementierung
- **Performance-First**: `contain: strict`, reduzierte Transitions, keine `backdrop-filter`
- **Touch-First**: Entwickelt für Touchscreens mit Fallbacks für Maus-Interaktion

---

## 2. Technologie-Stack

```
┌─────────────────────────────────────────────────┐
│                  Browser (Chromium 109+)          │
│                                                   │
│  HTML5 ─── index.html (statisches Markup)        │
│  CSS3  ─── styles.css (Custom Properties, Grid)  │
│  ES6+  ─── app.js (WebSocket, Canvas, Drag&Drop) │
└─────────────┬───────────────────────────────────┘
              │ WebSocket (ws:// / wss://)
              │ HTTP (fetch)
┌─────────────▼───────────────────────────────────┐
│          Node-RED (Port 8080 / 8443 TLS)         │
│                                                   │
│  ├── Statische Dateien (ui/)                     │
│  ├── WebSocket-Endpunkt (/ws)                    │
│  ├── REST-API (/history, /history/clear,         │
│  │             /api/manual)                      │
│  └── MQTT-Subscriber (barkasse/#)                │
└─────────────┬───────────────────────────────────┘
              │ MQTT
┌─────────────▼───────────────────────────────────┐
│              Mosquitto (Port 1883)                │
│                                                   │
│  Topics: barkasse/<node>/<cluster>/<sensor>       │
└──────────────────────────────────────────────────┘
```

### Warum kein Framework?

Die Entscheidung gegen React/Vue/Angular ist bewusst:

1. **Deployment-Einfachheit**: Drei Dateien (`index.html`, `styles.css`, `app.js`) + ein Asset
2. **Keine Build-Pipeline**: Kein Node.js auf dem Entwicklungsrechner nötig
3. **Minimale Angriffsfläche**: Keine npm-Dependency-Chain, keine Supply-Chain-Risiken
4. **Raspberry-Pi-tauglich**: Kein Heavy-JS-Framework auf ARM-Hardware
5. **Wartbarkeit**: Ein einzelner Entwickler kann die gesamte Codebasis überblicken

---

## 3. Systemarchitektur-Diagramm

```
  ESP32 / Arduino           Raspberry Pi / reTerminal
  ┌──────────────┐          ┌─────────────────────────────────────────┐
  │  Sensor-Node │          │                                         │
  │              │──MQTT──▶ │  Mosquitto ──▶ Node-RED ──▶ WebSocket  │
  │  publishes   │          │    :1883        :8080        /ws       │
  │  barkasse/#  │          │                   │                     │
  └──────────────┘          │                   ├── /history (GET)    │
                            │                   ├── /history/clear    │
                            │                   ├── /api/manual       │
                            │                   └── /ui/* (static)    │
                            │                                         │
                            │  Chromium (Vollbild) ◄── localhost:8443 │
                            └─────────────────────────────────────────┘
```

---

## 4. Dateistruktur

```
ui/
├── index.html        # HTML-Grundgerüst (HUD-Layout, Graph-Container, Modal)
├── styles.css        # Gesamtes Styling (294 Zeilen, CSS Custom Properties)
├── app.js            # Gesamte Logik (1709 Zeilen, Vanilla JS)
└── assets/
    └── background.png  # Hintergrundbild für das Dashboard
```

### Verantwortlichkeiten

| Datei | Zeilen | Verantwortung |
|---|---|---|
| `index.html` | ~120 | DOM-Struktur, Semantische Bereiche, Modal-Markup, Asset-Loading |
| `styles.css` | ~294 | Layout (Flexbox/Grid), Theming (Custom Properties), Touch-Optimierung, Animationen |
| `app.js` | ~1709 | WebSocket-Verbindung, Tile-Verwaltung, Drag&Drop, Graph-Rendering, Touch-Events, Modal-Logik |

---

## 5. Datenfluss

### Echtzeit-Updates (WebSocket)

```
Sensor → MQTT publish → Mosquitto → Node-RED subscriber
                                         │
                                    JSON parse + enrichment
                                         │
                                    WebSocket broadcast
                                         │
                                    ┌────▼─────┐
                                    │  Browser  │
                                    │           │
                                    │ 1. store.set(key, payload)
                                    │ 2. lastSeen.set(key, Date.now())
                                    │ 3. render(payload)
                                    │    ├── ensureTile() → DOM-Element erstellen/updaten
                                    │    └── paintDot()   → Status-LED aktualisieren
                                    │ 4. Wenn Graph diesen Key zeigt:
                                    │    └── graph.addPoint(payload)
                                    └──────────┘
```

### Historische Daten (HTTP)

```
Benutzer zieht Kachel auf Graph
    │
    ▼
GraphTile.onDrop()
    │
    ├── this.key = draggedTile.dataset.k
    └── this.refresh()
          │
          ├── fetch(`/history?key=${k}&period=${period}`)
          │         │
          │         ▼
          │   Node-RED → In-Memory-Store → JSON-Response
          │         { unit: "°C", data: [{ts, value}, ...] }
          │
          └── this.render()  → Canvas zeichnen
```

---

## 6. WebSocket-Protokoll

### Verbindung

```javascript
const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
const url = protocol + location.host + '/ws';
ws = new WebSocket(url);
```

### Nachrichten-Typen

#### `snapshot` – Initiale Daten beim Verbinden

```json
{
  "type": "snapshot",
  "data": [
    {
      "node": "esp32p4-01",
      "cluster": "weather",
      "sensor": "temperature",
      "value": 22.4,
      "unit": "°C",
      "ts": "2025-10-10T12:00:00Z"
    },
    ...
  ]
}
```

Verarbeitung:
1. Für jedes Objekt: `store` und `lastSeen` aktualisieren
2. Kachel erstellen/aktualisieren (wenn nicht in `mutedUntilNextUpdate`)
3. Kacheln alphabetisch sortieren (nur wenn neue Kacheln hinzukamen)

#### `update` – Einzelner Sensor-Update

```json
{
  "type": "update",
  "data": {
    "node": "hub",
    "cluster": "enclosure",
    "sensor": "temperature",
    "value": 28.3,
    "unit": "°C",
    "ts": "2025-10-10T12:05:00Z"
  }
}
```

Verarbeitung:
1. `store` und `lastSeen` aktualisieren
2. Kachel erstellen/aktualisieren
3. Kacheln sortieren (nur wenn neue Kachel)
4. Alle Graphen aktualisieren, die diesen Key anzeigen (`graph.addPoint()`)

### Reconnect-Logik

- Bei `ws.onclose` oder `ws.onerror` → 4 Sekunden warten → `connectWS()` erneut aufrufen
- Verhindert mehrfache Timer durch Guard: `if (reconnectTimer) return;`
- Status-Anzeige im Header wechselt: `connecting…` → `live` → `disconnected` → `connecting…`

---

## 7. HTTP-API-Endpunkte

| Endpunkt | Methode | Beschreibung | Parameter |
|---|---|---|---|
| `/history` | GET | Historische Sensordaten abrufen | `key` (Sensor-Key), `period` (`1h`, `1d`, `max`) |
| `/history/clear` | POST | Gesamte oder einzelne History löschen | Optional: `key` (nur diesen Sensor löschen) |
| `/api/manual` | POST | Manuellen Sensorwert einspeisen | JSON-Body: `{node, cluster, sensor, value, unit}` |

### Beispiel: History abrufen

```
GET /history?key=hub/enclosure/temperature&period=1h
```

Response:
```json
{
  "unit": "°C",
  "data": [
    {"ts": "2025-10-10T11:00:00Z", "value": 27.1},
    {"ts": "2025-10-10T11:05:00Z", "value": 27.3},
    ...
  ]
}
```

### Beispiel: Manuellen Wert senden

```
POST /api/manual
Content-Type: application/json

{
  "node": "manual",
  "cluster": "kitchen",
  "sensor": "temperature",
  "value": 22.5,
  "unit": "°C"
}
```

---

## 8. Sensor-Key-Schema

Jeder Sensor wird über einen eindeutigen **Key** identifiziert:

```
Format:  <node>/<cluster>/<sensor>
Beispiel: esp32p4-01/weather/temperature
Fallback: esp32p4-01/weather/state  (wenn sensor fehlt)
```

Die Key-Erstellung in JavaScript:

```javascript
function key(o) {
  return `${o.node}/${o.cluster}/${o.sensor || 'state'}`;
}
```

### Key-Beispiele aus dem Produktivsystem

| Key | Beschreibung |
|---|---|
| `esp32p4-01/weather/temperature` | Außentemperatur (ESP32 Mock) |
| `esp32p4-01/weather/humidity` | Luftfeuchtigkeit (ESP32 Mock) |
| `hub/enclosure/temperature` | Gehäuse-Innentemperatur |
| `hub/enclosure/condensation_risk` | Kondensationsrisiko |
| `hub/gnss/lat` | GPS-Breitengrad |
| `hub/gnss/speed_kmh` | GPS-Geschwindigkeit |

---

## 9. In-Memory-Datenmodell

Die UI hält alle Daten **im Browser-Speicher** (keine IndexedDB, kein localStorage):

```javascript
// Letzte Sensorwerte: key → vollständiges Payload-Objekt
const store = new Map();
// Beispiel: "hub/enclosure/temperature" → {node, cluster, sensor, value, unit, ts}

// Zuletzt-gesehen-Timestamps: key → Date.now()
const lastSeen = new Map();
// Beispiel: "hub/enclosure/temperature" → 1728561900000

// Ausgeblendete Kacheln (durch Trash gelöscht): Set von Keys
const mutedUntilNextUpdate = new Set();

// DOM-Element-Cache: key → HTMLElement
const tileEls = new Map();
```

### Lebenszyklus der Daten

1. **Verbindung hergestellt** → `snapshot` füllt `store` und `lastSeen`
2. **Laufende Updates** → `update` aktualisiert einzelne Einträge
3. **Kachel löschen** → Key wird zu `mutedUntilNextUpdate` hinzugefügt, Tile wird ausgeblendet
4. **Neuer Update für gelöschten Sensor** → Key wird aus `mutedUntilNextUpdate` entfernt, Tile erscheint wieder
5. **Browser-Refresh** → Alle Daten gehen verloren, `snapshot` bei Reconnect stellt Zustand wieder her

---

## 10. Lifecycle & Initialisierung

### Boot-Sequenz

```
1. systemd startet barkasse-ui.service (Node-RED)
2. systemd startet barkasse-fullscreen.service (Chromium)
   a. ExecStartPre: Warte auf Xauthority (bis 30s)
   b. ExecStartPre: Warte auf X11-Socket (bis 30s)
   c. ExecStartPre: Warte auf HTTPS :8443 (bis 30s)
   d. ExecStart: Chromium --start-fullscreen https://localhost:8443/
3. Browser lädt index.html → styles.css → app.js
4. app.js: connectWS() → WebSocket-Verbindung
5. Server sendet snapshot → Kacheln werden erstellt
6. Laufende updates → Kacheln werden aktualisiert
7. Status-Dots werden alle 30s aktualisiert (setInterval)
```

### JavaScript-Initialisierungsreihenfolge

```javascript
// 1. DOM-Elemente cachen
const topics = document.getElementById('topics');
const conn = document.getElementById('conn');
// ...

// 2. Context-Menü des Browsers unterdrücken
document.addEventListener('contextmenu', ...);

// 3. Graph-Instanzen erstellen
const graph1 = new GraphTile(document.getElementById('graph-1'));
const graph2 = new GraphTile(document.getElementById('graph-2'));

// 4. Event-Listener registrieren (Trash, Header-Menü)
trash.addEventListener('dragover', ...);
trash.addEventListener('drop', ...);
headerMenuBtn.addEventListener('click', ...);

// 5. WebSocket-Verbindung starten
connectWS();
```
