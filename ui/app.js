/**
 * Barkasse Dashboard - Frontend Application
 * 
 * This application displays sensor data in real-time using WebSockets.
 * Features:
 * - Live sensor tiles that update automatically
 * - Drag & drop tiles to graphs to view history
 * - Two fixed graph areas for historical data visualization
 * - Touch-friendly drag support (long-press for touch devices)
 */

/* ============================================================================
 * GLOBAL VARIABLES AND CONSTANTS
 * ============================================================================ */

// DOM elements
const topics = document.getElementById('topics');  // Container for sensor tiles (horizontal scroll)
const conn = document.getElementById('conn');      // Connection status indicator
const headerMenuBtn = document.getElementById('header-menu-btn'); // Top-right header menu button
const trash = document.getElementById('trash');   // Trash icon for deleting tiles

// Constants
const DEFAULT_CHART_HINT = 'Drag a tile here to view its history';

// Data storage
const store = new Map();                 // Stores latest sensor data: key -> sensor payload
const lastSeen = new Map();              // Tracks when each sensor last sent data: key -> timestamp
const mutedUntilNextUpdate = new Set();  // Tracks tiles that should be hidden until next update
const tileEls = new Map();               // Cache: key -> tile DOM element

// WebSocket and UI state
let ws = null;                    // WebSocket connection
let reconnectTimer = null;        // Timer for reconnection attempts
let draggedTile = null;           // Currently dragged tile element
let menuEl = null;                // Context menu element

// Touch-drag state (for coarse pointers where HTML5 drag isn't reliable)
let touchDragState = null;


// Suppress Chromium's native context menu (right-click / touch-and-hold).
// We provide our own tile menu instead.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
}, { capture: true });

/* ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================ */

/**
 * Creates a unique key for a sensor from its properties
 * Format: "node/cluster/sensor" or "node/cluster/state" if sensor is missing
 */
function key(o) {
  return `${o.node}/${o.cluster}/${o.sensor || 'state'}`;
}

/**
 * Formats a sensor value for display
 * - Numbers: rounded to 2 decimal places
 * - Empty/null/undefined: shows "—"
 * - Other types: converted to string
 */
function formatValue(v) {
  if (v === undefined || v === null || v === '') {
    return '—';
  }
  if (typeof v === 'number') {
    return v.toFixed(2);
  }
  return String(v);
}

/**
 * Calculates how many minutes ago a sensor last sent data
 * Returns Infinity if sensor was never seen
 */
function ageMinutesFromSeen(k) {
  const t = lastSeen.get(k);
  if (!t) return Infinity;
  return (Date.now() - t) / 60000; // Convert milliseconds to minutes
}

/**
 * Updates an existing tile element's content from a sensor payload.
 */
function updateTileContent(el, o) {
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';
}

/* ============================================================================
 * TILES (Create/Update/Render)
 * ============================================================================ */

/* ============================================================================
 * SENSOR TILE MANAGEMENT
 * ============================================================================ */

/**
 * Creates or updates a sensor tile in the horizontal list
 * - Creates new tile if it doesn't exist
 * - Updates existing tile with new data
 * - Handles drag & drop setup (different for mouse vs touch)
 */
