/* ============================================================================
 * Barkasse Dashboard Frontend Logic
 * - Modular tiles, health dot (green/yellow/red), drag-to-trash, drag-to-chart
 * - WebSocket live updates + REST /history
 * ==========================================================================*/

const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const chartCanvas = document.getElementById('chart');
const chartSection = document.getElementById('chart-section');
const chartTitle = document.getElementById('chart-title');
const chartHint = document.getElementById('chart-hint');
const trash = document.getElementById('trash');
const periodButtons = Array.from(document.querySelectorAll('#periods button'));

const store = new Map();               // key -> latest payload
const mutedUntilNextUpdate = new Set();// keys removed by user; reappear on next update
let ws;                                // WebSocket instance
let reconnectTimer = null;
let draggedTile = null;
let allowAutoSort = true;
let currentChartKey = null;
let currentChartPeriod = '1h';

// ---------- Utils ----------
function key(o) {
  return `${o.node}/${o.cluster}/${o.sensor || 'state'}`;
}
function formatValue(val) {
  if (val === undefined || val === null || val === '') return '—';
  if (typeof val === 'number') return Number.parseFloat(val).toFixed(2);
  return String(val);
}
function parseISO(ts) {
  try { return new Date(ts); } catch { return null; }
}

// ---------- Tiles ----------
function ensureTile(o) {
  const k = key(o);
  let el = document.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta">${o.node}</div>
      <div class="value">
        <span class="num">—</span>
        <span class="unit"></span>
      </div>
      <div class="meta ts"></div>
    `;
    el.setAttribute('draggable', 'true');
    grid.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0'));

    // Drag events
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);
  }
  return el;
}

function render(o) {
  const k = key(o);

  // If user muted this tile, only reinsert on a NEW update (this is one)
  if (mutedUntilNextUpdate.has(k)) {
    // Make sure it exists and is visible again
    mutedUntilNextUpdate.delete(k);
  }

  const el = ensureTile(o);
  el.style.display = ''; // ensure visible if it was hidden

  el.querySelector('h3').textContent = `${o.cluster} / ${o.sensor}`;
  el.querySelector('.meta').textContent = o.node;
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';

  // Update dot immediately (also periodically via ticker)
  updateHealthDot(el, o.ts);
}

function updateHealthDot(tileEl, ts) {
  const dot = tileEl.querySelector('.dot');
  if (!dot) return;

  let color = '#bbb'; // default unknown
  if (ts) {
    const t = parseISO(ts);
    const ageMin = t ? (Date.now() - t.getTime()) / 60000 : Infinity;
    if (ageMin < 3) color = '#2ecc71';        // green
    else if (ageMin >= 60) color = '#e74c3c'; // red
    else color = '#f1c40f';                   // yellow
  }
  dot.style.background = color;
}

// Recompute all dots every 30s
setInterval(() => {
  document.querySelectorAll('.tile').forEach(tile => {
    const k = tile.dataset.k;
    const o = store.get(k);
    if (o) updateHealthDot(tile, o.ts);
  });
}, 30000);

// ---------- WebSocket ----------
function connectWS() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(wsUrl);
  conn.textContent = 'connecting...';

  ws.addEventListener('open', () => {
    conn.textContent = 'live';
  });

  ws.addEventListener('close', () => {
    conn.textContent = 'disconnected';
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    conn.textContent = 'error';
    try { ws.close(); } catch {}
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
    connectWS();
  }, 4000);
}

function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    msg.data.forEach((o) => {
      const k = key(o);
      store.set(k, o);
      // Only render if not muted (muted will reappear on next *update*)
      if (!mutedUntilNextUpdate.has(k)) render(o);
    });
    if (allowAutoSort) sortTiles();
  } else if (msg.type === 'update') {
    const o = msg.data;
    const k = key(o);
    store.set(k, o);
    render(o);
    if (allowAutoSort) sortTiles();

    // If chart currently shows this key and period, refresh just the last point
    if (currentChartKey === k) {
      drawChartFor(currentChartKey, currentChartPeriod);
    }
  }
}

// ---------- Sorting ----------
function sortTiles() {
  const tiles = Array.from(grid.children);
  tiles.sort((a, b) => a.dataset.k.localeCompare(b.dataset.k));
  tiles.forEach((t) => grid.appendChild(t));
}

// ---------- Drag: tiles → grid / trash / chart ----------
function onTileDragStart(event) {
  const tile = event.currentTarget;
  draggedTile = tile;
  allowAutoSort = false;
  tile.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tile.dataset.k || '');

  showTrash(true);
  chartSection.classList.add('chart-over');

  // For Firefox to allow dragover targets
  document.body.classList.add('dragging-any');
}
function onTileDragEnd() {
  if (!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  showTrash(false);
  chartSection.classList.remove('chart-over');
  document.body.classList.remove('dragging-any');
}

// Grid reordering (same as before)
grid.addEventListener('dragover', (event) => {
  if (!draggedTile) return;
  event.preventDefault();
  const dropTarget = getClosestDropTarget(event.clientX, event.clientY);
  let referenceNode = null;

  if (dropTarget && dropTarget !== draggedTile) {
    const rect = dropTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const diffX = event.clientX - centerX;
    const diffY = event.clientY - centerY;
    const placeAfter = Math.abs(diffX) > Math.abs(diffY) ? diffX > 0 : diffY > 0;
    referenceNode = placeAfter ? dropTarget.nextElementSibling : dropTarget;
  }
  if (referenceNode !== draggedTile) {
    grid.insertBefore(draggedTile, referenceNode);
  }
});

// Drop to grid (no-op; handled by dragover reinsert)
grid.addEventListener('drop', (event) => {
  if (draggedTile) event.preventDefault();
});

// Trashcan drop
trash.addEventListener('dragover', (e) => {
  if (!draggedTile) return;
  e.preventDefault();
  trash.classList.add('over');
});
trash.addEventListener('dragleave', () => {
  trash.classList.remove('over');
});
trash.addEventListener('drop', (e) => {
  e.preventDefault();
  trash.classList.remove('over');
  if (!draggedTile) return;

  const k = draggedTile.dataset.k;
  mutedUntilNextUpdate.add(k);
  draggedTile.style.display = 'none';
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  showTrash(false);
});

// Chart drop
chartSection.addEventListener('dragover', (e) => {
  if (!draggedTile) return;
  e.preventDefault();
});
chartSection.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!draggedTile) return;
  const k = draggedTile.dataset.k;
  await drawChartFor(k, currentChartPeriod);
});

// Helpers for drag
function getClosestDropTarget(x, y) {
  const candidates = Array.from(grid.querySelectorAll('.tile:not(.dragging)'));
  if (!candidates.length) return null;
  let closest = null, minDistance = Number.POSITIVE_INFINITY;
  for (const tile of candidates) {
    const rect = tile.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d < minDistance) { minDistance = d; closest = tile; }
  }
  return closest;
}

function showTrash(show) {
  trash.classList.toggle('show', show);
}

// ---------- Chart ----------
periodButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    periodButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartPeriod = btn.dataset.p;
    if (currentChartKey) await drawChartFor(currentChartKey, currentChartPeriod);
  });
});

async function fetchHistory(k, period) {
  const url = `/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`;
  const res = await fetch(url);
  if (!res.ok) return { unit: '', data: [] };
  return await res.json();
}

async function drawChartFor(k, period) {
  const ctx = chartCanvas.getContext('2d');
  const { unit, data } = await fetchHistory(k, period);

  currentChartKey = k;
  chartTitle.textContent = `${k} (${period})`;
  chartHint.textContent = data.length ? '' : 'No data';
  // Clear
  ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);

  if (!data.length) return;

  // Prepare scales
  const w = chartCanvas.width, h = chartCanvas.height;
  const padL = 50, padR = 12, padT = 12, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xs = data.map(d => new Date(d.ts).getTime());
  const ys = data.map(d => d.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const yRange = (maxY - minY) || 1;

  // Axes
  ctx.lineWidth = 1; ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();

  // Y ticks (4)
  ctx.font = '12px system-ui';
  for (let i = 0; i <= 4; i++) {
    const yv = minY + (yRange * i / 4);
    const y = h - padB - (plotH * i / 4);
    ctx.fillText(yv.toFixed(2), 6, y + 4);
    ctx.globalAlpha = 0.12;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Line
  ctx.beginPath();
  data.forEach((d, i) => {
    const tx = new Date(d.ts).getTime();
    const x = padL + ((tx - minX) / (maxX - minX || 1)) * plotW;
    const y = h - padB - ((d.value - minY) / yRange) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Last point marker + label
  const last = data[data.length - 1];
  const lx = padL + ((new Date(last.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
  const ly = h - padB - ((last.value - minY) / yRange) * plotH;
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillText(`${last.value.toFixed(2)} ${unit || ''}`, lx + 6, ly - 6);
}

// ---------- Start ----------
connectWS();

// Resort every 30s (unless user rearranged)
setInterval(() => { if (allowAutoSort) sortTiles(); }, 30000);

// Small CSS helper note in code comments:
// .opacity-0 { opacity: 0; transform: scale(0.95); transition: opacity .5s, transform .5s; }
