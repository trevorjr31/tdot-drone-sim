# TDot Drone Sim

A drone simulator set in a 3D City of Toronto.

| Part | What it is | Where |
|---|---|---|
| Frontend | React + TypeScript + CesiumJS: photorealistic 3D Toronto, City of Toronto data layers, place search | [frontend/](frontend/) |
| Flight sim | PX4 autopilot in software-in-the-loop mode with PX4's built-in physics (SIH), in Docker | [sim/px4/](sim/px4/), [docker-compose.yml](docker-compose.yml) |
| Bridge | Python + MAVSDK: PX4 telemetry → WebSocket for the app, commands back to PX4 | [sim/bridge/](sim/bridge/) |

## Frontend

See [frontend/README.md](frontend/README.md). In short:

```bash
cd frontend
npm install
cp .env.example .env.local   # add VITE_CESIUM_ION_TOKEN
npm run data                 # download + prepare City of Toronto data
npm run dev                  # http://localhost:5173
npm test                     # unit tests (Vitest)
```

Requires Node 20.19+ (see [frontend/.nvmrc](frontend/.nvmrc)).

## Flight sim (PX4 SITL)

Needs Docker Desktop. The image is built from Ubuntu 22.04 with PX4 v1.16.2, so it
runs natively on Apple Silicon and x86. PX4 runs headless with its built-in physics
(SIH); the 3D view is the React app. The build has two stages: PX4 is compiled in a
throwaway stage, and the image you run holds only the compiled simulator (~180 MB).
PX4's onboard flight logging is off by default (it writes gigabytes per session); set
`PX4_LOGGING=1` on the `px4` service to turn it on (logs land in `/px4/log`).

```bash
docker compose build         # first time only (PX4: clone + deps + compile; compile ~1 min on an M2)
docker compose up -d         # start PX4 (home: Nathan Phillips Square) + the bridge
docker compose logs -f       # PX4 and bridge output
docker compose down          # stop
```

Then open the app: the **Drone** panel's status turns green once it's connected, and
**Take off / Hold / Return / Land** command PX4 while the 3D view and HUD follow its
telemetry. (The app needs PX4 and the bridge running; there's no offline demo.) The bridge listens on `ws://localhost:8765` (localhost only).

Home position is set with `PX4_HOME_LAT` / `PX4_HOME_LON` / `PX4_HOME_ALT` (metres
above sea level) in [docker-compose.yml](docker-compose.yml).

### Crash and reset

PX4 doesn't know about buildings, so the app detects collisions (see
[frontend/README.md](frontend/README.md)) and sends `crash`: the bridge cuts the motors
and PX4's physics drops the drone. `reset` restarts PX4: the bridge sends a MAVLink
shutdown (PX4 SITL can't reboot itself), Docker's `restart: unless-stopped` starts it
again at home, and the bridge re-uploads the geofence. For this, the **bridge owns the
Docker network** and PX4 joins it (`network_mode: service:bridge`), so PX4 restarting
doesn't take the bridge's network down.

Don't run `bridge_test.py` with the app open: the app's collision check would react to
the test drone (and could cut its motors).

### Geofence

Whenever PX4 (re)connects, the bridge uploads the City of Toronto boundary as an
inclusion geofence and sets a **120 m ceiling** above home (the drone limit is 122 m), with
**Return** as the breach action. PX4 enforces it itself, with or without a browser open.
The fence comes from `frontend/public/data/toronto/boundary-fence.geojson` (made by
`npm run data`, mounted read-only into the bridge). PX4 stores at most 64 fence points,
so the boundary is simplified to ~50 points, within about 500 m of the true line.

If PX4 takes over while you're flying with the keyboard (geofence, failsafe), the bridge
won't take control back until the keys are released, since re-entering offboard would
count as a pilot takeover and cancel PX4's failsafe.

### Smoke tests

Both check home is in Toronto, take off to 20 m and land. `flight_test.py` talks to PX4
directly over MAVLink; `bridge_test.py` goes through the bridge's WebSocket exactly as the
browser does: it checks the geofence is loaded and the 20 Hz state rate, flies forward
with keyboard-style velocity messages, checks the hover and hand-back to Hold, flies to a
point 60 m north, climbs into the 120 m ceiling and checks PX4 switches to Return, then
crashes (motors cut: it must fall and disarm) and resets (back at home, geofence re-uploaded):

```bash
docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
  python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/flight_test.py"

docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
  python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/bridge_test.py"
```

They use `mavsdk-grpc`, MAVSDK-Python's established API (the plain `mavsdk` package
switched to a different native API in v4). They run inside PX4's network namespace
because PX4 only sends MAVLink to localhost by default; the bridge does the same via
`network_mode: service:px4`. The bridge uses PX4's API link (UDP 14540) and the flight
test its ground-station link (14550), so both can run at once.

### How the pieces connect

```
PX4 SITL ──MAVLink/UDP──▶ bridge (MAVSDK) ──WebSocket──▶ React + Cesium app
         ◀── commands ───                  ◀── commands ──
```

WebSocket protocol (see [sim/bridge/bridge.py](sim/bridge/bridge.py)):

| Direction | Message |
|---|---|
| bridge → app | `{"type":"status","px4Connected":true,"px4Version":"1.16.2","geofence":{…}}` on connect and on change |
| bridge → app | `{"type":"state","state":{…}}` at 20 Hz, same fields as the app's `DroneState` |
| app → bridge | `{"type":"command","id":"…","action":"takeoff","altitudeM":30}` (`takeoff`, `land`, `rtl`, `hold`, `arm`, `disarm`, `goto` with `lat`/`lon`/optional `relAltM`, `crash`, `reset`) |
| bridge → app | `{"type":"ack","id":"…","ok":false,"error":"…"}` with PX4's reason if refused |
| app → bridge | `{"type":"velocity","forwardMs":5,"rightMs":0,"downMs":0,"yawRateDegS":0}` ~10 Hz while keys are held (keyboard flying; body frame, down positive) |
| bridge → app | `{"type":"notice","level":"error","message":"…"}` e.g. "Take off first" |

Keyboard flying uses PX4's offboard mode: the bridge streams the latest velocity at
20 Hz, hovers if input goes stale (0.5 s) and hands back to PX4 Hold after 3 s without
input (e.g. the tab was closed). Only non-zero input takes control, so the zeros sent
on key release can't override a command sent meanwhile.

## CI

GitHub Actions ([.github/workflows](.github/workflows)):

| Workflow | Runs on | Does |
|---|---|---|
| Frontend | changes under `frontend/` | lint, type-check, unit tests, production build |
| Flight sim | changes under `sim/` or `docker-compose.yml`, or manually | builds PX4 + bridge, fetches the geofence boundary, runs both smoke tests |

Dependabot opens weekly update PRs for npm, pip, the Docker base image and the Actions.
