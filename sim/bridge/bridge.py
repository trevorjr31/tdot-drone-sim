"""
PX4 ⇄ browser bridge.

Browsers can't speak MAVLink over UDP, so this service connects to PX4 with
MAVSDK and exposes a WebSocket the React app talks to:

  server → client  {"type": "status", "px4Connected": bool, "px4Version": str|null, "geofence": {...},
                    "returnAltM": number|null}
                   {"type": "state",  "state": {...DroneState...}}        (RATE_HZ)
                   {"type": "ack",    "id": str, "ok": bool, "error": str|null}
                   {"type": "notice", "level": "error", "message": str}   (e.g. offboard refused)
  client → server  {"type": "command", "id": str,
                    "action": "takeoff"|"land"|"rtl"|"hold"|"arm"|"disarm"|"goto"|"crash"|"reset"|"returnAlt",
                    "altitudeM"?: number, "lat"?: number, "lon"?: number, "relAltM"?: number}
                   {"type": "velocity", "forwardMs": n, "rightMs": n, "downMs": n, "yawRateDegS": n}
                     Keyboard flying: body-frame velocity, sent ~10 Hz while keys are held.
                     The bridge switches PX4 to offboard mode and streams the setpoint. If the
                     messages stop, it hovers after VELOCITY_STALE_S and hands back to PX4's
                     Hold mode after OFFBOARD_IDLE_S (e.g. the browser tab was closed).

The state matches the frontend's DroneState (src/drone/types.ts) field for field.

Crash and reset: PX4 doesn't know about buildings, so the app detects collisions and
sends "crash": the bridge cuts the motors (flight termination) and PX4's physics drops
the drone. "reset" restarts PX4 (MAVLink shutdown; Docker's restart policy starts it
again), which puts the drone back on the ground at home.

Geofence: on every PX4 (re)connect the bridge uploads the City of Toronto boundary
(FENCE_FILE, produced by `npm run data`) as an inclusion fence and sets a 120 m
ceiling above home, with PX4's Return mode as the breach action. PX4 enforces it
itself, whether or not a browser is connected.

Return height: PX4's Return mode climbs to RTL_RETURN_ALT and flies straight home, not
knowing about buildings. On connect the bridge turns off PX4's return cone (which lets
it return lower near home) and sets a high default (RETURN_ALT_DEFAULT_M); while the app
is open it sends "returnAlt" with a height that clears the buildings between the drone
and home (it has the City building data). Unlike other commands, "returnAlt" doesn't
interrupt keyboard flying.
"""

import asyncio
import json
import logging
import math
import os
import time

from mavsdk_grpc import System
from mavsdk_grpc.geofence import FenceType, GeofenceData, Point, Polygon
from mavsdk_grpc.offboard import VelocityBodyYawspeed
from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

MAVLINK_URL = os.environ.get("MAVLINK_URL", "udpin://0.0.0.0:14540")
WS_HOST = os.environ.get("WS_HOST", "0.0.0.0")
WS_PORT = int(os.environ.get("WS_PORT", "8765"))
RATE_HZ = float(os.environ.get("STATE_RATE_HZ", "20"))
DEFAULT_TAKEOFF_ALT_M = 30.0
# PX4 counts as connected while its telemetry keeps arriving.
TELEMETRY_TIMEOUT_S = 3.0
MAX_TAKEOFF_ALT_M = 120.0  # stay under the 122 m (400 ft) drone ceiling
# Keyboard (offboard velocity) limits and timeouts.
MAX_SPEED_MS = 12.0
MAX_CLIMB_MS = 3.0
MAX_YAW_RATE_DEG_S = 90.0
OFFBOARD_RATE_HZ = 20.0  # PX4 needs setpoints faster than 2 Hz or it fails safe
VELOCITY_STALE_S = 0.5  # no fresh input for this long → hover
OFFBOARD_IDLE_S = 3.0  # no input for this long → leave offboard, PX4 Hold
# Geofence (see module docstring).
FENCE_FILE = os.environ.get("FENCE_FILE", "/data/boundary-fence.geojson")
FENCE_CEILING_M = float(os.environ.get("FENCE_CEILING_M", "120"))
FENCE_ACTION_RETURN = 3  # PX4 GF_ACTION: 1 warning, 2 hold, 3 return, 4 terminate, 5 land
PX4_MAX_FENCE_POINTS = 63  # PX4 dataman holds 64 fence entries (one is bookkeeping)
# Return home (see module docstring). Stay under the geofence ceiling, or the return itself breaches it.
RETURN_ALT_MAX_M = FENCE_CEILING_M - 5
RETURN_ALT_MIN_M = 20.0
RETURN_ALT_DEFAULT_M = RETURN_ALT_MAX_M  # until the app sends a building-aware height
# Flight-mode telemetry lags a mode switch; ignore "not offboard" reports this soon after starting.
OFFBOARD_MODE_GRACE_S = 1.5

