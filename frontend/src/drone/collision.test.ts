import { describe, expect, it } from 'vitest'
import type { FeatureCollection, MassingProps, Position } from '../data/torontoData'
import { buildingsFromTile, checkBuildings, distanceToRingM, findImpact, footprintContains } from './collision'

// A 40 m × 40 m building near City Hall: ground 90 m ASL, 30 m tall (roof 120 m ASL),
// with a 10 m × 10 m courtyard in the middle.
const LAT = 43.6525
const LON = -79.3832
const mLat = 1 / 110_574
const mLon = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180))
const square = (half: number): Position[] => [
  [LON - half * mLon, LAT - half * mLat],
  [LON + half * mLon, LAT - half * mLat],
  [LON + half * mLon, LAT + half * mLat],
  [LON - half * mLon, LAT + half * mLat],
  [LON - half * mLon, LAT - half * mLat],
]
const tile: FeatureCollection<MassingProps> = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { h: 25, top: 30, g: 90 }, geometry: { type: 'Polygon', coordinates: [square(20), square(5)] } }],
}
const buildings = buildingsFromTile(tile)
const at = (eastM: number, northM: number) => [LON + eastM * mLon, LAT + northM * mLat] as const

describe('buildingsFromTile', () => {
  it('uses the highest point (top) for the roof, measured from the ground elevation', () => {
    expect(buildings).toHaveLength(1)
    expect(buildings[0].groundM).toBe(90)
    expect(buildings[0].roofM).toBe(120)
    expect(buildings[0].holes).toHaveLength(1)
  })
})

describe('footprintContains', () => {
  it('is true inside the footprint and false in the courtyard or outside, regardless of height', () => {
    expect(footprintContains(buildings[0], ...at(12, 0))).toBe(true)
    expect(footprintContains(buildings[0], ...at(0, 0))).toBe(false) // courtyard
    expect(footprintContains(buildings[0], ...at(25, 0))).toBe(false)
  })
})

describe('distanceToRingM', () => {
  it('measures distance to the nearest wall', () => {
    expect(distanceToRingM(...at(30, 0), square(20))).toBeCloseTo(10, 0)
    expect(distanceToRingM(...at(30, 30), square(20))).toBeCloseTo(Math.hypot(10, 10), 0) // nearest is a corner
  })
})

describe('checkBuildings', () => {
  it('hits a building when inside its footprint and below its roof', () => {
    const r = checkBuildings(buildings, ...at(12, 0), 100)
    expect(r.hit).toBe(buildings[0])
    expect(r.nearest?.distanceM).toBe(0)
  })

  it('does not hit when flying above the roof', () => {
    expect(checkBuildings(buildings, ...at(12, 0), 125).hit).toBeNull()
  })

  it('does not hit inside the courtyard (a hole in the footprint)', () => {
    expect(checkBuildings(buildings, ...at(0, 0), 100).hit).toBeNull()
  })

  it('counts brushing a wall (within the margin) as a hit', () => {
    expect(checkBuildings(buildings, ...at(20.5, 0), 100, { marginM: 1 }).hit).toBe(buildings[0])
    expect(checkBuildings(buildings, ...at(22, 0), 100, { marginM: 1 }).hit).toBeNull()
  })

  it('reports the distance to the nearest building for proximity warnings', () => {
    const r = checkBuildings(buildings, ...at(28, 0), 100)
    expect(r.hit).toBeNull()
    expect(r.nearest?.distanceM).toBeCloseTo(8, 0)
  })

  it('ignores buildings beyond the search radius or below the drone', () => {
    expect(checkBuildings(buildings, ...at(200, 0), 100).nearest).toBeNull()
    expect(checkBuildings(buildings, ...at(28, 0), 140).nearest).toBeNull()
  })
})

describe('findImpact', () => {
  const isHit = (p: { lon: number; lat: number; altAmslM: number }) => checkBuildings(buildings, p.lon, p.lat, p.altAmslM, { marginM: 1 }).hit !== null
  const point = (eastM: number, alt = 100) => ({ lon: at(eastM, 0)[0], lat: at(eastM, 0)[1], altAmslM: alt })

  it('finds the point where the path meets the wall (margin included), outside the building', () => {
    // Flying west from 40 m east of centre to 10 m east (inside): wall at 20 m, margin 1 m.
    const impact = findImpact(point(40), point(10), isHit)
    const eastM = (impact.lon - LON) / mLon
    expect(eastM).toBeGreaterThan(20.9)
    expect(eastM).toBeLessThan(21.1)
    expect(isHit(impact)).toBe(false)
  })

  it('finds the wall even when the new sample is already deep inside', () => {
    // From 40 m west of centre to 10 m west: 11 m past the west wall (at 20 m, +1 m margin).
    const from = point(-40)
    const to = point(-10)
    const impact = findImpact(from, to, isHit)
    expect((impact.lon - LON) / mLon).toBeCloseTo(-21, 0)
  })

  it('interpolates altitude along the path', () => {
    const impact = findImpact(point(40, 100), point(10, 110), isHit)
    expect(impact.altAmslM).toBeGreaterThan(100)
    expect(impact.altAmslM).toBeLessThan(110)
  })
})
