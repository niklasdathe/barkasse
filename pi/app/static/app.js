/* === globals === */
const grid = document.getElementById('grid');
const conn = document.getElementById('conn');
const store = new Map(); // key -> last payload
const lastSeen = new Map(); // key -> Date.now() of last WS message
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
el.querySelector('.num').textContent = formatValue(o.value);
el.querySelector('.unit').textContent = o.unit || '';
el.querySelector('.ts').textContent = o.ts || '';
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
connectWS();