log = logging.getLogger("bridge")


def clean(value):
    """NaN/inf (PX4 sends NaN before a GPS fix) → None, so the JSON stays valid for browsers."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    return value

FLIGHT_MODE_LABELS = {
    "READY": "Ready",
    "TAKEOFF": "Takeoff",
    "HOLD": "Hold",
    "MISSION": "Mission",
    "RETURN_TO_LAUNCH": "Return",
    "LAND": "Land",
    "OFFBOARD": "Offboard",
    "FOLLOW_ME": "Follow me",
    "MANUAL": "Manual",
    "ALTCTL": "Altitude",
    "POSCTL": "Position",
    "ACRO": "Acro",
    "STABILIZED": "Stabilized",
    "RATTITUDE": "Rattitude",
}


class Bridge:
    def __init__(self) -> None:
        self.drone = System()
        self.px4_connected = False
        self.px4_version: str | None = None
        self.clients: set[ServerConnection] = set()
        self.have_position = False
        self.last_telemetry = 0.0
        # Keyboard flying (offboard velocity control).
        self.offboard_active = False
        self.offboard_starting = False
        self.velocity = (0.0, 0.0, 0.0, 0.0)
        self.velocity_at = 0.0
        self.offboard_started_at = 0.0
        # PX4 left offboard on its own (geofence, failsafe, …). Restarting offboard while keys are
        # still held would count as a pilot takeover and cancel PX4's failsafe, so wait for a release.
        self.offboard_blocked = False
        self.resetting = False
        self.geofence = {"source": None, "points": 0, "ceilingM": FENCE_CEILING_M, "uploaded": False, "error": None}
        # Height PX4 returns home at, as last set (None until set on connect).
        self.return_alt: float | None = None
        self.s = {
            "lat": 0.0,
            "lon": 0.0,
            "altAmslM": 0.0,
            "relAltM": 0.0,
            "headingDeg": 0.0,
            "rollDeg": 0.0,
            "pitchDeg": 0.0,
            "groundSpeedMs": 0.0,
            "climbRateMs": 0.0,
            "battery": 1.0,
            "armed": False,
            "inAir": False,
            "flightMode": "Unknown",
            "home": None,
        }

    # --- PX4 side -----------------------------------------------------------

    async def run_px4(self) -> None:
        log.info("Connecting to PX4 at %s", MAVLINK_URL)
        await self.drone.connect(system_address=MAVLINK_URL)
        asyncio.create_task(self.watch_connection())
        asyncio.create_task(self.watch_liveness())
        for name, stream in [
            ("position", self.watch_position),
            ("attitude", self.watch_attitude),
            ("velocity", self.watch_velocity),
            ("battery", self.watch_battery),
            ("armed", self.watch_armed),
            ("in_air", self.watch_in_air),
            ("flight_mode", self.watch_flight_mode),
            ("home", self.watch_home),
        ]:
            asyncio.create_task(self.keep_watching(name, stream))

    async def keep_watching(self, name: str, stream) -> None:
        """Telemetry streams can end if PX4 restarts; resubscribe instead of dying."""
        while True:
            try:
                await stream()
            except Exception as e:  # noqa: BLE001 - log and retry whatever went wrong
                log.warning("Telemetry %s stopped (%s); retrying", name, e)
            await asyncio.sleep(1)

    async def watch_connection(self) -> None:
        # Logged only. MAVSDK's connection state can't be trusted for "is PX4 there": PX4
        # forwards MAVLink between its links, so other clients (e.g. a ground station or the
        # flight test) appear as extra systems, and when one of them goes away MAVSDK reports
        # a disconnect even though PX4 is fine. Liveness comes from telemetry instead.
        async for state in self.drone.core.connection_state():
            log.info("MAVSDK connection state: %s", "connected" if state.is_connected else "disconnected")

    async def watch_liveness(self) -> None:
        while True:
            alive = time.monotonic() - self.last_telemetry < TELEMETRY_TIMEOUT_S
            if alive != self.px4_connected:
                self.px4_connected = alive
                if alive:
                    await self.on_px4_connected()
                else:
                    log.warning("No telemetry from PX4 for %.0f s: treating it as disconnected", TELEMETRY_TIMEOUT_S)
                self.broadcast_status()
            await asyncio.sleep(0.5)

    async def on_px4_connected(self) -> None:
        try:
            v = await self.drone.info.get_version()
            self.px4_version = f"{v.flight_sw_major}.{v.flight_sw_minor}.{v.flight_sw_patch}"
        except Exception:  # noqa: BLE001
            self.px4_version = None
        log.info("PX4 connected (version %s)", self.px4_version)
        asyncio.create_task(self.upload_geofence())
        asyncio.create_task(self.setup_return())
        t = self.drone.telemetry
        for setter in (t.set_rate_position, t.set_rate_attitude_euler, t.set_rate_velocity_ned):
            try:
                await setter(RATE_HZ)
            except Exception as e:  # noqa: BLE001 - some rates aren't settable in every PX4 build
                log.debug("Could not set telemetry rate: %s", e)

    def load_fence_points(self) -> list[tuple[float, float]]:
        """Outer ring of the fence polygon as (lat, lon), without GeoJSON's repeated closing point."""
        with open(FENCE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        geom = data["features"][0]["geometry"]
        ring = geom["coordinates"][0] if geom["type"] == "Polygon" else max(geom["coordinates"], key=lambda p: len(p[0]))[0]
        if len(ring) > 1 and ring[0] == ring[-1]:
            ring = ring[:-1]
        if len(ring) > PX4_MAX_FENCE_POINTS:
            raise ValueError(f"fence has {len(ring)} points; PX4 holds at most {PX4_MAX_FENCE_POINTS}")
        return [(lat, lon) for lon, lat, *_ in ring]

    async def upload_geofence(self) -> None:
        g = self.geofence
        g.update(uploaded=False, error=None)
        try:
            points = self.load_fence_points()
            await self.drone.geofence.upload_geofence(
                GeofenceData(polygons=[Polygon([Point(lat, lon) for lat, lon in points], FenceType.INCLUSION)], circles=[])
            )
            await self.drone.param.set_param_float("GF_MAX_VER_DIST", FENCE_CEILING_M)
            await self.drone.param.set_param_int("GF_ACTION", FENCE_ACTION_RETURN)
            g.update(source=os.path.basename(FENCE_FILE), points=len(points), uploaded=True)
            log.info("Geofence uploaded: %d-point City of Toronto boundary, %.0f m ceiling, breach → Return", len(points), FENCE_CEILING_M)
        except FileNotFoundError:
            g["error"] = f"{FENCE_FILE} not found (run `npm run data` in frontend/)"
            log.warning("No geofence: %s", g["error"])
        except Exception as e:  # noqa: BLE001
            g["error"] = str(e)
            log.warning("Geofence upload failed: %s", e)
        self.broadcast_status()

    async def setup_return(self) -> None:
        """Return home always climbs to the return height (no cone), starting high and safe."""
        self.return_alt = None
        try:
            await self.drone.param.set_param_int("RTL_CONE_ANG", 0)
            await self.set_return_alt(RETURN_ALT_DEFAULT_M)
            log.info("Return home: cone off, %.0f m until the app sends a building-aware height", RETURN_ALT_DEFAULT_M)
        except Exception as e:  # noqa: BLE001
            log.warning("Could not set up Return home: %s", e)

    async def set_return_alt(self, rel_alt_m: float) -> None:
        alt = round(max(RETURN_ALT_MIN_M, min(RETURN_ALT_MAX_M, rel_alt_m)), 1)
        if alt == self.return_alt:
            return
        await self.drone.action.set_return_to_launch_altitude(alt)
        log.debug("Return height %.0f m", alt)
        self.return_alt = alt
        self.broadcast_status()

    async def watch_position(self) -> None:
        async for p in self.drone.telemetry.position():
            self.last_telemetry = time.monotonic()
            self.s.update(lat=p.latitude_deg, lon=p.longitude_deg, altAmslM=p.absolute_altitude_m, relAltM=p.relative_altitude_m)
            self.have_position = not math.isnan(p.latitude_deg)

    async def watch_attitude(self) -> None:
        async for a in self.drone.telemetry.attitude_euler():
            self.last_telemetry = time.monotonic()
            self.s.update(headingDeg=a.yaw_deg % 360, rollDeg=a.roll_deg, pitchDeg=a.pitch_deg)

    async def watch_velocity(self) -> None:
        async for v in self.drone.telemetry.velocity_ned():
            self.s.update(groundSpeedMs=math.hypot(v.north_m_s, v.east_m_s), climbRateMs=-v.down_m_s)

    async def watch_battery(self) -> None:
        async for b in self.drone.telemetry.battery():
            pct = b.remaining_percent
            if not math.isnan(pct):
                # MAVSDK ≥2 reports 0–100; older versions reported 0–1.
                self.s["battery"] = max(0.0, min(1.0, pct / 100 if pct > 1 else pct))

    async def watch_armed(self) -> None:
        async for armed in self.drone.telemetry.armed():
            self.s["armed"] = armed

    async def watch_in_air(self) -> None:
        async for in_air in self.drone.telemetry.in_air():
            self.s["inAir"] = in_air

    async def watch_flight_mode(self) -> None:
        async for mode in self.drone.telemetry.flight_mode():
            self.s["flightMode"] = FLIGHT_MODE_LABELS.get(mode.name, mode.name.replace("_", " ").title())
            # PX4 left offboard on its own (failsafe, another ground station, …): stop streaming.
            settled = time.monotonic() - self.offboard_started_at > OFFBOARD_MODE_GRACE_S
            if self.offboard_active and not self.offboard_starting and settled and mode.name != "OFFBOARD":
                log.info("PX4 left offboard on its own (now %s); keyboard paused until keys are released", mode.name)
                self.offboard_active = False
                self.offboard_blocked = True
                broadcast(
                    self.clients,
                    json.dumps(
                        {
                            "type": "notice",
                            "level": "error",
                            "message": f"PX4 took over ({self.s['flightMode']}), e.g. geofence or failsafe. "
                            "Release the keys, then press again to fly.",
                        }
                    ),
                )

    async def watch_home(self) -> None:
        async for h in self.drone.telemetry.home():
            self.s["home"] = {"lat": h.latitude_deg, "lon": h.longitude_deg, "altAmslM": h.absolute_altitude_m}

    async def run_command(self, action: str, msg: dict) -> None:
        a = self.drone.action
        if action == "returnAlt":
            # A setting, not a flight command: leave keyboard flying alone.
            await self.set_return_alt(float(msg["relAltM"]))
            return
        # Any explicit command takes over from keyboard flying (a deliberate switch, so no block).
        self.offboard_active = False
        self.offboard_blocked = False
        if action == "takeoff":
            alt = float(msg.get("altitudeM") or DEFAULT_TAKEOFF_ALT_M)
            alt = max(2.0, min(MAX_TAKEOFF_ALT_M, alt))
            await a.set_takeoff_altitude(alt)
            if not self.s["armed"] and self.s["flightMode"] == "Offboard":
                # Landed while keyboard flying: PX4 won't arm in offboard once the setpoint
                # stream has stopped ("offboard signal lost"), so switch to Hold first.
                await a.hold()
                await asyncio.sleep(0.5)
            if not self.s["armed"]:
                await a.arm()
            await a.takeoff()
        elif action == "land":
            await a.land()
        elif action == "rtl":
            await a.return_to_launch()
        elif action == "hold":
            await a.hold()
        elif action == "arm":
            await a.arm()
        elif action == "disarm":
            await a.disarm()
        elif action == "crash":
            # Hit a building: motors off, like a real crash. PX4's physics drops the drone.
            if self.s["armed"]:
                await a.kill()
        elif action == "reset":
            await self.reset_px4()
        elif action == "goto":
            if not self.s["inAir"]:
                raise ValueError("Take off first")
            lat, lon = float(msg["lat"]), float(msg["lon"])
            home = self.s["home"] or {"altAmslM": self.s["altAmslM"] - self.s["relAltM"]}
            rel = msg.get("relAltM")
            rel = self.s["relAltM"] if rel is None else max(5.0, min(MAX_TAKEOFF_ALT_M, float(rel)))
            # NaN yaw: let PX4 face the direction of travel.
            await a.goto_location(lat, lon, home["altAmslM"] + rel, math.nan)
        else:
            raise ValueError(f"Unknown action: {action}")

    async def reset_px4(self) -> None:
        """Restart PX4 so the drone is back on the ground at home (e.g. after a crash)."""
        if self.resetting:
            raise ValueError("Already resetting")
        self.resetting = True
        self.broadcast_status()
        try:
            if self.s["armed"]:
                await self.drone.action.kill()
                await asyncio.sleep(1)
            requested = time.monotonic()
            # PX4 SITL can't reboot itself, but it can shut down; Docker then starts it again.
            await self.drone.action.shutdown()
            log.info("Reset: PX4 shutting down, waiting for it to come back")
            await asyncio.sleep(2)
            deadline = requested + 60
            while self.last_telemetry < requested + 2:
                if time.monotonic() > deadline:
                    raise TimeoutError("PX4 did not come back within 60 s (is its container's restart policy set?)")
                await asyncio.sleep(0.5)
            await self.on_px4_connected()  # fresh PX4: telemetry rates + geofence again
            log.info("Reset: PX4 is back")
        finally:
            self.resetting = False
            self.broadcast_status()

    # --- keyboard flying (offboard velocity) ----------------------------------

    def on_velocity(self, ws: ServerConnection, msg: dict) -> None:
        def num(key: str, limit: float) -> float:
            v = msg.get(key, 0)
            v = float(v) if isinstance(v, (int, float)) and math.isfinite(v) else 0.0
            return max(-limit, min(limit, v))

        self.velocity = (
            num("forwardMs", MAX_SPEED_MS),
            num("rightMs", MAX_SPEED_MS),
            num("downMs", MAX_CLIMB_MS),
            num("yawRateDegS", MAX_YAW_RATE_DEG_S),
        )
        now = time.monotonic()
        idle_before = now - self.velocity_at
        self.velocity_at = now
        if self.offboard_blocked:
            # Unblock on release: zeros (the app sends them on key-up) or a gap in input.
            if not any(self.velocity) or idle_before > VELOCITY_STALE_S:
                self.offboard_blocked = False
            if self.offboard_blocked or not any(self.velocity):
                return
        # Only real input takes control. The app sends a few zeros when keys are released;
        # those must not restart offboard and override a command (e.g. a fly-to) sent meanwhile.
        if not self.offboard_active and not self.offboard_starting and any(self.velocity):
            if not self.px4_connected:
                return
            if not self.s["inAir"]:
                self.notify(ws, "Take off first, then fly with the keyboard")
                return
            asyncio.create_task(self.start_offboard(ws))

    async def start_offboard(self, ws: ServerConnection) -> None:
        self.offboard_starting = True
        try:
            # PX4 only accepts offboard once it's receiving setpoints.
            await self.drone.offboard.set_velocity_body(VelocityBodyYawspeed(0, 0, 0, 0))
            await self.drone.offboard.start()
            self.offboard_started_at = time.monotonic()
            self.offboard_active = True
            log.info("Keyboard flying: offboard started")
            asyncio.create_task(self.stream_offboard())
        except Exception as e:  # noqa: BLE001
            log.warning("Offboard start failed: %s", e)
            self.notify(ws, f"Couldn't start keyboard flying: {e}")
        finally:
            self.offboard_starting = False

    async def stream_offboard(self) -> None:
        interval = 1 / OFFBOARD_RATE_HZ
        while self.offboard_active:
            idle = time.monotonic() - self.velocity_at
            try:
                if idle > OFFBOARD_IDLE_S:
                    log.info("Keyboard flying: no input for %.0f s, switching to Hold", OFFBOARD_IDLE_S)
                    self.offboard_active = False
                    self.offboard_blocked = False
                    await self.drone.action.hold()
                    break
                v = self.velocity if idle <= VELOCITY_STALE_S else (0.0, 0.0, 0.0, 0.0)
                await self.drone.offboard.set_velocity_body(VelocityBodyYawspeed(*v))
            except Exception as e:  # noqa: BLE001
                log.warning("Offboard setpoint failed: %s", e)
            await asyncio.sleep(interval)

    def notify(self, ws: ServerConnection, message: str) -> None:
        asyncio.create_task(self.safe_send(ws, json.dumps({"type": "notice", "level": "error", "message": message})))

    async def safe_send(self, ws: ServerConnection, text: str) -> None:
        try:
            await ws.send(text)
        except ConnectionClosed:
            pass

    # --- browser side ---------------------------------------------------------

    def status_message(self) -> str:
        return json.dumps(
            {
                "type": "status",
                "px4Connected": self.px4_connected,
                "px4Version": self.px4_version,
                "geofence": self.geofence,
                "returnAltM": self.return_alt,
                "resetting": self.resetting,
            }
        )

    def broadcast_status(self) -> None:
        broadcast(self.clients, self.status_message())

    async def handle_client(self, ws: ServerConnection) -> None:
        self.clients.add(ws)
        log.info("Client connected (%d total)", len(self.clients))
        try:
            await ws.send(self.status_message())
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "command":
                    asyncio.create_task(self.handle_command(ws, msg))
                elif msg.get("type") == "velocity":
                    self.on_velocity(ws, msg)
        except ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            log.info("Client disconnected (%d left)", len(self.clients))

    async def handle_command(self, ws: ServerConnection, msg: dict) -> None:
        action = str(msg.get("action", ""))
        reply = {"type": "ack", "id": msg.get("id"), "ok": True, "error": None}
        if not self.px4_connected:
            reply.update(ok=False, error="PX4 is not connected")
        else:
            try:
                (log.debug if action == "returnAlt" else log.info)("Command: %s", action)
                await self.run_command(action, msg)
            except Exception as e:  # noqa: BLE001 - report PX4's refusal back to the user
                log.warning("Command %s failed: %s", action, e)
                reply.update(ok=False, error=str(e))
        try:
            await ws.send(json.dumps(reply))
        except ConnectionClosed:
            pass

    async def broadcast_state(self) -> None:
        interval = 1 / RATE_HZ
        while True:
            if self.clients and self.px4_connected and self.have_position:
                state = {**self.s, "timeMs": time.monotonic() * 1000}
                if state["home"] is None:  # until PX4 reports home, use the current position
                    state["home"] = {"lat": state["lat"], "lon": state["lon"], "altAmslM": state["altAmslM"] - state["relAltM"]}
                broadcast(self.clients, json.dumps({"type": "state", "state": clean(state)}, allow_nan=False))
            await asyncio.sleep(interval)


async def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    bridge = Bridge()
    async with serve(bridge.handle_client, WS_HOST, WS_PORT):
        log.info("WebSocket listening on ws://%s:%d", WS_HOST, WS_PORT)
        await bridge.run_px4()
        await bridge.broadcast_state()


if __name__ == "__main__":
    asyncio.run(main())