function ensureTile(o) {
  const k = key(o);
  let el = tileEls.get(k) || topics.querySelector(`[data-k="${CSS.escape(k)}"]`);
  
  // Create new tile if it doesn't exist
  if (!el) {
    // Create tile element
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    const titleSensor = o.sensor || 'state';
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${titleSensor}</h3>
      <div class="meta node"></div>
      <div class="value"><span class="num">—</span><span class="unit"></span></div>
      <div class="meta ts"></div>
    `;

    // Add to DOM and fade in
    topics.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0'));

    // Native HTML5 drag (mouse) + custom long-press drag (touch)
    el.setAttribute('draggable', 'true');

    // Mouse drag handlers (HTML5 DnD)
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);

    // Prevent native image drag behavior
    el.addEventListener('mousedown', (e) => {
      if (e.target && e.target.tagName === 'IMG') {
        e.preventDefault();
      }
    });

    // Touch drag implementation (long-press to drag)
    installTouchDrag(el);

    // Context menu: right-click (mouse) opens actions, and long-press (touch) too
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTileMenu(el, e.clientX, e.clientY);
    });

    // Long-press menu is handled via pointer events in installTouchDrag() on touch,
    // and via right-click context menu on mouse.

  }

  // Keep cache in sync even if the element was found via querySelector.
  tileEls.set(k, el);

  // Update tile content with sensor data
  updateTileContent(el, o);

  return el;
}

/* ==========================================================================
 * TOUCH DRAG (reTerminal-like) — FULL REPLACEMENT
 * ==========================================================================
 */

function installTouchDrag(tileEl) {
  const MOVE_THRESHOLD_PX = 10;
  const VERTICAL_INTENT_BIAS_PX = 4;
  const MENU_HOLD_MS = 650;

  const isLikelyTouchEnvironment = () => {
    const maxTp = Number(navigator.maxTouchPoints || 0);
    const hoverNone = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);
    return maxTp > 0 || hoverNone;
  };

  const isTouchLikePointerEvent = (e) => {
    // On Chromium/X11 some touchscreens appear as pointerType=mouse.
    if (!e || !e.pointerType) return isLikelyTouchEnvironment();
    if (e.pointerType === "touch" || e.pointerType === "pen") return true;
    if (e.pointerType === "mouse") return isLikelyTouchEnvironment();
    return false;
  };

  let startX = 0;
  let startY = 0;
  let pointerId = null;
  let touchId = null;
  let mouseActive = false;
  let menuTimer = null;
  let dragStarted = false;

  const clearTimers = () => {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = null;
  };

  const movedBeyondThreshold = (clientX, clientY) => {
    const dx = clientX - startX;
    const dy = clientY - startY;
    return (dx * dx + dy * dy) >= (MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX);
  };

  const scheduleMenuOnly = (tile, cx, cy) => {
    clearTimers();
    dragStarted = false;

    // Open menu only if the user holds without moving.
    menuTimer = setTimeout(() => {
      if (touchDragState) return;
      if (dragStarted) return;
      openTileMenu(tile, cx, cy);
    }, MENU_HOLD_MS);
  };

  const maybeStartDragFromMove = (tile, clientX, clientY, originalEvent) => {
    if (touchDragState) return;
    if (!movedBeyondThreshold(clientX, clientY)) return;

    const dx = clientX - startX;
    const dy = clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Preserve horizontal swipe for scrolling the tile strip.
    // Start dragging only when the gesture is clearly vertical (towards graphs/trash).
    const verticalIntent = absDy > (absDx + VERTICAL_INTENT_BIAS_PX);
    if (!verticalIntent) return;

    // Moving cancels the long-press menu.
    if (menuTimer) {
      clearTimeout(menuTimer);
      menuTimer = null;
    }

    dragStarted = true;

    // IMPORTANT: prevent the browser from stealing the gesture (scroll -> pointercancel)
    originalEvent?.preventDefault?.();

    startTouchDrag(tile, originalEvent || { clientX, clientY });
  };

  // Prefer Pointer Events when available.
  if ("PointerEvent" in window) {
    const onPointerDown = (e) => {
      // Primary only.
      if (typeof e.button === "number" && e.button !== 0) return;
      if (!tileEl.dataset.k) return;

      const touchLike = isTouchLikePointerEvent(e);

      // Do not interfere with real mouse: native HTML5 drag handles that.
      if (!touchLike) return;

      pointerId = e.pointerId;
      touchId = null;
      startX = e.clientX;
      startY = e.clientY;

      // Capture pointer so we reliably get pointerup even if finger leaves the tile.
      // (This is the big fix on many Linux touch stacks.)
      try { tileEl.setPointerCapture(e.pointerId); } catch {}

      scheduleMenuOnly(tileEl, startX, startY);
    };

    const onPointerMove = (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;

      const touchLike = isTouchLikePointerEvent(e);
      if (!touchLike) return;

      // Start drag on vertical intent.
      maybeStartDragFromMove(tileEl, e.clientX, e.clientY, e);

      if (touchDragState) {
        e.preventDefault(); // requires CSS touch-action to be effective
        updateTouchDrag(e.clientX, e.clientY);
      }
    };

    const onPointerUpOrCancel = async (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;

      const touchLike = isTouchLikePointerEvent(e);
      if (!touchLike) return;

      clearTimers();

      // Treat cancel like an end; cancel is common on touch hardware.
      if (touchDragState) {
        e.preventDefault();
        await finishTouchDrag(e.clientX, e.clientY);
      }

      pointerId = null;
      dragStarted = false;
    };

    tileEl.addEventListener("pointerdown", onPointerDown, { passive: true });
    tileEl.addEventListener("pointermove", onPointerMove, { passive: false });
    tileEl.addEventListener("pointerup", onPointerUpOrCancel, { passive: false });
    tileEl.addEventListener("pointercancel", onPointerUpOrCancel, { passive: false });
    return;
  }

  // Touch Events fallback (older embedded browsers / kiosk shells).
  const getTouchById = (touchList, id) => {
    if (!touchList) return null;
    for (let i = 0; i < touchList.length; i++) {
      if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
  };

  const onTouchStart = (e) => {
    if (!tileEl.dataset.k) return;
    if (!e.touches || e.touches.length !== 1) return;

    const t = e.touches[0];
    touchId = t.identifier;
    pointerId = null;
    startX = t.clientX;
    startY = t.clientY;

    scheduleMenuOnly(tileEl, startX, startY);
  };

  const onTouchMove = (e) => {
    if (touchId === null) return;
    const t = getTouchById(e.touches, touchId);
    if (!t) return;

    maybeStartDragFromMove(tileEl, t.clientX, t.clientY, e);

    if (touchDragState) {
      e.preventDefault();
      updateTouchDrag(t.clientX, t.clientY);
    }
  };

  const onTouchEndOrCancel = async (e) => {
    if (touchId === null) return;
    clearTimers();

    if (touchDragState) {
      const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
      if (t) {
        e.preventDefault();
        await finishTouchDrag(t.clientX, t.clientY);
      } else {
        await finishTouchDrag(startX, startY);
      }
    }

    touchId = null;
    dragStarted = false;
  };

  tileEl.addEventListener("touchstart", onTouchStart, { passive: true });
  tileEl.addEventListener("touchmove", onTouchMove, { passive: false });
  tileEl.addEventListener("touchend", onTouchEndOrCancel, { passive: false });
  tileEl.addEventListener("touchcancel", onTouchEndOrCancel, { passive: false });

  // Mouse-event fallback (touchscreens that emulate mouse, esp. on X11).
  if (isLikelyTouchEnvironment()) {
    let windowHandlersAttached = false;

    const onMouseDown = (e) => {
      if (typeof e.button === "number" && e.button !== 0) return;
      if (!tileEl.dataset.k) return;
      if (touchDragState) return;

      mouseActive = true;
      startX = e.clientX;
      startY = e.clientY;

      scheduleMenuOnly(tileEl, startX, startY);

      if (!windowHandlersAttached) {
        windowHandlersAttached = true;
        window.addEventListener("mousemove", onMouseMove, { passive: false });
        window.addEventListener("mouseup", onMouseUp, { passive: false });
      }
    };

    const onMouseMove = (e) => {
      if (!mouseActive) return;

      maybeStartDragFromMove(tileEl, e.clientX, e.clientY, e);

      if (touchDragState) {
        e.preventDefault();
        updateTouchDrag(e.clientX, e.clientY);
      }
    };

    const onMouseUp = async (e) => {
      if (!mouseActive) return;
      mouseActive = false;
      clearTimers();

      if (touchDragState) {
        e.preventDefault();
        await finishTouchDrag(e.clientX, e.clientY);
      }

      dragStarted = false;

      if (windowHandlersAttached) {
        windowHandlersAttached = false;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      }
    };

    tileEl.addEventListener("mousedown", onMouseDown, { passive: true });
  }
}

function startTouchDrag(tileEl, e) {
  closeTileMenu();
  draggedTile = tileEl;
  draggedTile.classList.add("dragging");
  showTrash();

  // Create overlay to capture all move/up events reliably.
  const overlay = document.createElement("div");
  overlay.className = "drag-overlay";
  overlay.addEventListener("contextmenu", (ev) => ev.preventDefault(), { capture: true });

  // Prevent click-through / accidental selections while dragging
  overlay.addEventListener("pointerdown", (ev) => ev.preventDefault?.(), { passive: false });
  overlay.addEventListener("touchstart", (ev) => ev.preventDefault?.(), { passive: false });

  document.body.appendChild(overlay);

  const ghost = tileEl.cloneNode(true);
  ghost.classList.add("tile-ghost");
  ghost.removeAttribute("draggable");
  ghost.style.width = tileEl.getBoundingClientRect().width + "px";
  ghost.style.height = tileEl.getBoundingClientRect().height + "px";
  document.body.appendChild(ghost);

  touchDragState = {
    overlay,
    ghost,
    overGraphEl: null,
    overTrash: false,
    offsetX: 24,
    offsetY: 24,
    finishing: false,
    cleanup: null,
    usingCapture: false,
    pointerId: null,
  };

  const getXY = (ev) => {
    if (!ev) return null;
    if (typeof ev.clientX === "number" && typeof ev.clientY === "number") {
      return { x: ev.clientX, y: ev.clientY };
    }
    if (ev.touches && ev.touches.length) {
      return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    }
    if (ev.changedTouches && ev.changedTouches.length) {
      return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
    }
    return null;
  };

  const onMove = (ev) => {
    if (!touchDragState) return;
    const pt = getXY(ev);
    if (!pt) return;
    ev.preventDefault?.();
    updateTouchDrag(pt.x, pt.y);
  };

  const onEnd = async (ev) => {
    const pt = getXY(ev) || { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
    ev.preventDefault?.();
    await finishTouchDrag(pt.x, pt.y);
  };

  // Pointer Events
  if ("PointerEvent" in window) {
    overlay.addEventListener("pointermove", onMove, { passive: false });
    overlay.addEventListener("pointerup", onEnd, { passive: false });
    overlay.addEventListener("pointercancel", onEnd, { passive: false });

    if (typeof e?.pointerId === "number" && typeof overlay.setPointerCapture === "function") {
      try {
        overlay.setPointerCapture(e.pointerId);
        touchDragState.usingCapture = true;
        touchDragState.pointerId = e.pointerId;
      } catch {}
    }
  }

  // Touch Events
  overlay.addEventListener("touchmove", onMove, { passive: false });
  overlay.addEventListener("touchend", onEnd, { passive: false });
  overlay.addEventListener("touchcancel", onEnd, { passive: false });

  // Mouse Events
  overlay.addEventListener("mousemove", onMove, { passive: false });
  overlay.addEventListener("mouseup", onEnd, { passive: false });

  touchDragState.cleanup = () => {
    overlay.removeEventListener("pointermove", onMove);
    overlay.removeEventListener("pointerup", onEnd);
    overlay.removeEventListener("pointercancel", onEnd);
    overlay.removeEventListener("touchmove", onMove);
    overlay.removeEventListener("touchend", onEnd);
    overlay.removeEventListener("touchcancel", onEnd);
    overlay.removeEventListener("mousemove", onMove);
    overlay.removeEventListener("mouseup", onEnd);
  };

  updateTouchDrag(e?.clientX ?? startX, e?.clientY ?? startY);
}

function updateTouchDrag(clientX, clientY) {
  if (!touchDragState) return;

  // Position ghost
  const x = clientX - touchDragState.offsetX;
  const y = clientY - touchDragState.offsetY;
  touchDragState.ghost.style.transform = `translate(${x}px, ${y}px)`;

  // Hit-test drop targets (ignore overlay so we can detect underlying elements)
  const prevPe = touchDragState.overlay ? touchDragState.overlay.style.pointerEvents : "";
  if (touchDragState.overlay) touchDragState.overlay.style.pointerEvents = "none";
  const under = document.elementFromPoint(clientX, clientY);
  if (touchDragState.overlay) touchDragState.overlay.style.pointerEvents = prevPe;

  const graphEl = under ? under.closest?.('.graph-tile[data-graph="true"]') : null;
  const trashEl = under ? under.closest?.("#trash") : null;

  // Graph hover styling
  if (touchDragState.overGraphEl && touchDragState.overGraphEl !== graphEl) {
    touchDragState.overGraphEl.classList.remove("chart-over");
  }
  if (graphEl) {
    graphEl.classList.add("chart-over");
  }
  touchDragState.overGraphEl = graphEl;

  // Trash hover styling
  const isOverTrash = !!trashEl;
  trash.classList.toggle("over", isOverTrash);
  touchDragState.overTrash = isOverTrash;
}

async function finishTouchDrag(clientX, clientY) {
  if (!touchDragState) return;
  if (touchDragState.finishing) return;
  touchDragState.finishing = true;

  // Final hover update
  updateTouchDrag(clientX, clientY);

  const dropOnTrash = touchDragState.overTrash;
  const dropOnGraphEl = touchDragState.overGraphEl;

  // Cleanup hover styles
  if (dropOnGraphEl) dropOnGraphEl.classList.remove("chart-over");
  trash.classList.remove("over");

  // Perform drop action
  if (draggedTile && draggedTile.dataset.k) {
    const k = draggedTile.dataset.k;

    if (dropOnTrash) {
      mutedUntilNextUpdate.add(k);
      draggedTile.style.display = "none";
    } else if (dropOnGraphEl) {
      const gt = graphs.find((g) => g.el === dropOnGraphEl);
      if (gt) {
        gt.key = k;
        await gt.draw?.(); // if you have draw(); otherwise refresh()
        if (!gt.draw) await gt.refresh?.();
      }
    }
  }

  // Cleanup drag state
  try { touchDragState.cleanup?.(); } catch {}

  try { touchDragState.overlay?.remove(); } catch {}
  try { touchDragState.ghost?.remove(); } catch {}

  touchDragState = null;

  if (draggedTile) draggedTile.classList.remove("dragging");
  draggedTile = null;
  hideTrash();
}

/**
 * Opens a small context menu for a tile with actions like "Clear history"
 */
function openTileMenu(tile, clientX, clientY) {
  closeTileMenu();
  const k = tile.dataset.k;
  if (!k) return;

  menuEl = document.createElement('div');
  menuEl.className = 'tile-menu';
  menuEl.innerHTML = `
    <button class="menu-item" data-action="clear" aria-label="Clear history for this tile">Clear history…</button>
  `;

  // Position near cursor/touch
  menuEl.style.left = Math.max(8, clientX) + 'px';
  menuEl.style.top = Math.max(8, clientY) + 'px';

  document.body.appendChild(menuEl);

  // Outside click closes
  const onDocClick = (e) => {
    if (menuEl && !menuEl.contains(e.target)) {
      closeTileMenu();
      document.removeEventListener('click', onDocClick, true);
    }
  };
  document.addEventListener('click', onDocClick, true);

  // Handle menu actions
  menuEl.querySelector('[data-action="clear"]').addEventListener('click', async () => {
    closeTileMenu();
    const proceed = confirm(`Delete history for ${k}?`);
    if (!proceed) return;
    try {
      await clearHistory(k);
      // Redraw graphs that show this key
      graphs.forEach(gt => {
        if (gt.key === k) gt.refresh();
      });
      // Brief feedback on tile
      const num = tile.querySelector('.num');
      if (num) {
        const old = num.textContent;
        num.textContent = '—';
        setTimeout(() => { num.textContent = old; }, 1200);
      }
    } catch (e) {
      alert('Failed to clear history: ' + e.message);
    }
  });
}

function closeTileMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

/* ============================================================================
 * HEADER MENU (Clear history + Fullscreen toggle)
 * ============================================================================ */

let headerMenuEl = null;

function openHeaderMenu(anchorBtn) {
  closeHeaderMenu();
  headerMenuEl = document.createElement('div');
  headerMenuEl.className = 'tile-menu';
  headerMenuEl.innerHTML = `
    <button class="menu-item" data-action="manual-input" aria-label="Enter manual value">Input manual value…</button>
    <button class="menu-item" data-action="clear-all" aria-label="Clear all history">Clear history…</button>
    <button class="menu-item" data-action="toggle-fullscreen" aria-label="Toggle fullscreen">Toggle fullscreen</button>
    <button class="menu-item" data-action="refresh-page" aria-label="Refresh page">Refresh page</button>
  `;

  // Position below the anchor button
  const rect = anchorBtn.getBoundingClientRect();
  headerMenuEl.style.left = (rect.right - 180) + 'px'; // align to right-ish
  headerMenuEl.style.top = (rect.bottom + 4) + 'px';

  document.body.appendChild(headerMenuEl);

  const onDocClick = (e) => {
    if (headerMenuEl && !headerMenuEl.contains(e.target) && e.target !== anchorBtn) {
      closeHeaderMenu();
      document.removeEventListener('click', onDocClick, true);
    }
  };
  document.addEventListener('click', onDocClick, true);

  // Actions
  headerMenuEl.querySelector('[data-action="manual-input"]').addEventListener('click', () => {
    closeHeaderMenu();
    openManualInputModal();
  });
  headerMenuEl.querySelector('[data-action="clear-all"]').addEventListener('click', async () => {
    closeHeaderMenu();
    const proceed = confirm('Delete stored history on this Raspberry Pi? This cannot be undone.');
    if (!proceed) return;
    try {
      await clearHistory();
      graphs.forEach(g => g.key && g.refresh());
    } catch (e) {
      alert('Failed to clear history: ' + e.message);
    }
  });

  headerMenuEl.querySelector('[data-action="toggle-fullscreen"]').addEventListener('click', async () => {
    closeHeaderMenu();
    try {
      await toggleFullscreen();
    } catch (e) {
      alert('Fullscreen toggle failed: ' + e.message);
    }
  });

  headerMenuEl.querySelector('[data-action="refresh-page"]').addEventListener('click', () => {
    closeHeaderMenu();
    window.location.reload();
  });
}

function closeHeaderMenu() {
  if (headerMenuEl) {
    headerMenuEl.remove();
    headerMenuEl = null;
  }
}

async function toggleFullscreen() {
  const el = document.documentElement; // use the root for full coverage
  const isFs = !!document.fullscreenElement;
  if (!isFs) {
    if (el.requestFullscreen) {
      await el.requestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  }
}

/**
 * Updates the status dot color based on how recently data was received
 * - Green: < 3 minutes ago (fresh)
 * - Yellow: 3-60 minutes ago (stale)
 * - Red: > 60 minutes ago (old)
 * - Gray: never seen
 */
function paintDot(el) {
  const k = el.dataset.k;
  if (!k) return;
  
  const m = ageMinutesFromSeen(k);
  let color = '#bbb'; // Gray (default)
  
  if (m < 3) {
    color = '#2ecc71';      // Green (fresh)
  } else if (m >= 60) {
    color = '#e74c3c';      // Red (old)
  } else {
    color = '#f1c40f';      // Yellow (stale)
  }
  
  el.querySelector('.dot').style.background = color;
}

/**
 * Renders a sensor update to the UI
 * - Removes from muted list if present
 * - Creates/updates tile
 * - Makes tile visible
 * - Updates status dot color
 */
function render(o) {
  const k = key(o);
  
  // Remove from muted list if present (tile was deleted but now has new data)
  if (mutedUntilNextUpdate.has(k)) {
    mutedUntilNextUpdate.delete(k);
  }
  
  const el = ensureTile(o);
  el.style.display = ''; // Ensure visible
  
  paintDot(el);
}

// Update status dots every 30 seconds
setInterval(() => {
  topics.querySelectorAll('.tile[data-k]').forEach(paintDot);
}, 30000);

/**
 * Sorts tiles alphabetically by their key (node/cluster/sensor)
 */
function sortTiles() {
  const arr = Array.from(topics.children)
    .filter(el => el.classList.contains('tile') && el.dataset.k);
  
  // Sort alphabetically by key
  arr.sort((a, b) => (a.dataset.k || '').localeCompare(b.dataset.k || ''));
  
  // Re-append in sorted order
  arr.forEach(el => topics.appendChild(el));
}

/* ============================================================================
 * GRAPH TILE CLASS
 * ============================================================================ */

/**
 * GraphTile - Manages a single graph area for displaying sensor history
 * 
 * Features:
 * - Drag & drop: accepts sensor tiles to display their history
 * - Period selection: 1h, 1d, or max (all data)
 * - Auto-resize: adjusts canvas size when container resizes
 * - Canvas-based rendering: draws charts directly without external libraries
 */
class GraphTile {
  constructor(rootEl, key = null, period = '1h') {
    this.el = rootEl;        // Root DOM element
    this.period = period;    // Time period: '1h', '1d', or 'max'
    this.key = key;          // Sensor key being displayed (null = empty)
    this.data = null;
    this.unit = null;
    this.hoverX = null;      // Track hover X coordinate

    // Cache DOM elements
    this.title = this.el.querySelector('.chart-title');
    this.canvas = this.el.querySelector('canvas.chart');
    this.hint = this.el.querySelector('.chart-hint');
    this.buttons = Array.from(this.el.querySelectorAll('.periods button'));

    // Graph tiles are NOT draggable (they accept drops instead)
    this.el.removeAttribute('draggable');

    // Setup drag & drop handlers
    this.el.addEventListener('dragover', e => this.onDragOver(e));
    this.el.addEventListener('dragleave', e => this.onDragLeave(e));
    this.el.addEventListener('drop', e => this.onDrop(e));

    // Setup period button handlers
    this.buttons.forEach(b => {
      b.addEventListener('click', e => this.onPeriodClick(e));
    });

    // Setup tooltip interaction
    if (this.canvas) {
      // Use pointer events to handle both mouse and touch without delay
      this.canvas.style.touchAction = 'none'; // Prevent browser scrolling
      this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e), { passive: true });
      this.canvas.addEventListener('pointermove', e => this.onPointerMove(e), { passive: true });
      this.canvas.addEventListener('pointerup', e => this.onPointerUp(e), { passive: true });
      this.canvas.addEventListener('pointercancel', e => this.onPointerUp(e), { passive: true });
      this.canvas.addEventListener('pointerleave', e => this.onPointerLeave(e), { passive: true });
    }
    
    this.syncButtons();
    this.reset();

    // Setup auto-resize observer for crisp canvas rendering
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.el);

    // Draw graph if sensor key is provided
    if (this.key) {
      this.refresh();
    }
  }

  /**
   * Cleanup: disconnect resize observer
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  /**
   * Updates button active states to match current period
   */
  syncButtons() {
    this.buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.p === this.period);
    });
  }

  /**
   * Handles period button clicks
   */
  onPeriodClick(e) {
    e.preventDefault();
    this.period = e.currentTarget.dataset.p;
    this.syncButtons();
    if (this.key) {
      this.refresh();
    }
  }

  /**
   * Handles pointer down to update tooltip and capture pointer (for touch scrubbing)
   */
  onPointerDown(e) {
    if (this.canvas && typeof this.canvas.setPointerCapture === 'function') {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
    }
    this.onPointerMove(e);
  }

  /**
   * Handles pointer up/cancel to hide tooltip and release capture
   */
  onPointerUp(e) {
    this.hoverX = null;
    this.render();
    if (this.canvas && typeof this.canvas.releasePointerCapture === 'function') {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch (err) {}
    }
  }

  /**
   * Handles pointer move to show tooltip
   */
  onPointerMove(e) {
    if (!this.key || !this.data || this.data.length === 0) return;
    
    // Get X coordinate relative to the canvas
    const rect = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - rect.left;
    
    // Redraw to show tooltip
    this.render();
  }

  /**
   * Handles pointer leave to hide tooltip
   */
  onPointerLeave(e) {
    // If we have captured the pointer (e.g. touch scrubbing), ignore leave
    if (this.canvas && e && typeof this.canvas.hasPointerCapture === 'function') {
      try {
        if (this.canvas.hasPointerCapture(e.pointerId)) return;
      } catch (err) {}
    }
    this.hoverX = null;
    this.render();
  }

  /**
   * Handles drag over event - shows visual feedback
   */
  onDragOver(e) {
    if (!draggedTile || !draggedTile.dataset.k) return;
    e.preventDefault();
    this.el.classList.add('chart-over');
  }

  /**
   * Handles drag leave event - removes visual feedback
   */
  onDragLeave(e) {
    const rel = e.relatedTarget;
    if (!rel || !this.el.contains(rel)) {
      this.el.classList.remove('chart-over');
    }
  }

  /**
   * Handles drop event - sets sensor key and draws graph
   */
  async onDrop(e) {
    if (!draggedTile || !draggedTile.dataset.k) return;
    e.preventDefault();
    this.el.classList.remove('chart-over');
    this.key = draggedTile.dataset.k;
    this.hoverX = null; // Reset hover state
    await this.refresh();
  }

  /**
   * Resets graph to empty state
   */
  reset() {
    if (this.title) {
      this.title.textContent = '—';
    }
    if (this.hint) {
      this.hint.textContent = DEFAULT_CHART_HINT;
    }
    this.hoverX = null;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Resizes canvas to match container size with device pixel ratio
   * Ensures crisp rendering on high-DPI displays
   */
  resizeCanvas() {
    const body = this.el.querySelector('.graph-body');
    if (!body) return;

    // Get CSS dimensions
    const cssW = Math.max(1, Math.floor(body.clientWidth));
    const cssH = Math.max(1, Math.floor(body.clientHeight - (this.hint?.offsetHeight || 0)));
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    // Set canvas size (internal resolution)
    this.canvas.width = cssW * dpr;
    this.canvas.height = cssH * dpr;
    
    // Set CSS size (display size)
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    // Scale context for high-DPI
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    // Redraw if sensor is assigned
    if (this.key) {
      this.render();
    }
  }

  /**
   * Fetches historical data and renders the graph
   */
  async refresh() {
    if (!this.key) return;

    // Update title
    if (this.title) {
      this.title.textContent = `${this.key} (${this.period})`;
    }
    this.syncButtons();

    // Clear canvas
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Fetch historical data
    let unit, data;
    try {
      ({ unit, data } = await fetchHistory(this.key, this.period));
    } catch {
      if (this.hint) {
        this.hint.textContent = 'Failed to load data';
      }
      return;
    }
    
    this.unit = unit;
    this.data = data;
    this.render();
  }

  /**
   * Adds a new data point and re-renders without fetching
   */
  addPoint(o) {
      if (this.key && this.data) {
          const val = { ts: o.ts, value: o.value };
          this.data.push(val);
          
          // Prune based on period
          if (this.period !== 'max') {
             const now = new Date().getTime();
             const ms = this.period === '1d' ? 86400000 : 3600000;
             const cutoff = now - ms;
             
             // Simple loop to remove old points from the start
             while(this.data.length > 0 && new Date(this.data[0].ts).getTime() < cutoff) {
                 this.data.shift();
             }
          }
          this.render();
      }
  }

  /**
   * Renders the graph using cached data
   */
  render() {
    if (!this.key) return;

    // Update title
    if (this.title) {
      this.title.textContent = `${this.key} (${this.period})`;
    }
    this.syncButtons();
    
    // Clear canvas
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const data = this.data;
    const unit = this.unit;

    // Check if data is available
    if (!Array.isArray(data) || data.length === 0) {
      if (this.hint) {
        this.hint.textContent = 'No data';
      }
      return;
    }

    // Hide hint if data is available
    if (this.hint) {
      this.hint.textContent = '';
    }

    // Get canvas dimensions
    const w = parseFloat(this.canvas.style.width) || this.canvas.width;
    const h = parseFloat(this.canvas.style.height) || this.canvas.height;
    
    // Padding for axes and labels
    const padL = 50; // Left (for Y-axis labels)
    const padR = 12; // Right
    const padT = 12; // Top
    const padB = 24; // Bottom (for X-axis)
    
    const plotW = w - padL - padR; // Plot area width
    const plotH = h - padT - padB; // Plot area height

    // Extract and calculate ranges
    const xs = data.map(d => new Date(d.ts).getTime()); // X values (timestamps)
    const ys = data.map(d => d.value);                   // Y values (sensor values)
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const yR = (maxY - minY) || 1; // Y range (avoid division by zero)

    // Draw axes
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000'; // Ensure default stroke color
    ctx.setLineDash([]);      // Ensure default line dash

    ctx.beginPath();
    ctx.moveTo(padL, padT);        // Top-left
    ctx.lineTo(padL, h - padB);    // Bottom-left (Y-axis)
    ctx.lineTo(w - padR, h - padB); // Bottom-right (X-axis)
    ctx.stroke();

    // Draw Y-axis grid lines and labels
    ctx.font = '12px system-ui';
    ctx.fillStyle = '#000';
    for (let i = 0; i <= 4; i++) {
      const yv = minY + (yR * i / 4); // Y value at this grid line
      const y = h - padB - (plotH * i / 4); // Y position on canvas
      
      // Draw label
      ctx.fillText(yv.toFixed(2), 6, y + 4);
      
      // Draw grid line (semi-transparent)
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Draw data line
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padL + ((new Date(d.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
      const y = h - padB - ((d.value - minY) / yR) * plotH;
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = '#000';
    ctx.stroke();

    // Draw latest value as a dot with label (only if not hovering to avoid clutter, or always? keeping it always for now)
    const last = data[data.length - 1];
    const lx = padL + ((new Date(last.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
    const ly = h - padB - ((last.value - minY) / yR) * plotH;
    
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`${last.value.toFixed(2)} ${unit || ''}`, lx + 6, ly - 6);

    // ----------------------------------------
    // Draw Tooltip / Hover Indicator
    // ----------------------------------------
    if (this.hoverX !== null) {
      // 1. Determine which data point is closest to the cursor horizontally
      const plotX = Math.max(0, Math.min(plotW, this.hoverX - padL));
      const targetTime = minX + (plotX / plotW) * (maxX - minX);
      
      // Find closest data point
      let closest = data[0];
      let minDiff = Math.abs(new Date(closest.ts).getTime() - targetTime);

      // (Optimized search could be binary search, but linear is fine for this size)
      for (let i = 1; i < data.length; i++) {
        const t = new Date(data[i].ts).getTime();
        const diff = Math.abs(t - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = data[i];
        }
      }

      if (closest) {
        // Coordinates of the closest point
        const cx = padL + ((new Date(closest.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
        const cy = h - padB - ((closest.value - minY) / yR) * plotH;

        // Draw vertical dotted line
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, padT);
        ctx.lineTo(cx, h - padB);
        ctx.strokeStyle = '#888';
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();

        // Draw highlight circle
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.stroke();

        // Prepare tooltip text
        const dateObj = new Date(closest.ts);
        const dateOnlyStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const valStr = `${closest.value.toFixed(2)} ${unit || ''}`;

        // Measure text for box
        ctx.font = '12px system-ui';
        const dateOnlyW = ctx.measureText(dateOnlyStr).width;
        const timeW = ctx.measureText(timeStr).width;
        ctx.font = 'bold 12px system-ui';
        const valW = ctx.measureText(valStr).width;
        
        const boxW = Math.max(dateOnlyW, timeW, valW) + 16;
        const boxH = 52;
        
        // Position tooltip near the point, but keep it inside canvas
        let tx = cx + 10; 
        let ty = cy - 45;

        if (tx + boxW > w - 4) {
          tx = cx - boxW - 10; // Flip to left
        }
        if (ty < 0) {
          ty = cy + 10; // Flip below if too high
        }

        // Draw Tooltip Box
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.shadowColor = 'rgba(0,0,0,0.15)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.fillRect(tx, ty, boxW, boxH);
        ctx.restore();

        // Border
        ctx.strokeStyle = '#ccc';
        ctx.strokeRect(tx, ty, boxW, boxH);

        // Draw Text
        ctx.fillStyle = '#444';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        ctx.font = '12px system-ui';
        ctx.fillText(dateOnlyStr, tx + 8, ty + 6);
        ctx.fillText(timeStr, tx + 8, ty + 20);
        
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px system-ui';
        ctx.fillText(valStr, tx + 8, ty + 34);
      }
    }
  }
}

// Create two fixed graph instances
const graph1 = new GraphTile(document.getElementById('graph-1'), null, '1h');
const graph2 = new GraphTile(document.getElementById('graph-2'), null, '1h');
const graphs = [graph1, graph2];

/* ============================================================================
 * DRAG & DROP HANDLERS
 * ============================================================================ */

/**
 * Handles drag start event for sensor tiles
 */
function onTileDragStart(e) {
  draggedTile = e.currentTarget;
  draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k || '');
  
  // Set custom drag image (the tile itself) for better visual feedback
  if (typeof e.dataTransfer.setDragImage === 'function') {
    const rect = draggedTile.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
      e.dataTransfer.setDragImage(draggedTile, offsetX, offsetY);
    }
  }
  
  showTrash();
}

/**
 * Handles drag end event for sensor tiles
 */
function onTileDragEnd() {
  if (!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  hideTrash();
}

/**
 * Shows trash icon (for deleting tiles)
 */
function showTrash() {
  trash.classList.add('show');
}

/**
 * Hides trash icon
 */
function hideTrash() {
  trash.classList.remove('show', 'over');
}

// Trash drop handlers
trash.addEventListener('dragover', e => {
  if (!draggedTile) return;
  e.preventDefault();
  trash.classList.add('over');
});

trash.addEventListener('dragleave', () => {
  trash.classList.remove('over');
});

trash.addEventListener('drop', e => {
  e.preventDefault();
  trash.classList.remove('over');
  
  if (!draggedTile || !draggedTile.dataset.k) return;
  
  const k = draggedTile.dataset.k;
  
  // Hide tile and mark as muted (won't show until next update)
  mutedUntilNextUpdate.add(k);
  draggedTile.style.display = 'none';
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  
  hideTrash();
});

/* ============================================================================
 * WEBSOCKET CONNECTION
 * ============================================================================ */

/**
 * Establishes WebSocket connection to server
 * - Automatically reconnects on disconnect
 * - Handles snapshot (initial data) and update messages
 */
function connectWS() {
  // Determine WebSocket protocol (ws:// or wss://)
  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = protocol + location.host + '/ws';
  
  ws = new WebSocket(url);
  
  // Update connection status
  conn.textContent = 'connecting…';
  
  // Connection opened
  ws.onopen = () => {
    conn.textContent = 'live';
  };
  
  // Connection closed, schedule reconnection
  ws.onclose = () => {
    conn.textContent = 'disconnected';
    scheduleReconnect();
  };
  
  // Connection error
  ws.onerror = () => {
    conn.textContent = 'error';
    try {
      ws.close();
    } catch {}
  };
  
  // Message received
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      
      if (msg.type === 'snapshot') {
        // Initial data when connecting - load all sensors at once
        let anyNew = false;
        msg.data.forEach(o => {
          const k = key(o);
          
          if (!tileEls.has(k)) {
            anyNew = true;
          }

          store.set(k, o);
          lastSeen.set(k, Date.now());
          
          // Only render if not muted (not deleted)
          if (!mutedUntilNextUpdate.has(k)) {
            render(o);
          }
        });
        
        if (anyNew) {
          sortTiles();
        }
        
      } else if (msg.type === 'update') {
        // Single sensor update - update tile and refresh graphs if needed
        const o = msg.data;
        const k = key(o);
        
        const isNew = !tileEls.has(k);

        store.set(k, o);
        lastSeen.set(k, Date.now());
        render(o);
        
        if (isNew) {
          sortTiles();
        }
        
        // Refresh any graphs showing this sensor
        graphs.forEach(gt => {
          if (gt.key === k) {
            gt.addPoint(o);
          }
        });
      }
    } catch (e) {
      console.error('WebSocket JSON parse error', e);
    }
  };
}

/**
 * Schedules a reconnection attempt after 4 seconds
 * Prevents multiple simultaneous reconnection attempts
 */
function scheduleReconnect() {
  if (reconnectTimer) return; // Already scheduled
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, 4000);
}

/* ============================================================================
 * HTTP API FUNCTIONS
 * ============================================================================ */

/**
 * Fetches historical sensor data from server
 * @param {string} k - Sensor key (node/cluster/sensor)
 * @param {string} period - Time period: '1h', '1d', or 'max'
 * @returns {Promise<{unit: string, data: Array}>}
 */
async function fetchHistory(k, period) {
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if (!r.ok) {
    throw new Error('HTTP ' + r.status);
  }
  return r.json();
}

/**
 * Calls the backend to clear history
 * - If key is provided, clears only that series
 * - Otherwise clears all history
 */
async function clearHistory(key = null) {
  const url = key ? `/history/clear?key=${encodeURIComponent(key)}` : '/history/clear';
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ============================================================================
 * INITIALIZATION
 * ============================================================================ */

// Start WebSocket connection when page loads
connectWS();

// Wire header menu button
if (headerMenuBtn) {
  headerMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openHeaderMenu(headerMenuBtn);
  });
}

/* ============================================================================
 * MANUAL INPUT MODAL
 * ============================================================================ */

const manualModal = document.getElementById('manual-modal');
const manualSelect = document.getElementById('manual-select-topic');
const manualNewWrap = document.getElementById('manual-new-topic-wrap');
const manualToggleBtn = document.getElementById('manual-toggle-new');
const manualSendBtn = document.getElementById('manual-send-btn');
const manualCancelBtn = document.getElementById('manual-cancel-btn');
const manualCloseBtn = document.getElementById('manual-close-btn');

let isNewTopicMode = false;

function openManualInputModal() {
  // Populate select with existing topics
  manualSelect.innerHTML = '';
  const sortedKeys = Array.from(store.keys()).sort();
  sortedKeys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    manualSelect.appendChild(opt);
  });
  
  if (sortedKeys.length === 0) {
    // Force new mode if no topics
    isNewTopicMode = true;
  } else {
    isNewTopicMode = false;
  }
  
  updateManualMode();
  
  // Clear values
  document.getElementById('manual-value').value = '';
  
  // Show modal
  manualModal.style.display = 'flex';
  
  // Focus value input (trigger keyboard)
  setTimeout(() => {
    document.getElementById('manual-value').focus();
  }, 100);
}

function closeManualModal() {
  manualModal.style.display = 'none';
}

function updateManualMode() {
  if (isNewTopicMode) {
    manualSelect.style.display = 'none';
    manualNewWrap.style.display = 'flex';
    manualToggleBtn.textContent = 'Select Existing Topic';
  } else {
    manualSelect.style.display = 'block';
    manualNewWrap.style.display = 'none';
    manualToggleBtn.textContent = 'Create New Topic';
  }
}

// Event Listeners for Manual Modal
if (manualToggleBtn) {
  manualToggleBtn.addEventListener('click', () => {
    isNewTopicMode = !isNewTopicMode;
    updateManualMode();
  });
}

[manualCloseBtn, manualCancelBtn].forEach(btn => {
  if(btn) btn.addEventListener('click', closeManualModal);
});

if (manualSendBtn) {
  manualSendBtn.addEventListener('click', async () => {
    const valStr = document.getElementById('manual-value').value;
    if (valStr === '') {
      alert('Please enter a value');
      return;
    }
    const val = parseFloat(valStr);
    const unit = document.getElementById('manual-unit').value;
    
    let node, cluster, sensor;
    
    if (isNewTopicMode) {
      node = document.getElementById('manual-node').value.trim() || 'manual';
      cluster = document.getElementById('manual-cluster').value.trim() || 'manual';
      sensor = document.getElementById('manual-sensor').value.trim() || 'value';
    } else {
      // Parse key: "node/cluster/sensor"
      const k = manualSelect.value;
      const parts = k.split('/');
      node = parts[0];
      cluster = parts[1];
      sensor = parts[2];
      
      // If we selected an existing topic, we might want to preserve unit if not specified
      if (!unit && store.has(k)) {
        // unit = store.get(k).unit; // Wait, we are sending to backend, backend handles it? 
        // Backend takes input unit. If we send empty unit, backend uses empty unit.
        // It's better if the user enters it if changed, or we can pre-fill it.
        // For now, let's just send what is typed.
      }
    }
    
    const payload = {
      node, cluster, sensor, value: val, unit
    };
    
    try {
      manualSendBtn.disabled = true;
      manualSendBtn.textContent = 'Sending...';
      
      const res = await fetch('/api/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) throw new Error('Failed to send');
      
      // Success: Keep modal open, show feedback, clear value
      manualSendBtn.textContent = 'Sent!';
      document.getElementById('manual-value').value = '';
      document.getElementById('manual-value').focus();

      setTimeout(() => {
        manualSendBtn.disabled = false;
        manualSendBtn.textContent = 'Send Update';
      }, 750);
      
    } catch (e) {
      alert('Error sending value: ' + e.message);
      manualSendBtn.disabled = false;
      manualSendBtn.textContent = 'Send Update';
    }
  });
}
