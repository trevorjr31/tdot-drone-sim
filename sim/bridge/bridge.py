"""
PX4 ⇄ browser bridge.

Browsers can't speak MAVLink over UDP, so this service connects to PX4 with
MAVSDK and exposes a WebSocket the React app talks to:

  server → client  {"type": "status", "px4Connected": bool, "px4Version": str|null, "geofence": {...},
                    "returnAltM": number|null, "config": {...SimConfig}}
                   {"type": "state",  "state": {...DroneState...}}        (RATE_HZ)
                   {"type": "ack",    "id": str, "ok": bool, "error": str|null}
                   {"type": "notice", "level": "error", "message": str}   (e.g. offboard refused)
  client → server  {"type": "command", "id": str,
                    "action": "takeoff"|"land"|"rtl"|"hold"|"arm"|"disarm"|"goto"|"crash"|"reset"|"returnAlt"|"config",
                    "altitudeM"?: number, "lat"?: number, "lon"?: number, "relAltM"?: number,
                    "config"?: {...some SimConfig fields}}
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
it return lower near home) and sets a high default (5 m under the ceiling); while the app
is open it sends "returnAlt" with a height that clears the buildings between the drone
and home (it has the City building data). Unlike other commands, "returnAlt" doesn't
interrupt keyboard flying.

Sim config: speeds, battery behaviour, the geofence ceiling and breach action, and what
happens after a return (CONFIG_SPEC) are set from the app's Settings with the "config"
command. The bridge validates them, saves them to CONFIG_FILE (so they survive restarts)
and applies them to PX4's parameters, now and on every PX4 (re)connect. Unlike other
commands, "config" works while PX4 is away (applied when it's back) and doesn't
interrupt keyboard flying.

Setting PX4's parameters: PX4 saves its parameters to a file after every change, and a
change that lands while it's saving makes the save fail its check; once, that froze
PX4's MAVLink for good. The battery drain changes about once a second in flight, so the
bridge never changes parameters the normal way: it sets them as PX4's *defaults* through
the MAVLink shell (`param set-default`), which takes effect straight away and is never
saved. On connect it clears any saved values for these parameters once (`param reset`),
so the defaults apply, and it sets them all again on every connect anyway.

Battery: PX4's simulated battery drains at a set rate while armed (SIM_BAT_DRAIN, the
seconds from full to empty) and refills on disarm. By default it stops at 50%, so the
bridge lets it run down to 0% and sets PX4's low-battery responses: a warning at 25%,
Return at 15%, and landing where it is at 5% (BATTERY_*_THR; the app's warnings use the
same levels). PX4's simulation knows nothing about load, so the bridge updates the drain
rate about once a second from what the drone is doing (drain_factor): `batteryMin`
minutes of hovering, less idling on the ground or descending, more climbing or flying fast.
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
from mavsdk_grpc.shell import Device
from websockets.asyncio.server import ServerConnection, broadcast, serve
from websockets.exceptions import ConnectionClosed

MAVLINK_URL = os.environ.get("MAVLINK_URL", "udpin://0.0.0.0:14540")
WS_HOST = os.environ.get("WS_HOST", "0.0.0.0")
WS_PORT = int(os.environ.get("WS_PORT", "8765"))
RATE_HZ = float(os.environ.get("STATE_RATE_HZ", "20"))
DEFAULT_TAKEOFF_ALT_M = 30.0
# PX4 counts as connected while its telemetry keeps arriving.
TELEMETRY_TIMEOUT_S = 3.0
# Keyboard (offboard velocity) limits and timeouts.
MAX_SPEED_MS = 12.0
MAX_CLIMB_MS = 3.0
MAX_YAW_RATE_DEG_S = 90.0
OFFBOARD_RATE_HZ = 20.0  # PX4 needs setpoints faster than 2 Hz or it fails safe
VELOCITY_STALE_S = 0.5  # no fresh input for this long → hover
OFFBOARD_IDLE_S = 3.0  # no input for this long → leave offboard, PX4 Hold
# Geofence (see module docstring).
FENCE_FILE = os.environ.get("FENCE_FILE", "/data/boundary-fence.geojson")
PX4_MAX_FENCE_POINTS = 63  # PX4 dataman holds 64 fence entries (one is bookkeeping)
# Return home (see module docstring): at most RETURN_BELOW_CEILING_M under the geofence
# ceiling, or the return itself breaches it.
RETURN_BELOW_CEILING_M = 5.0
RETURN_ALT_MIN_M = 20.0
# How often the battery drain rate follows the load, and how much it must change to be re-sent.
BATTERY_LOAD_INTERVAL_S = 1.0
BATTERY_LOAD_MIN_CHANGE = 0.03

# Sim config (see module docstring): name → (type, min, max, default) for numbers,
# (bool, default) or (tuple of choices, default). The app mirrors this in src/drone/simConfig.ts.
CONFIG_FILE = os.environ.get("CONFIG_FILE", "/config/sim-config.json")
CONFIG_SPEC: dict[str, tuple] = {
    # Speeds, m/s: PX4's MPC_XY_CRUISE (fly-to, routes, Return), MPC_Z_V_AUTO_UP/_DN,
    # MPC_TKO_SPEED, MPC_LAND_SPEED; keyboardMs is the app's keyboard flying speed.
    "cruiseMs": (float, 1.0, 12.0, 5.0),
    "climbMs": (float, 0.5, 8.0, 3.0),
    "descendMs": (float, 0.5, 4.0, 1.5),
    "takeoffMs": (float, 0.5, 5.0, 1.5),
    "landMs": (float, 0.2, 2.0, 0.7),
    "keyboardMs": (float, 1.0, 12.0, 6.0),
    # Battery: minutes of hovering from full to empty; whether the drain follows the load;
    # PX4's levels (BAT_LOW_THR, BAT_CRIT_THR, BAT_EMERGEN_THR) and what it does (COM_LOW_BAT_ACT).
    "batteryMin": (float, 2.0, 60.0, float(os.environ.get("BATTERY_FLIGHT_MIN", "20"))),
    "batteryLoad": (bool, True),
    "batteryLowPct": (float, 5.0, 60.0, 25.0),
    "batteryCriticalPct": (float, 3.0, 50.0, 15.0),
    "batteryEmergencyPct": (float, 1.0, 30.0, 5.0),
    "lowBatteryAction": (("return", "land", "warn"), "return"),
    # Geofence: height ceiling above home (GF_MAX_VER_DIST) and what a breach does (GF_ACTION).
    "ceilingM": (float, 20.0, 500.0, float(os.environ.get("FENCE_CEILING_M", "120"))),
    "fenceAction": (("return", "hold", "land", "warn"), "return"),
    # After Return reaches home: land, or hover there (RTL_LAND_DELAY).
    "afterReturn": (("land", "hover"), "land"),
}
# How long to wait for PX4's console prompt after a command.
SHELL_TIMEOUT_S = 3.0
# Every parameter the bridge sets (as defaults, see "Setting PX4's parameters" above).
MANAGED_PARAMS = [
    "MPC_XY_CRUISE", "MPC_Z_VEL_MAX_UP", "MPC_Z_VEL_MAX_DN", "MPC_Z_V_AUTO_UP", "MPC_Z_V_AUTO_DN",
    "MPC_TKO_SPEED", "MPC_LAND_SPEED", "SIM_BAT_DRAIN", "SIM_BAT_MIN_PCT", "BAT_LOW_THR", "BAT_CRIT_THR",
    "BAT_EMERGEN_THR", "GF_MAX_VER_DIST", "RTL_LAND_DELAY", "COM_LOW_BAT_ACT", "GF_ACTION", "RTL_CONE_ANG",
    "RTL_RETURN_ALT",
]
# PX4 values for the choices.
LOW_BATTERY_ACTIONS = {"warn": 0, "land": 2, "return": 3}  # COM_LOW_BAT_ACT (3: Return, then land at emergency)
FENCE_ACTIONS = {"warn": 1, "hold": 2, "return": 3, "land": 5}  # GF_ACTION
AFTER_RETURN = {"land": 0.0, "hover": -1.0}  # RTL_LAND_DELAY


def default_config() -> dict:
    return {k: spec[-1] for k, spec in CONFIG_SPEC.items()}


def validate_config(current: dict, updates: dict) -> dict:
    """`current` with `updates` applied, or ValueError saying what's wrong."""
    if not isinstance(updates, dict):
        raise ValueError("config must be an object")
    new = dict(current)
    for key, value in updates.items():
        spec = CONFIG_SPEC.get(key)
        if spec is None:
            raise ValueError(f"Unknown setting: {key}")
        if spec[0] is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true or false")
        elif isinstance(spec[0], tuple):
            if value not in spec[0]:
                raise ValueError(f"{key} must be one of {', '.join(spec[0])}")
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{key} must be a number")
            if not spec[1] <= value <= spec[2]:
                raise ValueError(f"{key} must be between {spec[1]:g} and {spec[2]:g}")
            value = float(value)
        new[key] = value
    if not new["batteryLowPct"] > new["batteryCriticalPct"] > new["batteryEmergencyPct"]:
        raise ValueError("Battery levels must go low > critical > emergency")
    return new


