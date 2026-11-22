/**
 * Planned routes vs buildings. PX4 doesn't know about buildings, so the autopilot
 * flies a straight line at the chosen height and would hit anything taller on the
 * way. Before a route starts, this finds the highest building along the line (within
 * a corridor either side, for PX4's path wobble and the drone's size) so the app can
 * insist on a height that clears it.
 */
import type { FeatureCollection, MassingIndex, MassingProps } from '../data/torontoData'
import { buildingsFromTile, footprintContains, type Building } from './collision'

/** Half-width of the strip checked either side of the straight line, metres. */
export const ROUTE_CORRIDOR_M = 15
/** Required height above the highest building on the route, metres. */
export const ROUTE_CLEARANCE_M = 10

const M_PER_DEG_LAT = 110_574
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

export type LatLon = { lat: number; lon: number }

export type RouteCheck = {
  /** Tallest building the route passes over or near, if any. */
  highest: Building | null
  /** Lowest safe height above home for crossing (highest roof + clearance), metres. 0 when nothing's in the way. */
  minSafeRelAltM: number
  /** Tallest building at the destination (within the corridor of it), if any. */
  destHighest: Building | null
  /** Lowest safe height to end at, over the destination, metres above home. */
  destMinSafeRelAltM: number
}

/**
 * The highest building within `corridorM` of the segment from → to, from an already
 * loaded set of buildings (pure; no tile loading).
 */
export function highestOnRoute(buildings: Iterable<Building>, from: LatLon, to: LatLon, corridorM = ROUTE_CORRIDOR_M): Building | null {
  // Local metres around the start point (equirectangular: fine over a city).
  const kx = mPerDegLon(from.lat)
  const toXY = (lon: number, lat: number): [number, number] => [(lon - from.lon) * kx, (lat - from.lat) * M_PER_DEG_LAT]
  const [bx, by] = toXY(to.lon, to.lat)
  const padLon = corridorM / kx
  const padLat = corridorM / M_PER_DEG_LAT
  const west = Math.min(from.lon, to.lon) - padLon
  const east = Math.max(from.lon, to.lon) + padLon
  const south = Math.min(from.lat, to.lat) - padLat
  const north = Math.max(from.lat, to.lat) + padLat

  let highest: Building | null = null
  for (const b of buildings) {
    if (highest && b.roofM <= highest.roofM) continue
    const [w, s, e, n] = b.bbox
    if (e < west || w > east || n < south || s > north) continue
    if (nearSegment(b, toXY, bx, by, corridorM) || footprintContains(b, from.lon, from.lat) || footprintContains(b, to.lon, to.lat))
      highest = b
  }
  return highest
}

/** True if any footprint edge comes within `corridorM` of the segment (0,0) → (bx,by), or crosses it. */
function nearSegment(b: Building, toXY: (lon: number, lat: number) => [number, number], bx: number, by: number, corridorM: number): boolean {
  const ring = b.outer.map(([lon, lat]) => toXY(lon, lat))
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentDistance(ring[j][0], ring[j][1], ring[i][0], ring[i][1], 0, 0, bx, by) <= corridorM) return true
  }
  return false
}

/** Shortest distance between segments p1-p2 and q1-q2 (0 if they cross). */
function segmentDistance(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number): number {
  if (segmentsCross(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y)) return 0
  return Math.min(
    pointSegment(p1x, p1y, q1x, q1y, q2x, q2y),
    pointSegment(p2x, p2y, q1x, q1y, q2x, q2y),
    pointSegment(q1x, q1y, p1x, p1y, p2x, p2y),
    pointSegment(q2x, q2y, p1x, p1y, p2x, p2y),
  )
}

function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function segmentsCross(p1x: number, p1y: number, p2x: number, p2y: number, q1x: number, q1y: number, q2x: number, q2y: number): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d1 = d(q1x, q1y, q2x, q2y, p1x, p1y)
  const d2 = d(q1x, q1y, q2x, q2y, p2x, p2y)
  const d3 = d(p1x, p1y, p2x, p2y, q1x, q1y)
  const d4 = d(p1x, p1y, p2x, p2y, q2x, q2y)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** Massing tiles whose buildings could be within the corridor of the segment. */
export function tilesOnRoute(index: MassingIndex, from: LatLon, to: LatLon, corridorM = ROUTE_CORRIDOR_M): string[] {
  const padLon = corridorM / mPerDegLon(from.lat)
  const padLat = corridorM / M_PER_DEG_LAT
  return Object.entries(index.tiles)
    .filter(([, t]) => clipsRect(from, to, t.bbox[0] - padLon, t.bbox[1] - padLat, t.bbox[2] + padLon, t.bbox[3] + padLat))
    .map(([key]) => key)
}

/** Whether the segment touches the rectangle (Liang–Barsky clipping). */
function clipsRect(a: LatLon, b: LatLon, w: number, s: number, e: number, n: number): boolean {
  const dx = b.lon - a.lon
  const dy = b.lat - a.lat
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a.lon - w],
    [dx, e - a.lon],
    [-dy, a.lat - s],
    [dy, n - a.lat],
  ]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
      if (t0 > t1) return false
    }
  }
  return true
}

/** Loads the tiles a route crosses and finds the lowest safe height for it. */
export class RouteSafety {
  private readonly tiles = new Map<string, Promise<Building[]>>()
  private readonly index: MassingIndex
  private readonly loadTile: (key: string) => Promise<FeatureCollection<MassingProps>>

  constructor(index: MassingIndex, loadTile: (key: string) => Promise<FeatureCollection<MassingProps>>) {
    this.index = index
    this.loadTile = loadTile
  }

  async check(from: LatLon, to: LatLon, homeAmslM: number): Promise<RouteCheck> {
    const keys = tilesOnRoute(this.index, from, to)
    const sets = await Promise.all(keys.map((k) => this.tile(k)))
    const all = sets.flat()
    const highest = highestOnRoute(all, from, to)
    const destHighest = highestOnRoute(all, to, to)
    const safe = (b: Building | null) => (b ? Math.max(0, Math.ceil(b.roofM - homeAmslM + ROUTE_CLEARANCE_M)) : 0)
    return { highest, minSafeRelAltM: safe(highest), destHighest, destMinSafeRelAltM: safe(destHighest) }
  }

  private tile(key: string): Promise<Building[]> {
    let t = this.tiles.get(key)
    if (!t) {
      t = this.loadTile(key).then((fc) => buildingsFromTile(fc, this.index.wards))
      t.catch(() => this.tiles.delete(key)) // retry next time
      this.tiles.set(key, t)
    }
    return t
  }
}
