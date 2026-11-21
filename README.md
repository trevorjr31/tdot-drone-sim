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
(SIH); the 3D view will be the React app.

```bash
docker compose build         # first time only (PX4: clone + deps + compile; compile ~1 min on an M2)
docker compose up -d         # start PX4 (home: Nathan Phillips Square) + the bridge
docker compose logs -f       # PX4 and bridge output
docker compose down          # stop
```

Then in the app's **Drone** panel choose **PX4 (live)**: the status turns green, and
**Take off / Hold / Return / Land** command PX4 while the 3D view and HUD follow its
telemetry. The bridge listens on `ws://localhost:8765` (localhost only).

Home position is set with `PX4_HOME_LAT` / `PX4_HOME_LON` / `PX4_HOME_ALT` (metres
above sea level) in [docker-compose.yml](docker-compose.yml).

### Smoke tests

Both check home is in Toronto, take off to 20 m and land. `flight_test.py` talks to PX4
directly over MAVLink; `bridge_test.py` goes through the bridge's WebSocket exactly as the
browser does (and checks the 20 Hz state rate):

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
| bridge → app | `{"type":"status","px4Connected":true,"px4Version":"1.16.2"}` on connect and on change |
| bridge → app | `{"type":"state","state":{…}}` at 20 Hz, same fields as the app's `DroneState` |
| app → bridge | `{"type":"command","id":"…","action":"takeoff","altitudeM":30}` (`takeoff`, `land`, `rtl`, `hold`, `arm`, `disarm`) |
| bridge → app | `{"type":"ack","id":"…","ok":false,"error":"…"}` with PX4's reason if refused |

## CI

GitHub Actions ([.github/workflows](.github/workflows)):

| Workflow | Runs on | Does |
|---|---|---|
| Frontend | changes under `frontend/` | lint, type-check, unit tests, production build |
| Flight sim | changes under `sim/` or `docker-compose.yml`, or manually | builds PX4 + bridge and runs both smoke tests |

Dependabot opens weekly update PRs for npm, pip, the Docker base image and the Actions.