def load_config() -> dict:
    """Saved config over the defaults; settings that are missing or no longer valid fall back."""
    config = default_config()
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            saved = json.load(f)
        for key, value in saved.items():
            try:
                config = validate_config(config, {key: value})
            except ValueError as e:
                log.warning("Ignoring saved setting %s: %s", key, e)
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("Could not read %s: %s", CONFIG_FILE, e)
    return config


def save_config(config: dict) -> None:
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        tmp = CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
        os.replace(tmp, CONFIG_FILE)
    except Exception as e:  # noqa: BLE001 - still applied, just not kept over a restart
        log.warning("Could not save the sim config to %s: %s", CONFIG_FILE, e)
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


def drain_factor(in_air: bool, climb_ms: float, speed_ms: float) -> float:
    """
    Battery drain relative to hovering (1.0), roughly like a small quadcopter: idling on
    the ground draws little; climbing costs up to twice as much (at 4 m/s); descending a
    bit less; forward flight is slightly cheaper up to ~8 m/s (the rotors get extra lift
    from moving air), then drag makes it dearer.
    """
    if not in_air:
        return 0.3
    f = 1.0
    f += 0.25 * min(climb_ms, 4.0) if climb_ms > 0 else -0.08 * min(-climb_ms, 3.0)
    f += -0.1 * speed_ms / 8 if speed_ms <= 8 else -0.1 + 0.04 * (speed_ms - 8)
    return max(0.3, min(2.5, f))


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
        # Battery drain vs load (see drain_factor): smoothed factor and the last one sent to PX4.
        self.drain_load = 1.0
        self.drain_sent: float | None = None
        self.shell_lock = asyncio.Lock()
        self.shell_prompt = asyncio.Event()
        self.offboard_started_at = 0.0
        # PX4 left offboard on its own (geofence, failsafe, …). Restarting offboard while keys are
        # still held would count as a pilot takeover and cancel PX4's failsafe, so wait for a release.
        self.offboard_blocked = False
        self.resetting = False
        self.config = load_config()
        self.geofence = {"source": None, "points": 0, "ceilingM": self.config["ceilingM"], "uploaded": False, "error": None}
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
        asyncio.create_task(self.follow_battery_load())
        for name, stream in [
            ("position", self.watch_position),
            ("attitude", self.watch_attitude),
            ("velocity", self.watch_velocity),
            ("battery", self.watch_battery),
            ("armed", self.watch_armed),
            ("in_air", self.watch_in_air),
            ("flight_mode", self.watch_flight_mode),
            ("home", self.watch_home),
            ("shell", self.watch_shell),
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
        asyncio.create_task(self.setup_px4())
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
            g.update(source=os.path.basename(FENCE_FILE), points=len(points), uploaded=True)
            log.info("Geofence uploaded: %d-point City of Toronto boundary", len(points))
        except FileNotFoundError:
            g["error"] = f"{FENCE_FILE} not found (run `npm run data` in frontend/)"
            log.warning("No geofence: %s", g["error"])
        except Exception as e:  # noqa: BLE001
            g["error"] = str(e)
            log.warning("Geofence upload failed: %s", e)
        self.broadcast_status()

    @property
    def return_alt_max(self) -> float:
        return self.config["ceilingM"] - RETURN_BELOW_CEILING_M

    async def px4_shell(self, command: str) -> None:
        """
        Runs a command on PX4's console over MAVLink, one at a time: PX4 drops commands sent
        while it's still busy, so wait for its prompt (pxh>) before the next.
        """
        async with self.shell_lock:
            self.shell_prompt.clear()
            await self.drone.shell.send(command, Device.SHELL)
            try:
                await asyncio.wait_for(self.shell_prompt.wait(), SHELL_TIMEOUT_S)
            except TimeoutError:
                log.warning("PX4 console didn't answer: %s", command)

    async def set_param(self, name: str, value: float | int) -> None:
        """Sets a PX4 parameter as its default: effective now, never saved (see the docstring)."""
        text = str(value) if isinstance(value, int) else f"{float(value):.6g}"
        try:
            await self.px4_shell(f"param set-default {name} {text}")
        except Exception as e:  # noqa: BLE001 - no shell: fall back to a normal (saved) change
            log.warning("PX4 shell unavailable (%s); setting %s the normal way", e, name)
            if isinstance(value, int):
                await self.drone.param.set_param_int(name, value)
            else:
                await self.drone.param.set_param_float(name, float(value))

    async def watch_shell(self) -> None:
        """Logs problems PX4's console reports for the bridge's commands."""
        async for out in self.drone.shell.receive():
            text = getattr(out, "data", str(out))
            if "pxh>" in text:
                self.shell_prompt.set()
            for line in text.splitlines():
                if any(w in line.lower() for w in ("error", "failed", "not found", "invalid")):
                    log.warning("PX4 console: %s", line.strip())

    async def setup_px4(self) -> None:
        """On connect: clear saved values, Return always climbs to its height (no cone), starting high; then the sim config."""
        self.return_alt = None
        try:
            # Saved values would override the defaults the bridge sets; one save, before anything flies.
            await self.px4_shell("param reset " + " ".join(MANAGED_PARAMS))
            await self.set_param("RTL_CONE_ANG", 0)
            await self.set_param("SIM_BAT_MIN_PCT", 0.0)  # PX4's default stops at 50%
            await self.set_return_alt(self.return_alt_max)
        except Exception as e:  # noqa: BLE001
            log.warning("Could not set up Return home: %s", e)
        await self.apply_config()

    async def apply_config(self) -> None:
        """Sets PX4's parameters from the sim config (see CONFIG_SPEC)."""
        c = self.config
        floats = [
            ("MPC_XY_CRUISE", c["cruiseMs"]),
            # The auto speeds can't exceed these limits, so raise them along.
            ("MPC_Z_VEL_MAX_UP", max(3.0, c["climbMs"], c["takeoffMs"])),
            ("MPC_Z_VEL_MAX_DN", max(1.5, c["descendMs"], c["landMs"])),
            ("MPC_Z_V_AUTO_UP", c["climbMs"]),
            ("MPC_Z_V_AUTO_DN", c["descendMs"]),
            ("MPC_TKO_SPEED", c["takeoffMs"]),
            ("MPC_LAND_SPEED", c["landMs"]),
            ("SIM_BAT_DRAIN", c["batteryMin"] * 60),
            ("BAT_LOW_THR", c["batteryLowPct"] / 100),
            ("BAT_CRIT_THR", c["batteryCriticalPct"] / 100),
            ("BAT_EMERGEN_THR", c["batteryEmergencyPct"] / 100),
            ("GF_MAX_VER_DIST", c["ceilingM"]),
            ("RTL_LAND_DELAY", AFTER_RETURN[c["afterReturn"]]),
        ]
        ints = [
            ("COM_LOW_BAT_ACT", LOW_BATTERY_ACTIONS[c["lowBatteryAction"]]),
            ("GF_ACTION", FENCE_ACTIONS[c["fenceAction"]]),
        ]
        try:
            for name, value in floats:
                await self.set_param(name, float(value))
            for name, value in ints:
                await self.set_param(name, int(value))
            self.drain_sent = None  # the load loop re-sends the drain rate
            self.geofence["ceilingM"] = c["ceilingM"]
            # A lower ceiling: keep Return under it (the app sends a building-aware height again).
            if self.return_alt is not None and self.return_alt > self.return_alt_max:
                await self.set_return_alt(self.return_alt_max)
            log.info(
                "Sim config applied: cruise %.1f m/s, battery %.0f min (%s), levels %.0f/%.0f/%.0f%% → %s, "
                "ceiling %.0f m → %s, after return %s",
                c["cruiseMs"], c["batteryMin"], "load" if c["batteryLoad"] else "fixed",
                c["batteryLowPct"], c["batteryCriticalPct"], c["batteryEmergencyPct"], c["lowBatteryAction"],
                c["ceilingM"], c["fenceAction"], c["afterReturn"],
            )
        except Exception as e:  # noqa: BLE001
            log.warning("Could not apply the sim config: %s", e)
        self.broadcast_status()

    async def update_config(self, updates: dict) -> None:
        """The app changed settings: check, save and apply them (when PX4 is there)."""
        self.config = validate_config(self.config, updates)
        save_config(self.config)
        if self.px4_connected:
            await self.apply_config()
        else:
            self.geofence["ceilingM"] = self.config["ceilingM"]
            self.broadcast_status()

    async def follow_battery_load(self) -> None:
        """Keeps PX4's simulated drain rate in line with the load (see drain_factor)."""
        while True:
            await asyncio.sleep(BATTERY_LOAD_INTERVAL_S)
            s = self.s
            if not (self.px4_connected and s["armed"]):
                self.drain_load = 1.0
                continue
            if not self.config["batteryLoad"]:
                continue  # fixed rate: apply_config set it
            target = drain_factor(s["inAir"], s["climbRateMs"], s["groundSpeedMs"])
            self.drain_load += 0.4 * (target - self.drain_load)  # smooth over a few seconds
            sent = self.drain_sent
            if sent is not None and abs(self.drain_load - sent) / sent < BATTERY_LOAD_MIN_CHANGE:
                continue
            try:
                await self.set_param("SIM_BAT_DRAIN", self.config["batteryMin"] * 60 / self.drain_load)
                self.drain_sent = self.drain_load
                log.debug("Battery drain ×%.2f", self.drain_load)
            except Exception as e:  # noqa: BLE001 - e.g. PX4 restarting
                log.debug("Could not set the battery drain: %s", e)

    async def set_return_alt(self, rel_alt_m: float) -> None:
        alt = round(max(RETURN_ALT_MIN_M, min(self.return_alt_max, rel_alt_m)), 1)
        if alt == self.return_alt:
            return
        await self.set_param("RTL_RETURN_ALT", alt)
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
            alt = max(2.0, min(self.config["ceilingM"], alt))
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
            rel = self.s["relAltM"] if rel is None else max(5.0, min(self.config["ceilingM"], float(rel)))
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
                "config": self.config,
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
        if action == "config":
            # A setting, not a flight command: works without PX4, leaves keyboard flying alone.
            try:
                await self.update_config(msg.get("config"))
                log.info("Sim config changed: %s", ", ".join(sorted(msg["config"])))
            except Exception as e:  # noqa: BLE001
                reply.update(ok=False, error=str(e))
        elif not self.px4_connected:
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
