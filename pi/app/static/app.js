/* ============================================================================
 * Barkasse UI: modular tiles + health dot + drag-to-trash + drag-to-chart
 * ==========================================================================*/
const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const chartCanvas = document.getElementById('chart');
const chartSection = document.getElementById('chart-section');
const chartTitle = document.getElementById('chart-title');
const chartHint  = document.getElementById('chart-hint');
const trash = document.getElementById('trash');
const periodButtons = Array.from(document.querySelectorAll('#periods button'));

const store = new Map();                 // key -> latest payload
const mutedUntilNextUpdate = new Set();  // keys muted by user
const lastSeen = new Map();   // key -> Date.now() of last WS update we saw
let ws, reconnectTimer = null;
let draggedTile = null;
let allowAutoSort = true;
let currentChartKey = null;
let currentChartPeriod = '1h';



// ---- Timestamp handling: ISO / epoch(s) / epoch(ms) → Date ----
function parseAnyTs(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  if (typeof ts === 'number' || (typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts))) {
    let n = Number(ts);
    if (n > 1e12) n = n / 1e6;           // ns -> ms
    if (n > 1e10) return new Date(n);    // ms
    return new Date(n * 1000);           // s
  }
  const iso = String(ts).replace('Z', '+00:00');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function ageMinutesForKey(k, ts) {
  const byTs = (() => {
    const d = parseAnyTs(ts);
    return d ? (Date.now() - d.getTime()) / 60000 : Infinity;
  })();
  const seen = lastSeen.get(k);
  const bySeen = seen ? (Date.now() - seen) / 60000 : Infinity;
  return Math.min(byTs, bySeen);
}


// ---- Keys / formatting ----
function key(o) { return `${o.node}/${o.cluster}/${o.sensor || 'state'}`; }
function formatValue(val) {
  if (val === undefined || val === null || val === '') return '—';
  if (typeof val === 'number') return Number.parseFloat(val).toFixed(2);
  return String(val);
}

