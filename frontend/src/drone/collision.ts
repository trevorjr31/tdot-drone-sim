import { cellKey, cellOf, MASSING_GRID } from '../data/massingGrid'
import type { FeatureCollection, MassingIndex, MassingProps, Position } from '../data/torontoData'
import { pointInRing } from '../places/geo'

/**
 * Building collision checks against the City of Toronto 3D Massing data.
 *
 * PX4's physics knows nothing about buildings, so the app checks the drone
 * against massing footprints near it: inside a footprint and below its roof
 * means a collision. Also reports the distance to the nearest building, for a
 * proximity warning. Tiles are loaded around the drone on their own, whether
 * or not the massing layer is visible.
 */

export type Building = {
  /** Outer ring, [lon, lat]. */
  outer: Position[]
  holes: Position[][]
  /** [west, south, east, north] degrees. */
  bbox: [number, number, number, number]
  /** Ground and roof (highest point) heights, metres above sea level. */
  groundM: number
  roofM: number
}

export type CollisionCheck = {
  /** The building the drone is inside (or touching), if any. */
  hit: Building | null
  /** Nearest building whose height range the drone is in, within `nearRadiusM`. */
  nearest: { building: Building; distanceM: number } | null
}

export type CheckOptions = {
  /** Treat being this close to a wall as touching it (the drone has a size). */
  marginM?: number
  /** Only report the nearest building within this distance. */
  nearRadiusM?: number
}

const M_PER_DEG_LAT = 110_574
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

/** Builds the per-building records from a massing tile. */
export function buildingsFromTile(fc: FeatureCollection<MassingProps>): Building[] {
  const out: Building[] = []
  for (const f of fc.features) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const [outer, ...holes] of polygons) {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
      for (const [lon, lat] of outer) {
        w = Math.min(w, lon)
        s = Math.min(s, lat)
        e = Math.max(e, lon)
        n = Math.max(n, lat)
      }
      out.push({ outer, holes, bbox: [w, s, e, n], groundM: f.properties.g, roofM: f.properties.g + f.properties.top })
    }
  }
  return out
}

/** Inside the outer ring and not in a courtyard (hole). */
export function footprintContains(b: Building, lon: number, lat: number): boolean {
  const [w, s, e, n] = b.bbox
  if (lon < w || lon > e || lat < s || lat > n) return false
  return pointInRing(lon, lat, b.outer) && !b.holes.some((h) => pointInRing(lon, lat, h))
}

/** Shortest distance in metres from a point to a ring's edges (equirectangular, fine at city scale). */
export function distanceToRingM(lon: number, lat: number, ring: Position[]): number {
  const kx = mPerDegLon(lat)
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][0] - lon) * kx
    const ay = (ring[j][1] - lat) * M_PER_DEG_LAT
    const bx = (ring[i][0] - lon) * kx
    const by = (ring[i][1] - lat) * M_PER_DEG_LAT
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
  }
  return best
}

/** Pure check of a point against a list of buildings (no tile loading). */
export function checkBuildings(
  buildings: Iterable<Building>,
  lon: number,
  lat: number,
  altAmslM: number,
  { marginM = 1, nearRadiusM = 60 }: CheckOptions = {},
): CollisionCheck {
  const padLat = nearRadiusM / M_PER_DEG_LAT
  const padLon = nearRadiusM / mPerDegLon(lat)
  let hit: Building | null = null
  let nearest: CollisionCheck['nearest'] = null

  for (const b of buildings) {
    const [w, s, e, n] = b.bbox
    if (lon < w - padLon || lon > e + padLon || lat < s - padLat || lat > n + padLat) continue
    // Only buildings whose height range the drone is in can be hit (or are worth warning about).
    if (altAmslM > b.roofM + marginM || altAmslM < b.groundM - 2) continue

    const inside = pointInRing(lon, lat, b.outer) && !b.holes.some((h) => pointInRing(lon, lat, h))
    const distanceM = inside ? 0 : distanceToRingM(lon, lat, b.outer)
    if (distanceM <= marginM && !hit) hit = b
    if (distanceM <= nearRadiusM && (!nearest || distanceM < nearest.distanceM)) nearest = { building: b, distanceM }
  }
  return { hit, nearest }
}

