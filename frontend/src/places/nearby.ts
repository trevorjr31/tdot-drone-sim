/**
 * Places by type ("the nearest hospital"): a list of Toronto places from OpenStreetMap,
 * prepared by `npm run data` (public/data/toronto/places.json), and the lookup of the
 * nearest ones of a category to a point.
 *
 * The geocoder (Google through Cesium ion) finds places by name; it can't answer "the
 * nearest X to here", so that comes from this list instead.
 */

const M_PER_DEG_LAT = 110_574
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

/** The kinds of place that can be searched for by type. Order is the file format: don't reorder, only append. */
export const PLACE_CATEGORIES = [
  'hospital',
  'police',
  'fire_station',
  'school',
  'university',
  'library',
  'park',
  'transit_station',
  'stadium',
  'museum',
  'shopping_mall',
  'helipad',
] as const
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number]

/** How each category reads in the app ("the nearest hospital"). */
export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  hospital: 'hospital',
  police: 'police station',
  fire_station: 'fire station',
  school: 'school',
  university: 'university or college',
  library: 'library',
  park: 'park',
  transit_station: 'subway or train station',
  stadium: 'stadium',
  museum: 'museum',
  shopping_mall: 'shopping mall',
  helipad: 'helipad',
}

export type NearbyPlace = {
  category: PlaceCategory
  /** Null for unnamed places (some helipads); shown as coordinates. */
  name: string | null
  /** The place's centre: a node's position, or the middle of a building or area. */
  lat: number
  lon: number
  /** Roughly how far the place extends from its centre, metres (0 for a single point). */
  radiusM: number
}

/** places.json: compact rows [category index, name, lat, lon, radius m]. */
export type PlacesFile = {
  generatedAt: string
  attribution: string
  categories: readonly string[]
  places: [number, string | null, number, number, number][]
}

export function parsePlaces(file: PlacesFile): NearbyPlace[] {
  const out: NearbyPlace[] = []
  for (const [c, name, lat, lon, radiusM] of file.places) {
    // Map by name, so a file from an older script with a different list still reads right.
    const category = file.categories[c] as PlaceCategory | undefined
    if (category && (PLACE_CATEGORIES as readonly string[]).includes(category)) out.push({ category, name, lat, lon, radiusM })
  }
  return out
}

/** OpenStreetMap tags → category, or null for places we don't list. */
export function categoryOf(tags: Record<string, string | undefined>): PlaceCategory | null {
  switch (tags.amenity) {
    case 'hospital':
      return 'hospital'
    case 'police':
      return 'police'
    case 'fire_station':
      return 'fire_station'
    case 'school':
      return 'school'
    case 'university':
    case 'college':
      return 'university'
    case 'library':
      return 'library'
  }
  if (tags.aeroway === 'helipad') return 'helipad'
  if (tags.leisure === 'stadium') return 'stadium'
  if (tags.leisure === 'park') return 'park'
  if (tags.tourism === 'museum') return 'museum'
  if (tags.shop === 'mall') return 'shopping_mall'
  if (tags.railway === 'station' || (tags.public_transport === 'station' && tags.train === 'yes')) return 'transit_station'
  if (tags.station === 'subway') return 'transit_station'
  return null
}

export type NearbyResult = NearbyPlace & {
  /** Straight-line distance from the search point to the place's centre, metres. */
  distanceM: number
  /** To its edge (centre distance less its radius, at least 0): what "nearest" ranks by, so a big park counts as near when you're beside it. */
  edgeDistanceM: number
}

/**
 * The `limit` places of `category` nearest `from`, nearest first (by distance to their
 * edge). Callers check which can actually be flown to and pick the best of these.
 */
