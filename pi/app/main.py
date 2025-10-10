from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from typing import Dict, Deque, List
from collections import deque
from datetime import datetime, timezone, timedelta
import asyncio, json
import paho.mqtt.client as mqtt

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# ---------------- Stores ----------------
LATEST: Dict[str, dict] = {}             # key -> last payload
HISTORY: Dict[str, Deque[dict]] = {}     # key -> deque of {"ts", "value", "unit"}
MAX_HISTORY_POINTS = 20000
KEEP_DAYS = 14

# WS clients + event queue (MQTT → loop)
CLIENTS = set()
EVENT_Q: asyncio.Queue = asyncio.Queue()

def key_from_payload(p: dict) -> str:
    node = p.get("node","?")
    cluster = p.get("cluster","?")
    sensor = p.get("sensor","state")
    return f"{node}/{cluster}/{sensor}"

def to_iso_utc(ts) -> str:
    # Accept ISO, epoch s/ms; fallback to now
    try:
        if ts is None or ts == "": raise ValueError
        if isinstance(ts,(int,float)) or (isinstance(ts,str) and ts.strip().replace(".","",1).isdigit()):
            n = float(ts)
            if n > 1e12: n /= 1e6
            if n > 1e10: dt = datetime.fromtimestamp(n/1000.0, tz=timezone.utc)
            else:        dt = datetime.fromtimestamp(n, tz=timezone.utc)
            return dt.isoformat()
        return datetime.fromisoformat(str(ts).replace("Z","+00:00")).astimezone(timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()

def ensure_ts(p: dict) -> dict:
    p["ts"] = to_iso_utc(p.get("ts"))
    return p

def push_history(k: str, p: dict):
    v = p.get("value")
    if v is None: return
    try:
        vv = float(v)
    except Exception:
        return
    unit = p.get("unit") or ""
    dq = HISTORY.get(k)
    if dq is None:
        dq = HISTORY[k] = deque(maxlen=MAX_HISTORY_POINTS)
    dq.append({"ts": p["ts"], "value": vv, "unit": unit})
    # prune by age
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)
        while dq and datetime.fromisoformat(dq[0]["ts"]) < cutoff:
            dq.popleft()
    except Exception:
        pass

async def broadcast(msg: dict):
    dead = []
    for c in list(CLIENTS):
        try:
            await c.send_json(msg)
        except Exception:
            dead.append(c)
    for d in dead:
        CLIENTS.discard(d)

# ---------- MQTT (thread) ----------
MQTT_HOST = "192.168.50.1"
MQTT_PORT = 1883
MQTT_USER = "barkasse"
MQTT_PASS = "change-me"

m = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="barkasse-hub-ui")
m.username_pw_set(MQTT_USER, MQTT_PASS)

def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[MQTT] Connected rc={rc}")
    client.subscribe("barkasse/#", qos=0)

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        print("[MQTT] decode error:", e)
        return
    # Normalize into individual sensor payloads
    items = []
    if isinstance(payload, dict) and isinstance(payload.get("sensors"), dict):
        base = {k: payload.get(k) for k in ("node","cluster","ts")}
        for sname, sobj in payload["sensors"].items():
            if not isinstance(sobj, dict): continue
            o = dict(base)
            o["sensor"] = sname
            o.update(sobj)
            items.append(o)
    elif isinstance(payload, dict):
        items.append(payload)

    # Hand off to asyncio loop
    for it in items:
        it = ensure_ts(it)
        try:
            EVENT_Q.put_nowait(it)
        except asyncio.QueueFull:
            pass

m.on_connect = on_connect
m.on_message = on_message
m.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
m.loop_start()

# ---------- Background worker ----------
async def event_worker():
    while True:
        p = await EVENT_Q.get()
        try:
            k = key_from_payload(p)
            LATEST[k] = p
            push_history(k, p)
            await broadcast({"type":"update", "data": p})
        finally:
            EVENT_Q.task_done()

@app.on_event("startup")
async def _startup():
    asyncio.create_task(event_worker())

# ---------- HTTP ----------
@app.get("/")
def root():
    return HTMLResponse(open("static/index.html","r",encoding="utf-8").read())

@app.get("/history")
def history(key: str, period: str = Query("1h", regex="^(1h|1d|max)$")):
    dq = HISTORY.get(key, deque())
    if not dq:
        return JSONResponse({"key": key, "unit": "", "data": []})
    now = datetime.now(timezone.utc)
    cutoff = None
    if period == "1h": cutoff = now - timedelta(hours=1)
    elif period == "1d": cutoff = now - timedelta(days=1)
    data, unit = [], ""
    for p in dq:
        try:
            ts = datetime.fromisoformat(p["ts"])
        except Exception:
            continue
        if cutoff and ts < cutoff:
            continue
        data.append(p)
        unit = p.get("unit", unit)
    return JSONResponse({"key": key, "unit": unit, "data": data})

@app.get("/topics")
def topics():
    return JSONResponse(sorted(LATEST.keys()))

# ---------- WS ----------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    await ws.send_json({"type":"snapshot", "data": list(LATEST.values())})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        CLIENTS.discard(ws)
