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

The app reads that data only through [src/data/torontoData.ts](src/data/torontoData.ts),
so it can later point at a backend instead.

Contains information licensed under the Open Government Licence – Toronto.
