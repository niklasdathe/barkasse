# Barkasse Hub – UI-Styling, Theming & Kiosk-Optimierung

## Inhaltsverzeichnis

1. [CSS Custom Properties (Theming)](#1-css-custom-properties-theming)
2. [Layout-System](#2-layout-system)
3. [Kachel-Styling](#3-kachel-styling)
4. [Graph-Styling](#4-graph-styling)
5. [Scrollbar-Anpassung](#5-scrollbar-anpassung)
6. [Animationen & Transitionen](#6-animationen--transitionen)
7. [Touch- & Kiosk-Optimierungen](#7-touch---kiosk-optimierungen)
8. [Modal-Styling](#8-modal-styling)
9. [Performance-Optimierungen](#9-performance-optimierungen)
10. [Theming-Anleitung (Anpassungen vornehmen)](#10-theming-anleitung)

---

## 1. CSS Custom Properties (Theming)

Alle zentralen Größen und Farben werden über **CSS Custom Properties** in `:root` definiert. Änderungen an einer Stelle wirken sich konsistent auf die gesamte UI aus.

```css
:root {
  /* Kachel-Dimensionen */
  --tile-h: 120px;              /* Höhe einer Sensor-Kachel */
  --tile-w: 200px;              /* Breite einer Sensor-Kachel */
  --topics-gap: 10px;           /* Abstand zwischen Kacheln */
  --scroll-thickness: 30px;     /* Scrollbar-Dicke im Topic-Strip */

  /* Allgemeines Spacing */
  --pad-h: 32px;                /* Horizontaler Rand links/rechts */
  --pad-v: 6px;                 /* Vertikaler Rand oben/unten */

  /* Karten-Erscheinung */
  --card-radius: 16px;          /* Ecken-Rundung für Kacheln und Graphen */
  --card-bg: rgba(255,255,255,.8);  /* Hintergrund mit Transparenz */
  --shadow: 0 2px 4px rgba(0,0,0,.15);  /* Schatten-Stärke */
}
```

### Schnell-Referenz: Was welche Variable steuert

| Variable | Betrifft | Effekt |
|---|---|---|
| `--tile-h` | `.tile`, `#topics` | Höhe der Kacheln + Scroll-Container |
| `--tile-w` | `.tile` | Breite der Kacheln (Fix, kein Flex-Grow) |
| `--topics-gap` | `#topics` | Horizontaler Abstand im Scroll-Strip |
| `--scroll-thickness` | Scrollbar, `#topics` Height | Größe der Touch-Scrollbar |
| `--pad-h` | Header, Topics, Graphs | Seitenrand |
| `--pad-v` | Topics, Graphs | Vertikaler Sektions-Abstand |
| `--card-radius` | `.tile`, `.graph-tile` | Ecken-Rundung aller Karten |
| `--card-bg` | `.tile`, `.graph-tile`, `.tile-menu` | Hintergrundfarbe + Transparenz |
| `--shadow` | `.tile`, `.graph-tile` | Box-Shadow aller Karten |

---

## 2. Layout-System

### Gesamtlayout (`#hud`)

Das Dashboard nutzt ein **vertikales Flexbox-Layout** über die gesamte Viewport-Höhe:

```
┌─────────────── 100vh ───────────────┐
│  header          (flex: 0 0 auto)   │
│  #topics-wrap    (flex: 0 0 auto)   │
│    └─ #topics    (fixed height)     │
│  #graphs         (flex: 0 0 auto)   │
│    └─ Grid: 2 Spalten              │
│                                     │
│  (Restlicher Raum = leer)           │
└─────────────────────────────────────┘
```

**Hinweis:** `body { overflow: hidden }` – die Seite scrollt nicht. Nur der `#topics`-Strip scrollt horizontal.

### Hintergrund-Schichtung

```
z-index:
  #bg              — Ebene 0 (fixed, Hintergrundbild)
  #hud             — z-index: 2 (Flex-Container mit transparentem Overlay)
  .tile-menu       — z-index: 1000 (Kontextmenü)
  .drag-overlay    — z-index: 1800 (Touch-Drag-Fangfläche)
  .tile-ghost      — z-index: 2000 (Ghost-Kachel beim Drag)
  .modal-overlay   — z-index: 5000 (Modal-Dialog)
```

### Topic-Strip-Layout

Der Topic-Strip (`#topics`) ist ein **horizontaler Flex-Scroller**:

```css
#topics {
  display: flex;
  flex-direction: row;
  gap: var(--topics-gap);        /* 10px Abstand */
  overflow-x: auto;             /* Horizontales Scrollen */
  overflow-y: hidden;           /* Kein vertikales Scrollen */
  height: calc(var(--tile-h) + var(--scroll-thickness));  /* 120px + 30px = 150px */
}
```

Besonderheiten:
- `touch-action: pan-x` (nur horizontales Swipen erlaubt)
- `margin-top: 100px` auf `#topics-wrap` (großer vertikaler Offset unter dem Header)
- `padding-bottom: 25px` (Platz für die Scrollbar)

### Graph-Grid-Layout

```css
#graphs {
  display: grid;
  grid-template-columns: 1fr 1fr;   /* Zwei gleich breite Spalten */
  gap: 10px;
}
```

Jeder Graph hat eine **fixe Höhe** von 320px.

---

## 3. Kachel-Styling

### Basis-Kachel

```css
.tile {
  flex: 0 0 var(--tile-w);        /* Fixe Breite, kein Schrumpfen/Wachsen */
  height: var(--tile-h);          /* Fixe Höhe */
  contain: strict;                /* Performance-Isolation */
  position: relative;             /* Für Status-Dot-Positionierung */
  background: var(--card-bg);     /* Semi-transparenter Hintergrund */
  border-radius: var(--card-radius);  /* Abgerundete Ecken */
  padding: 12px 14px;
  box-shadow: var(--shadow);
  cursor: grab;
  touch-action: pan-x;           /* Nur horizontales Swipen */
}
```

### Kachel-Inhalt (Typografie)

| Element | Klasse | Font-Size | Beschreibung |
|---|---|---|---|
| Titel | `h3` | 16px | `cluster / sensor` |
| Meta | `.meta` | 12px, `#444`, α=0.8 | Node-Name, Timestamp |
| Wert | `.value .num` | 32px, bold | Hauptwert (z. B. `22.40`) |
| Einheit | `.value .unit` | 16px, α=0.7 | Einheit (z. B. `°C`) |

### Status-Dot

```css
.tile .dot {
  position: absolute;
  right: 10px;
  top: 10px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(0,0,0,.08) inset, 0 1px 2px rgba(0,0,0,.25);
}
```

Die Farbe wird dynamisch per JavaScript gesetzt (`el.style.background = color`).

### Drag-Zustand

```css
.tile.dragging {
  opacity: .9;
  cursor: grabbing;
  box-shadow: 0 10px 22px rgba(0,0,0,.18);   /* Größerer Schatten */
  transform: scale(1.02);                     /* Leichte Vergrößerung */
  touch-action: none;                          /* Alle Gesten deaktiviert */
}
```

### Fade-In-Animation

Neue Kacheln starten mit `opacity-0` und werden per `requestAnimationFrame` eingeblendet:

```css
.opacity-0 {
  opacity: 0;
  transform: scale(0.95);
  transition: opacity .5s, transform .5s;
}
```

---

## 4. Graph-Styling

### Graph-Karte

```css
.graph-tile {
  background: var(--card-bg);
  border-radius: var(--card-radius);
  padding: 12px 14px;
  box-shadow: var(--shadow);
  height: 320px;                  /* Fixe Höhe */
  display: flex;
  flex-direction: column;
  gap: 10px;
}
```

### Graph-Header (Titel + Perioden-Buttons)

```css
.graph-tile .graph-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
```

### Perioden-Buttons

```css
.periods button {
  border-radius: 999px;           /* Pill-Form */
  padding: 6px 12px;
  background: rgba(0,0,0,.08);    /* Normal-Zustand */
}
.periods button.active {
  background: #000;               /* Schwarz für aktiv */
  color: #fff;
}
```

### Canvas

```css
.graph-tile canvas.chart {
  flex: 1;                         /* Füllt verfügbaren Platz */
  width: 100%;
  height: 100%;
}
```

Die tatsächliche Pixel-Auflösung wird in JavaScript via `resizeCanvas()` gesetzt.

### Drop-Feedback

```css
.chart-over {
  outline: 2px dashed #4a90e2;    /* Blauer gestrichelter Rand */
  border-radius: 14px;
}
```

### Hinweis-Text

```css
.graph-tile .chart-hint {
  align-self: flex-end;
  margin-top: 6px;
  opacity: .7;
  font-size: 12px;
}
```

---

## 5. Scrollbar-Anpassung

Die horizontale Scrollbar des Topic-Strips ist für Touch-Bedienung **extra groß** gestaltet:

```css
/* Scrollbar-Höhe (Dicke) */
#topics::-webkit-scrollbar {
  height: var(--scroll-thickness);    /* 30px */
}

/* Track (Hintergrund) */
#topics::-webkit-scrollbar-track {
  background: rgba(0,0,0,.08);
  border-radius: 999px;
  margin-inline: 4px;                /* Abgerundete Enden */
}

/* Thumb (Griff) */
#topics::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,.35);
  border-radius: 999px;
  border: 4px solid transparent;      /* Vergrößert die Touch-Fläche */
  background-clip: content-box;
}

/* Hover */
#topics::-webkit-scrollbar-thumb:hover {
  background: rgba(0,0,0,.5);
  background-clip: content-box;
}
```

**Trick mit `border`**: Der Thumb hat eine `4px` transparente Border, die per `background-clip: content-box` nur den inneren Bereich füllt. So ist die visuelle Pill-Form kleiner, aber die tippbare Fläche größer.

---

## 6. Animationen & Transitionen

### Kachel-Transitionen

```css
.tile {
  transition: transform .12s ease, opacity .3s;
}
```

| Property | Dauer | Wann |
|---|---|---|
| `transform` | 120ms | Drag-Start (scale 1.02), Drag-Ende |
| `opacity` | 300ms | Fade-in (opacity-0 → 1) |

**Bewusst weggelassen**: `box-shadow`-Transition (Performance-Grund auf ARM-Hardware).

### Modal-Pop-Animation

```css
@keyframes modalPop {
  from { transform: scale(0.9); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
.modal {
  animation: modalPop 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
```

Die Cubic-Bezier-Kurve erzeugt einen leichten „Bounce"-Effekt (Overshoot).

### Trash Ein-/Ausblenden

```css
.drop-target {
  transform: translateY(120%);         /* Außerhalb des Viewports */
  transition: transform .2s ease;
}
.drop-target.show {
  transform: translateY(0);            /* Einblenden von unten */
}
```

---

## 7. Touch- & Kiosk-Optimierungen

### Unterdrücken unerwünschter Browser-Funktionen

```css
/* Kein Long-Press-Callout, keine Textauswahl */
body, .tile, #topics {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

/* Touch-Gesten steuern */
#topics { touch-action: pan-x; }         /* Nur horizontales Swipen */
.drag-overlay { touch-action: none; }    /* Keine Gesten beim Drag */
.tile { touch-action: pan-x; }           /* Nur horizontal auf Kacheln */

/* Webkit Input-Styling entfernen */
input[type="number"], input[type="text"], select {
  -webkit-appearance: none;
}
```

### JavaScript-Level Kiosk-Optimierungen

```javascript
// Natives Kontextmenü global unterdrücken
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
}, { capture: true });
```

### Vollbild

Per Header-Menü → „Toggle fullscreen" wird `document.documentElement.requestFullscreen()` aufgerufen. In der Kiosk-Konfiguration startet Chromium bereits mit `--start-fullscreen`.

---

## 8. Modal-Styling

### Overlay

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;                       /* Über allem */
  background: rgba(0,0,0,0.6);        /* Dunkler Overlay */
  display: flex;
  align-items: center;
  justify-content: center;
}
```

**Hinweis**: `backdrop-filter: blur(4px)` ist auskommentiert (Performance-Grund auf Raspberry Pi).

### Modal-Card

```css
.modal {
  background: #fff;
  width: 90%;
  max-width: 500px;
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0,0,0,0.4);  /* Dramatischer Schatten */
}
```

### Formular-Elemente

```css
.input-lg {
  padding: 12px;
  font-size: 16px;                    /* Groß genug für Touch */
  border: 2px solid #ddd;
  border-radius: 8px;
  background: #f9f9f9;
}
.input-lg:focus {
  border-color: #007bff;             /* Blaue Focus-Farbe */
  background: #fff;
}
```

### Buttons

```css
.btn {
  padding: 12px 20px;                /* Große Touch-Fläche */
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
}
.primary-btn {
  background: #007bff;
  color: #fff;
}
.primary-btn:active {
  background: #0056b3;               /* Dunklere Farbe beim Drücken */
}
```

### Form-Grid

Der Value/Unit-Bereich nutzt ein **2:1 Grid**:

```css
.form-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;   /* Value ist doppelt so breit wie Unit */
  gap: 12px;
}
```

---

## 9. Performance-Optimierungen

Die UI ist speziell für **Raspberry Pi 4 / reTerminal** (ARM Cortex-A72, VideoCore VI GPU) optimiert:

### CSS-Level

| Optimierung | Beschreibung |
|---|---|
| `contain: strict` auf `.tile` | Isoliert Layout, Style und Paint pro Kachel |
| Keine `backdrop-filter` | Extrem GPU-intensiv, auf ARM nicht performant |
| Reduzierte `box-shadow`-Transitionen | Shadow-Transition auf Kacheln entfernt |
| Minimale `filter` | `contrast`/`saturate` auf `#bg` auskommentiert |
| Keine externe Fonts | System-Font-Stack: `system-ui, Segoe UI, Arial, sans-serif` |

### JavaScript-Level

| Optimierung | Beschreibung |
|---|---|
| Gecachte DOM-Referenzen (`tileEls` Map) | Vermeidet wiederholtes `querySelector` |
| Gecachte Drop-Target-Rects beim Drag | Kein `elementFromPoint` in der Move-Schleife |
| `requestAnimationFrame` für Fade-In | Vermeidet Force-Layout nach `appendChild` |
| Canvas statt SVG/DOM für Graphen | Weniger DOM-Knoten, direktes Pixel-Rendering |
| `setTransform` statt wiederholtes `scale()` | Einmaliges High-DPI-Setup per `resizeCanvas()` |
| Prune in `addPoint()` | Entfernt alte Datenpunkte beim Stream statt unbegrenztes Wachstum |

### Bewusste Kompromisse

| Entscheidung | Grund |
|---|---|
| Kein Virtual Scrolling für Tiles | Erwartete Sensor-Anzahl < 50 |
| Linearer statt binärer Tooltip-Search | Datensätze typischerweise < 1000 Punkte |
| `toFixed(2)` statt `Intl.NumberFormat` | Einfachheit, ausreichend für Sensorwerte |

---

## 10. Theming-Anleitung

### Hintergrund ändern

Tausche die Datei `ui/assets/background.png` aus. Das Bild wird per CSS `center/cover` skaliert:

```css
#bg {
  background: url('/assets/background.png') center/cover no-repeat;
}
```

### Kacheln anpassen

```css
:root {
  --tile-h: 140px;              /* Größere Kacheln */
  --tile-w: 250px;              /* Breitere Kacheln */
  --card-radius: 8px;           /* Weniger Rundung */
  --card-bg: rgba(0,0,20,.7);   /* Dunkles Theme */
}
```

### Farben

| Element | Wo anpassen | Standard |
|---|---|---|
| Karten-Hintergrund | `--card-bg` | `rgba(255,255,255,.8)` |
| Schatten | `--shadow` | `0 2px 4px rgba(0,0,0,.15)` |
| Header-Text | `header { color: }` | `#fff` |
| Dot-Farben | `paintDot()` in `app.js` | Grün/Gelb/Rot/Grau |
| Graph-Linie | `render()` in `app.js` | `#000` |
| Aktiver Perioden-Button | `.periods button.active` | `background: #000; color: #fff` |
| Trash-Farbe | `.trash { background: }` | `rgba(255,60,60,.95)` |
| Primary-Button | `.primary-btn` | `#007bff` |

### Dunkles Theme (Beispiel)

```css
:root {
  --card-bg: rgba(30, 30, 40, .85);
  --shadow: 0 2px 8px rgba(0, 0, 0, .4);
}

body { color: #e0e0e0; }
header { color: #fff; }
.tile h3 { color: #fff; }
.tile .meta { color: #aaa; }
.tile .value { color: #fff; }

#graphs .chart-title { color: #ddd; }
.graph-tile .chart-hint { color: #888; }

.periods button { background: rgba(255,255,255,.1); color: #ccc; }
.periods button.active { background: #4a90e2; color: #fff; }

.tile-menu { background: rgba(30, 30, 40, .95); }
.tile-menu .menu-item { color: #ddd; }
.tile-menu .menu-item:hover { background: rgba(255,255,255,.1); }
```

### Schriftart ändern

```css
body {
  font-family: 'Inter', system-ui, sans-serif;
}
```

Lade die Schrift lokal (kein CDN auf dem Boot!):

```html
<link rel="stylesheet" href="/assets/fonts/inter.css"/>
```

### Graph-Darstellung anpassen

Die Graph-Farben und -Dimensionen sind in `app.js` in der `render()`-Methode der `GraphTile`-Klasse hartcodiert. Relevante Konstanten:

```javascript
// Padding (Achsen-Beschriftungen)
const padL = 50;   // Links (Y-Achsen-Labels)
const padR = 12;   // Rechts
const padT = 12;   // Oben
const padB = 24;   // Unten (X-Achse)

// Farben
ctx.strokeStyle = '#000';       // Achsen und Datenlinie
ctx.fillStyle = '#000';         // Labels
ctx.globalAlpha = 0.12;         // Grid-Linien Transparenz

// Tooltip
ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';  // Tooltip-Box
ctx.strokeStyle = '#ccc';                      // Tooltip-Rand
ctx.strokeStyle = '#888';                      // Vertikale Hover-Linie
```

### Scrollbar-Anpassung

Für dünnere Scrollbars (Desktop-Modus):

```css
:root {
  --scroll-thickness: 12px;
}
```

Für dickere Scrollbars (großer Touchscreen):

```css
:root {
  --scroll-thickness: 40px;
}
```
