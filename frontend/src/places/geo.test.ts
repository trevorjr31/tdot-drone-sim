import { describe, expect, it } from 'vitest'
import type { Position } from '../data/torontoData'
import { bboxOf, defaultRange, distanceM, pointInRing } from './geo'

describe('distanceM', () => {
  it('measures north-south distance (0.01° latitude ≈ 1.1 km)', () => {
    expect(distanceM(-79.38, 43.65, -79.38, 43.66)).toBeCloseTo(1105.7, 0)
  })

  it('shrinks east-west distance with latitude', () => {
    // At 43.65°N, 0.01° of longitude is ~805 m (vs ~1113 m at the equator).
    expect(distanceM(-79.39, 43.65, -79.38, 43.65)).toBeCloseTo(805, -1)
  })

  it('gives a sensible real-world distance: CN Tower to City Hall ≈ 1.2 km', () => {
    const d = distanceM(-79.3871, 43.6426, -79.3832, 43.6534)
    expect(d).toBeGreaterThan(1100)
    expect(d).toBeLessThan(1300)
  })
})

describe('pointInRing', () => {
  const square: Position[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ]
  // An L-shape: the top-right quarter is missing.
  const lShape: Position[] = [
    [0, 0],
    [10, 0],
    [10, 5],
    [5, 5],
    [5, 10],
    [0, 10],
    [0, 0],
  ]

  it('detects points inside and outside a simple ring', () => {
    expect(pointInRing(5, 5, square)).toBe(true)
    expect(pointInRing(15, 5, square)).toBe(false)
  })

  it('handles concave shapes', () => {
    expect(pointInRing(2, 8, lShape)).toBe(true)
    expect(pointInRing(8, 8, lShape)).toBe(false) // in the missing corner
  })
})

describe('bboxOf', () => {
  it('covers the outer rings of every polygon (holes ignored)', () => {
    const polygons: Position[][][] = [
      [
        [
          [-79.4, 43.6],
          [-79.3, 43.6],
          [-79.3, 43.7],
          [-79.4, 43.6],
        ],
        [
          [-79.39, 43.61],
          [-79.31, 43.61],
          [-79.39, 43.61],
        ],
      ],
      [
        [
          [-79.5, 43.65],
          [-79.45, 43.8],
          [-79.5, 43.65],
        ],
      ],
    ]
    expect(bboxOf(polygons)).toEqual({ west: -79.5, south: 43.6, east: -79.3, north: 43.8 })
  })
})

describe('defaultRange', () => {
  it('uses a fixed distance for points', () => {
    expect(defaultRange({ type: 'point', lon: -79.38, lat: 43.65 })).toBe(600)
  })

  it('never goes closer than 450 m or further than 8 km', () => {
    const tiny = { type: 'area' as const, west: -79.3801, south: 43.6501, east: -79.38, north: 43.6502 }
    const huge = { type: 'area' as const, west: -79.64, south: 43.58, east: -79.11, north: 43.86 }
    expect(defaultRange(tiny)).toBe(450)
    expect(defaultRange(huge)).toBe(8000)
  })

  it('scales with the size of the area in between', () => {
    const block = { type: 'area' as const, west: -79.39, south: 43.65, east: -79.38, north: 43.655 }
    const range = defaultRange(block)
    expect(range).toBeGreaterThan(450)
    expect(range).toBeLessThan(8000)
  })
})