/** Keeps the massing tiles around the drone loaded and checks positions against them. */
export class BuildingCollider {
  private readonly index: MassingIndex
  private readonly loadTile: (key: string) => Promise<FeatureCollection<MassingProps>>
  private readonly tiles = new Map<string, Building[] | 'loading'>()
  private readonly loadRadiusM: number

  constructor(
    index: MassingIndex,
    loadTile: (key: string) => Promise<FeatureCollection<MassingProps>>,
    loadRadiusM = 300,
  ) {
    this.index = index
    this.loadTile = loadTile
    this.loadRadiusM = loadRadiusM
  }

  /** Call as the drone moves: loads nearby tiles, drops far ones. */
  setPosition(lon: number, lat: number) {
    const { cellLon, cellLat } = MASSING_GRID
    const dCol = Math.ceil(this.loadRadiusM / (mPerDegLon(lat) * cellLon))
    const dRow = Math.ceil(this.loadRadiusM / (M_PER_DEG_LAT * cellLat))
    const { col, row } = cellOf(lon, lat)
    const wanted = new Set<string>()
    for (let c = col - dCol; c <= col + dCol; c++) {
      for (let r = row - dRow; r <= row + dRow; r++) {
        const key = cellKey(c, r)
        if (this.index.tiles[key]) wanted.add(key)
      }
    }
    for (const key of wanted) {
      if (this.tiles.has(key)) continue
      this.tiles.set(key, 'loading')
      this.loadTile(key)
        .then((fc) => this.tiles.set(key, buildingsFromTile(fc)))
        .catch(() => this.tiles.delete(key)) // retried on a later move
    }
    for (const key of this.tiles.keys()) {
      if (!wanted.has(key) && this.tiles.size > wanted.size + 8) this.tiles.delete(key)
    }
  }

  /** True once every tile around the last position has loaded. */
  get ready() {
    return [...this.tiles.values()].every((t) => t !== 'loading')
  }

  /** Buildings whose footprint contains the point, whatever their height (for click info). */
  footprintsAt(lon: number, lat: number): Building[] {
    const out: Building[] = []
    for (const t of this.tiles.values()) {
      if (t === 'loading') continue
      for (const b of t) if (footprintContains(b, lon, lat)) out.push(b)
    }
    return out
  }

  check(lon: number, lat: number, altAmslM: number, options?: CheckOptions): CollisionCheck {
    const all = function* (tiles: Map<string, Building[] | 'loading'>) {
      for (const t of tiles.values()) if (t !== 'loading') yield* t
    }
    return checkBuildings(all(this.tiles), lon, lat, altAmslM, options)
  }
}

export type Point3 = { lon: number; lat: number; altAmslM: number }

/**
 * Where the drone met the building: the last point still outside it on the
 * straight path from `from` (outside) to `to` (inside), found by bisection.
 * The drone is then drawn at the wall, never inside it. (At 20 Hz and ≤12 m/s the
 * drone moves ≤0.6 m per sample, so it can't skip a whole wall between samples.)
 */
export function findImpact(from: Point3, to: Point3, isHit: (p: Point3) => boolean, iterations = 12): Point3 {
  if (isHit(from)) return from
  let outside = 0
  let inside = 1
  const at = (f: number): Point3 => ({
    lon: from.lon + (to.lon - from.lon) * f,
    lat: from.lat + (to.lat - from.lat) * f,
    altAmslM: from.altAmslM + (to.altAmslM - from.altAmslM) * f,
  })
  for (let i = 0; i < iterations; i++) {
    const mid = (outside + inside) / 2
    if (isHit(at(mid))) inside = mid
    else outside = mid
  }
  return at(outside)
}
