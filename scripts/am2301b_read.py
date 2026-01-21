#!/usr/bin/env python3
"""
AM2301B (AHT20-based) I2C reader via i2ctransfer (i2c-tools).

Implements the datasheet sequence:
1) Read status: write 0x71, read 1 byte. Check status & 0x18 == 0x18 (power-on check).
2) Wait 10 ms
3) Trigger measurement: 0xAC 0x33 0x00
4) Wait >=80 ms, then read 7 bytes (status + 5 data + CRC). If busy (bit7==1), keep polling.
5) CRC8: init 0xFF, poly = 1 + x^4 + x^5 + x^8 (0x31)
6) Convert 20-bit humidity/temp to %RH and °C.

Outputs ONE JSON object (a "sensors map") that your existing Parse&Expand node can expand.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone


HEXBYTE_RE = re.compile(r"0x([0-9a-fA-F]{2})")


def run_i2ctransfer(args_list: list[str]) -> str:
    """Run i2ctransfer and return stdout (raises on nonzero exit)."""
    p = subprocess.run(args_list, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip() or f"i2ctransfer failed: {args_list}")
    return p.stdout.strip()


def parse_hexbytes(s: str) -> list[int]:
    """Extract all 0xNN tokens from i2ctransfer output."""
    return [int(m.group(1), 16) for m in HEXBYTE_RE.finditer(s)]


def crc8_aosong(data: list[int]) -> int:
    """
    CRC8 with:
    - initial value 0xFF
    - polynomial: 1 + x^4 + x^5 + x^8  -> 0x31 (MSB-first)
    """
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0x31) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


def read_status(bus: int, addr: int) -> int:
    # write 0x71, read 1 byte
    out = run_i2ctransfer(["i2ctransfer", "-y", str(bus), f"w1@0x{addr:02x}", "0x71", "r1"])
    vals = parse_hexbytes(out)
    if not vals:
        raise RuntimeError(f"Empty status read. Raw output: {out!r}")
    return vals[-1]


def trigger_measurement(bus: int, addr: int) -> None:
    # write 0xAC 0x33 0x00
    run_i2ctransfer(["i2ctransfer", "-y", str(bus), f"w3@0x{addr:02x}", "0xAC", "0x33", "0x00"])


def read_frame7(bus: int, addr: int) -> list[int]:
    # read 7 bytes
    out = run_i2ctransfer(["i2ctransfer", "-y", str(bus), f"r7@0x{addr:02x}"])
    vals = parse_hexbytes(out)
    if len(vals) < 7:
        raise RuntimeError(f"Expected 7 bytes, got {len(vals)}. Raw output: {out!r}")
    # if there are extra tokens (rare formatting), keep the last 7
    return vals[-7:]


def convert(frame: list[int]) -> tuple[float, float]:
    """
    frame layout:
    [0]=status
    [1..5]=data
    [6]=crc

    humidity raw: 20-bit from bytes 1,2,3 (upper nibble of byte3)
    temp raw:     20-bit from lower nibble of byte3 + bytes 4,5
    """
    b0, b1, b2, b3, b4, b5, crc = frame

    # CRC over first 6 bytes (status + 5 data)
    calc = crc8_aosong([b0, b1, b2, b3, b4, b5])
    if calc != crc:
        raise RuntimeError(f"CRC mismatch: got 0x{crc:02x}, expected 0x{calc:02x}. Frame={frame}")

    # Busy bit check
    if b0 & 0x80:
        raise RuntimeError("Sensor still busy (status.bit7=1)")

    hum_raw = ((b1 << 16) | (b2 << 8) | b3) >> 4
    tmp_raw = ((b3 & 0x0F) << 16) | (b4 << 8) | b5

    humidity = (hum_raw / 1048576.0) * 100.0
    temperature = (tmp_raw / 1048576.0) * 200.0 - 50.0
    return temperature, humidity


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bus", type=int, default=1)
    ap.add_argument("--addr", type=lambda x: int(x, 0), default=0x38)
    ap.add_argument("--node", default="hub")
    ap.add_argument("--cluster", default="enclosure")
    ap.add_argument("--wait-ms", type=int, default=90, help="Initial wait after trigger (>=80ms per datasheet).")
    ap.add_argument("--poll-ms", type=int, default=200, help="Extra time budget to poll until not busy.")
    ap.add_argument("--poll-step-ms", type=int, default=10)
    ap.add_argument("--round", type=int, default=1, help="Decimals to round to (default: 0.1 resolution).")
    args = ap.parse_args()

    # Step 1: status check (datasheet says only needed after power-on)
    status = read_status(args.bus, args.addr)
    if (status & 0x18) != 0x18:
        # Datasheet says: initialize 0x1B/0x1C/0x1E regs if not equal to 0x18,
        # but does not list the actual init write values in this PDF.
        # We still continue and try to measure, but we warn on stderr.
        print(f"WARNING: status=0x{status:02x} (status&0x18 != 0x18). Sensor may need init.", file=sys.stderr)

    # Step 2: wait 10 ms
    time.sleep(0.010)

    # Step 3: trigger measurement
    trigger_measurement(args.bus, args.addr)

    # Step 4: wait >=80ms, then poll until not busy
    time.sleep(max(args.wait_ms, 80) / 1000.0)

    deadline = time.time() + (args.poll_ms / 1000.0)
    last_err = None
    while True:
        try:
            frame = read_frame7(args.bus, args.addr)
            temperature, humidity = convert(frame)
            break
        except RuntimeError as e:
            last_err = e
            # if it's "busy", poll; else fail fast
            if "busy" not in str(e).lower():
                raise
            if time.time() >= deadline:
                raise RuntimeError(f"Timed out waiting for not-busy frame. Last error: {last_err}") from None
            time.sleep(args.poll_step_ms / 1000.0)

    # Output as sensors-map so your existing Parse&Expand function can fan out
    t = round(temperature, args.round)
    h = round(humidity, args.round)
    payload = {
        "node": args.node,
        "cluster": args.cluster,
        "ts": iso_now(),
        "sensors": {
            "temperature": {"value": t, "unit": "°C"},
            "humidity": {"value": h, "unit": "%RH"},
        },
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"AM2301B read failed: {e}", file=sys.stderr)
        raise SystemExit(2)
