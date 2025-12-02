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
const btnClearHistory = document.getElementById('btn-clear-history'); // Clear history button
const trash = document.getElementById('trash');   // Trash icon for deleting tiles

// Constants
const DEFAULT_CHART_HINT = 'Drag a tile here to view its history';

// Data storage
const store = new Map();                 // Stores latest sensor data: key -> sensor payload
const lastSeen = new Map();              // Tracks when each sensor last sent data: key -> timestamp
const mutedUntilNextUpdate = new Set();  // Tracks tiles that should be hidden until next update

// WebSocket and UI state
let ws = null;                    // WebSocket connection
let reconnectTimer = null;        // Timer for reconnection attempts
let draggedTile = null;           // Currently dragged tile element

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
  let el = topics.querySelector(`[data-k="${CSS.escape(k)}"]`);
  
  // Create new tile if it doesn't exist
  if (!el) {
    // Create tile element
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta node"></div>
      <div class="value"><span class="num">—</span><span class="unit"></span></div>
      <div class="meta ts"></div>
    `;

    // Add to DOM and fade in
    topics.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0'));

    // Setup drag & drop based on input device type
    const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    
    if (!isCoarse) {
      // Mouse/precision pointer: enable drag immediately
      el.setAttribute('draggable', 'true');
    }

    // Common drag handlers for both mouse and touch
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);

    // Prevent native image drag behavior
    el.addEventListener('mousedown', (e) => {
      if (e.target && e.target.tagName === 'IMG') {
        e.preventDefault();
      }
    });

    // Touch-friendly drag: enable only after long-press (~400ms)
    if (isCoarse) {
      let lpTimer = null;

      const enableDrag = () => {
        el.setAttribute('draggable', 'true');
        el.classList.add('drag-ready');
      };

      const disableDrag = () => {
        el.removeAttribute('draggable');
        el.classList.remove('drag-ready');
      };

      // Start long-press timer on touch start
      el.addEventListener('touchstart', () => {
        lpTimer = setTimeout(enableDrag, 400);
      }, { passive: true });

      // Cancel drag activation if user scrolls
      el.addEventListener('touchmove', () => {
        clearTimeout(lpTimer);
      }, { passive: true });

      // Clean up after touch ends
      el.addEventListener('touchend', () => {
        clearTimeout(lpTimer);
        // If drag didn't happen, disable drag after short delay
        setTimeout(() => {
          if (!el.classList.contains('dragging')) {
            disableDrag();
          }
        }, 50);
      }, { passive: true });

      // Disable drag after drag completes (so scrolling stays smooth)
      el.addEventListener('dragend', () => {
        disableDrag();
      });
    }
  }

  // Update tile content with sensor data
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';

  return el;
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
  
  // Update tile content
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';
  
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
    
    this.syncButtons();
    this.reset();

    // Setup auto-resize observer for crisp canvas rendering
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.el);

    // Draw graph if sensor key is provided
    if (this.key) {
      this.draw();
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
      this.draw();
    }
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
    await this.draw();
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
      this.draw();
    }
  }

  /**
   * Draws the graph with historical sensor data
   * - Fetches data from /history endpoint
   - Draws axes, grid lines, and data line
   * - Shows latest value as a dot with label
   */
  async draw() {
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
    ctx.beginPath();
    ctx.moveTo(padL, padT);        // Top-left
    ctx.lineTo(padL, h - padB);    // Bottom-left (Y-axis)
    ctx.lineTo(w - padR, h - padB); // Bottom-right (X-axis)
    ctx.stroke();

    // Draw Y-axis grid lines and labels
    ctx.font = '12px system-ui';
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
    ctx.stroke();

    // Draw latest value as a dot with label
    const last = data[data.length - 1];
    const lx = padL + ((new Date(last.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
    const ly = h - padB - ((last.value - minY) / yR) * plotH;
    
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`${last.value.toFixed(2)} ${unit || ''}`, lx + 6, ly - 6);
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
        msg.data.forEach(o => {
          const k = key(o);
          store.set(k, o);
          lastSeen.set(k, Date.now());
          
          // Only render if not muted (not deleted)
          if (!mutedUntilNextUpdate.has(k)) {
            render(o);
          }
        });
        sortTiles();
        
      } else if (msg.type === 'update') {
        // Single sensor update - update tile and refresh graphs if needed
        const o = msg.data;
        const k = key(o);
        
        store.set(k, o);
        lastSeen.set(k, Date.now());
        render(o);
        sortTiles();
        
        // Refresh any graphs showing this sensor
        graphs.forEach(gt => {
          if (gt.key === k) {
            gt.draw();
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

// Wire Clear History button
if (btnClearHistory) {
  btnClearHistory.addEventListener('click', async () => {
    const proceed = confirm('Delete stored history on this Raspberry Pi? This cannot be undone.');
    if (!proceed) return;
    try {
      const res = await clearHistory();
      // After clearing, force graphs to redraw (they will show "No data")
      graphs.forEach(g => g.key && g.draw());
      // Brief visual feedback
      btnClearHistory.disabled = true;
      const old = btnClearHistory.textContent;
      btnClearHistory.textContent = 'History cleared';
      setTimeout(() => {
        btnClearHistory.disabled = false;
        btnClearHistory.textContent = old;
      }, 1500);
    } catch (e) {
      alert('Failed to clear history: ' + e.message);
    }
  });
}
