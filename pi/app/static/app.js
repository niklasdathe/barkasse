/* === globals === */
const grid = document.getElementById('grid');
const conn = document.getElementById('conn');

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

/* === Graph tiles (multi-instance) === */
class GraphTile {
  constructor(key=null, period='1h'){
    this.period = period;
    this.key = key;

    this.el = document.createElement('div');
    this.el.className = 'tile graph-tile';
    this.el.dataset.graph = 'true';
    this.el.setAttribute('draggable','true');
    this.el.innerHTML = `
      <div class="graph-header">
        <div class="chart-title">—</div>
        <div class="periods" role="group" aria-label="Chart period">
          <button data-p="1h">1h</button>
          <button data-p="1d">1d</button>
          <button data-p="max">max</button>
        </div>
      </div>
      <div class="graph-body" aria-label="History chart drop target">
        <canvas class="chart"></canvas>
        <div class="chart-hint">${DEFAULT_CHART_HINT}</div>
      </div>
    `;
    grid.appendChild(this.el);

    this.title = this.el.querySelector('.chart-title');
    this.canvas = this.el.querySelector('.chart');
    this.hint = this.el.querySelector('.chart-hint');
    this.buttons = Array.from(this.el.querySelectorAll('.periods button'));

    this.el.addEventListener('dragstart', onTileDragStart);
    this.el.addEventListener('dragend', onTileDragEnd);
    this.el.addEventListener('dragover', e => this.onDragOver(e));
    this.el.addEventListener('dragleave', e => this.onDragLeave(e));
    this.el.addEventListener('drop', e => this.onDrop(e));
    this.buttons.forEach(b => b.addEventListener('click', e => this.onPeriodClick(e)));

    this.syncButtons();
    this.reset();

    /* === NEW: make canvas pixel size match the fixed tile size (crisp) === */
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvasToTile());
    this.resizeObserver.observe(this.el);

    if (this.key) this.draw();
  }

  destroy(){
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.el.removeEventListener('dragstart', onTileDragStart);
    this.el.removeEventListener('dragend', onTileDragEnd);
    this.el.remove();
  }

  /* === NEW === */
  resizeCanvasToTile(){
    const body = this.el.querySelector('.graph-body');
    if (!body) return;
    const cssW = Math.max(1, Math.floor(body.clientWidth));
    const cssH = Math.max(1, Math.floor(body.clientHeight - (this.hint?.offsetHeight || 0)));
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    // set internal pixel buffer size to avoid blur
    this.canvas.width  = cssW * dpr;
    this.canvas.height = cssH * dpr;

    // keep CSS size logical
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    // scale the context so drawing code can stay in CSS pixels
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // redraw if data present
    if (this.key) this.draw();
  }

  syncButtons(){
    this.buttons.forEach(btn=>{
      if(btn.dataset.p === this.period) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  onPeriodClick(e){
    e.preventDefault();
    this.period = e.currentTarget.dataset.p;
    this.syncButtons();
    if (this.key) this.draw();
  }
  onDragOver(e){ if(!draggedTile || !draggedTile.dataset.k) return; e.preventDefault(); this.el.classList.add('chart-over'); }
  onDragLeave(e){ const rel = e.relatedTarget; if (!rel || !this.el.contains(rel)) this.el.classList.remove('chart-over'); }
  async onDrop(e){
    if(!draggedTile || !draggedTile.dataset.k) return;
    e.preventDefault();
    this.el.classList.remove('chart-over');
    this.key = draggedTile.dataset.k;
    await this.draw();
  }

  reset(){
    this.title.textContent = '—';
    this.hint.textContent = DEFAULT_CHART_HINT;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
  }

  async draw(){
    if(!this.key) return;
    this.title.textContent = `${this.key} (${this.period})`;
    this.syncButtons();

    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);

    let unit, data;
    try { ({unit, data} = await fetchHistory(this.key, this.period)); }
    catch { this.hint.textContent = 'Failed to load data'; return; }
    if (!Array.isArray(data) || data.length === 0){ this.hint.textContent = 'No data'; return; }
    this.hint.textContent = '';

    // use CSS pixel size (post-transform) by reading the styled size
    const w = parseFloat(this.canvas.style.width)  || this.canvas.width;
    const h = parseFloat(this.canvas.style.height) || this.canvas.height;

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
}


const graphTiles = new Set();  // hold all GraphTile instances

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
        // refresh any graphs showing this key
        graphTiles.forEach(gt => { if (gt.key === k) gt.draw(); });
      }
    }catch(e){ console.error('WS JSON error', e); }
  };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer=setTimeout(()=>{reconnectTimer=null; connectWS();},4000); }

/* === sorting === */
function sortTiles(){ Array.from(grid.children).sort((a,b)=>{
  // keep graphs roughly grouped by insertion order while sorting sensors by key
  const ga = a.dataset.graph === 'true', gb = b.dataset.graph === 'true';
  if (ga && !gb) return -1;
  if (!ga && gb) return 1;
  if (!ga && !gb) return (a.dataset.k||'').localeCompare(b.dataset.k||'');
  return 0;
}).forEach(t=>grid.appendChild(t)); }
setInterval(()=>{ if (allowAutoSort) sortTiles(); }, 30000);

/* === drag: tiles / dropzones === */
function showDropTargets(){
  trash.classList.add('show');
  graphCreate.classList.add('show');
}
function hideDropTargets(){
  trash.classList.remove('show', 'over');
  graphCreate.classList.remove('show', 'over');
  document.querySelectorAll('.graph-tile').forEach(t=>t.classList.remove('chart-over'));
}

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
      // remove that specific graph
      const inst = [...graphTiles].find(gt => gt.el === tile);
      if (inst){ graphTiles.delete(inst); inst.destroy(); }
      tile.classList.remove('dragging');
    } else if (tile.dataset.k){
      const k = tile.dataset.k;
      mutedUntilNextUpdate.add(k);
      tile.style.display='none';
      tile.classList.remove('dragging');
      // also clear any graphs showing this key
      graphTiles.forEach(gt => { if (gt.key === k){ gt.key=null; gt.reset(); } });
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
  const k = draggedTile.dataset.k;
  const inst = new GraphTile(k, '1h');
  graphTiles.add(inst);
  draggedTile.classList.remove('dragging');
  draggedTile=null;
  hideDropTargets();
});

/* === history fetching === */
async function fetchHistory(k, period){
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

/* === start === */
connectWS();

// If your HTML ships an initial (single) graph-tile, upgrade it to a class instance:
const initialGraph = document.querySelector('.graph-tile[data-bootstrap="true"]');
if (initialGraph){
  // replace placeholder with a managed instance (no key bound yet)
  initialGraph.remove();
  const inst = new GraphTile(null, '1h');
  graphTiles.add(inst);
}
