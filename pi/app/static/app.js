/* ============================================================================
 * Barkasse Dashboard Frontend Logic
 * ---------------------------------------------------------------------------
 * - Connects to FastAPI backend via WebSocket
 * - Receives live MQTT JSON updates from all nodes
 * - Dynamically creates & updates sensor tiles
 * - Shows connection state (connecting / live / disconnected)
 * - Robust auto-reconnect & error handling
 * ==========================================================================*/

const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const store = new Map(); // key -> latest sensor object
let ws;                  // WebSocket instance
let reconnectTimer = null;
let draggedTile = null;
let allowAutoSort = true;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function key(o) {
  return `${o.node}/${o.cluster}/${o.sensor || 'state'}`;
}

function formatValue(val) {
  if (val === undefined || val === null || val === '') return '—';
  if (typeof val === 'number') {
    // Round to 2 decimals for readability
    return Number.parseFloat(val).toFixed(2);
  }
  return String(val);
}

// ---------------------------------------------------------------------------
// Tile creation & update
// ---------------------------------------------------------------------------

function ensureTile(o) {
  const k = key(o);
  let el = document.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.innerHTML = `
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta">${o.node}</div>
      <div class="value">
        <span class="num">—</span>
        <span class="unit"></span>
      </div>
      <div class="meta ts"></div>
    `;
    grid.appendChild(el);

    // Fade-in animation
    requestAnimationFrame(() => el.classList.remove('opacity-0'));
  }
  el.setAttribute('draggable', 'true');
  return el;
}

function render(o) {
  const el = ensureTile(o);
  el.querySelector('h3').textContent = `${o.cluster} / ${o.sensor}`;
  el.querySelector('.meta').textContent = o.node;
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';
}

// ---------------------------------------------------------------------------
// WebSocket connection & handling
// ---------------------------------------------------------------------------

function connectWS() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host + '/ws';

  ws = new WebSocket(wsUrl);
  console.log(`[WS] Connecting to ${wsUrl} ...`);
  conn.textContent = 'connecting...';

  ws.addEventListener('open', () => {
    console.log('[WS] Connected');
    conn.textContent = 'live';
  });

  ws.addEventListener('close', () => {
    console.warn('[WS] Disconnected');
    conn.textContent = 'disconnected';
    scheduleReconnect();
  });

  ws.addEventListener('error', (err) => {
    console.error('[WS] Error:', err);
    conn.textContent = 'error';
    ws.close();
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleMessage(msg);
    } catch (e) {
      console.error('[WS] JSON parse error', e);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[WS] Reconnecting...');
    connectWS();
  }, 4000);
}

// ---------------------------------------------------------------------------
// Message handler (from FastAPI WebSocket)
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    console.log(`[WS] Received snapshot (${msg.data.length} entries)`);
    msg.data.forEach((o) => {
      const k = key(o);
      store.set(k, o);
      render(o);
    });
  } else if (msg.type === 'update') {
    const o = msg.data;
    const k = key(o);
    store.set(k, o);
    render(o);
  } else {
    console.warn('[WS] Unknown message type:', msg);
  }
}

// ---------------------------------------------------------------------------
// Layout sorting (optional)
// ---------------------------------------------------------------------------

function sortTiles() {
  const layoutBefore = captureTilePositions();
  const tiles = Array.from(grid.children);
  tiles.sort((a, b) => a.dataset.k.localeCompare(b.dataset.k));
  tiles.forEach((t) => grid.appendChild(t));
  animateToNewPositions(layoutBefore);
}

function captureTilePositions() {
  const positions = new Map();
  for (const tile of grid.querySelectorAll('.tile')) {
    positions.set(tile, tile.getBoundingClientRect());
  }
  return positions;
}

function animateToNewPositions(previousPositions) {
  requestAnimationFrame(() => {
    for (const tile of grid.querySelectorAll('.tile')) {
      if (tile === draggedTile) continue;

      const previous = previousPositions.get(tile);
      if (!previous) continue;

      const current = tile.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;

      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        continue;
      }

      tile.style.transition = 'none';
      tile.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

      requestAnimationFrame(() => {
        tile.style.transition = '';
        tile.style.transform = '';
      });
    }
  });
}

function getClosestDropTarget(x, y) {
  const candidates = Array.from(grid.querySelectorAll('.tile:not(.dragging)'));
  if (!candidates.length) return null;

  let closest = null;
  let minDistance = Number.POSITIVE_INFINITY;

  for (const tile of candidates) {
    const rect = tile.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < minDistance) {
      minDistance = distance;
      closest = tile;
    }
  }

  return closest;
}

grid.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile) return;

  draggedTile = tile;
  allowAutoSort = false;
  tile.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  // Firefox requires dataTransfer data to be set.
  event.dataTransfer.setData('text/plain', tile.dataset.k || '');
});

grid.addEventListener('dragend', () => {
  if (!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile = null;
});

grid.addEventListener('dragover', (event) => {
  if (!draggedTile) return;
  event.preventDefault();

  const layoutBefore = captureTilePositions();

  const dropTarget = getClosestDropTarget(event.clientX, event.clientY);
  let referenceNode = null;

  if (dropTarget && dropTarget !== draggedTile) {
    const rect = dropTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const diffX = event.clientX - centerX;
    const diffY = event.clientY - centerY;
    const placeAfter = Math.abs(diffX) > Math.abs(diffY)
      ? diffX > 0
      : diffY > 0;

    referenceNode = placeAfter ? dropTarget.nextElementSibling : dropTarget;
  }

  if (referenceNode === draggedTile) {
    return;
  }

  grid.insertBefore(draggedTile, referenceNode);
  animateToNewPositions(layoutBefore);
});

grid.addEventListener('drop', (event) => {
  if (draggedTile) {
    event.preventDefault();
  }
});

// Resort every 30s just to keep things tidy unless the user rearranged tiles
setInterval(() => {
  if (allowAutoSort) {
    sortTiles();
  }
}, 30000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connectWS();

// ---------------------------------------------------------------------------
// Small CSS helper for fade-in animation (ensure you have .opacity-0 in CSS):
// .opacity-0 { opacity: 0; transform: scale(0.95); transition: opacity .5s, transform .5s; }
// .tile { transition: opacity .3s, transform .3s; }
// ---------------------------------------------------------------------------

