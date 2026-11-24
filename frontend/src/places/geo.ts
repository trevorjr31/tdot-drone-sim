import type { Position } from '../data/torontoData'

/**
 * Small geometry helpers for places. Plain maths (no Cesium), so they're easy
 * to unit test. Distances use an equirectangular approximation, which is well
 * within a metre over city-scale distances at Toronto's latitude.
 */

const M_PER_DEG_LAT = 110_574
const M_PER_DEG_LON_AT_EQUATOR = 111_320

export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * M_PER_DEG_LON_AT_EQUATOR * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180)
  const y = (lat2 - lat1) * M_PER_DEG_LAT
  return Math.hypot(x, y)
}

/** Bounding box of the outer rings of one or more polygons. */
export function bboxOf(polygons: Position[][][]) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0]) {
      west = Math.min(west, lon)
      south = Math.min(south, lat)
      east = Math.max(east, lon)
      north = Math.max(north, lat)
    }
  }
  return { west, south, east, north }
}

/** Ray-casting point-in-polygon test on a [lon, lat] ring. */
export function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
