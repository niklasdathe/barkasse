from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from typing import Dict, Deque, List, Optional, Union
from collections import deque
from datetime import datetime, timezone, timedelta
import json, asyncio
import paho.mqtt.client as mqtt

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# -------- Live store & history --------
LATEST: Dict[str, dict] = {}            # key -> last payload (full JSON)
HISTORY: Dict[str, Deque[dict]] = {}    # key -> deque of {"ts": iso, "value": float, "unit": str}
CLIENTS = set()

MAX_HISTORY_POINTS = 20000              # per topic ring buffer
KEEP_DAYS = 14                          # optional time-based prune

# -------- Helpers --------
def key_from_payload(p: dict) -> str:
    node = p.get("node", "?")
    cluster = p.get("cluster", "?")
    sensor = p.get("sensor", "state")
    return f"{node}/{cluster}/{sensor}"

def to_iso_utc_from_any(ts: Optional[Union[str, int, float]]) -> str:
    """Accepts ISO8601 string, epoch seconds, or epoch millis. Returns ISO8601 with offset."""
    if ts is None or ts == "":
        return datetime.now(timezone.utc).isoformat()
    try:
        # numeric? epoch seconds or ms
        if isinstance(ts, (int, float)) or (isinstance(ts, str) and ts.strip().isdigit()):
            n = float(ts)
            # Heuristic: treat large numbers as ms
            if n > 1e12:  # very large (ns) → scale down
                n = n / 1e6
            if n > 1e10:  # ms
                dt = datetime.fromtimestamp(n / 1000.0, tz=timezone.utc)
            else:         # s
                dt = datetime.fromtimestamp(n, tz=timezone.utc)
            return dt.isoformat()
        # string ISO?
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()

def ensure_ts(payload: dict) -> dict:
    payload["ts"] = to_iso_utc_from_any(payload.get("ts"))
    return payload

def push_history(k: str, payload: dict):
    val = payload.get("value", None)
    if val is None:
        return
    try:
        v = float(val)
    except Exception:
        return
    unit = payload.get("unit") or ""
    ts_iso = payload["ts"]
    dq = HISTORY.get(k)
    if dq is None:
        dq = HISTORY[k] = deque(maxlen=MAX_HISTORY_POINTS)
    dq.append({"ts": ts_iso, "value": v, "unit": unit})

    # Optional prune by age
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

# -------- MQTT --------
MQTT_HOST = "192.168.50.1"
MQTT_PORT = 1883
MQTT_USER = "barkasse"
MQTT_PASS = "change-me"

m = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="barkasse-hub-ui")
m.username_pw_set(MQTT_USER, MQTT_PASS)

def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[MQTT] Connected {MQTT_HOST}:{MQTT_PORT} rc={rc}")
    client.subscribe("barkasse/#", qos=0)

def _handle_payload(p: dict):
    ensure_ts(p)
    k = key_from_payload(p)
    LATEST[k] = p
    push_history(k, p)
    asyncio.run(broadcast({"type": "update", "data": p}))

def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        print("[MQTT] decode error:", e)
        return

    if isinstance(payload, dict) and isinstance(payload.get("sensors"), dict):
        base = {k: payload.get(k) for k in ("node", "cluster", "ts")}
        for sname, sobj in payload["sensors"].items():
            o = dict(base)
            o["sensor"] = sname
            if isinstance(sobj, dict):
                o.update(sobj)
            _handle_payload(o)
    elif isinstance(payload, dict):
        _handle_payload(payload)

m.on_connect = on_connect
m.on_message = on_message
m.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
m.loop_start()

# -------- HTTP --------
@app.get("/")
def root():
    return HTMLResponse(open("static/index.html", "r", encoding="utf-8").read())

@app.get("/history")
def get_history(
    key: str = Query(..., description="Format: node/cluster/sensor"),
    period: str = Query("1d", regex="^(1h|1d|max)$")
):
    dq = HISTORY.get(key, deque())
    if not dq:
        return JSONResponse({"key": key, "unit": "", "data": []})

    now = datetime.now(timezone.utc)
    if period == "1h":
        cutoff = now - timedelta(hours=1)
    elif period == "1d":
        cutoff = now - timedelta(days=1)
    else:
        cutoff = None

    data: List[dict] = []
    unit = ""
    for p in dq:
        try:
            pts = datetime.fromisoformat(p["ts"])
        except Exception:
            continue
        if cutoff and pts < cutoff:
            continue
        data.append(p)
        unit = p.get("unit", unit)

    return JSONResponse({"key": key, "unit": unit, "data": data})

@app.get("/topics")
def topics():
    return JSONResponse(sorted(LATEST.keys()))

# -------- WebSocket --------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    await ws.send_json({"type": "snapshot", "data": list(LATEST.values())})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        CLIENTS.discard(ws)
