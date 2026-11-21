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

## Controls

Left-drag pans, right-drag/scroll zooms, Ctrl+drag tilts. Click a neighbourhood or
building for details.

The **Layers** panel (top-left) toggles each layer; your choices are remembered in
this browser. Shortcuts: **G** photorealistic 3D, **M** building massing,
**N** neighbourhoods, **B** city boundary. With photorealistic 3D off, the map shows
Cesium terrain and satellite imagery, and the overlays drape onto that instead.

Contains information licensed under the Open Government Licence – Toronto.
