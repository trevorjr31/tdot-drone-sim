import { describe, expect, it } from 'vitest'
import { estimateRoute, formatDistance, formatDuration, legCrossings, routeSteps, type RouteStart } from './routePlan'

const ground: RouteStart = { lat: 43.65, lon: -79.38, relAltM: 0, inAir: false }
// About 800 m east, then 800 m north of that.
const a = { lat: 43.65, lon: -79.37, label: 'A' }
const b = { lat: 43.6572, lon: -79.37, label: 'B' }

describe('routeSteps', () => {
  it('takes off to the first crossing height, flies, then descends to the chosen height', () => {
    expect(routeSteps(ground, [a], [80], 40)).toEqual([
      { kind: 'takeoff', altM: 80 },
      { kind: 'fly', stop: 0, dest: a, altM: 80 },
      { kind: 'vertical', altM: 40, lat: a.lat, lon: a.lon, atStart: false },
    ])
  })

  it('changes height over each stop for the next leg', () => {
    const steps = routeSteps(ground, [a, b], [0, 90], 50)
    expect(steps.map((s) => s.kind)).toEqual(['takeoff', 'fly', 'vertical', 'fly', 'vertical'])
    expect(steps[2]).toEqual({ kind: 'vertical', altM: 90, lat: a.lat, lon: a.lon, atStart: false })
    expect(steps[4]).toMatchObject({ altM: 50 })
  })

  it('from the air, never descends before the first leg', () => {
    const air = { ...ground, relAltM: 70, inAir: true }
    expect(legCrossings(air, [0, 0], 40)).toEqual([70, 40])
    expect(routeSteps(air, [a], [0], 40).map((s) => s.kind)).toEqual(['fly', 'vertical'])
  })

  it('climbs on the spot first when the first leg needs it', () => {
    const air = { ...ground, relAltM: 30, inAir: true }
    expect(routeSteps(air, [a], [60], 60)[0]).toEqual({ kind: 'vertical', altM: 60, lat: ground.lat, lon: ground.lon, atStart: true })
  })
})

describe('estimateRoute', () => {
  it('adds up the legs and the height changes', () => {
    const e = estimateRoute(ground, routeSteps(ground, [a, b], [0, 0], 30))
    expect(e.distanceM).toBeGreaterThan(1550)
    expect(e.distanceM).toBeLessThan(1650)
    expect(e.climbM).toBe(30)
    // ~1.6 km at 4 m/s ≈ 6.7 min, plus the take-off (~22 s) and settling at the stops.
    expect(e.timeS / 60).toBeGreaterThan(6.5)
    expect(e.timeS / 60).toBeLessThan(8)
  })
})

describe('formatting', () => {
  it('reads naturally', () => {
    expect(formatDistance(843)).toBe('840 m')
    expect(formatDistance(2440)).toBe('2.4 km')
    expect(formatDuration(42)).toBe('40 s')
    expect(formatDuration(370)).toBe('6 min')
    expect(formatDuration(4200)).toBe('1 h 10 min')
  })
})

describe('estimate vs a real flight', () => {
  it('matches a two-stop route flown in the sim (155 s)', () => {
    // Take off to 37 m, 210 m to stop 1, 250 m to stop 2, descend 7 m.
    const steps = [
      { kind: 'takeoff' as const, altM: 37 },
      { kind: 'fly' as const, stop: 0, dest: { lat: 43.65255, lon: -79.3859, label: '1' }, altM: 37 },
      { kind: 'fly' as const, stop: 1, dest: { lat: 43.65480, lon: -79.3859, label: '2' }, altM: 37 },
      { kind: 'vertical' as const, altM: 30, lat: 43.6548, lon: -79.3859, atStart: false },
    ]
    const start = { lat: 43.65255, lon: -79.38330, relAltM: 0, inAir: false }
    expect(estimateRoute(start, steps).timeS).toBeGreaterThan(140)
    expect(estimateRoute(start, steps).timeS).toBeLessThan(170)
  })
})
