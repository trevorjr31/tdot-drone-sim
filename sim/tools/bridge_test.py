"""
End-to-end test of PX4 + bridge, over the same WebSocket protocol the browser uses:
wait for live state over Toronto, command a takeoff, check it climbs, command a landing.

    docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
      python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/bridge_test.py"
"""

import asyncio
import json
import os
import sys
import uuid

from websockets.asyncio.client import connect

BRIDGE_URL = os.environ.get("BRIDGE_URL", "ws://127.0.0.1:8765")
TAKEOFF_ALT_M = 20.0
TORONTO_BOX = {"lat": (43.58, 43.86), "lon": (-79.64, -79.11)}


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.state: dict | None = None
        self.px4_connected = False
        self.acks: dict[str, dict] = {}
        self.states_seen = 0

    async def pump(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if msg["type"] == "state":
                self.state = msg["state"]
                self.states_seen += 1
            elif msg["type"] == "status":
                self.px4_connected = msg["px4Connected"]
                print(f"Status: PX4 {'connected' if msg['px4Connected'] else 'not connected'} ({msg.get('px4Version')})")
            elif msg["type"] == "ack":
                self.acks[msg["id"]] = msg

    async def command(self, action: str, **params):
        cid = str(uuid.uuid4())
        await self.ws.send(json.dumps({"type": "command", "id": cid, "action": action, **params}))
        ack = await self.until(lambda: self.acks.get(cid), 30, f"ack for {action}")
        if not ack["ok"]:
            sys.exit(f"FAIL: {action} refused: {ack['error']}")
        print(f"{action}: accepted")

    async def until(self, predicate, timeout, what):
        try:
            async with asyncio.timeout(timeout):
                while not (result := predicate()):
                    await asyncio.sleep(0.1)
                return result
        except TimeoutError:
            sys.exit(f"FAIL: timed out after {timeout}s waiting for {what} (last state: {self.state})")


async def main():
    print(f"Connecting to bridge at {BRIDGE_URL}…")
    async with connect(BRIDGE_URL) as ws:
        c = Client(ws)
        pump = asyncio.create_task(c.pump())

        await c.until(lambda: c.px4_connected and c.state, 90, "PX4 connection and first state")
        s = c.state
        in_toronto = TORONTO_BOX["lat"][0] < s["lat"] < TORONTO_BOX["lat"][1] and TORONTO_BOX["lon"][0] < s["lon"] < TORONTO_BOX["lon"][1]
        print(f"State: {s['lat']:.5f}, {s['lon']:.5f}, {s['altAmslM']:.1f} m AMSL, mode {s['flightMode']}, battery {s['battery']:.0%}")
        if not in_toronto:
            sys.exit("FAIL: drone is not in Toronto")

        # Let PX4 finish its pre-arm checks (GPS fix, home) before asking it to fly.
        await c.until(lambda: c.state.get("home") and c.state["flightMode"] != "Unknown", 60, "home position")
        await asyncio.sleep(2)

        n0 = c.states_seen
        await asyncio.sleep(2)
        rate = (c.states_seen - n0) / 2
        print(f"State rate: {rate:.0f} Hz")
        if rate < 10:
            sys.exit(f"FAIL: state rate too low ({rate:.1f} Hz)")

        await c.command("takeoff", altitudeM=TAKEOFF_ALT_M)
        await c.until(lambda: c.state["relAltM"] > TAKEOFF_ALT_M - 2, 60, "takeoff altitude")
        print(f"Airborne: {c.state['relAltM']:.1f} m, mode {c.state['flightMode']}, armed {c.state['armed']}")

        await c.command("land")
        await c.until(lambda: not c.state["inAir"], 90, "landing")
        print(f"Landed: {c.state['relAltM']:.1f} m, mode {c.state['flightMode']}")
        print("PASS")
        pump.cancel()


if __name__ == "__main__":
    asyncio.run(main())
