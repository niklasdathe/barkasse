from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import json, asyncio, time, re
import paho.mqtt.client as mqtt

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Live store: latest values by "node/cluster/sensor"
LATEST = {}  # key: "node/cluster/sensor" -> payload dict
CLIENTS = set()

def key_from_payload(p):
    node = p.get("node","?")
    cluster = p.get("cluster","?")
    sensor = p.get("sensor","state")
    return f"{node}/{cluster}/{sensor}"

# --- MQTT ---
MQTT_HOST = "192.168.50.1"
MQTT_PORT = 1883
MQTT_USER = "barkasse"
MQTT_PASS = "change-me"

m = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="barkasse-hub-ui")
m.username_pw_set(MQTT_USER, MQTT_PASS)

def on_connect(client, userdata, flags, rc, properties=None):
    print(f"[MQTT] Connected to broker {MQTT_HOST}:{MQTT_PORT} (rc={rc})")
    client.subscribe("barkasse/#", qos=0)

def on_message(client, userdata, msg):
    try:
        print(f"[MQTT] {msg.topic}: {msg.payload[:120]}")
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        print("decode error:", e)
        return
    # Normalize cluster/state aggregate:
    if "sensors" in payload and isinstance(payload["sensors"], dict):
        # explode into individual entries too:
        base = {k: payload.get(k) for k in ("node","cluster","ts")}
        for sname, sobj in payload["sensors"].items():
            o = dict(base)
            o["sensor"] = sname
            o.update(sobj)
            k = key_from_payload(o)
            LATEST[k] = o
            asyncio.run(broadcast({"type":"update", "data":o}))
    else:
        k = key_from_payload(payload)
        LATEST[k] = payload
        asyncio.run(broadcast({"type":"update", "data":payload}))

m.on_connect = on_connect
m.on_message = on_message
m.connect_async(MQTT_HOST, MQTT_PORT, keepalive=60)
m.loop_start()

# --- Web ---
@app.get("/")
def root():
    return HTMLResponse(open("static/index.html","r",encoding="utf-8").read())

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    # send current snapshot
    await ws.send_json({"type":"snapshot", "data": list(LATEST.values())})
    try:
        while True:
            await ws.receive_text()  # no incoming commands yet
    except WebSocketDisconnect:
        CLIENTS.discard(ws)

async def broadcast(msg: dict):
    dead = []
    for c in list(CLIENTS):
        try:
            await c.send_json(msg)
        except Exception:
            dead.append(c)
    for d in dead:
        CLIENTS.discard(d)
