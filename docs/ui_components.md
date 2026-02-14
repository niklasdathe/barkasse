# Barkasse Hub – UI-Komponenten (Referenz)

## Inhaltsverzeichnis

1. [HTML-Struktur (index.html)](#1-html-struktur)
2. [Sensor-Kacheln (Tiles)](#2-sensor-kacheln-tiles)
3. [Graph-Bereiche (GraphTile-Klasse)](#3-graph-bereiche-graphtile-klasse)
4. [Drag & Drop System](#4-drag--drop-system)
5. [Touch-Drag-System](#5-touch-drag-system)
6. [Kontextmenüs](#6-kontextmenüs)
7. [Header-Menü](#7-header-menü)
8. [Manual-Input-Modal](#8-manual-input-modal)
9. [Verbindungsstatus-Anzeige](#9-verbindungsstatus-anzeige)
10. [Trash-Drop-Target](#10-trash-drop-target)

---

## 1. HTML-Struktur

Die `index.html` definiert ein vertikales Flex-Layout (`#hud`) mit folgenden Bereichen:

```
┌──────────────────────────────────────────────────┐
│  #bg (Hintergrundbild, position:fixed)           │
├──────────────────────────────────────────────────┤
│  #hud (Flex-Container, 100vh)                    │
│  ┌──────────────────────────────────────────────┐│
│  │  <header>                                    ││
│  │  ┌──────────┐              ┌───────┐ ┌─┐    ││
│  │  │ SENSOR-  │              │ live  │ │⋮│    ││
│  │  │   HUB    │              └───────┘ └─┘    ││
│  │  └──────────┘              #conn   menu-btn ││
│  └──────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────┐│
│  │  #topics-wrap (margin-top: 100px)            ││
│  │  ┌──────────────────────────────────────┐    ││
│  │  │  #topics (horizontal scroll)         │    ││
│  │  │  ┌──────┐ ┌──────┐ ┌──────┐ ───▶   │    ││
│  │  │  │ Tile │ │ Tile │ │ Tile │   ...   │    ││
│  │  │  └──────┘ └──────┘ └──────┘         │    ││
│  │  └──────────────────────────────────────┘    ││
│  └──────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────┐│
│  │  #graphs (CSS Grid: 2 Spalten)               ││
│  │  ┌──────────────────┐ ┌──────────────────┐   ││
│  │  │  Graph #1        │ │  Graph #2        │   ││
│  │  │  ┌─────────────┐ │ │  ┌─────────────┐ │   ││
│  │  │  │  <canvas>   │ │ │  │  <canvas>   │ │   ││
│  │  │  └─────────────┘ │ │  └─────────────┘ │   ││
│  │  │  [1h] [1d] [max] │ │  [1h] [1d] [max] │   ││
│  │  └──────────────────┘ └──────────────────┘   ││
│  └──────────────────────────────────────────────┘│
│                                          ┌──────┐│
│                                          │🗑️    ││
│  Trash (fixed, bottom-right)             │ Drop ││
│                                          │ here ││
│                                          └──────┘│
├──────────────────────────────────────────────────┤
│  #manual-modal (display:none)                    │
│  ┌──────────────────────────────────────────┐    │
│  │  Modal: Manual Value Input               │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### Semantische Bereiche

| ID / Element | ARIA | Funktion |
|---|---|---|
| `<header>` | — | Titel "SENSOR-HUB", Verbindungsstatus, Menü-Button |
| `#topics-wrap` | `aria-label="Topics"` | Wrapper für die horizontale Sensor-Kachelleiste |
| `#topics` | `aria-live="polite"` | Container für dynamische Sensor-Kacheln |
| `#graphs` | `<main>` | Hauptinhalt: zwei Graph-Bereiche |
| `#graph-1`, `#graph-2` | `aria-label="History graph ... drop target"` | Graph-Karten mit Canvas, Perioden-Buttons, Hinweis-Text |
| `#trash` | `aria-label="Drop here to remove tile"` | Papierkorb-Drop-Zone |
| `#manual-modal` | — | Overlay-Modal für manuelle Eingaben |

---

## 2. Sensor-Kacheln (Tiles)

### Erstellung

Kacheln werden **dynamisch** durch `ensureTile(o)` erzeugt, wenn ein neuer Sensor erkannt wird. Es gibt kein statisches Tile-Markup in `index.html`.

### DOM-Struktur einer Kachel

```html
<div class="tile" data-k="hub/enclosure/temperature" draggable="true">
  <span class="dot" aria-hidden="true"></span>     <!-- Status-LED -->
  <h3>enclosure / temperature</h3>                 <!-- cluster / sensor -->
  <div class="meta node">hub</div>                 <!-- Node-Name -->
  <div class="value">
    <span class="num">28.30</span>                 <!-- Formatierter Wert -->
    <span class="unit">°C</span>                   <!-- Einheit -->
  </div>
  <div class="meta ts">2025-10-10T12:05:00Z</div>  <!-- Timestamp -->
</div>
```

### Wichtige Attribute

| Attribut | Beschreibung |
|---|---|
| `data-k` | Eindeutiger Sensor-Key (`node/cluster/sensor`) |
| `draggable="true"` | Aktiviert HTML5-Drag für Maus |
| `class="tile"` | CSS-Klasse für Styling |
| `class="opacity-0"` | Initiale Klasse für Fade-in-Animation (wird per `requestAnimationFrame` entfernt) |

### Lebenszyklus einer Kachel

```
1. Sensor-Daten empfangen (WebSocket)
     │
2. ensureTile(payload)
     │
     ├── Kachel existiert NICHT:
     │     a. createElement('div')
     │     b. innerHTML setzen (dot, h3, meta, value, ts)
     │     c. topics.appendChild(el)
     │     d. requestAnimationFrame → opacity-0 entfernen (Fade-in)
     │     e. draggable="true" setzen
     │     f. Event-Listener: dragstart, dragend, contextmenu
     │     g. installTouchDrag(el)
     │     h. tileEls.set(key, el)
     │
     ├── Kachel existiert:
     │     a. querySelector / Cache-Lookup
     │     b. updateTileContent(el, payload)
     │
3. paintDot(el)  → Status-LED-Farbe aktualisieren
4. sortTiles()   → Alphabetisch neu ordnen (nur bei neuen Kacheln)
```

### Status-Dot (Frische-Indikator)

Der farbige Punkt oben rechts auf jeder Kachel zeigt an, wie aktuell die Daten sind:

| Farbe | Berechnung | Bedeutung |
|---|---|---|
| 🟢 Grün (`#2ecc71`) | `< 3 Minuten` seit letztem Update | Frische Daten |
| 🟡 Gelb (`#f1c40f`) | `3–60 Minuten` seit letztem Update | Veraltende Daten |
| 🔴 Rot (`#e74c3c`) | `> 60 Minuten` seit letztem Update | Alte Daten |
| ⚪ Grau (`#bbb`) | Sensor noch nie gesehen | Unbekannt |

Die Dots werden aktualisiert:
- Bei jedem eingehenden Sensor-Update (`render()` → `paintDot()`)
- Periodisch alle 30 Sekunden per `setInterval`

### Wertformatierung

```javascript
function formatValue(v) {
  if (v === undefined || v === null || v === '') return '—';  // Strich für fehlende Werte
  if (typeof v === 'number') return v.toFixed(2);             // 2 Nachkommastellen
  return String(v);                                            // Alles andere als String
}
```

### Sortierung

Kacheln werden alphabetisch nach ihrem Key sortiert:

```javascript
function sortTiles() {
  const arr = Array.from(topics.children)
    .filter(el => el.classList.contains('tile') && el.dataset.k);
  arr.sort((a, b) => a.dataset.k.localeCompare(b.dataset.k));
  arr.forEach(el => topics.appendChild(el));  // Re-Append in sortierter Reihenfolge
}
```

Die Sortierung wird nur ausgelöst, wenn **neue Kacheln** hinzukommen (nicht bei Updates).

---

## 3. Graph-Bereiche (GraphTile-Klasse)

### Überblick

Die UI verfügt über **zwei fixe Graph-Bereiche** (`#graph-1` und `#graph-2`). Beide werden als Instanzen der `GraphTile`-Klasse verwaltet. Es können keine weiteren Graphen hinzugefügt oder entfernt werden.

### GraphTile-Klasse – Eigenschaften

| Eigenschaft | Typ | Beschreibung |
|---|---|---|
| `el` | `HTMLElement` | Root-DOM-Element des Graphen |
| `period` | `string` | Aktiver Zeitraum: `'1h'`, `'1d'`, `'max'` |
| `key` | `string \| null` | Sensor-Key der angezeigten Daten (null = leer) |
| `data` | `Array \| null` | Geladene Datenpunkte `[{ts, value}, ...]` |
| `unit` | `string \| null` | Einheit der Y-Achse (z. B. `°C`) |
| `hoverX` | `number \| null` | X-Position des Hovers/Touch (für Tooltip) |
| `title` | `HTMLElement` | `.chart-title` Titel-Element |
| `canvas` | `HTMLCanvasElement` | `<canvas>` für das Diagramm |
| `hint` | `HTMLElement` | `.chart-hint` Hinweis-Text |
| `buttons` | `Array<HTMLElement>` | Perioden-Buttons (`1h`, `1d`, `max`) |
| `resizeObserver` | `ResizeObserver` | Beobachtet Container-Größenänderungen |

### GraphTile-Klasse – Methoden

| Methode | Beschreibung |
|---|---|
| `constructor(rootEl, key, period)` | Initialisiert DOM-Referenzen, Event-Listener, ResizeObserver |
| `destroy()` | Trennt den ResizeObserver |
| `syncButtons()` | Aktualisiert die `active`-Klasse der Perioden-Buttons |
| `onPeriodClick(e)` | Handler für Perioden-Button-Klicks → `refresh()` |
| `onPointerDown(e)` | Setzt Pointer-Capture für Touch-Scrubbing |
| `onPointerMove(e)` | Aktualisiert `hoverX` und rendert Tooltip |
| `onPointerUp(e)` | Entfernt Tooltip und Pointer-Capture |
| `onPointerLeave(e)` | Entfernt Tooltip (wenn kein aktiver Capture) |
| `onDragOver(e)` | Visuelles Feedback beim Drag über den Graphen |
| `onDragLeave(e)` | Entfernt visuelles Drag-Feedback |
| `onDrop(e)` | Setzt `this.key` und ruft `refresh()` auf |
| `reset()` | Leert Titel, Hinweis und Canvas |
| `resizeCanvas()` | Passt Canvas-Auflösung an Container und DPR an |
| `refresh()` | Lädt Daten vom Server (`fetchHistory`) und rendert |
| `addPoint(o)` | Fügt Datenpunkt hinzu und rendert (ohne Server-Fetch) |
| `render()` | Zeichnet das Diagramm auf das Canvas |

### Canvas-Rendering im Detail

Das Diagramm wird vollständig mit der **Canvas 2D API** gezeichnet, ohne externe Libraries:

```
┌─────────────────────────────────────────────────────┐
│ padT=12                                             │
│  ┌────────────────────────────────────────────────┐ │
│  │  Y-Achse    Daten-Linie                        │ │
│p │  Labels     ─────────────────────┐             │p│
│a │  27.10      ┌──────────────────  │ ●(letzter)  │a│
│d │  26.85      │   ╱╲     ╱╲       │ 28.30 °C    │d│
│L │  26.60      │  ╱  ╲   ╱  ╲      │             │R│
│= │  26.35      │ ╱    ╲ ╱    ╲     │             │=│
│50│  26.10      │╱      ╳      ╲    │             │12│
│  │             └──────────────────  │             │ │
│  │  Grid-Linien (α=0.12)           │             │ │
│  └────────────────────────────────────────────────┘ │
│                 padB=24 (X-Achse)                   │
└─────────────────────────────────────────────────────┘
```

#### Render-Schritte

1. **Canvas leeren**: `ctx.clearRect()`
2. **Achsen zeichnen**: L-förmig (Y-Achse links, X-Achse unten)
3. **Y-Achse Grid**: 5 Linien (`i=0..4`) mit Labels und semi-transparenten Hilfslinien
4. **Datenlinie**: `ctx.beginPath()` → `moveTo/lineTo` für jeden Datenpunkt
5. **Letzter Punkt**: Kreis + Label mit aktuellem Wert
6. **Tooltip** (bei Hover/Touch):
   - Vertikale gestrichelte Linie
   - Highlight-Kreis auf dem nächsten Datenpunkt
   - Tooltip-Box mit Datum, Uhrzeit und Wert

#### High-DPI-Unterstützung

```javascript
resizeCanvas() {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  this.canvas.width = cssW * dpr;   // Interne Auflösung
  this.canvas.height = cssH * dpr;
  this.canvas.style.width = cssW + 'px';   // CSS-Größe
  this.canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // Skalierung
}
```

#### Tooltip-Rendering

Der Tooltip reagiert auf **Pointer Events** (Maus und Touch gleichermaßen):

- **Touch**: Finger auf Canvas → Tooltip erscheint → Scrubbing über Datenpunkte
- **Maus**: Hover über Canvas → Tooltip folgt der Maus
- Tooltip wird intelligently positioniert (links/rechts/oben/unten, je nach Platz)
- Zeigt: Datum, Uhrzeit, Wert + Einheit

### Perioden-Auswahl

| Button | Period | Beschreibung |
|---|---|---|
| `1h` | `'1h'` | Letzte Stunde |
| `1d` | `'1d'` | Letzter Tag (24h) |
| `max` | `'max'` | Alle verfügbaren Daten |

Bei Klick: `this.period = ...` → `this.refresh()` → Server-Fetch → Render.

### Live-Daten (addPoint)

Wenn ein WebSocket-Update eintrifft und ein Graph diesen Sensor anzeigt, wird `addPoint()` aufgerufen:

```javascript
addPoint(o) {
  this.data.push({ ts: o.ts, value: o.value });
  
  // Alte Daten entfernen basierend auf Periode
  if (this.period !== 'max') {
    const ms = this.period === '1d' ? 86400000 : 3600000;
    const cutoff = Date.now() - ms;
    while (this.data.length > 0 && new Date(this.data[0].ts).getTime() < cutoff) {
      this.data.shift();
    }
  }
  this.render();
}
```

---

## 4. Drag & Drop System

### Übersicht

Es gibt **zwei parallele Drag-Systeme**:

1. **HTML5 Drag and Drop** (für Desktop/Maus)
2. **Custom Touch Drag** (für Touchscreens, da HTML5 DnD auf Touch unzuverlässig ist)

### HTML5 Drag & Drop (Maus)

#### Drag-Start

```javascript
function onTileDragStart(e) {
  draggedTile = e.currentTarget;
  draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k);
  showTrash();  // Papierkorb einblenden
}
```

#### Drop-Targets

| Target | Event | Aktion |
|---|---|---|
| `GraphTile` (`.graph-tile`) | `dragover` → `drop` | Graph zeigt History für den gedragten Sensor |
| `#trash` | `dragover` → `drop` | Kachel wird ausgeblendet (muted) |

#### Drag-End

```javascript
function onTileDragEnd() {
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  hideTrash();
}
```

---

## 5. Touch-Drag-System

### Warum ein eigenes System?

HTML5 Drag and Drop funktioniert auf **vielen Touchscreens nicht zuverlässig**, insbesondere:
- reTerminal mit X11
- Chromium auf Linux ARM (Pointer-Typ `mouse` trotz Touch-Hardware)
- Ältere Embedded-Browser ohne PointerEvent-Support

### Architektur

```
                    installTouchDrag(tileEl)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
    Pointer Events    Touch Events   Mouse Events
   (bevorzugt)       (Fallback)     (X11-Fallback)
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┼─────────────┐
              ▼            ▼             ▼
       Long-Press      Vertical       Horizontal
       (650ms)         Move           Swipe
        │               │              │
        ▼               ▼              ▼
    openTileMenu()  startTouchDrag()  → ignoriert
                        │               (Scroll)
                        ▼
                  ┌──────────────┐
                  │ Drag-Overlay │
                  │ (full-screen)│
                  │ + Ghost-Tile │
                  └──────────────┘
                        │
              ┌─────────┼──────────┐
              ▼         ▼          ▼
          Drop on    Drop on    Drop on
          Graph      Trash      Nothing
              │         │          │
              ▼         ▼          ▼
          refresh()  mute+hide   cancel
```

### Gesten-Erkennung

| Geste | Bedingung | Ergebnis |
|---|---|---|
| **Tap** | Kein Move über Threshold | Nichts (normales Click-Verhalten) |
| **Long-Press** (650ms) | Kein Move, Timer läuft ab | Kontextmenü öffnen |
| **Horizontal Swipe** | `abs(dx) > abs(dy) + 4px` | Ignoriert (Scroll-Geste für Topic-Strip) |
| **Vertical Drag** | `abs(dy) > abs(dx) + 4px` UND > 10px | Touch-Drag starten |

### Schwellenwerte

```javascript
const MOVE_THRESHOLD_PX = 10;           // Mindest-Bewegung für Drag
const VERTICAL_INTENT_BIAS_PX = 4;     // Extra Pixel, die dy größer sein muss als dx
const MENU_HOLD_MS = 650;               // Long-Press Dauer für Kontextmenü
```

### Event-Priorisierung

Die `installTouchDrag()`-Funktion inspiziert die Umgebung und wählt:

1. **PointerEvent** (bevorzugt): `pointerdown`, `pointermove`, `pointerup/cancel`
   - Nutzt `setPointerCapture` für zuverlässigen Event-Empfang
   - Erkennt `pointerType` (`touch`, `pen`, `mouse`)
2. **TouchEvent** (Fallback): `touchstart`, `touchmove`, `touchend/cancel`
   - Für ältere Browser ohne PointerEvent
3. **MouseEvent** (X11-Fallback): `mousedown`, `mousemove`, `mouseup`
   - Nur wenn `isLikelyTouchEnvironment()` true ist
   - Für Touchscreens, die Mouse-Events emulieren

### Touch-Umgebungserkennung

```javascript
const isLikelyTouchEnvironment = () => {
  const maxTp = Number(navigator.maxTouchPoints || 0);
  const hoverNone = window.matchMedia?.("(hover: none)").matches;
  return maxTp > 0 || hoverNone;
};
```

### Ghost-Tile und Overlay

Beim Touch-Drag werden zwei Elemente erstellt:

1. **Drag-Overlay** (`div.drag-overlay`): Unsichtbares Vollbild-Element (z-index: 1800)
   - Fängt alle Move/Up-Events ab
   - Verhindert unbeabsichtigte Interaktionen
   - `touch-action: none` (CSS)
2. **Ghost-Tile** (`div.tile-ghost`): Visueller Klon der gezogenen Kachel
   - `position: fixed; z-index: 2000`
   - Folgt dem Finger per `transform: translate()`
   - `pointer-events: none`

### Hit-Test (Drop-Target-Erkennung)

Die Drop-Targets werden **beim Drag-Start gecached**, um Layout-Thrashing zu vermeiden:

```javascript
const targets = [];
document.querySelectorAll('.graph-tile[data-graph="true"]').forEach(el => {
  targets.push({ el, rect: el.getBoundingClientRect(), type: 'graph' });
});
const trashEl = document.getElementById('trash');
if (trashEl) targets.push({ el: trashEl, rect: trashEl.getBoundingClientRect(), type: 'trash' });
```

Während des Drags wird per einfacher Rechteck-Kollision geprüft:

```javascript
for (const t of touchDragState.targets) {
  if (clientX >= t.rect.left && clientX <= t.rect.right &&
      clientY >= t.rect.top && clientY <= t.rect.bottom) {
    // Treffer
  }
}
```

---

## 6. Kontextmenüs

### Tile-Kontextmenü

Wird geöffnet durch:
- **Maus**: Rechtsklick auf eine Kachel
- **Touch**: Long-Press (650ms) auf eine Kachel

```html
<div class="tile-menu" style="left: Xpx; top: Ypx;">
  <button class="menu-item" data-action="clear">Clear history…</button>
</div>
```

**Aktionen:**

| Aktion | Beschreibung |
|---|---|
| `clear` | Löscht die History für diesen einen Sensor (nach Bestätigung via `confirm()`) |

Das Menü wird geschlossen durch:
- Klick außerhalb des Menüs
- Auswahl einer Aktion
- Start eines neuen Drags

### Natives Context-Menü

Das native Browser-Kontextmenü wird **global unterdrückt**:

```javascript
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
}, { capture: true });
```

Dies ist notwendig, da auf Touchscreens das natürliche Long-Press-Menü des Browsers die eigene Long-Press-Logik stören würde.

---

## 7. Header-Menü

Zugang über den `⋮`-Button (drei Punkte) oben rechts:

```html
<div class="tile-menu">
  <button class="menu-item" data-action="manual-input">Input manual value…</button>
  <button class="menu-item" data-action="clear-all">Clear history…</button>
  <button class="menu-item" data-action="toggle-fullscreen">Toggle fullscreen</button>
  <button class="menu-item" data-action="refresh-page">Refresh page</button>
</div>
```

### Aktionen

| Aktion | Beschreibung |
|---|---|
| `manual-input` | Öffnet das Manual-Input-Modal |
| `clear-all` | Löscht **alle** gespeicherte History (nach `confirm()`) |
| `toggle-fullscreen` | Schaltet Vollbild per `requestFullscreen()` / `exitFullscreen()` |
| `refresh-page` | Lädt die Seite komplett neu (`window.location.reload()`) |

### Positionierung

Das Menü wird unter dem Button positioniert, rechtsbündig ausgerichtet:

```javascript
const rect = anchorBtn.getBoundingClientRect();
headerMenuEl.style.left = (rect.right - 180) + 'px';
headerMenuEl.style.top = (rect.bottom + 4) + 'px';
```

---

## 8. Manual-Input-Modal

### Zweck

Erlaubt dem Benutzer, **manuell Sensorwerte einzugeben**, die dann über die REST-API an den Server gesendet werden. Nützlich für:
- Handablesungen (z. B. Wasserstand, Tankfüllstand)
- Test-Daten einspeisen
- Sensoren ohne elektronische Anbindung

### Modi

| Modus | Beschreibung |
|---|---|
| **Existing Topic** (Standard) | Dropdown mit allen bekannten Sensoren aus dem `store` |
| **New Topic** | Drei Textfelder: Node, Cluster, Sensor |

Umschaltung über den Button „Create New Topic" / „Select Existing Topic".

### Formularfelder

| Feld | Typ | Pflicht | Standard |
|---|---|---|---|
| Topic (Select) | `<select>` | Ja (in Existing-Modus) | Erster Sensor |
| Node | `<input text>` | Nein | `"manual"` |
| Cluster | `<input text>` | Nein | `"manual"` |
| Sensor | `<input text>` | Nein | `"value"` |
| Value | `<input number>` | Ja | — |
| Unit | `<input text>` | Nein | — |

### Sende-Ablauf

```
1. Benutzer füllt Formular aus
2. Klick auf "Send Update"
3. Button wird disabled, Text: "Sending..."
4. POST /api/manual mit JSON-Payload:
   { node, cluster, sensor, value, unit }
5. Bei Erfolg:
   a. Button: "Sent!" (750ms)
   b. Value-Feld wird geleert
   c. Focus zurück auf Value-Feld
6. Bei Fehler:
   a. alert() mit Fehlermeldung
   b. Button zurücksetzen
```

### Besonderheiten

- Wenn **keine Sensoren** im `store` vorhanden sind, wird automatisch in den „New Topic"-Modus gewechselt
- Das Modal nutzt eine **Pop-Animation** (`modalPop`, CSS-Keyframe)
- `setTimeout(100)` vor Focus auf Value-Feld (damit die Touch-Tastatur zuverlässig erscheint)

---

## 9. Verbindungsstatus-Anzeige

Das `#conn`-Element im Header zeigt den aktuellen WebSocket-Status:

| Text | Zustand |
|---|---|
| `connecting…` | WebSocket wird aufgebaut |
| `live` | WebSocket verbunden, Daten fließen |
| `disconnected` | Verbindung verloren (Reconnect in 4s) |
| `error` | WebSocket-Fehler aufgetreten |

---

## 10. Trash-Drop-Target

### Funktion

Der Papierkorb erscheint beim Beginn eines Drag-Vorgangs (Maus oder Touch) und erlaubt das **Ausblenden** einer Sensor-Kachel.

### Verhalten

```
Drag beginnt → trash.classList.add('show')
                (Papierkorb gleitet von unten ein, position: fixed, bottom-right)

Drag über Trash → trash.classList.add('over')
                  (Visuelles Feedback: gestrichelte Umrandung)

Drop auf Trash → mutedUntilNextUpdate.add(key)
                 tile.style.display = 'none'
                 (Kachel verschwindet bis zum nächsten Update für diesen Sensor)

Drag endet → trash.classList.remove('show', 'over')
             (Papierkorb gleitet wieder hinaus)
```

### Wichtig

- Das **Löschen ist temporär**: Sobald der Sensor erneut einen Wert sendet, erscheint die Kachel wieder
- Kein Datenverlust: Nur die UI-Anzeige wird unterdrückt (`mutedUntilNextUpdate`)
- Beim Page-Refresh ist die Kachel sofort wieder da (Set wird nicht persistiert)
