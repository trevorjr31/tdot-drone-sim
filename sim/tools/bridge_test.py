"""
End-to-end test of PX4 + bridge, over the same WebSocket protocol the browser uses:
check the City of Toronto geofence is loaded, take off, fly forward with keyboard-style
velocity messages, let go (hover, then PX4 Hold), fly to a point, climb into the 120 m
ceiling (PX4 must switch to Return), crash (motors cut: it must fall and disarm), and
reset (PX4 restarts: back on the ground at home, geofence uploaded again).

    docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
      python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/bridge_test.py"
"""

import asyncio
import json
import math
import os
import sys
import uuid

from websockets.asyncio.client import connect

BRIDGE_URL = os.environ.get("BRIDGE_URL", "ws://127.0.0.1:8765")
TAKEOFF_ALT_M = 20.0
# PX4 treats a fly-to target as reached within a few metres (its acceptance radius).
ARRIVAL_RADIUS_M = 5.0
CEILING_M = 120.0  # bridge's FENCE_CEILING_M


def distance_m(lat1, lon1, lat2, lon2):
    x = (lon2 - lon1) * 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    y = (lat2 - lat1) * 110_574
    return math.hypot(x, y)


# Return height used to test Return; the bridge's default (FENCE_CEILING_M - 5) until the app sets one.
RETURN_TEST_ALT_M = 45.0
RETURN_DEFAULT_ALT_M = 115.0

