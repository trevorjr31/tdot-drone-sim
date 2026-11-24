import { describe, expect, it } from 'vitest'
import type { FeatureCollection, MassingIndex, MassingProps, Position } from '../data/torontoData'
import { MASSING_GRID } from '../data/massingGrid'
import { buildingsFromTile } from './collision'
import { highestOnRoute, RouteSafety, tilesOnRoute } from './routeSafety'

const LAT = 43.6525
const LON = -79.3832
const mLat = 1 / 110_574
const mLon = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180))
const at = (eastM: number, northM: number) => ({ lon: LON + eastM * mLon, lat: LAT + northM * mLat })

/** A 20 m square building centred east/north of the origin. */
function building(eastM: number, northM: number, top: number, g = 90) {
  const c = at(eastM, northM)
  const ring: Position[] = [
    [c.lon - 10 * mLon, c.lat - 10 * mLat],
    [c.lon + 10 * mLon, c.lat - 10 * mLat],
    [c.lon + 10 * mLon, c.lat + 10 * mLat],
    [c.lon - 10 * mLon, c.lat + 10 * mLat],
    [c.lon - 10 * mLon, c.lat - 10 * mLat],
  ]
  return { type: 'Feature' as const, properties: { h: top, top, g }, geometry: { type: 'Polygon' as const, coordinates: [ring] } }
}

const tile: FeatureCollection<MassingProps> = {
  type: 'FeatureCollection',
  features: [
    building(200, 0, 40), // on the line east
    building(200, 22, 80), // edge 12 m north of the line: inside the 15 m corridor
    building(200, -60, 150), // 50 m south: outside
  ],
}
const buildings = buildingsFromTile(tile)

describe('highestOnRoute', () => {
  it('finds the tallest building in the corridor, ignoring ones farther away', () => {
    expect(highestOnRoute(buildings, at(0, 0), at(400, 0))?.roofM).toBe(170) // 90 + 80
  })

  it('returns null when the route is clear', () => {
    expect(highestOnRoute(buildings, at(0, 100), at(400, 100))).toBeNull()
  })

  it('counts a building the route ends on (the destination roof)', () => {
    expect(highestOnRoute(buildings, at(0, -200), at(200, -60))?.roofM).toBe(240)
  })

  it('catches a building the line crosses diagonally', () => {
    expect(highestOnRoute(buildings, at(150, -120), at(250, 0))?.roofM).toBe(240)
  })
})

describe('tilesOnRoute / RouteSafety', () => {
  const index: MassingIndex = {
    grid: MASSING_GRID,
    year: 2025,
    buildings: 3,
    tiles: {
      near: { n: 3, maxTop: 150, bbox: [LON - 0.001, LAT - 0.001, LON + 0.004, LAT + 0.001] },
      far: { n: 1, maxTop: 10, bbox: [LON + 0.1, LAT + 0.1, LON + 0.11, LAT + 0.11] },
    },
  }

  it('only loads tiles the route crosses', () => {
    expect(tilesOnRoute(index, at(0, 0), at(400, 0))).toEqual(['near'])
  })

  it('gives the lowest safe height above home: highest roof + 10 m clearance', async () => {
    const safety = new RouteSafety(index, async () => tile)
    const check = await safety.check(at(0, 0), at(400, 0), 92)
    expect(check.highest?.roofM).toBe(170)
    expect(check.minSafeRelAltM).toBe(88) // 170 - 92 + 10
    expect((await safety.check(at(0, 100), at(400, 100), 92)).minSafeRelAltM).toBe(0)
  })
})
