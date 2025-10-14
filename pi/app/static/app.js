/* === globals === */
const topics = document.getElementById('topics');  // horizontal scroller for topic tiles
const conn = document.getElementById('conn');

const trash = document.getElementById('trash');
const DEFAULT_CHART_HINT = 'Drag a tile here to view its history';

const store = new Map();                 // key -> last payload
const lastSeen = new Map();              // key -> Date.now() of last WS message
const mutedUntilNextUpdate = new Set();

let ws, reconnectTimer = null;
let draggedTile = null;

/* === helpers === */
function key(o){ return `${o.node}/${o.cluster}/${o.sensor || 'state'}`; }
function formatValue(v){ return (v===undefined||v===null||v==='') ? '—' : (typeof v==='number'? v.toFixed(2): String(v)); }
function ageMinutesFromSeen(k){ const t=lastSeen.get(k); return t? (Date.now()-t)/60000 : Infinity; }

/* === topic tiles (horizontal list) === */
function ensureTile(o){
  const k = key(o);
  let el = topics.querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (!el) {
    // --- create tile
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

    // --- append + fade in
    topics.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('opacity-0'));

    // --- touch vs mouse: default drag for mouse, long-press for touch
    const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!isCoarse) {
      // Mouse/precision pointer: regular drag
      el.setAttribute('draggable', 'true');
    }

    // --- common handlers
    el.addEventListener('dragstart', onTileDragStart);
    el.addEventListener('dragend', onTileDragEnd);

    // Avoid native image drag ghosts inside the tile
    el.addEventListener('mousedown', (e) => {
      if (e.target && e.target.tagName === 'IMG') e.preventDefault();
    });

    // --- Touch-friendly drag: enable only after long-press (~400 ms)
    if (isCoarse) {
      let lpTimer = null;

      const enableDrag = () => {
        el.setAttribute('draggable', 'true');
        el.classList.add('drag-ready');  // optional styling hook
      };
      const disableDrag = () => {
        el.removeAttribute('draggable');
        el.classList.remove('drag-ready');
      };

      el.addEventListener('touchstart', () => {
        // start long-press timer; scrolling cancels it
        lpTimer = setTimeout(enableDrag, 400);
      }, { passive: true });

      el.addEventListener('touchmove', () => {
        // user is scrolling -> cancel drag activation
        clearTimeout(lpTimer);
      }, { passive: true });

      el.addEventListener('touchend', () => {
        clearTimeout(lpTimer);
        // if a drag did not actually happen, turn drag back off shortly after
        setTimeout(() => {
          if (!el.classList.contains('dragging')) disableDrag();
        }, 50);
      }, { passive: true });

      // After any drag completes, disable again so scrolling stays silky
      el.addEventListener('dragend', () => {
        disableDrag();
      });
    }
  }

  // --- update tile content
  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent  = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent   = o.ts || '';

  return el;
}

function paintDot(el){
  const k = el.dataset.k; if(!k) return;
  const m = ageMinutesFromSeen(k);
  let color = '#bbb';
  if (m < 3) color = '#2ecc71'; else if (m >= 60) color = '#e74c3c'; else color = '#f1c40f';
  el.querySelector('.dot').style.background = color;
}
function render(o){
  const k = key(o);
  if (mutedUntilNextUpdate.has(k)) mutedUntilNextUpdate.delete(k);
  const el = ensureTile(o);
  el.style.display = ''; // ensure visible

  el.querySelector('.node').textContent = o.node || '';
  el.querySelector('.num').textContent  = formatValue(o.value);
  el.querySelector('.unit').textContent = o.unit || '';
  el.querySelector('.ts').textContent   = o.ts || '';
  paintDot(el);
}
setInterval(()=>{ topics.querySelectorAll('.tile[data-k]').forEach(paintDot); }, 30000);

/* === sort by node/cluster/sensor === */
function sortTiles(){
  const arr = Array.from(topics.children).filter(el => el.classList.contains('tile') && el.dataset.k);
  arr.sort((a,b)=> (a.dataset.k||'').localeCompare(b.dataset.k||'')); // alphabetical by "node/cluster/sensor"
  arr.forEach(el => topics.appendChild(el));
}

/* === TWO fixed graph tiles (NOT draggable) === */
class GraphTile {
  constructor(rootEl, key=null, period='1h'){
    this.el = rootEl;
    this.period = period;
    this.key = key;

    this.title = this.el.querySelector('.chart-title');
    this.canvas = this.el.querySelector('canvas.chart');
    this.hint = this.el.querySelector('.chart-hint');
    this.buttons = Array.from(this.el.querySelectorAll('.periods button'));

    // Make sure graph tiles are NOT draggable
    this.el.removeAttribute('draggable');

    // Accept drops from topic tiles
    this.el.addEventListener('dragover', e => this.onDragOver(e));
    this.el.addEventListener('dragleave', e => this.onDragLeave(e));
    this.el.addEventListener('drop', e => this.onDrop(e));

    this.buttons.forEach(b => b.addEventListener('click', e => this.onPeriodClick(e)));
    this.syncButtons();
    this.reset();

    // crisp canvas sizing
    this.resizeObserver = new ResizeObserver(()=>this.resizeCanvas());
    this.resizeObserver.observe(this.el);

    if (this.key) this.draw();
  }
  destroy(){ if(this.resizeObserver) this.resizeObserver.disconnect(); }

