# TDot Drone Sim

A drone simulator set in a 3D City of Toronto.

| Part | What it is | Where |
|---|---|---|
| Frontend | React + TypeScript + CesiumJS: photorealistic 3D Toronto, City of Toronto data layers, place search | [frontend/](frontend/) |
| Flight sim | PX4 autopilot in software-in-the-loop mode with PX4's built-in physics (SIH), in Docker | [sim/](sim/), [docker-compose.yml](docker-compose.yml) |

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
docker compose build px4     # first time only (clone + deps + compile; compile ~1 min on an M2)
docker compose up -d px4     # start PX4 (home: Nathan Phillips Square)
docker compose logs -f px4   # PX4 console output
docker compose down          # stop
```

Home position is set with `PX4_HOME_LAT` / `PX4_HOME_LON` / `PX4_HOME_ALT` (metres
above sea level) in [docker-compose.yml](docker-compose.yml).

### Smoke test

Connects with MAVSDK, checks home is in Toronto, then arms, takes off to 20 m,
hovers and lands:

```bash
docker run --rm --network container:tdot-px4 -v "$PWD/sim/tools:/tools:ro" \
  python:3.12-slim sh -c "pip install -q -r /tools/requirements.txt && python /tools/flight_test.py"
```

It uses `mavsdk-grpc`, MAVSDK-Python's established API (the plain `mavsdk` package
switched to a different native API in v4). It runs inside PX4's network namespace
because PX4 only sends MAVLink to localhost by default.

### How the pieces will connect

```
PX4 SITL ──MAVLink/UDP──▶ bridge (MAVSDK) ──WebSocket──▶ React + Cesium app
         ◀── commands ───                  ◀── commands ──
```

The bridge is next: it turns PX4 telemetry into a WebSocket feed the app can draw,
and passes the app's commands (arm, take off, fly, land) back to PX4.

## CI

GitHub Actions ([.github/workflows](.github/workflows)):

| Workflow | Runs on | Does |
|---|---|---|
| Frontend | changes under `frontend/` | lint, type-check, unit tests, production build |
| Flight sim | changes under `sim/` or `docker-compose.yml`, or manually | builds the PX4 image and runs the flight test above |

Dependabot opens weekly update PRs for npm, pip, the Docker base image and the Actions.
