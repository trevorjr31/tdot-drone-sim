# TDot Drone Sim: frontend

React + TypeScript + Vite app that renders a 3D City of Toronto with CesiumJS.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in VITE_CESIUM_ION_TOKEN
npm run data                 # download + prepare City of Toronto data
npm run dev                  # http://localhost:5173
```

## Keys (`.env.local`, git-ignored)

| Variable | Needed for |
|---|---|
| `VITE_CESIUM_ION_TOKEN` | Cesium imagery/terrain, and Google Photorealistic 3D Tiles via ion |
| `VITE_GOOGLE_MAPS_API_KEY` | Optional. Streams Google 3D Tiles directly from Google instead of ion |

## City of Toronto data

The City's open data API doesn't allow browser requests (no CORS), so
`npm run data` ([scripts/fetch-toronto-data.ts](scripts/fetch-toronto-data.ts))
downloads datasets from open.toronto.ca, trims and simplifies them with mapshaper,
and writes GeoJSON to `public/data/toronto/` (git-ignored). Downloads are cached
in `.data-cache/`; pass `-- --refresh` to re-download.

| Dataset | Output |
|---|---|
| City boundary | `boundary.geojson` |
| Neighbourhoods (158) | `neighbourhoods.geojson` |
| 3D Massing (~430k buildings, newest year) | `massing/{col}_{row}.json` in ~1 km grid tiles + `massing/index.json` (~130 MB total) |

The massing step takes ~20 s and needs a few GB of RAM. The grid is defined once in
[src/data/massingGrid.ts](src/data/massingGrid.ts) and shared by the script and the app,
which loads tiles within ~2.5 km of the camera.

City elevations are metres above sea level; Cesium uses the WGS84 ellipsoid. The
conversion (`TORONTO_GEOID_OFFSET_M` in [src/config.ts](src/config.ts)) was measured
against Google's 3D Tiles.

The app reads data only through [src/data/torontoData.ts](src/data/torontoData.ts),
so it can later point at a backend instead.

## Search

The search box (top-left, or press **/**) finds addresses, intersections, landmarks
and the City's 158 neighbourhoods:

- Neighbourhoods and saved places match instantly as you type (local data).
- Addresses and landmarks come from Google's geocoder via Cesium ion (required by
  Google's terms when using its 3D Tiles), after a short pause or on Enter. Queries are
  pinned to Toronto; results far outside it are dropped, and ones outside the City
  boundary are tagged.
- Results fly to an angled view and drop a pin; neighbourhoods are selected instead.
- Saved places live in [src/places/presets.ts](src/places/presets.ts). Most are
  defined by name/address and looked up once per browser; recent searches are remembered.
- The Home button returns to the downtown view.

## Drone

The **Drone** panel (left) has two sources, both producing the same
[`DroneState`](src/drone/types.ts):

- **Demo flight**: a scripted quadcopter that takes off from Nathan Phillips Square, flies
  west along Queen St W to Trinity Bellwoods and back, then lands (~8 min). No PX4 needed.
- **PX4 (live)**: real PX4 telemetry via the bridge (`docker compose up -d` at the repo
  root; see the top-level README). **Take off** (with height), **Hold**, **Return** and
  **Land** command PX4; refusals (e.g. pre-arm checks failing) show in the panel. The
  connection retries automatically, so the bridge can start before or after the app.
  Override the address with `VITE_BRIDGE_URL`.

The chosen source is remembered in this browser.

- **Cameras** (**C** cycles): *Chase* follows behind, *FPV* is the drone's-eye view,
  *Free* gives the mouse back. Searching for a place or pressing Home switches to Free.
- **HUD** (bottom-right): height above whatever is below (ground or roof), altitude above
  sea level, speed, climb, heading, distance from home, battery, flight mode, armed state,
  and a warning above Transport Canada's 122 m (400 ft) limit.
- The model is drawn 4× real size so it's visible from the chase camera; a red dot marks
  it from far away, a dashed line drops to the ground, and a yellow trail shows the path.
- No collisions yet: the drone can pass through buildings (chunk 4e).

In dev builds `window.viewer` and `window.tdot` (`{ demo, droneView }`) are available in
the browser console for debugging.

## Controls

Left-drag pans, right-drag/scroll zooms, Ctrl+drag tilts. Click a neighbourhood or
building for details.

The **Layers** panel (top-left) toggles each layer; your choices are remembered in
this browser. Shortcuts: **G** photorealistic 3D, **M** building massing,
**N** neighbourhoods, **B** city boundary. With photorealistic 3D off, the map shows
Cesium terrain and satellite imagery, and the overlays drape onto that instead.

Contains information licensed under the Open Government Licence – Toronto.