  syncButtons(){ this.buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.p === this.period)); }
  onPeriodClick(e){ e.preventDefault(); this.period = e.currentTarget.dataset.p; this.syncButtons(); if(this.key) this.draw(); }

  onDragOver(e){
    if(!draggedTile || !draggedTile.dataset.k) return;
    e.preventDefault();
    this.el.classList.add('chart-over');
  }
  onDragLeave(e){
    const rel = e.relatedTarget;
    if (!rel || !this.el.contains(rel)) this.el.classList.remove('chart-over');
  }
  async onDrop(e){
    if(!draggedTile || !draggedTile.dataset.k) return;
    e.preventDefault();
    this.el.classList.remove('chart-over');
    this.key = draggedTile.dataset.k;
    await this.draw();
  }

  reset(){
    if (this.title) this.title.textContent = '—';
    if (this.hint)  this.hint.textContent  = DEFAULT_CHART_HINT;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
  }

  resizeCanvas(){
    const body = this.el.querySelector('.graph-body');
    if(!body) return;
    const cssW = Math.max(1, Math.floor(body.clientWidth));
    const cssH = Math.max(1, Math.floor(body.clientHeight - (this.hint?.offsetHeight || 0)));
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    this.canvas.width  = cssW * dpr;
    this.canvas.height = cssH * dpr;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.key) this.draw();
  }

  async draw(){
    if(!this.key) return;
    if (this.title) this.title.textContent = `${this.key} (${this.period})`;
    this.syncButtons();

    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);

    let unit, data;
    try {
      ({unit, data} = await fetchHistory(this.key, this.period));
    } catch {
      if (this.hint) this.hint.textContent = 'Failed to load data';
      return;
    }
    if (!Array.isArray(data) || data.length === 0){
      if (this.hint) this.hint.textContent = 'No data';
      return;
    }
    if (this.hint) this.hint.textContent = '';

    const w = parseFloat(this.canvas.style.width)  || this.canvas.width;
    const h = parseFloat(this.canvas.style.height) || this.canvas.height;
    const padL=50,padR=12,padT=12,padB=24;
    const plotW=w-padL-padR, plotH=h-padT-padB;

    const xs = data.map(d=>new Date(d.ts).getTime());
    const ys = data.map(d=>d.value);
    const minX=Math.min(...xs), maxX=Math.max(...xs);
    const minY=Math.min(...ys), maxY=Math.max(...ys);
    const yR=(maxY-minY)||1;

    ctx.lineWidth=1; ctx.beginPath();
    ctx.moveTo(padL,padT); ctx.lineTo(padL,h-padB); ctx.lineTo(w-padR,h-padB); ctx.stroke();

    ctx.font='12px system-ui';
    for(let i=0;i<=4;i++){
      const yv=minY+(yR*i/4);
      const y=h-padB-(plotH*i/4);
      ctx.fillText(yv.toFixed(2),6,y+4);
      ctx.globalAlpha=.12; ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke(); ctx.globalAlpha=1;
    }

    ctx.beginPath();
    data.forEach((d,i)=>{
      const x = padL + ((new Date(d.ts).getTime()-minX)/(maxX-minX||1))*plotW;
      const y = h - padB - ((d.value-minY)/yR)*plotH;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();

    const last=data[data.length-1];
    const lx=padL+((new Date(last.ts).getTime()-minX)/(maxX-minX||1))*plotW;
    const ly=h-padB-((last.value-minY)/yR)*plotH;
    ctx.beginPath(); ctx.arc(lx,ly,3,0,Math.PI*2); ctx.fill();
    ctx.fillText(`${last.value.toFixed(2)} ${unit||''}`, lx+6, ly-6);
  }
}

/* instantiate exactly two graphs (fixed) */
const graph1 = new GraphTile(document.getElementById('graph-1'), null, '1h');
const graph2 = new GraphTile(document.getElementById('graph-2'), null, '1h');
const graphs = [graph1, graph2];

/* === drag/drop for topic tiles: only graphs + trash === */
function onTileDragStart(e){
  draggedTile = e.currentTarget;
  draggedTile.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain', draggedTile.dataset.k || '');
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
function onTileDragEnd(){
  if(!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile=null;
  hideTrash();
}

function showTrash(){ trash.classList.add('show'); }
function hideTrash(){ trash.classList.remove('show','over'); }
trash.addEventListener('dragover', e=>{ if(!draggedTile) return; e.preventDefault(); trash.classList.add('over'); });
trash.addEventListener('dragleave', ()=>trash.classList.remove('over'));
trash.addEventListener('drop', e=>{
  e.preventDefault();
  trash.classList.remove('over');
  if(!draggedTile || !draggedTile.dataset.k) return;
  const k = draggedTile.dataset.k;
  mutedUntilNextUpdate.add(k);
  draggedTile.style.display='none';
  draggedTile.classList.remove('dragging');
  draggedTile=null;
  hideTrash();
});

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
        sortTiles();
      } else if (msg.type==='update'){
        const o = msg.data; const k = key(o);
        store.set(k,o); lastSeen.set(k, Date.now()); render(o);
        sortTiles();
        // refresh any graphs showing this key
        graphs.forEach(gt => { if (gt.key === k) gt.draw(); });
      }
    }catch(e){ console.error('WS JSON error', e); }
  };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer=setTimeout(()=>{reconnectTimer=null; connectWS();},4000); }

/* === history fetching === */
async function fetchHistory(k, period){
  const r = await fetch(`/history?key=${encodeURIComponent(k)}&period=${encodeURIComponent(period)}`);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}

/* === init === */
connectWS();
