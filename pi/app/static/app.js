/* === globals === */


const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const initialGraphTiles = Array.from(document.querySelectorAll('.graph-tile[data-graph="true"]'));
const graphStates = new Map();
const DEFAULT_CHART_PERIOD = '1h';

const trash = document.getElementById('trash');
const graphCreate = document.getElementById('graph-create');
const DEFAULT_CHART_HINT = 'Drag a tile here to view its history';

const store = new Map();                 // key -> last payload
const lastSeen = new Map();              // key -> Date.now() of last WS message
const mutedUntilNextUpdate = new Set();

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
  let el = document.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if(!el){
    el = document.createElement('div');
    el.className = 'tile opacity-0';
    el.dataset.k = k;
    el.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <h3>${o.cluster} / ${o.sensor}</h3>
      <div class="meta node"></div>
      <div class="value"><span class="num">—</span><span class="unit"></span></div>
      <div class="meta ts"></div>`;
    el.setAttribute('draggable','true');



    grid.appendChild(el);
    requestAnimationFrame(()=>el.classList.remove('opacity-0'));
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);
  }
  return el;
}
function paintDot(el){
  if (!el.dataset.k) return;
  const k = el.dataset.k;
  const m = ageMinutesFromSeen(k);
  let color = '#bbb';
  if (m < 3) color = '#2ecc71'; else if (m >= 60) color = '#e74c3c'; else color = '#f1c40f';
  el.querySelector('.dot').style.background = color;
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
setInterval(()=>{ document.querySelectorAll('.tile[data-k]').forEach(paintDot); }, 30000);

/* === graph tile === */
function syncPeriodButtons(state){
  state.periodButtons.forEach(btn=>{
    if(btn.dataset.p === state.currentPeriod) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

function handlePeriodClick(e, state){
  e.preventDefault();
  const btn = e.currentTarget;
  state.currentPeriod = btn.dataset.p;
  syncPeriodButtons(state);
  if (state.currentKey) drawChartFor(state, state.currentKey, state.currentPeriod).catch(err=>console.error('Chart period error', err));
}

function resetGraphDisplay(state){
  state.currentKey = null;
  if (state.title) state.title.textContent = '—';
  if (state.hint) state.hint.textContent = DEFAULT_CHART_HINT;
  if (state.canvas){
    const ctx = state.canvas.getContext('2d');
    ctx.clearRect(0,0,state.canvas.width,state.canvas.height);
  }
}

function onGraphTileDragOver(e){
  if (!draggedTile || draggedTile === e.currentTarget) return;
  if (!draggedTile.dataset.k) return;
  e.preventDefault();
  e.currentTarget.classList.add('chart-over');
}

function onGraphTileDragLeave(e){
  const tile = e.currentTarget;
  const rel = e.relatedTarget;
  if (!rel || !tile.contains(rel)) tile.classList.remove('chart-over');
}

async function onGraphTileDrop(e, state){
  if (!draggedTile || draggedTile === e.currentTarget) return;
  if (!draggedTile.dataset.k) return;
  e.preventDefault();
  e.currentTarget.classList.remove('chart-over');
  try {
    await drawChartFor(state, draggedTile.dataset.k, state.currentPeriod);
  } catch (err) {
    console.error('Chart draw error', err);
  }
}

function setupGraphTile(tile){
  const state = {
    tile,
    canvas: tile.querySelector('.chart'),
    title: tile.querySelector('.chart-title'),
    hint: tile.querySelector('.chart-hint'),
    periodButtons: Array.from(tile.querySelectorAll('.periods button')),
    currentKey: null,
    currentPeriod: DEFAULT_CHART_PERIOD,
  };
  state.handlePeriodClick = (e)=>handlePeriodClick(e, state);
  state.handleDrop = (e)=>onGraphTileDrop(e, state);
  tile.dataset.graph = 'true';
  tile.setAttribute('draggable','true');
  tile.addEventListener('dragstart', onTileDragStart);
  tile.addEventListener('dragend', onTileDragEnd);
  tile.addEventListener('dragover', onGraphTileDragOver);
  tile.addEventListener('dragleave', onGraphTileDragLeave);
  tile.addEventListener('drop', state.handleDrop);
  state.periodButtons.forEach(btn=>btn.addEventListener('click', state.handlePeriodClick));
  graphStates.set(tile, state);
  syncPeriodButtons(state);
  resetGraphDisplay(state);
  return state;
}

function destroyGraphTile(tile){
  const state = graphStates.get(tile);
  if (!state) return;
  tile.removeEventListener('dragstart', onTileDragStart);
  tile.removeEventListener('dragend', onTileDragEnd);
  tile.removeEventListener('dragover', onGraphTileDragOver);
  tile.removeEventListener('dragleave', onGraphTileDragLeave);
  tile.removeEventListener('drop', state.handleDrop);
  state.periodButtons.forEach(btn=>btn.removeEventListener('click', state.handlePeriodClick));
  graphStates.delete(tile);
  tile.remove();
}

function createGraphTile(){
  const tile = document.createElement('div');
  tile.className = 'tile graph-tile';
  tile.innerHTML = `
        <div class="graph-header">
          <div class="chart-title">—</div>
          <div class="periods" role="group" aria-label="Chart period">
            <button data-p="1h">1h</button>
            <button data-p="1d">1d</button>
            <button data-p="max">max</button>
          </div>
        </div>
        <div class="graph-body" aria-label="History chart drop target">
          <canvas class="chart" width="1200" height="260"></canvas>
          <div class="chart-hint">${DEFAULT_CHART_HINT}</div>
        </div>`;
  grid.appendChild(tile);
  return setupGraphTile(tile);
}

function showDropTargets(){
  trash.classList.add('show');
  graphCreate.classList.add('show');
}

function hideDropTargets(){
  trash.classList.remove('show', 'over');
  graphCreate.classList.remove('show', 'over');
  graphStates.forEach(({tile})=>tile.classList.remove('chart-over'));
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
        graphStates.forEach(state=>{
          if (state.currentKey === k) drawChartFor(state, state.currentKey, state.currentPeriod).catch(err=>console.error('Chart update error', err));
        });
      }
    }catch(e){ console.error('WS JSON error', e); }
  };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer=setTimeout(()=>{reconnectTimer=null; connectWS();},4000); }

/* === sorting === */
function sortTiles(){
  const tiles = Array.from(grid.children);
  tiles.sort((a,b)=>{
    const ag = a.dataset.graph === 'true';
    const bg = b.dataset.graph === 'true';
    if (ag && !bg) return 1;
    if (!ag && bg) return -1;
    const ak = a.dataset.k || '';
    const bk = b.dataset.k || '';
    return ak.localeCompare(bk);
  }).forEach(t=>grid.appendChild(t));
}
setInterval(()=>{ if (allowAutoSort) sortTiles(); }, 30000);

/* === drag: tiles / dropzones === */
function onTileDragStart(e){
  draggedTile=e.currentTarget;
  allowAutoSort=false;
  draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k||'');
  showDropTargets();
}
function onTileDragEnd(){
  if(!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile=null;
  hideDropTargets();
}
grid.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault();
  const others=[...grid.querySelectorAll('.tile:not(.dragging)')]; if(!others.length) return;
  let closest=null, mind=Infinity;
  for(const t of others){ const r=t.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2; const d=Math.hypot(e.clientX-cx,e.clientY-cy); if(d<mind){mind=d;closest=t;} }
  if(closest && closest!==draggedTile){ grid.insertBefore(draggedTile, closest); }
});
trash.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); trash.classList.add('over'); });
trash.addEventListener('dragleave', ()=>trash.classList.remove('over'));
trash.addEventListener('drop', e=>{
  e.preventDefault();
  trash.classList.remove('over');
  if(!draggedTile) return;
  const tile = draggedTile;
  try {
    if (tile.dataset.graph === 'true'){
      tile.classList.remove('dragging');
      destroyGraphTile(tile);
    } else if (tile.dataset.k){
      const k = tile.dataset.k;
      mutedUntilNextUpdate.add(k);
      graphStates.forEach(state=>{
        if (state.currentKey === k) resetGraphDisplay(state);
      });
      tile.style.display='none';
      tile.classList.remove('dragging');
    }
  } finally {
    draggedTile=null;
    hideDropTargets();
  }
});
graphCreate.addEventListener('dragover', e=>{
  if(!draggedTile || !draggedTile.dataset.k) return;
  e.preventDefault();
  graphCreate.classList.add('over');
});
graphCreate.addEventListener('dragleave', ()=>graphCreate.classList.remove('over'));
graphCreate.addEventListener('drop', async e=>{
  if(!draggedTile || !draggedTile.dataset.k) return;
  e.preventDefault();
  graphCreate.classList.remove('over');
  const key = draggedTile.dataset.k;
  const tile = draggedTile;
  try {
    const state = createGraphTile();
    try {
      await drawChartFor(state, key, state.currentPeriod);
    } catch (err) {
      console.error('Chart create error', err);
    }
  } finally {
    tile.classList.remove('dragging');
    draggedTile=null;
    hideDropTargets();
  }
});

async function fetchHistory(k, period){
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

async function drawChartFor(state, k, period){
  if (!state || !state.canvas) return;
  state.currentKey = k;
  state.currentPeriod = period;
  if (state.title) state.title.textContent = `${k} (${period})`;
  syncPeriodButtons(state);

  const ctx = state.canvas.getContext('2d');
  ctx.clearRect(0,0,state.canvas.width,state.canvas.height);

  let unit, data;
  try {
    ({unit, data} = await fetchHistory(k, period));
  } catch (err) {
    if (state.hint) state.hint.textContent = 'Failed to load data';
    throw err;
  }
  if (!Array.isArray(data) || data.length === 0){
    if (state.hint) state.hint.textContent = 'No data';
    return;
  }

  if (state.hint) state.hint.textContent = '';

  const w=state.canvas.width, h=state.canvas.height;
  const padL=50,padR=12,padT=12,padB=24;
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
}

/* === start === */
initialGraphTiles.forEach(setupGraphTile);
connectWS();
