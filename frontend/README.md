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
| City boundary for PX4's geofence (~50 points) | `boundary-fence.geojson` |
| 3D Massing (~430k buildings, newest year) | `massing/{col}_{row}.json` in ~1 km grid tiles + `massing/index.json` (~145 MB total) |
| Address Points (~525k civic addresses) | joined into the massing tiles (no file of its own) |

The massing step takes ~30 s and needs a few GB of RAM. It also downloads the City's
address points (~175 MB CSV) and gives each building the addresses inside its footprint;
a point on no footprint (many sit mid-lot) goes to the nearest building within 15 m that
has no address of its own. About 93% of buildings end up with an address, plus a place
name where the City has one (e.g. "Old City Hall") and the ward. The grid is defined once in
[src/data/massingGrid.ts](src/data/massingGrid.ts) and shared by the script and the app,
which loads tiles within ~2.5 km of the camera.

City elevations are metres above sea level; Cesium uses the WGS84 ellipsoid. The
conversion (`TORONTO_GEOID_OFFSET_M` in [src/config.ts](src/config.ts)) was measured
against Google's 3D Tiles.

The app reads data only through [src/data/torontoData.ts](src/data/torontoData.ts),
so it can later point at a backend instead.

## Search

The search box lives in the Drone panel's **Plan a route** step (press **/** to focus it
there). It finds addresses, intersections, landmarks
and the City's 158 neighbourhoods:

- Neighbourhoods and saved places match instantly as you type (local data).
- Addresses and landmarks come from Google's geocoder via Cesium ion (required by
  Google's terms when using its 3D Tiles), after a short pause or on Enter. Queries are
  pinned to Toronto; results far outside it are dropped, and ones outside the City
  boundary are tagged.
- A chosen result becomes the route's destination and drops a pin; the camera stays on
  the drone.
- Saved places live in [src/places/presets.ts](src/places/presets.ts). Most are
  defined by name/address and looked up once per browser; recent searches are remembered.

## Drone

The drone is PX4, via the bridge: start them with `docker compose up -d` at the repo root
(see the top-level README). The app connects on start and keeps retrying, so the bridge
can start before or after it; the **Drone** panel shows the connection status. Override
the address with `VITE_BRIDGE_URL`. Telemetry arrives as a
[`DroneState`](src/drone/types.ts).

- **Before a flight** the panel shows the status, the geofence and two choices:
  - **Free fly**: takes off straight away (to 30 m) and goes to the controls.
  - **Plan a route**: choose a destination (*Pick on map*, or search for a place),
    then set the **height** and **Take off**. The drone climbs to that height and flies
    to the destination on autopilot: the panel shows its progress and a single
    **Take over controls** button, which stops the autopilot (PX4 holds where it is) and
    switches to the manual controls below. *Back* returns to the choice.

  After landing (or Reset after a crash) the panel returns to this choice. Refusals
  (e.g. pre-arm checks failing) show in the panel.
- **In flight** (free fly, or after taking over): **Hold**, **Return** and **Land**, plus
  **keyboard flying**: **W/S** (or ↑/↓) forward/back, **A/D** slide, **←/→** (or Q/E)
  turn, **Space/Shift** up/down. The bridge puts PX4 in offboard mode and streams the
  velocity; letting go hovers, and after 3 s idle PX4 is handed back to Hold.
  **Plan a route** at the bottom opens the route planner in the air: choose a destination
  and height, then **Fly there** hands over to the autopilot (it climbs or descends to
  that height on the way). *Back* returns to the controls.
- **Camera**: always a chase camera on the drone. It starts behind and above it and swings
  round to stay behind as it turns; **drag** to rotate around the drone, **scroll** to zoom
  (3 m to 30 km), straight through any building in the way. Your angle and zoom are kept as it flies. There's no free camera or Home
  button for now.
- **HUD** (bottom-right): height above whatever is below (ground or roof), altitude above
  sea level, speed, climb, heading, distance from home, battery, flight mode, armed state,
  and a warning above Transport Canada's 122 m (400 ft) limit.
- The model is drawn 4× real size so it's visible from the chase camera; a red dot marks
  it from far away, a dashed line drops to the ground, and a yellow trail shows the path.
- **Building collisions**: every state is checked against City massing footprints near the
  drone (tiles load around it; the massing is never drawn on the map). Inside a
  footprint and below its roof (the building's highest point), or within 2.5 m of its wall,
  is a **crash**. The impact point is where the drone's path met the wall (found by
  bisecting between the last two samples), so it never goes inside. The drone tumbles and
  falls from there onto whatever is below in the 3D scene and lies there as a wreck; with
  PX4 the motors are cut (flight termination). **Reset drone** in the panel restarts PX4
  with the drone back at home.

  The 2.5 m margin covers half the drawn drone (it's 4× size) plus the usual 1–2 m
  difference between City footprints and Google's 3D buildings. The HUD's **Building**
  readout gives the distance to the nearest building at the drone's height (amber under
  15 m, red under 5 m). PX4's own physics still doesn't know about buildings.
- The panel shows the geofence status (see the top-level README).

In dev builds `window.viewer` and `window.tdot` (`{ px4, droneView }`) are available in
the browser console for debugging.

## Controls

Drag rotates around the drone, scroll zooms. Click a neighbourhood or
building for details: the card opens folded to just its title (the name or address);
the ▸ button, or a click on the title, shows the details.

The map is always the photorealistic 3D city. **Settings** (the gear, top-right) has the **Layers** toggles for
the two overlays, **N** neighbourhoods and **B** city boundary; your choices are
remembered in this browser. The City 3D Massing data is never drawn: it runs in the
background for building collisions, the HUD's building distance, and click info.

Clicking works at any zoom: on a building you get its name (or address) as the title,
its addresses, neighbourhood, ward and heights from the City footprint under the click; anywhere else you get the neighbourhood.
Buildings are matched by footprint only, because from far away the clicked 3D position
is too imprecise vertically to tell a roof from the ground.

Contains information licensed under the Open Government Licence – Toronto.
