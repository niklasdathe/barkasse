/* === globals === */
const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const store = new Map();                 // key -> last payload
const lastSeen = new Map();              // key -> Date.now() of last WS message
const mutedUntilNextUpdate = new Set();

const createGraphBtn = document.getElementById('create-graph');
const trash = document.getElementById('trash');

let ws, reconnectTimer = null;
let draggedTile = null;
let allowAutoSort = true;
let bootstrappedOnce = false;

/* === helpers === */
function key(o){ return `${o.node}/${o.cluster}/${o.sensor || 'state'}`; }
function formatValue(v){ return (v===undefined||v===null||v==='') ? '—' : (typeof v==='number'? v.toFixed(2): String(v)); }
function ageMinutesFromSeen(k){ const t=lastSeen.get(k); return t? (Date.now()-t)/60000 : Infinity; }

/* === tiles === */
function ensureTile(o){
  const k = key(o);
  let el = document.querySelector(`[data-k="${CSS.escape(k)}"]`); // tolerate old tiles without data-type
  if(!el){
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.dataset.type = 'metric';
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta node"></div>
      <div class="value"><span class="num">—</span><span class="unit"></span></div>
      <div class="meta ts"></div>`;
    makeTileDraggable(el);
    grid.appendChild(el);
    requestAnimationFrame(()=>el.classList.remove('opacity-0'));
  }
  return el;
}
function paintDot(el){
  const k = el.dataset.k;
  const m = ageMinutesFromSeen(k);
  let color = '#bbb';
  if (m < 3) color = '#2ecc71'; else if (m >= 60) color = '#e74c3c'; else color = '#f1c40f';
  const d = el.querySelector('.dot');
  if (d) d.style.background = color;
}
function render(o){
  const k = key(o);
  if (mutedUntilNextUpdate.has(k)) mutedUntilNextUpdate.delete(k);
  const el = ensureTile(o);
  el.style.display = '';
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent  = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent   = o.ts || '';
  paintDot(el);
}
setInterval(()=>{ document.querySelectorAll('.tile').forEach(paintDot); }, 30000);

/* === chart tile === */
function chartTileIdForKey(k){ return `chart__${k}`; }

function createChartTile(k, period='1h'){
  // If a chart tile for this key already exists, just focus/redraw it
  let existing = document.getElementById(chartTileIdForKey(k));
  if (existing){
    existing.querySelectorAll('.periods button').forEach(b=>{
      b.classList.toggle('active', b.dataset.p === period);
    });
    drawChartInto(existing, k, period);
    grid.insertBefore(existing, grid.firstChild); // surface it slightly
    return existing;
  }

  const tile = document.createElement('div');
  tile.className = 'tile chart opacity-0';
  tile.id = chartTileIdForKey(k);
  tile.dataset.type = 'chart';
  tile.dataset.k = k;
  tile.innerHTML = `
    <div class="chart-head">
      <div class="chart-title">${k}</div>
      <div class="periods" role="group" aria-label="Chart period">
        <button data-p="1h" class="active">1h</button>
        <button data-p="1d">1d</button>
        <button data-p="max">max</button>
      </div>
    </div>
    <div class="chart-body">
      <canvas width="1200" height="240"></canvas>
      <div class="chart-hint">Drag metrics anywhere; drop a metric tile on 📈 to make charts</div>
    </div>`;

  makeTileDraggable(tile);
  grid.appendChild(tile);
  requestAnimationFrame(()=>tile.classList.remove('opacity-0'));

  // Period clicks (delegated per tile)
  tile.querySelector('.periods').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if (!btn) return;
    const p = btn.dataset.p;
    tile.querySelectorAll('.periods button').forEach(b=>b.classList.toggle('active', b===btn));
    drawChartInto(tile, k, p);
  });

  drawChartInto(tile, k, period);
  return tile;
}

async function fetchHistory(k, period){
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

async function drawChartInto(tile, k, period){
  tile.dataset.k = k; // keep binding
  const canvas = tile.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const {unit, data} = await fetchHistory(k, period);
  if (!Array.isArray(data) || data.length === 0){
    const hint = tile.querySelector('.chart-hint');
    hint.textContent = 'No data';
    return;
  }
  tile.querySelector('.chart-hint').textContent = '';

  const w=canvas.width, h=canvas.height;
  const padL=50,padR=12,padT=8,padB=22;
  const plotW=w-padL-padR, plotH=h-padT-padB;

  const xs = data.map(d=>new Date(d.ts).getTime());
  const ys = data.map(d=>d.value);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const yR=(maxY-minY)||1;

  // axes
  ctx.lineWidth=1; ctx.beginPath();
  ctx.moveTo(padL,padT); ctx.lineTo(padL,h-padB); ctx.lineTo(w-padR,h-padB); ctx.stroke();

  // Y ticks
  ctx.font='12px system-ui';
  for(let i=0;i<=4;i++){
    const yv=minY+(yR*i/4);
    const y=h-padB-(plotH*i/4);
    ctx.fillText(yv.toFixed(2),6,y+4);
    ctx.globalAlpha=.12; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke(); ctx.globalAlpha=1;
  }

  // line
  ctx.beginPath();
  data.forEach((d,i)=>{
    const x = padL + ((new Date(d.ts).getTime()-minX)/(maxX-minX||1))*plotW;
    const y = h - padB - ((d.value-minY)/yR)*plotH;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // last marker
  const last=data[data.length-1];
  const lx=padL+((new Date(last.ts).getTime()-minX)/(maxX-minX||1))*plotW;
  const ly=h-padB-((last.value-minY)/yR)*plotH;
  ctx.beginPath(); ctx.arc(lx,ly,3,0,Math.PI*2); ctx.fill();
  ctx.fillText(`${last.value.toFixed(2)} ${unit||''}`, lx+6, ly-6);

  tile.querySelector('.chart-title').textContent = `${k} (${period})`;
}

// Auto-redraw charts on new data for their bound key
function refreshChartsForKey(k){
  document.querySelectorAll('.tile.chart').forEach(tile=>{
    if (tile.dataset.k !== k) return;
    const activeBtn = tile.querySelector('.periods button.active');
    const p = activeBtn ? activeBtn.dataset.p : '1h';
    drawChartInto(tile, k, p).catch(console.error);
  });
}

/* === WS === */
function connectWS(){
  const url = (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
  ws = new WebSocket(url);
  conn.textContent='connecting…';
  ws.onopen    = ()=> { conn.textContent='live'; if (!bootstrappedOnce) bootstrapLatest(); };
  ws.onclose   = ()=>{ conn.textContent='disconnected'; scheduleReconnect(); };
  ws.onerror   = ()=>{ conn.textContent='error'; try{ws.close();}catch{} };
  ws.onmessage = (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type==='snapshot'){
        bootstrappedOnce = true;
        msg.data.forEach(o=>{ const k=key(o); store.set(k,o); lastSeen.set(k, Date.now()); if(!mutedUntilNextUpdate.has(k)) render(o);});
        if (allowAutoSort) sortTiles();
      } else if (msg.type==='update'){
        const o = msg.data; const k = key(o);
        store.set(k,o); lastSeen.set(k, Date.now()); render(o);
        if (allowAutoSort) sortTiles();
        refreshChartsForKey(k);
      }
    }catch(e){ console.error('WS JSON error', e); }
  };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer=setTimeout(()=>{reconnectTimer=null; connectWS();},4000); }

// HTTP bootstrap fallback (in case WS snapshot didn’t arrive yet)
async function bootstrapLatest(){
  try{
    const r = await fetch('/latest');
    if (!r.ok) return;
    const arr = await r.json();
    if (Array.isArray(arr)){
      arr.forEach(o=>{ const k=key(o); store.set(k,o); lastSeen.set(k, Date.now()); if(!mutedUntilNextUpdate.has(k)) render(o);});
      if (allowAutoSort) sortTiles();
    }
  }catch(_){ /* ignore */ }
}

/* === sorting === */
function sortTiles(){ Array.from(grid.children).sort((a,b)=>{
  if (a.dataset.type!==b.dataset.type) return a.dataset.type==='chart' ? -1 : 1;
  const ka=a.dataset.k||'', kb=b.dataset.k||''; return ka.localeCompare(kb);
}).forEach(t=>grid.appendChild(t)); }
setInterval(()=>{ if (allowAutoSort) sortTiles(); }, 30000);

/* === drag + drop (tiles + zones) === */
function makeTileDraggable(el){
  el.setAttribute('draggable','true');
  el.addEventListener('dragstart', onTileDragStart);
  el.addEventListener('dragend', onTileDragEnd);
}

function onTileDragStart(e){
  draggedTile=e.currentTarget; allowAutoSort=false; draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k||'');
  document.querySelector('.float-zones').style.transform='translateY(0)';
}
function onTileDragEnd(){
  if(!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile=null; document.querySelector('.float-zones').style.transform='';
}

// Re-order inside grid
grid.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault();
  const others=[...grid.querySelectorAll('.tile:not(.dragging)')]; if(!others.length) return;
  let closest=null, mind=Infinity;
  for(const t of others){ const r=t.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2; const d=Math.hypot(e.clientX-cx,e.clientY-cy); if(d<mind){mind=d;closest=t;} }
  if(closest && closest!==draggedTile){ grid.insertBefore(draggedTile, closest); }
});

// Trash drop (delete any tile type)
trash.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); trash.classList.add('over'); });
trash.addEventListener('dragleave', ()=>trash.classList.remove('over'));
trash.addEventListener('drop', e=>{
  e.preventDefault(); trash.classList.remove('over');
  if(!draggedTile) return;
  const k = draggedTile.dataset.k;
  if (draggedTile.dataset.type === 'metric'){
    mutedUntilNextUpdate.add(k);
    draggedTile.remove();
  } else if (draggedTile.dataset.type === 'chart'){
    draggedTile.remove();
  }
  draggedTile=null;
});

// Create-graph drop (make or focus a chart for dropped metric)
createGraphBtn.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); createGraphBtn.classList.add('over'); });
createGraphBtn.addEventListener('dragleave', ()=>createGraphBtn.classList.remove('over'));
createGraphBtn.addEventListener('drop', e=>{
  e.preventDefault(); createGraphBtn.classList.remove('over');
  if(!draggedTile) return;
  const k = draggedTile.dataset.k;
  if (draggedTile.dataset.type === 'metric'){
    createChartTile(k, '1h');
  }
  draggedTile=null;
});

/* === start === */
connectWS();
bootstrapLatest(); // in case WS snapshot is delayed
```js
/* === globals === */
const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const store = new Map();                 // key -> last payload
const lastSeen = new Map();              // key -> Date.now() of last WS message
const mutedUntilNextUpdate = new Set();

const createGraphBtn = document.getElementById('create-graph');
const trash = document.getElementById('trash');

let ws, reconnectTimer = null;
let draggedTile = null;
let allowAutoSort = true;

/* === helpers === */
function key(o){ return `${o.node}/${o.cluster}/${o.sensor || 'state'}`; }
function formatValue(v){ return (v===undefined||v===null||v==='') ? '—' : (typeof v==='number'? v.toFixed(2): String(v)); }
function ageMinutesFromSeen(k){ const t=lastSeen.get(k); return t? (Date.now()-t)/60000 : Infinity; }

/* === tiles === */
function ensureTile(o){
  const k = key(o);
  let el = document.querySelector(`[data-k="${CSS.escape(k)}"][data-type="metric"]`);
  if(!el){
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.dataset.type = 'metric';
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta node"></div>
      <div class="value"><span class="num">—</span><span class="unit"></span></div>
      <div class="meta ts"></div>`;
    makeTileDraggable(el);
    grid.appendChild(el);
    requestAnimationFrame(()=>el.classList.remove('opacity-0'));
  }
  return el;
}
function paintDot(el){
  const k = el.dataset.k;
  const m = ageMinutesFromSeen(k);
  let color = '#bbb';
  if (m < 3) color = '#2ecc71'; else if (m >= 60) color = '#e74c3c'; else color = '#f1c40f';
  const d = el.querySelector('.dot');
  if (d) d.style.background = color;
}
function render(o){
  const k = key(o);
  if (mutedUntilNextUpdate.has(k)) mutedUntilNextUpdate.delete(k);
  const el = ensureTile(o);
  el.style.display = '';
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent  = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent   = o.ts || '';
  paintDot(el);
}
setInterval(()=>{ document.querySelectorAll('.tile').forEach(paintDot); }, 30000);

/* === chart tile === */
function chartTileIdForKey(k){ return `chart__${k}`; }

function createChartTile(k, period='1h'){
  // If a chart tile for this key already exists, just focus/redraw it
  let existing = document.getElementById(chartTileIdForKey(k));
  if (existing){
    existing.querySelectorAll('.periods button').forEach(b=>{
      b.classList.toggle('active', b.dataset.p === period);
    });
    drawChartInto(existing, k, period);
    grid.insertBefore(existing, grid.firstChild); // surface it slightly
    return existing;
  }

  const tile = document.createElement('div');
  tile.className = 'tile chart opacity-0';
  tile.id = chartTileIdForKey(k);
  tile.dataset.type = 'chart';
  tile.dataset.k = k;
  tile.innerHTML = `
    <div class="chart-head">
      <div class="chart-title">${k}</div>
      <div class="periods" role="group" aria-label="Chart period">
        <button data-p="1h" class="active">1h</button>
        <button data-p="1d">1d</button>
        <button data-p="max">max</button>
      </div>
    </div>
    <div class="chart-body">
      <canvas width="1200" height="240"></canvas>
      <div class="chart-hint">Drag metrics anywhere; drop a metric tile on 📈 to make charts</div>
    </div>`;

  makeTileDraggable(tile);
  grid.appendChild(tile);
  requestAnimationFrame(()=>tile.classList.remove('opacity-0'));

  // Period clicks (delegated per tile)
  tile.querySelector('.periods').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if (!btn) return;
    const p = btn.dataset.p;
    tile.querySelectorAll('.periods button').forEach(b=>b.classList.toggle('active', b===btn));
    drawChartInto(tile, k, p);
  });

  drawChartInto(tile, k, period);
  return tile;
}

async function fetchHistory(k, period){
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

async function drawChartInto(tile, k, period){
  tile.dataset.k = k; // keep binding
  const canvas = tile.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const {unit, data} = await fetchHistory(k, period);
  if (!Array.isArray(data) || data.length === 0){
    const hint = tile.querySelector('.chart-hint');
    hint.textContent = 'No data';
    return;
  }
  tile.querySelector('.chart-hint').textContent = '';

  const w=canvas.width, h=canvas.height;
  const padL=50,padR=12,padT=8,padB=22;
  const plotW=w-padL-padR, plotH=h-padT-padB;

  const xs = data.map(d=>new Date(d.ts).getTime());
  const ys = data.map(d=>d.value);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const yR=(maxY-minY)||1;

  // axes
  ctx.lineWidth=1; ctx.beginPath();
  ctx.moveTo(padL,padT); ctx.lineTo(padL,h-padB); ctx.lineTo(w-padR,h-padB); ctx.stroke();

  // Y ticks
  ctx.font='12px system-ui';
  for(let i=0;i<=4;i++){
    const yv=minY+(yR*i/4);
    const y=h-padB-(plotH*i/4);
    ctx.fillText(yv.toFixed(2),6,y+4);
    ctx.globalAlpha=.12; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke(); ctx.globalAlpha=1;
  }

  // line
  ctx.beginPath();
  data.forEach((d,i)=>{
    const x = padL + ((new Date(d.ts).getTime()-minX)/(maxX-minX||1))*plotW;
    const y = h - padB - ((d.value-minY)/yR)*plotH;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  // last marker
  const last=data[data.length-1];
  const lx=padL+((new Date(last.ts).getTime()-minX)/(maxX-minX||1))*plotW;
  const ly=h-padB-((last.value-minY)/yR)*plotH;
  ctx.beginPath(); ctx.arc(lx,ly,3,0,Math.PI*2); ctx.fill();
  ctx.fillText(`${last.value.toFixed(2)} ${unit||''}`, lx+6, ly-6);

  tile.querySelector('.chart-title').textContent = `${k} (${period})`;
}

// Auto-redraw charts on new data for their bound key
function refreshChartsForKey(k){
  document.querySelectorAll('.tile.chart').forEach(tile=>{
    if (tile.dataset.k !== k) return;
    const activeBtn = tile.querySelector('.periods button.active');
    const p = activeBtn ? activeBtn.dataset.p : '1h';
    drawChartInto(tile, k, p).catch(console.error);
  });
}

/* === WS === */
function connectWS(){
  const url = (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws';
  ws = new WebSocket(url);
  conn.textContent='connecting…';
  ws.onopen    = ()=> conn.textContent='live';
  ws.onclose   = ()=>{ conn.textContent='disconnected'; scheduleReconnect(); };
  ws.onerror   = ()=>{ conn.textContent='error'; try{ws.close();}catch{} };
  ws.onmessage = (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type==='snapshot'){
        msg.data.forEach(o=>{ const k=key(o); store.set(k,o); lastSeen.set(k, Date.now()); if(!mutedUntilNextUpdate.has(k)) render(o);});
        if (allowAutoSort) sortTiles();
      } else if (msg.type==='update'){
        const o = msg.data; const k = key(o);
        store.set(k,o); lastSeen.set(k, Date.now()); render(o);
        if (allowAutoSort) sortTiles();
        refreshChartsForKey(k);
      }
    }catch(e){ console.error('WS JSON error', e); }
  };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer=setTimeout(()=>{reconnectTimer=null; connectWS();},4000); }

/* === sorting === */
function sortTiles(){ Array.from(grid.children).sort((a,b)=>{
  // Keep charts first among equals by type (optional aesthetic)
  if (a.dataset.type!==b.dataset.type) return a.dataset.type==='chart' ? -1 : 1;
  const ka=a.dataset.k||'', kb=b.dataset.k||''; return ka.localeCompare(kb);
}).forEach(t=>grid.appendChild(t)); }
setInterval(()=>{ if (allowAutoSort) sortTiles(); }, 30000);

/* === drag + drop (tiles + zones) === */
function makeTileDraggable(el){
  el.setAttribute('draggable','true');
  el.addEventListener('dragstart', onTileDragStart);
  el.addEventListener('dragend', onTileDragEnd);
}

function onTileDragStart(e){
  draggedTile=e.currentTarget; allowAutoSort=false; draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k||'');
  document.querySelector('.float-zones').style.transform='translateY(0)';
}
function onTileDragEnd(){
  if(!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile=null; document.querySelector('.float-zones').style.transform='';
}

// Re-order inside grid
grid.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault();
  const others=[...grid.querySelectorAll('.tile:not(.dragging)')]; if(!others.length) return;
  let closest=null, mind=Infinity;
  for(const t of others){ const r=t.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2; const d=Math.hypot(e.clientX-cx,e.clientY-cy); if(d<mind){mind=d;closest=t;} }
  if(closest && closest!==draggedTile){ grid.insertBefore(draggedTile, closest); }
});

// Trash drop (delete any tile type)
trash.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); trash.classList.add('over'); });
trash.addEventListener('dragleave', ()=>trash.classList.remove('over'));
trash.addEventListener('drop', e=>{
  e.preventDefault(); trash.classList.remove('over');
  if(!draggedTile) return;
  const k = draggedTile.dataset.k;
  if (draggedTile.dataset.type === 'metric'){
    mutedUntilNextUpdate.add(k);
    draggedTile.remove();
  } else if (draggedTile.dataset.type === 'chart'){
    draggedTile.remove();
  }
  draggedTile=null;
});

// Create-graph drop (make or focus a chart for dropped metric)
createGraphBtn.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); createGraphBtn.classList.add('over'); });
createGraphBtn.addEventListener('dragleave', ()=>createGraphBtn.classList.remove('over'));
createGraphBtn.addEventListener('drop', e=>{
  e.preventDefault(); createGraphBtn.classList.remove('over');
  if(!draggedTile) return;
  const k = draggedTile.dataset.k;
  if (draggedTile.dataset.type === 'metric'){
    createChartTile(k, '1h');
  }
  draggedTile=null;
});

/* === start === */
connectWS();
