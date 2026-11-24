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

- **Before a flight** the panel shows two choices (the connection status is always visible
  in its header, even when collapsed):
  - **Free fly**: takes off straight away (to 30 m) and goes to the controls.
  - **Plan a route**: choose a destination (*Pick on map*, or search for a place; a point
    picked on the map is named after the building there, with a "Building · height" tag, or
    shown as its coordinates if there's no building or it has no name or address); add
    more stops the same way (up to 8) to visit them in order, reorder them with ↑ or
    remove them with ×. Set the **height** to arrive at and **Take off**. The panel shows
    the route's **distance and flight time** (at the sim config's speeds, calibrated in the
    sim) and its **battery**: what's left at the last stop and back home after PX4's Return
    from there. Take off is refused if it would get home with less than the critical level
    (15% by default). The map shows the stops and the path in grey. The drone flies the route on autopilot: the panel shows which
    stop it's heading for, the distance and time to go, and a single **Take over controls**
    button, which stops the autopilot (PX4 holds where it is) and switches to the manual
    controls below. *Back* returns to the choice.
  - **Route safety**: PX4 doesn't know about buildings, so the app checks the straight line
    of each leg against the City massing (a 15 m strip either side) and the panel names the
    tallest building on the way. Each leg is flown at a crossing height 10 m above its
    tallest building (or your height, if higher): the drone changes height straight up or
    down, at the start or over a stop, never on the way, and descends to your height over
    the last stop. A leg that can't be flown straight because a building is too tall to
    clear under the ceiling goes **round** it instead, by the shortest path: the planner
    searches the area for a way that stays 15 m from every building too tall to cross 5 m
    under the ceiling, straightens it into a few turning points, and flies those as hidden
    waypoints (the panel names the building and how much longer the way round is). Take off
    is refused only if there's no way round within 2.5 km, or if your height is too low for
    the last stop itself.

  After landing (or Reset after a crash) the panel returns to this choice. Refusals
  (e.g. pre-arm checks failing) show in the panel.
- **In flight** (free fly, or after taking over): **Hold**, **Return** and **Land**, plus
  **keyboard flying**: **W/S** (or ↑/↓) forward/back, **A/D** slide, **←/→** (or Q/E)
  turn, **Space/Shift** up/down. The bridge puts PX4 in offboard mode and streams the
  velocity; letting go hovers, and after 3 s idle PX4 is handed back to Hold.
  **Plan a route** at the bottom opens the route planner in the air: choose the stops
  and height, then **Fly there** hands over to the autopilot (same route safety; from the
  air it never descends before arriving). *Back* returns to the controls.
  **Return** flies home at a height that clears the buildings in the way (see "Return home
  height" in the top-level README); if none can under the ceiling, the panel warns.
  **Land** over a building asks first: PX4 lands straight down and doesn't know the
  building is there, so the drone would crash onto the roof. *Return home* is offered
  instead.
  **Battery**: the panel warns when it's low (25%: head home), critical (15%: PX4 is
  flying home) and empty (5%: PX4 is landing where it is), with the minutes until PX4
  acts (see "Battery" in the top-level README).
- **Camera**: always a chase camera on the drone. It starts behind and above it and swings
  round to stay behind as it turns; **drag** to rotate around the drone, **scroll** to zoom
  (3 m to 30 km), straight through any building in the way. Your angle and zoom are kept as it flies. There's no free camera or Home
  button for now.
- **HUD** (bottom-right): height above whatever is below (ground or roof), altitude above
  sea level, speed, climb, heading, distance from home, battery (with minutes of flight
  left, once it can tell), flight mode, armed state,
  and a warning above Transport Canada's 122 m (400 ft) limit. **Settings → Flight
  readouts** hides it (remembered in this browser); crash, collision and height-limit
  warnings still appear.
- The model is a small X-frame quadcopter (front propellers red, back ones light, so the
  heading reads from any angle) whose propellers spin while it's armed and spin down when
  it disarms or crashes. It's drawn 4× real size so it's visible from the chase camera; a red dot marks
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
- **Settings → Geofence** shows the fence PX4 enforces: status, area (City of Toronto
  boundary), ceiling, breach action and the current Return height (see the top-level
  README). The panel only mentions it if the upload failed.
- **Settings → Simulation** sets the simulated drone: speeds (cruise, climb, descent,
  take-off, landing, keyboard), battery (minutes of hovering, whether the drain follows the
  load, the low / critical / emergency levels and what PX4 does at critical), the geofence
  ceiling and breach action, and whether Return lands or hovers at home. *Apply* sends them
  to the bridge, which checks, saves and applies them to PX4 straight away (see "Sim config"
  in the top-level README). Route estimates and battery checks use them.

In dev builds `window.viewer` and `window.tdot` (`{ px4, droneView }`) are available in
the browser console for debugging.

## Controls

Drag rotates around the drone, scroll zooms. Click a neighbourhood or
building for details: the card opens folded to just its title (the name or address);
the ▸ button, or a click on the title, shows the details.

The map is always the photorealistic 3D city. **Settings** (the gear, top-right) has the **Layers** toggles for
the two overlays, **N** neighbourhoods and **B** city boundary (remembered in this
browser), the **Drone** options (flight readouts, flight trail) and the **Geofence**
details. The City 3D Massing data is never drawn: it runs in the
background for building collisions, the HUD's building distance, and click info.

Clicking works at any zoom: on a building you get its name (or address) as the title,
its addresses, neighbourhood, ward and heights from the City footprint under the click; anywhere else you get the neighbourhood.
Buildings are matched by footprint only, because from far away the clicked 3D position
is too imprecise vertically to tell a roof from the ground.

Contains information licensed under the Open Government Licence – Toronto.
