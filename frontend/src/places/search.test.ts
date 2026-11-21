import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../test/memoryStorage'
import { addRecent, loadPresetCache, loadRecent, normalize, placeType, searchLocal, titleFor } from './search'
import type { Place, PlaceTarget } from './types'

const point: PlaceTarget = { type: 'point', lon: -79.38, lat: 43.65 }

function place(title: string, extra: Partial<Place> = {}): Place {
  return { id: `test:${title}`, kind: 'google', title, target: point, ...extra }
}

/** A square area roughly `sizeM` metres across, centred downtown. */
function area(sizeM: number): PlaceTarget {
  const dLat = sizeM / 110_574 / 2
  const dLon = sizeM / 80_500 / 2
  return { type: 'area', west: -79.4 - dLon, south: 43.67 - dLat, east: -79.4 + dLon, north: 43.67 + dLat }
}

describe('normalize', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalize('Yonge–Eglinton')).toBe('yonge eglinton')
    expect(normalize('  Café  Diplomático ')).toBe('cafe diplomatico')
  })

  it('treats & as "and" so intersections match either way', () => {
    expect(normalize('Bay St. & King St W')).toBe('bay st and king st w')
  })
})

describe('searchLocal', () => {
  const places = ['Annex', 'North Riverdale', 'South Riverdale', 'Casa Loma', 'Rosedale-Moore Park'].map((t) =>
    place(t, { kind: 'neighbourhood' }),
  )

  it('matches partial words anywhere in the name', () => {
    expect(searchLocal('riverd', places).map((p) => p.title)).toEqual(['North Riverdale', 'South Riverdale'])
  })

  it('ranks whole-name prefix matches first', () => {
    expect(searchLocal('rose', places)[0].title).toBe('Rosedale-Moore Park')
  })

  it('needs every typed word to match', () => {
    expect(searchLocal('south river', places).map((p) => p.title)).toEqual(['South Riverdale'])
    expect(searchLocal('south annex', places)).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(searchLocal('   ', places)).toEqual([])
  })
})

describe('titleFor', () => {
  it('splits an address into title and locality, dropping ", Canada"', () => {
    expect(titleFor('100 Queen St W', '100 Queen St W, Toronto, ON M5H 2N1, Canada')).toEqual({
      title: '100 Queen St W',
      subtitle: 'Toronto, ON M5H 2N1',
    })
  })

  it('keeps the typed landmark name when Google returns only its street address', () => {
    expect(titleFor('CN Tower', '290 Bremner Blvd, Toronto, ON M5V 3L9, Canada')).toEqual({
      title: 'CN Tower',
      subtitle: '290 Bremner Blvd, Toronto, ON M5V 3L9',
    })
  })
})

describe('placeType', () => {
  it('labels neighbourhoods', () => {
    expect(placeType(place('Casa Loma', { kind: 'neighbourhood', neighbourhoodId: '096' }))).toBe('Neighbourhood')
  })

  it('labels addresses, intersections and streets', () => {
    expect(placeType(place('1 Austin Terrace'))).toBe('Address')
    expect(placeType(place('Yonge St & Bloor St W'))).toBe('Intersection')
    expect(placeType(place('Bay St. & King St W'))).toBe('Intersection')
    expect(placeType(place('Leslie St'))).toBe('Street')
    expect(placeType(place('Queen St W and Spadina Ave'))).toBe('Intersection')
    expect(placeType(place('Arts and Letters Club'))).toBe('Place')
  })

  // The Casa Loma bug: a bare name returned the 2.5 km district, not the castle.
  it('labels a large result without a street number as an Area, a small one as a Place', () => {
    expect(placeType(place('Casa Loma', { target: area(2500) }))).toBe('Area')
    expect(placeType(place('Casa Loma', { target: area(250) }))).toBe('Place')
  })

  it('gives saved places their real type (being saved is shown separately)', () => {
    expect(placeType(place('Casa Loma', { kind: 'preset', target: area(250) }))).toBe('Place')
    expect(placeType(place('Yonge & Eglinton', { kind: 'preset' }))).toBe('Intersection')
    expect(placeType(place('Yonge & Eglinton Ave', { kind: 'preset' }))).toBe('Intersection')
  })
})

describe('recent places', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the newest first, without duplicates, capped at 5', () => {
    for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) addRecent(place(t))
    addRecent(place('C'))
    expect(loadRecent().map((p) => p.title)).toEqual(['C', 'F', 'E', 'D', 'B'])
    expect(loadRecent().every((p) => p.kind === 'recent')).toBe(true)
  })

  it('ignores corrupt stored data', () => {
    localStorage.setItem('tdot.recentPlaces.v1', '{not json')
    expect(loadRecent()).toEqual([])
  })
})

describe('storage unavailable (private mode, blocked cookies)', () => {
  beforeEach(() =>
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }),
  )
  afterEach(() => vi.unstubAllGlobals())

  it('falls back to empty values instead of crashing', () => {
    expect(loadRecent()).toEqual([])
    expect(loadPresetCache()).toEqual({})
    expect(() => addRecent(place('A'))).not.toThrow()
  })
})