// ---- Tiles ----
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
      <div class="meta node"></div>
      <div class="value">
        <span class="num">—</span><span class="unit"></span>
      </div>
      <div class="meta ts"></div>
    `;
    el.setAttribute('draggable', 'true');
    grid.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0'));
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);
  }
  return el;
}

function render(o) {
  const k = key(o);
  if (mutedUntilNextUpdate.has(k)) mutedUntilNextUpdate.delete(k);
  const el = ensureTile(o);
  el.style.display = '';
  el.querySelector('h3').textContent = `${o.cluster} / ${o.sensor}`;
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent = o.ts || '';
  updateHealthDot(el, o.ts);
}

function updateHealthDot(tileEl, ts) {
  const k = tileEl.dataset.k;
  const m = ageMinutesForKey(k, ts);
  let color = '#bbb';
  if (m < 3) color = '#2ecc71';         // green
  else if (m >= 60) color = '#e74c3c';  // red
  else color = '#f1c40f';               // yellow
  tileEl.querySelector('.dot').style.background = color;
}


// refresh dots every 30s
setInterval(() => {
  document.querySelectorAll('.tile').forEach(tile => {
    const o = store.get(tile.dataset.k);
    if (o) updateHealthDot(tile, o.ts);
  });
}, 30000);

// ---- WebSocket ----
function connectWS() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(wsUrl);
  conn.textContent = 'connecting…';

  ws.addEventListener('open', () => { conn.textContent = 'live'; });
  ws.addEventListener('close', () => { conn.textContent = 'disconnected'; scheduleReconnect(); });
  ws.addEventListener('error', () => { conn.textContent = 'error'; try { ws.close(); } catch {} });

  ws.addEventListener('message', (ev) => {
    try { handleMessage(JSON.parse(ev.data)); }
    catch (e) { console.error('[WS] JSON parse error', e); }
  });
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, 4000);
}
function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    msg.data.forEach(o => {
      const k = key(o);
      store.set(k, o);
      lastSeen.set(k, Date.now());          // <—
      if (!mutedUntilNextUpdate.has(k)) render(o);
    });
    if (allowAutoSort) sortTiles();
  } else if (msg.type === 'update') {
    const o = msg.data; const k = key(o);
    store.set(k, o);
    lastSeen.set(k, Date.now());            // <—
    render(o);
    if (allowAutoSort) sortTiles();
    if (currentChartKey === k) drawChartFor(currentChartKey, currentChartPeriod);
  }
}

// ---- Sorting ----
function sortTiles() {
  const tiles = Array.from(grid.children);
  tiles.sort((a, b) => a.dataset.k.localeCompare(b.dataset.k));
  tiles.forEach(t => grid.appendChild(t));
}
setInterval(() => { if (allowAutoSort) sortTiles(); }, 30000);

// ---- Drag: grid/trash/chart ----
function onTileDragStart(event) {
  draggedTile = event.currentTarget;
  allowAutoSort = false;
  draggedTile.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedTile.dataset.k || '');
  showTrash(true);
  chartSection.classList.add('chart-over');
}
function onTileDragEnd() {
  if (!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  showTrash(false);
  chartSection.classList.remove('chart-over');
}

// grid reordering
grid.addEventListener('dragover', (e) => {
  if (!draggedTile) return; e.preventDefault();
  const dropTarget = getClosestDropTarget(e.clientX, e.clientY);
  let ref = null;
  if (dropTarget && dropTarget !== draggedTile) {
    const r = dropTarget.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const placeAfter = Math.abs(e.clientX - cx) > Math.abs(e.clientY - cy)
      ? (e.clientX - cx) > 0
      : (e.clientY - cy) > 0;
    ref = placeAfter ? dropTarget.nextElementSibling : dropTarget;
  }
  if (ref !== draggedTile) grid.insertBefore(draggedTile, ref);
});
grid.addEventListener('drop', (e) => { if (draggedTile) e.preventDefault(); });

// trash
trash.addEventListener('dragover', (e) => { if (!draggedTile) return; e.preventDefault(); trash.classList.add('over'); });
trash.addEventListener('dragleave', () => trash.classList.remove('over'));
trash.addEventListener('drop', (e) => {
  e.preventDefault(); trash.classList.remove('over');
  if (!draggedTile) return;
  const k = draggedTile.dataset.k;
  mutedUntilNextUpdate.add(k);
  if (currentChartKey === k) {
    currentChartKey = null;
    chartTitle.textContent = '—';
    chartHint.textContent = 'Drag a tile here to view its history';
    chartCanvas.getContext('2d').clearRect(0,0,chartCanvas.width,chartCanvas.height);
  }
  draggedTile.style.display = 'none';
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  showTrash(false);
});
function showTrash(show) { trash.classList.toggle('show', show); }

function getClosestDropTarget(x, y) {
  const candidates = Array.from(grid.querySelectorAll('.tile:not(.dragging)'));
  if (!candidates.length) return null;
  let closest = null, minD = Infinity;
  for (const t of candidates) {
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const d = Math.hypot(x - cx, y - cy);
    if (d < minD) { minD = d; closest = t; }
  }
  return closest;
}

// chart drop (section + canvas)
chartSection.addEventListener('dragover', (e) => { if (!draggedTile) return; e.preventDefault(); });
chartSection.addEventListener('drop', (e) => { e.preventDefault(); if (!draggedTile) return; drawChartFor(draggedTile.dataset.k, currentChartPeriod); });
chartCanvas.addEventListener('dragover', (e) => { if (!draggedTile) return; e.preventDefault(); });
chartCanvas.addEventListener('drop', (e) => { e.preventDefault(); if (!draggedTile) return; drawChartFor(draggedTile.dataset.k, currentChartPeriod); });

// ---- Chart ----
periodButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    periodButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartPeriod = btn.dataset.p;
    if (currentChartKey) await drawChartFor(currentChartKey, currentChartPeriod);
  });
});

async function fetchHistory(k, period) {
  const res = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if (!res.ok) throw new Error('history HTTP ' + res.status);
  return res.json();
}

async function drawChartFor(k, period) {
  currentChartKey = k;
  chartTitle.textContent = `${k} (${period})`;

  const ctx = chartCanvas.getContext('2d');
  ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);

  let payload = { unit:'', data:[] };
  try {
    payload = await fetchHistory(k, period);
  } catch (e) {
    console.error('History fetch failed:', e);
  }

  let { unit, data } = payload || { unit:'', data:[] };

  // --- Fallback: no history yet? Use the latest live reading so the user sees something.
  if (!Array.isArray(data) || data.length === 0) {
    const live = store.get(k);
    if (live && typeof live.value !== 'undefined') {
      data = [{
        ts: live.ts || new Date().toISOString(),
        value: Number(live.value),
        unit: live.unit || ''
      }];
      unit = live.unit || unit;
    }
  }

  if (!data.length) { chartHint.textContent = 'No data'; return; }
  chartHint.textContent = '';

  const w = chartCanvas.width, h = chartCanvas.height;
  const padL = 50, padR = 12, padT = 12, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const xs = data.map(d => new Date(d.ts).getTime());
  const ys = data.map(d => d.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const yR = (maxY - minY) || 1;

  // axes
  ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB); ctx.lineTo(w - padR, h - padB); ctx.stroke();

  // Y ticks
  ctx.font = '12px system-ui';
  for (let i = 0; i <= 4; i++) {
    const yv = minY + (yR * i / 4);
    const y = h - padB - (plotH * i / 4);
    ctx.fillText(yv.toFixed(2), 6, y + 4);
    ctx.globalAlpha = 0.12; ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // line
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = padL + ((new Date(d.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
    const y = h - padB - ((d.value - minY) / yR) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // last point marker
  const last = data[data.length - 1];
  const lx = padL + ((new Date(last.ts).getTime() - minX) / (maxX - minX || 1)) * plotW;
  const ly = h - padB - ((last.value - minY) / yR) * plotH;
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillText(`${last.value.toFixed(2)} ${unit || ''}`, lx + 6, ly - 6);
}

// ---- Start ----
connectWS();