export function nearestPlaces(
  places: NearbyPlace[],
  category: PlaceCategory,
  from: { lat: number; lon: number },
  limit = 4,
): NearbyResult[] {
  const kx = mPerDegLon(from.lat)
  const found: NearbyResult[] = []
  for (const p of places) {
    if (p.category !== category) continue
    const distanceM = Math.hypot((p.lon - from.lon) * kx, (p.lat - from.lat) * M_PER_DEG_LAT)
    found.push({ ...p, distanceM, edgeDistanceM: Math.max(0, distanceM - p.radiusM) })
  }
  return found.sort((a, b) => a.edgeDistanceM - b.edgeDistanceM || a.distanceM - b.distanceM).slice(0, limit)
}

type OsmElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number }
  tags?: Record<string, string>
}

/** Same category and name this close together: one place mapped twice (e.g. a point and its building). */
const DUPLICATE_WITHIN_M = 300

/**
 * Turns an Overpass `out tags bb` answer into places: classified, unnamed ones
 * dropped except helipads (often unnamed, still worth finding), duplicates merged
 * (keeping the one with an outline), coordinates rounded to ~1 m.
 */
export function placesFromOsm(elements: OsmElement[]): NearbyPlace[] {
  const out: NearbyPlace[] = []
  for (const e of elements) {
    const tags = e.tags ?? {}
    const category = categoryOf(tags)
    if (!category) continue
    const name = tags.name?.trim() || null
    if (!name && category !== 'helipad') continue
    // Overpass gives ways and relations either a centre or bounds, not both: use the middle of the bounds.
    const mid = e.bounds && { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 }
    const at = e.center ?? (e.lat != null && e.lon != null ? { lat: e.lat, lon: e.lon } : mid)
    if (!at) continue
    let radiusM = 0
    if (e.bounds) {
      const b = e.bounds
      const w = (b.maxlon - b.minlon) * mPerDegLon(at.lat)
      const h = (b.maxlat - b.minlat) * M_PER_DEG_LAT
      radiusM = Math.round(Math.hypot(w, h) / 2)
    }
    out.push({ category, name, lat: round(at.lat, 5), lon: round(at.lon, 5), radiusM })
  }

  // Bigger outlines first, so a building or campus wins over a point inside it.
  out.sort((a, b) => b.radiusM - a.radiusM)
  const kept: NearbyPlace[] = []
  for (const p of out) {
    const dup =
      p.name &&
      kept.some(
        (k) =>
          k.category === p.category &&
          k.name === p.name &&
          Math.hypot((k.lon - p.lon) * mPerDegLon(p.lat), (k.lat - p.lat) * M_PER_DEG_LAT) <= DUPLICATE_WITHIN_M + k.radiusM,
      )
    if (!dup) kept.push(p)
  }
  return kept.sort((a, b) => PLACE_CATEGORIES.indexOf(a.category) - PLACE_CATEGORIES.indexOf(b.category) || a.lat - b.lat)
}

/** The file the app loads. */
export function placesFile(places: NearbyPlace[], generatedAt: string): PlacesFile {
  return {
    generatedAt,
    attribution: '© OpenStreetMap contributors (ODbL)',
    categories: PLACE_CATEGORIES,
    places: places.map((p) => [PLACE_CATEGORIES.indexOf(p.category), p.name, p.lat, p.lon, p.radiusM]),
  }
}

/** Overpass QL for every category, inside a [south, west, north, east] box. */
export function overpassQuery(bbox: [number, number, number, number]): string {
  const b = bbox.join(',')
  return [
    '[out:json][timeout:180];',
    '(',
    `  nwr["amenity"~"^(hospital|police|fire_station|school|university|college|library)$"](${b});`,
    `  nwr["aeroway"="helipad"](${b});`,
    `  nwr["leisure"~"^(park|stadium)$"]["name"](${b});`,
    `  nwr["tourism"="museum"]["name"](${b});`,
    `  nwr["shop"="mall"]["name"](${b});`,
    `  nwr["railway"="station"]["name"](${b});`,
    `  nwr["station"="subway"]["name"](${b});`,
    ');',
    // Bounds for ways and relations (their size); the centre is taken as their middle.
    'out tags bb;',
  ].join('\n')
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp
