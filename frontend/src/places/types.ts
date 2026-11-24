/** Where to point the camera: an area (preferred, sets zoom) or a single point. */
export type PlaceTarget =
  | { type: 'area'; west: number; south: number; east: number; north: number }
  | { type: 'point'; lon: number; lat: number }

export type PlaceKind = 'preset' | 'neighbourhood' | 'google' | 'recent'

export type Place = {
  /** Stable id, used for de-duplication and React keys. */
  id: string
  kind: PlaceKind
  title: string
  subtitle?: string
  target: PlaceTarget
  /** For neighbourhoods: the City's neighbourhood number, so the map can select it. */
  neighbourhoodId?: string
  /** True when the place is outside the City of Toronto boundary. */
  outsideCity?: boolean
  /** Optional orbit view around the target: which way to look, how steeply, from how far. */
  view?: { headingDeg: number; pitchDeg: number; rangeM: number }
  /** Optional exact camera position (overrides `view`), for views that aren't "look at X". */
  camera?: { lon: number; lat: number; height: number; headingDeg: number; pitchDeg: number }
}

/** What the map exposes to the search UI. */
export type MapApi = {
  /**
   * Marks a place on the map: a pin, or the neighbourhood selected. The camera stays
   * on the drone (it's always in chase); the drone can be sent there with fly-to.
   */
  showPlace: (place: Place) => void
  /** Removes the search-result pin. */
  clearPin: () => void
  /** Waits for a click on the map and returns that point (null if cancelled with Esc). */
  pickLocation: () => Promise<{ lon: number; lat: number } | null>
  /** Google geocoding through Cesium ion, limited to Toronto. */
  searchGoogle: (query: string) => Promise<{ places: Place[]; attributionHtml: string[] }>
  /** Local neighbourhood list (empty until the data has loaded). */
  neighbourhoods: () => Place[]
}

export function centreOf(target: PlaceTarget): { lon: number; lat: number } {
  return target.type === 'point'
    ? { lon: target.lon, lat: target.lat }
    : { lon: (target.west + target.east) / 2, lat: (target.south + target.north) / 2 }
}
