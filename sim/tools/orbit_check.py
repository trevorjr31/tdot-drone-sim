"""Quick check of the bridge's orbit command: direction and mode name. Not part of CI."""
import asyncio, json, math, uuid
from websockets.asyncio.client import connect

async def main():
    async with connect("ws://localhost:8765") as ws:
        state, acks = {}, {}
        async def pump():
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] == "state": state.update(m["state"])
                elif m["type"] == "ack": acks[m["id"]] = m
        asyncio.create_task(pump())
        async def cmd(action, **p):
            i = str(uuid.uuid4())
            await ws.send(json.dumps({"type": "command", "id": i, "action": action, **p}))
            for _ in range(300):
                if i in acks: return acks[i]
                await asyncio.sleep(0.1)
        while not state.get("home") or state.get("flightMode") in (None, "Unknown"):
            await asyncio.sleep(0.5)
        await asyncio.sleep(3)
        print("takeoff", (await cmd("takeoff", altitudeM=20))["ok"])
        while state["relAltM"] < 18: await asyncio.sleep(0.5)
        c = {"lat": state["lat"] + 30 / 110574, "lon": state["lon"]}  # centre 30 m north: drone starts on the circle, south side
        r = await cmd("orbit", lat=c["lat"], lon=c["lon"], relAltM=20, radiusM=30, clockwise=True, speedMs=5)
        print("orbit", r["ok"], r["error"])
        kx = 111320 * math.cos(math.radians(c["lat"]))
        prev, turned = None, 0.0
        for k in range(40):
            await asyncio.sleep(1)
            b = math.degrees(math.atan2((state["lon"] - c["lon"]) * kx, (state["lat"] - c["lat"]) * 110574))
            if prev is not None: turned += (b - prev + 540) % 360 - 180
            prev = b
            if k % 5 == 0:
                d = math.hypot((state["lon"] - c["lon"]) * kx, (state["lat"] - c["lat"]) * 110574)
                print(f"t={k:2d}s mode={state['flightMode']} dist={d:5.1f} m alt={state['relAltM']:4.1f} turned={turned:+6.0f}°")
        print("clockwise" if turned > 0 else "anticlockwise", f"{turned:+.0f}° in 40 s")
        print("land", (await cmd("land"))["ok"])
        while state["inAir"]: await asyncio.sleep(1)
        print("landed")

asyncio.run(main())
