import { describe, expect, it } from 'vitest'
import { categoryOf, nearestPlaces, parsePlaces, placesFile, placesFromOsm, type NearbyPlace } from './nearby'

const LAT = 43.65
const LON = -79.38
const M_LAT = 1 / 110_574
const M_LON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180))
/** A point `x` m east and `y` m north of (LAT, LON). */
const at = (x: number, y: number) => ({ lat: LAT + y * M_LAT, lon: LON + x * M_LON })

const place = (category: NearbyPlace['category'], name: string, x: number, y: number, radiusM = 0): NearbyPlace => ({
  category,
  name,
  ...at(x, y),
  radiusM,
})

describe('categoryOf', () => {
  it('maps OpenStreetMap tags to categories', () => {
    expect(categoryOf({ amenity: 'hospital' })).toBe('hospital')
    expect(categoryOf({ amenity: 'college' })).toBe('university')
    expect(categoryOf({ aeroway: 'helipad' })).toBe('helipad')
    expect(categoryOf({ leisure: 'park' })).toBe('park')
    expect(categoryOf({ railway: 'station' })).toBe('transit_station')
    expect(categoryOf({ station: 'subway' })).toBe('transit_station')
    expect(categoryOf({ shop: 'mall' })).toBe('shopping_mall')
  })

  it('ignores places we do not list', () => {
    expect(categoryOf({ amenity: 'clinic' })).toBeNull()
    expect(categoryOf({ shop: 'bakery' })).toBeNull()
    expect(categoryOf({})).toBeNull()
  })
})

describe('nearestPlaces', () => {
  const places = [
    place('hospital', 'Far General', 3000, 0),
    place('hospital', 'Near Western', 800, 0),
    place('hospital', 'Mid East', -1500, 0),
    place('park', 'Beside Park', 100, 0),
  ]

  it('finds the nearest of a category, nearest first', () => {
    const found = nearestPlaces(places, 'hospital', at(0, 0))
    expect(found.map((p) => p.name)).toEqual(['Near Western', 'Mid East', 'Far General'])
    expect(found[0].distanceM).toBeCloseTo(800, -1)
  })

  it('searches from wherever the drone will be', () => {
    expect(nearestPlaces(places, 'hospital', at(-1400, 0))[0].name).toBe('Mid East')
  })

  it('keeps to the limit, and gives nothing for a category with no places', () => {
    expect(nearestPlaces(places, 'hospital', at(0, 0), 2)).toHaveLength(2)
    expect(nearestPlaces(places, 'stadium', at(0, 0))).toEqual([])
  })

  it('ranks by distance to the edge, so a big park beside you beats a small one nearer its centre', () => {
    const parks = [place('park', 'Small Parkette', 300, 0, 20), place('park', 'Big Park', 0, 900, 800)]
    const found = nearestPlaces(parks, 'park', at(0, 0))
    expect(found[0].name).toBe('Big Park')
    expect(found[0].edgeDistanceM).toBeCloseTo(100, -1)
    expect(found[0].distanceM).toBeCloseTo(900, -1)
  })
})

describe('placesFromOsm', () => {
  it('classifies, keeps named places and unnamed helipads, and sizes outlines', () => {
    const places = placesFromOsm([
      { type: 'node', id: 1, ...at(0, 0), tags: { amenity: 'hospital', name: 'Toronto General' } },
      { type: 'node', id: 2, ...at(100, 0), tags: { amenity: 'hospital' } },
      { type: 'node', id: 3, ...at(200, 0), tags: { aeroway: 'helipad' } },
      { type: 'node', id: 4, ...at(300, 0), tags: { amenity: 'cafe', name: 'Coffee' } },
      {
        type: 'way',
        id: 5,
        center: at(2000, 0),
        bounds: { minlat: at(0, -300).lat, minlon: at(1600, 0).lon, maxlat: at(0, 300).lat, maxlon: at(2400, 0).lon },
        tags: { leisure: 'park', name: 'Grange Park' },
      },
    ])
    expect(places.map((p) => [p.category, p.name])).toEqual([
      ['hospital', 'Toronto General'],
      ['park', 'Grange Park'],
      ['helipad', null],
    ])
    // 800 × 600 m box: half its diagonal.
    expect(places[1].radiusM).toBeCloseTo(500, -1)
    expect(places[0].radiusM).toBe(0)
  })

  it('merges a place mapped twice (a point inside its building), keeping the outline', () => {
    const places = placesFromOsm([
      { type: 'node', id: 1, ...at(10, 10), tags: { amenity: 'hospital', name: 'Mount Sinai Hospital' } },
      {
        type: 'way',
        id: 2,
        center: at(0, 0),
        bounds: { minlat: at(0, -60).lat, minlon: at(-80, 0).lon, maxlat: at(0, 60).lat, maxlon: at(80, 0).lon },
        tags: { amenity: 'hospital', name: 'Mount Sinai Hospital' },
      },
      { type: 'node', id: 3, ...at(5000, 0), tags: { amenity: 'hospital', name: 'Mount Sinai Hospital' } },
    ])
    expect(places).toHaveLength(2)
    expect(places.find((p) => p.radiusM > 0)).toBeTruthy()
  })

  it('places a building with only bounds (what Overpass sends) at their middle', () => {
    const [p] = placesFromOsm([
      {
        type: 'way',
        id: 1,
        bounds: { minlat: at(0, -100).lat, minlon: at(-200, 0).lon, maxlat: at(0, 300).lat, maxlon: at(200, 0).lon },
        tags: { amenity: 'hospital', name: 'Toronto Western Hospital' },
      },
    ])
    expect(p.lat).toBeCloseTo(at(0, 100).lat, 5)
    expect(p.lon).toBeCloseTo(LON, 5)
    expect(p.radiusM).toBeCloseTo(283, -1)
  })

  it('round-trips through the file format', () => {
    const places = [place('hospital', 'A', 0, 0, 50), place('helipad', 'B', 10, 10)]
    const back = parsePlaces(placesFile(places, '2026-11-25T00:00:00Z'))
    expect(back).toEqual(places)
  })

  it('skips categories the app no longer knows', () => {
    const back = parsePlaces({
      generatedAt: '',
      attribution: '',
      categories: ['hospital', 'aquarium'],
      places: [
        [0, 'A', LAT, LON, 0],
        [1, 'Fish', LAT, LON, 0],
      ],
    })
    expect(back.map((p) => p.name)).toEqual(['A'])
  })
})