TORONTO_BOX = {"lat": (43.58, 43.86), "lon": (-79.64, -79.11)}


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.state: dict | None = None
        self.px4_connected = False
        self.geofence: dict | None = None
        self.return_alt: float | None = None
        self.config: dict | None = None
        self.ai = False
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
                self.geofence = msg.get("geofence")
                self.return_alt = msg.get("returnAltM")
                self.config = msg.get("config")
                self.ai = msg.get("ai") is True
                print(f"Status: PX4 {'connected' if msg['px4Connected'] else 'not connected'} ({msg.get('px4Version')})")
            elif msg["type"] == "ack":
                self.acks[msg["id"]] = msg
            elif msg["type"] == "notice":
                print(f"Notice: {msg['message']}")

    async def command(self, action: str, expect_refusal: bool = False, timeout: float = 30, **params):
        cid = str(uuid.uuid4())
        await self.ws.send(json.dumps({"type": "command", "id": cid, "action": action, **params}))
        ack = await self.until(lambda: self.acks.get(cid), timeout, f"ack for {action}")
        if expect_refusal:
            if ack["ok"]:
                sys.exit(f"FAIL: {action} {params} should have been refused")
            print(f"{action}: refused as expected ({ack['error']})")
        elif not ack["ok"]:
            sys.exit(f"FAIL: {action} refused: {ack['error']}")
        else:
            print(f"{action}: accepted")
        return ack

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

        await c.until(lambda: c.geofence and (c.geofence["uploaded"] or c.geofence["error"]), 30, "geofence upload")
        if not c.geofence["uploaded"]:
            sys.exit(f"FAIL: geofence not uploaded: {c.geofence['error']}")
        print(f"Geofence: {c.geofence['points']}-point boundary, {c.geofence['ceilingM']:.0f} m ceiling")

        # Sim config: bad values are refused; a change is saved and reported (then put back).
        await c.until(lambda: c.config, 10, "sim config in bridge status")
        original = c.config["keyboardMs"]
        await c.command("config", expect_refusal=True, config={"cruiseMs": 99})
        await c.command("config", expect_refusal=True, config={"batteryCriticalPct": 40})
        await c.command("config", config={"keyboardMs": original + 1})
        await c.until(lambda: c.config["keyboardMs"] == original + 1, 10, "changed setting in bridge status")
        await c.command("config", config={"keyboardMs": original})
        print(f"Sim config: cruise {c.config['cruiseMs']} m/s, battery {c.config['batteryMin']:.0f} min, ceiling {c.config['ceilingM']:.0f} m")

        # Routes in words: without an API key the bridge says so; with one, Claude plans a simple route.
        context = {"inAir": False, "relAltM": 0, "plannerAltM": 30, "ceilingM": 120}
        if not c.ai:
            await c.command("composeRoute", expect_refusal=True, text="go north 100 m then land", context=context)
        else:
            ack = await c.command("composeRoute", timeout=150, text="go north 100 m then land", context=context)
            actions = [st["action"] for st in ack["plan"]["steps"]]
            if actions != ["move", "land"]:
                sys.exit(f"FAIL: composeRoute planned {ack['plan']}")
            print(f"composeRoute: {ack['plan']['summary']}")

        # Let PX4 finish its pre-arm checks (GPS fix, home) before asking it to fly.
        await c.until(lambda: c.state.get("home") and c.state["flightMode"] != "Unknown", 60, "home position")
        await asyncio.sleep(2)

        n0 = c.states_seen
        await asyncio.sleep(2)
        rate = (c.states_seen - n0) / 2
        print(f"State rate: {rate:.0f} Hz")
        if rate < 10:
            sys.exit(f"FAIL: state rate too low ({rate:.1f} Hz)")

        # Start from the ground, whatever an earlier session left behind.
        if c.state["inAir"]:
            print(f"Drone already airborne ({c.state['relAltM']:.0f} m): landing first")
            await c.command("land")
            await c.until(lambda: not c.state["inAir"], 240, "initial landing")
            await asyncio.sleep(3)

        await c.command("takeoff", altitudeM=TAKEOFF_ALT_M)
        await c.until(lambda: c.state["relAltM"] > TAKEOFF_ALT_M - 2, 60, "takeoff altitude")
        print(f"Airborne: {c.state['relAltM']:.1f} m, mode {c.state['flightMode']}, armed {c.state['armed']}")

        # Keyboard flying: hold "forward" (W) for 4 s, sending like the browser does (10 Hz).
        start = (c.state["lat"], c.state["lon"])
        for i in range(40):
            await ws.send(json.dumps({"type": "velocity", "forwardMs": 5, "rightMs": 0, "downMs": 0, "yawRateDegS": 0}))
            if i == 20:
                # The app updates the return height every few seconds while flying: that must
                # not interrupt keyboard flying (checked just below: still Offboard and moving).
                await ws.send(json.dumps({"type": "command", "id": "return-alt-kb", "action": "returnAlt", "relAltM": 60}))
            await asyncio.sleep(0.1)
        moved = distance_m(*start, c.state["lat"], c.state["lon"])
        print(f"Keyboard forward: moved {moved:.1f} m, mode {c.state['flightMode']}, speed {c.state['groundSpeedMs']:.1f} m/s")
        if c.state["flightMode"] != "Offboard" or moved < 8:
            sys.exit("FAIL: velocity control didn't move the drone in offboard mode")

        # Let go: it should brake to a hover, then hand back to PX4's Hold mode.
        await c.until(lambda: c.state["groundSpeedMs"] < 1.0, 10, "hover after releasing keys")
        print(f"Released: hovering ({c.state['groundSpeedMs']:.1f} m/s)")
        await c.until(lambda: c.state["flightMode"] == "Hold", 10, "Hold mode after idle")
        print("Idle: back in Hold")

        # Fly to a point 60 m north at the current height.
        target = (c.state["lat"] + 60 / 110_574, c.state["lon"])
        await c.command("goto", lat=target[0], lon=target[1])
        # Regression: the app sends a few zero velocities when keys are released. Arriving
        # right after a fly-to, they must not take control back and cancel it.
        for _ in range(5):
            await ws.send(json.dumps({"type": "velocity", "forwardMs": 0, "rightMs": 0, "downMs": 0, "yawRateDegS": 0}))
            await asyncio.sleep(0.1)
        await c.until(lambda: distance_m(*target, c.state["lat"], c.state["lon"]) < ARRIVAL_RADIUS_M, 60, "arrival at fly-to target")
        print(f"Fly-to: arrived within {distance_m(*target, c.state['lat'], c.state['lon']):.1f} m at {c.state['relAltM']:.0f} m")

        # Return home climbs straight up to the return height before heading home (the app
        # sets that height to clear the buildings in the way; the bridge turns PX4's cone off).
        await c.command("returnAlt", relAltM=RETURN_TEST_ALT_M)
        await c.until(lambda: c.return_alt == RETURN_TEST_ALT_M, 10, "return height in bridge status")
        home = c.state["home"]
        away = distance_m(home["lat"], home["lon"], c.state["lat"], c.state["lon"])
        await c.command("rtl")
        await c.until(lambda: c.state["relAltM"] >= RETURN_TEST_ALT_M - 2, 60, "climb to the return height")
        closer = away - distance_m(home["lat"], home["lon"], c.state["lat"], c.state["lon"])
        print(f"Return: climbed to {c.state['relAltM']:.0f} m having moved {closer:.1f} m towards home ({away:.0f} m away)")
        if closer > 10:
            sys.exit("FAIL: Return headed home before reaching the return height")
        await c.command("hold")
        # Mode telemetry lags the command; the ceiling check below needs Return to be over.
        await c.until(lambda: c.state["flightMode"] == "Hold", 10, "Hold after stopping the return")

        # Geofence ceiling: climb with the "up" key until PX4 takes over with Return.
        max_alt = 0.0
        try:
            async with asyncio.timeout(90):
                while c.state["flightMode"] != "Return":
                    await ws.send(json.dumps({"type": "velocity", "forwardMs": 0, "rightMs": 0, "downMs": -3, "yawRateDegS": 0}))
                    max_alt = max(max_alt, c.state["relAltM"])
                    await asyncio.sleep(0.1)
        except TimeoutError:
            sys.exit(f"FAIL: no geofence breach after climbing to {max_alt:.0f} m (mode {c.state['flightMode']})")
        print(f"Ceiling: PX4 switched to Return at {max_alt:.0f} m above home")
        if not CEILING_M - 2 <= max_alt <= CEILING_M + 10:
            sys.exit(f"FAIL: breach at {max_alt:.0f} m, expected about {CEILING_M:.0f} m")

        # Crash: what the app sends on hitting a building. Motors off → it falls and disarms.
        await c.command("crash")
        await c.until(lambda: not c.state["armed"] and c.state["relAltM"] < 2, 30, "fall after crash")
        print(f"Crashed: fell to {c.state['relAltM']:.1f} m, disarmed")

        # Reset: PX4 restarts and the drone is back on the ground at home.
        await c.command("reset")

        def home_distance():
            # Read home fresh each time: right after PX4 restarts it can briefly be unset (NaN).
            h = c.state.get("home") or {}
            d = distance_m(h["lat"], h["lon"], c.state["lat"], c.state["lon"]) if h.get("lat") is not None else math.nan
            return d if not math.isnan(d) else None

        await c.until(lambda: (d := home_distance()) is not None and d < 3 and not c.state["armed"], 30, "drone back at home after reset")
        home = c.state["home"]
        await c.until(lambda: c.geofence and c.geofence["uploaded"], 30, "geofence after reset")
        await c.until(lambda: c.return_alt == RETURN_DEFAULT_ALT_M, 30, "safe default return height after reset")
        print(f"Reset: back at home ({distance_m(home['lat'], home['lon'], c.state['lat'], c.state['lon']):.1f} m), disarmed, geofence uploaded")
        print("PASS")
        pump.cancel()


if __name__ == "__main__":
    asyncio.run(main())
