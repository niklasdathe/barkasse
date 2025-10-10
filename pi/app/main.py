from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from typing import Dict, Deque
from collections import deque
from datetime import datetime, timezone, timedelta
import asyncio, json, threading
import paho.mqtt.client as mqtt

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# ---------------- Stores ----------------
LATEST: Dict[str, dict] = {}
HISTORY: Dict[str, Deque[dict]] = {}
MAX_HISTORY_POINTS = 20000
KEEP_DAYS = 14

CLIENTS = set()

# Will be initialized on startup so we have the REAL running loop
EVENT_Q: asyncio.Queue | None = None
LOOP: asyncio.AbstractEventLoop | None = None

def key_from_payload(p: dict) -> str:
    return f"{p.get('node','?')}/{p.get('cluster','?')}/{p.get('sensor','state')}"

def to_iso_utc(ts):
    try:
        if ts is None or ts == "":
            raise ValueError
        # Handle numeric-like timestamps (seconds/milliseconds/microseconds/nanoseconds)
        if isinstance(ts, (int, float)) or (
            isinstance(ts, str) and ts.strip().replace(".", "", 1).isdigit()
        ):
            n = float(ts)
            an = abs(n)
            # Normalize by magnitude:
            # - >=1e17: nanoseconds → seconds
            # - >=1e14: microseconds → seconds
            # - >=1e11: milliseconds → seconds
            if an >= 1e17:
                n /= 1e9
            elif an >= 1e14:
                n /= 1e6
            elif an >= 1e11:
                n /= 1e3
            dt = datetime.fromtimestamp(n, tz=timezone.utc)
            return dt.isoformat()
        # Handle ISO-8601 strings (support trailing Z)
        s = str(ts)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return (
            datetime.fromisoformat(s).astimezone(timezone.utc).isoformat()
        )
    except Exception:
        # Fallback to now to avoid dropping points entirely if parsing fails
        return datetime.now(timezone.utc).isoformat()

def ensure_ts(p: dict) -> dict:
    p["ts"] = to_iso_utc(p.get("ts"))
    return p

def push_history(k: str, p: dict):
    v = p.get("value")
    if v is None: return
    try: vv = float(v)
    except Exception: return
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
        try: await c.send_json(msg)
        except Exception: dead.append(c)
    for d in dead: CLIENTS.discard(d)

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
    # Runs in paho thread — MUST hand off to asyncio loop thread-safely
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        print("[MQTT] decode error:", e); return

    items = []
    if isinstance(payload, dict) and isinstance(payload.get("sensors"), dict):
        base = {k: payload.get(k) for k in ("node","cluster","ts")}
        for sname, sobj in payload["sensors"].items():
            if not isinstance(sobj, dict): continue
            o = dict(base); o["sensor"] = sname; o.update(sobj)
            items.append(ensure_ts(o))
    elif isinstance(payload, dict):
        items.append(ensure_ts(payload))

    # Thread-safe enqueue into asyncio loop
    if LOOP and EVENT_Q:
        for it in items:
            LOOP.call_soon_threadsafe(EVENT_Q.put_nowait, it)

m.on_connect = on_connect
m.on_message = on_message

# ---------- Background worker ----------
async def event_worker():
    assert EVENT_Q is not None
    while True:
        p = await EVENT_Q.get()
        try:
            k = key_from_payload(p)
            LATEST[k] = p
            push_history(k, p)
            await broadcast({"type":"update","data":p})
        finally:
            EVENT_Q.task_done()

@app.on_event("startup")
async def _startup():
    global LOOP, EVENT_Q
    LOOP = asyncio.get_running_loop()
    EVENT_Q = asyncio.Queue()
    # Start worker(s)
    asyncio.create_task(event_worker())
    # Start MQTT loop in its own thread AFTER LOOP is set
    def _start_mqtt():
        m.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        m.loop_forever()
    threading.Thread(target=_start_mqtt, daemon=True).start()

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
        if cutoff and ts < cutoff: continue
        data.append(p); unit = p.get("unit", unit)
    return JSONResponse({"key": key, "unit": unit, "data": data})

@app.get("/debug/stats")
def stats():
    return {
        "topics": len(LATEST),
        "history_topics": len(HISTORY),
        "history_points_total": sum(len(dq) for dq in HISTORY.values())
    }

# ---------- WS ----------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    await ws.send_json({"type":"snapshot","data": list(LATEST.values())})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        CLIENTS.discard(ws)
