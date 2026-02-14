# Barkasse Hub — UI-Architektur

## Inhaltsverzeichnis

1.  [Übersicht](#1-übersicht)
2.  [HTML-Struktur](#2-html-struktur)
3.  [CSS-Design-System](#3-css-design-system)
4.  [JavaScript-Architektur](#4-javascript-architektur)
5.  [WebSocket-Kommunikation](#5-websocket-kommunikation)
6.  [Tile-System](#6-tile-system)
7.  [Graphen (Canvas-Rendering)](#7-graphen-canvas-rendering)
8.  [Touch-Interaktion & Drag-and-Drop](#8-touch-interaktion--drag-and-drop)
9.  [Manual-Input-Dialog](#9-manual-input-dialog)
10. [Header & Menü](#10-header--menü)
11. [Deployment & Kiosk-Modus](#11-deployment--kiosk-modus)

---

## 1. Übersicht

Das UI ist eine Single-Page-Anwendung ohne Build-Tools und ohne Frameworks:

| Datei | Zeilen | Funktion |
|---|---|---|
| `ui/index.html` | ~120 | DOM-Struktur, Meta-Tags, Script-/CSS-Einbindung |
| `ui/styles.css` | ~294 | Vollständiges Stylesheet mit CSS Custom Properties |
| `ui/app.js` | ~1709 | Gesamte Anwendungslogik |

**Design-Entscheidungen:**
- Vanilla JavaScript — kein React, Vue, Angular oder jQuery
- Kein Bundler/Transpiler — direkte Auslieferung über Node-RED `httpStatic`
- Canvas-basierte Graphen — kein Chart.js oder D3
- Optimiert für 10.1" IPS-Touch (1280×800, Seeed reTerminal DM)
- WebSocket für Echtzeit-Updates, HTTP für Historiendaten

---

## 2. HTML-Struktur

```html
<body>
  <header>
    <div class="status-indicator">     <!-- Verbindungsstatus-LED -->
    <h1>Barkasse Hub</h1>
    <button class="menu-btn">⋮</button> <!-- Header-Menü -->
    <div class="header-menu">           <!-- Dropdown-Menü -->
  </header>

  <main>
    <section id="topics">                <!-- Horizontaler Tile-Strip -->
      <!-- Dynamisch generierte .tile-Elemente -->
    </section>

    <section id="graphs">               <!-- 2 fixe Graph-Bereiche -->
      <div class="graph-tile" id="graph-0">
        <div class="graph-header">
          <span class="graph-label"></span>
          <div class="period-btns">      <!-- 1h | 1d | max -->
        </div>
        <canvas></canvas>
      </div>
      <div class="graph-tile" id="graph-1">
        <!-- Identische Struktur -->
      </div>
    </section>

    <div id="trash" class="trash-target"> <!-- Drag-Ziel: Tile entfernen -->
  </main>

  <div id="manual-overlay" class="modal-overlay">
    <!-- Manueller Eingabedialog -->
  </div>
</body>
```

### Viewport & Meta

```html
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
```

Das `user-scalable=no` verhindert Pinch-to-Zoom auf dem Touchscreen und sorgt für stabiles Layout.

---

## 3. CSS-Design-System

### Custom Properties (Auszug)

```css
:root {
  --tile-h: 120px;
  --tile-w: 200px;
  --card-radius: 16px;
  --card-bg: rgba(255, 255, 255, .8);
  --card-shadow: 0 2px 12px rgba(0,0,0,.08);
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --col-accent: #2979ff;
  --col-ok: #4caf50;
  --col-warn: #ff9800;
  --col-err: #f44336;
}
```

### Layout-Architektur

| Bereich | Layout | Eigenschaft |
|---|---|---|
| `body` | Flexbox Column | `height: 100vh`, kein Scroll |
| `header` | Flexbox Row | Fixe Höhe, z-index: 100 |
| `#topics` | Flexbox Row | `overflow-x: auto`, horizontaler Scroll |
| `#graphs` | Flexbox Row | 2 gleich große Bereiche, `flex: 1` |
| `.tile` | Inline-Block | Feste Größe `var(--tile-w) × var(--tile-h)` |
| `.graph-tile` | Flexbox Column | Canvas füllt verfügbaren Platz |

### Performance-Optimierungen

```css
.tile {
  contain: strict;        /* Layout-Isolation */
  will-change: transform; /* GPU-Layer für Drag */
}

canvas {
  image-rendering: pixelated; /* Scharfe Linien bei 1:1 Pixel */
}
```

- Kein `backdrop-filter` (zu teuer auf Pi GPU)
- Minimale Transitions (nur `opacity`, `transform`)
- `contain: strict` verhindert Layout-Thrashing bei Tile-Updates

### Responsive Anpassungen

Das CSS enthält Media Queries für schmalere Bildschirme, wobei der primäre Zielbildschirm der 10.1" IPS-Touch (1280×800) ist. Die Tile-Breite und Graph-Aufteilung werden entsprechend angepasst.

---

## 4. JavaScript-Architektur

### Globale Datenstrukturen

```javascript
const store    = {};        // Map: key → aktuelles Sensor-Payload
const lastSeen = {};        // Map: key → Timestamp (Date.now())
const mutedUntilNextUpdate = new Set();  // Keys die temporär stumm sind
```

- **`store`**: Spiegelt `global.LATEST` des Servers wider, wird über WebSocket-Snapshot initialisiert und durch Updates inkrementell aktualisiert.
- **`lastSeen`**: Lokaler Timestamp für die Frische-Anzeige (Status-LED).
- **`mutedUntilNextUpdate`**: Verhindert redundante Graph-Refreshes nach manuellen Aktionen.

### Initialisierung

```javascript
// Reihenfolge beim Laden:
1. DOM-Referenzen cachen
2. GraphTile-Instanzen erstellen (2 Stück)
3. WebSocket-Verbindung aufbauen
4. Event-Listener registrieren (Touch, Menu, Modal)
5. Update-Timer starten (LED-Refresh alle 30s)
```

### Modul-Übersicht (innerhalb app.js)

| Bereich | Zeilen (ca.) | Funktion |
|---|---|---|
| Konstanten & Globals | 1–50 | Store, Config, DOM-Referenzen |
| WebSocket | 50–150 | Verbindung, Reconnect, Message-Handler |
| Tile-Management | 150–400 | `ensureTile()`, `sortTiles()`, Status-LED |
| GraphTile-Klasse | 400–900 | Canvas-Rendering, Tooltip, Period-Buttons |
| Drag & Drop | 900–1200 | `installTouchDrag()`, Long-Press, Drop-Targets |
| Manual Input | 1200–1500 | Modal-Dialog, Validierung, API-Call |
| Header & Menu | 1500–1650 | Dropdown, Clear-History, Fullscreen |
| Hilfsfunktionen | 1650–1709 | `paintDot()`, `debounce()`, `formatValue()` |

---

## 5. WebSocket-Kommunikation

### Verbindungsaufbau

```javascript
const WS_URL = `wss://${location.host}/ws`;  // Oder ws:// ohne TLS
let ws = null;
let reconnectTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { /* Status-LED grün */ };
  ws.onclose = () => { scheduleReconnect(); };
  ws.onerror = () => { /* Status-LED rot */ };
  ws.onmessage = handleMessage;
}
```

### Reconnect-Strategie

Bei Verbindungsverlust wird nach 2 Sekunden automatisch eine neue Verbindung aufgebaut. Der Timer wird bei `onclose` gestartet und bei `onopen` gelöscht.

### Nachrichtentypen

| Typ | Richtung | Beschreibung |
|---|---|---|
| `snapshot` | Server → Client | Alle aktuellen Sensorwerte beim Verbindungsaufbau |
| `update` | Server → Client | Einzelnes Sensor-Update (inkrementell) |

**Snapshot-Handling:**
```javascript
function handleMessage(event) {
  const msg = JSON.parse(event.data);
  if (msg.type === 'snapshot') {
    // Alle Tiles erstellen/aktualisieren
    msg.data.forEach(item => processUpdate(item));
    sortTiles();
  } else if (msg.type === 'update') {
    processUpdate(msg.data);
  }
}
```

**processUpdate:**
```javascript
function processUpdate(payload) {
  const key = `${payload.node}/${payload.cluster}/${payload.sensor}`;
  store[key] = payload;
  lastSeen[key] = Date.now();
  ensureTile(key, payload);
  // Graphen aktualisieren, falls dieser Key angezeigt wird
  graphs.forEach(g => { if (g.key === key) g.addPoint(payload); });
}
```

---

## 6. Tile-System

### Tile-Lebenszyklus

```
WebSocket Update/Snapshot
    │
    └──▶ ensureTile(key, payload)
              │
              ├── Tile existiert? → Wert + LED aktualisieren
              │
              └── Neu? → DOM-Element erstellen:
                    ├── .tile-label  (Node/Cluster/Sensor)
                    ├── .tile-value  (Formatierter Wert + Einheit)
                    └── .tile-dot    (Status-LED)
                    + insertBefore → sortTiles()
                    + installTouchDrag()
```

### Tile-DOM-Struktur

```html
<div class="tile" data-key="hub/enclosure/temperature">
  <span class="tile-label">enclosure / temperature</span>
  <span class="tile-value">28.3 °C</span>
  <span class="tile-dot" style="background: #4caf50;"></span>
</div>
```

### Status-LED (`paintDot`)

Die LED-Farbe zeigt die Aktualität des letzten Updates:

| Zeitdifferenz | Farbe | CSS Variable |
|---|---|---|
| < 3 Minuten | Grün | `--col-ok` (#4caf50) |
| 3–60 Minuten | Gelb | `--col-warn` (#ff9800) |
| > 60 Minuten | Rot | `--col-err` (#f44336) |

Ein globaler Timer (`setInterval`, 30s) aktualisiert alle LEDs, damit sie auch ohne neue Daten korrekt altern.

### Tile-Sortierung

`sortTiles()` sortiert alle `.tile`-Elemente alphabetisch nach `data-key` und ordnet sie im DOM um. Wird nach jedem Snapshot und nach Tile-Erstellung aufgerufen.

---

## 7. Graphen (Canvas-Rendering)

### GraphTile-Klasse

```javascript
class GraphTile {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.canvas = this.container.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.key = null;          // Aktuell angezeigter Sensor-Key
    this.period = '1h';       // Aktiver Zeitraum
    this.data = [];           // Array von {ts, value}
    this.hoverIndex = -1;     // Tooltip-Position
  }
}
```

### Datenquellen nach Zeitraum

| Period | Quelle | Endpunkt | Aggregation |
|---|---|---|---|
| `1h` | In-Memory | `GET /history?period=1h` | Rohdaten |
| `1d` | In-Memory | `GET /history?period=1d` | Rohdaten |
| `max` | InfluxDB | `GET /history/influx?period=365d` | Auto (1h mean) |

### Canvas-Rendering

```javascript
paint() {
  const { ctx, canvas, data } = this;
  const W = canvas.width = canvas.clientWidth * devicePixelRatio;
  const H = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // 1. Hintergrund löschen
  // 2. Y-Achse: Min/Max mit 10% Padding
  // 3. X-Achse: Zeitbereich aus data[0].ts bis data[last].ts
  // 4. Gridlines zeichnen (horizontale Linien + Y-Labels)
  // 5. Linienzug zeichnen (Polyline)
  // 6. Hover-Tooltip bei hoverIndex
}
```

**Spezifika:**
- **HiDPI-Support**: Canvas-Auflösung wird mit `devicePixelRatio` skaliert.
- **Y-Padding**: 10% über Maximum und unter Minimum für Lesbarkeit.
- **Linienstil**: 2px Linie in `--col-accent`, keine Füllung.
- **Tooltip**: Vertikale Linie + Punkt + Wert-Label bei Hover/Touch.

### Hover/Touch-Interaktion

```javascript
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  // Finde nächsten Datenpunkt nach X-Position
  this.hoverIndex = findNearestIndex(x);
  this.paint();  // Repaint mit Tooltip
});
```

### Period-Buttons

Jeder Graph hat drei Buttons: **1h**, **1d**, **max**.
- Klick wechselt den Zeitraum und triggert `fetchHistory()`.
- Aktiver Button erhält CSS-Klasse `.active`.
- **1h/1d**: Laden aus In-Memory über `/history`.
- **max**: Lädt aus InfluxDB über `/history/influx`.

---

## 8. Touch-Interaktion & Drag-and-Drop

### Long-Press-to-Drag

Tiles sind per **Long-Press** (650 ms) in den Drag-Modus versetzbar. Dies verhindert versehentliches Drag beim Scroll.

```
pointerdown → Timer starten (650ms)
    │
    ├── pointermove > 10px vor Timer → Timer abbrechen (= Scroll)
    │
    └── Timer abgelaufen → Drag-Modus aktivieren
              │
              ├── pointermove → Tile folgt Finger (transform: translate)
              │        └── Hit-Test auf Drop-Targets (Graphen, Trash)
              │
              └── pointerup → Drop auslösen oder zurücksetzen
```

### Drop-Targets

| Ziel | Aktion |
|---|---|
| `.graph-tile` (Graph 0/1) | Sensor dem Graphen zuweisen → `fetchHistory()` |
| `#trash` | Tile stumm schalten (in `mutedUntilNextUpdate`) |

### Touch-Optimierungen

- **`touch-action: none`** auf Tiles während Drag (verhindert Browser-Scroll)
- **Pointer Events API** als primärer Handler (vereint Touch + Mouse)
- **Fallback**: Touch Events und Mouse Events für ältere Browser
- **`pointercancel`**: Cleanup bei System-Interrupts

### Visuelles Feedback

- Drag-Tile erhält `opacity: 0.6` und `z-index: 1000`
- Drop-Target erhält `.drag-over`-Klasse (z.B. Hintergrund-Highlight)
- Trash-Target wird sichtbar während Drag

---

## 9. Manual-Input-Dialog

### Aufruf

Das Modal wird über das Header-Menü geöffnet (Menüpunkt „Manueller Eintrag").

### Formular-Felder

| Feld | Typ | Pflicht | Beschreibung |
|---|---|---|---|
| Node | Text | Ja | Standard: `manual` |
| Cluster | Text | Ja | z.B. `kitchen`, `bilge` |
| Sensor | Text | Ja | z.B. `temperature`, `oil_level` |
| Value | Number | Ja | Numerischer Wert |
| Unit | Text | Nein | z.B. `°C`, `cm`, `bar` |

### Ablauf

```
Formular ausfüllen → Submit
    │
    └──▶ POST /api/manual { node, cluster, sensor, value, unit }
              │
              ├── 200 OK → Modal schließen, Wert erscheint als Tile
              └── 400 Error → Fehlermeldung im Modal
```

Der manuelle Wert wird serverseitig als MQTT-Nachricht publiziert und durchläuft die normale Pipeline (Parse → Store → Broadcast → InfluxDB).

---

## 10. Header & Menü

### Verbindungsstatus

Oben links zeigt ein farbiger Punkt den WebSocket-Status:

| Status | Farbe | Bedeutung |
|---|---|---|
| Connected | Grün | WebSocket-Verbindung aktiv |
| Disconnected | Rot | Verbindung unterbrochen |
| Reconnecting | Gelb | Reconnect-Versuch läuft |

### Dropdown-Menü (⋮)

| Menüpunkt | Aktion |
|---|---|
| **History löschen** | `POST /history/clear` — Löscht alle In-Memory-Historien |
| **Manueller Eintrag** | Öffnet Manual-Input-Modal |
| **Vollbild** | `document.documentElement.requestFullscreen()` |
| **Neu laden** | `location.reload()` |

Das Menü öffnet sich per Click/Touch auf den ⋮-Button und schließt automatisch bei Click außerhalb.

---

## 11. Deployment & Kiosk-Modus

### Statische Auslieferung

Das UI wird von Node-RED als statisches Verzeichnis ausgeliefert:

```javascript
// ~/.node-red/settings.js
httpStatic: '/home/hub/barkasse-hub/ui'
```

Dadurch sind die Dateien erreichbar unter:
- `https://barkasse:8443/index.html` (bzw. `/`)
- `https://barkasse:8443/app.js`
- `https://barkasse:8443/styles.css`

### Kiosk-Modus (Chromium)

`barkasse-fullscreen.service` startet Chromium im Kiosk-Modus:

```bash
chromium-browser \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --no-first-run \
  https://localhost:8443
```

**Absturz-Recovery:**
Der Service patcht vor jedem Start die Chromium-Preferences-Datei, um die "Chrome didn't shut down correctly"-Warnung zu unterdrücken:
```python
# Setzt exit_type: "Normal" und exited_cleanly: true
```

### Bildschirm-Dimensionen

| Eigenschaft | Wert |
|---|---|
| Auflösung | 1280 × 800 px |
| Diagonale | 10.1" |
| Typ | IPS, kapazitiv |
| Touch | Multi-Touch |
| Ausrichtung | Querformat (Standard) |

Die CSS-Variablen (`--tile-w: 200px`, `--tile-h: 120px`) sind auf diese Auflösung optimiert. Pro Tile-Strip-Zeile passen ca. 6 Tiles nebeneinander.
