import { describe, expect, it } from 'vitest'
import { DEFAULT_SIM_CONFIG } from './simConfig'
import { checkBattery, estimateReturn, estimateRoute, formatDistance, missionPoints, returnSteps, formatDuration, formatLatLon, legCrossings, routeSteps, type RouteStart } from './routePlan'

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
    expect(formatLatLon(43.652551, -79.3833)).toBe('43.6526, -79.3833')
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

describe('battery estimate', () => {
  const config = { ...DEFAULT_SIM_CONFIG }

  it('uses about 5% a minute while hovering (20-minute battery)', () => {
    // A 1.2 km leg at 4 m/s is 5 min, slightly cheaper than hovering while cruising.
    const air = { ...ground, relAltM: 30, inAir: true }
    const e = estimateRoute(air, [{ kind: 'fly', stop: 0, dest: { lat: 43.6608, lon: -79.38, label: 'x' }, altM: 30 }], config)
    expect(e.timeS / 60).toBeCloseTo(5.1, 0)
    expect(e.battery).toBeGreaterThan(0.22)
    expect(e.battery).toBeLessThan(0.26)
  })

  it('charges climbs more than descents', () => {
    const up = estimateRoute({ ...ground, relAltM: 10, inAir: true }, [{ kind: 'vertical', altM: 70, lat: 0, lon: 0, atStart: true }], config)
    const down = estimateRoute({ ...ground, relAltM: 70, inAir: true }, [{ kind: 'vertical', altM: 10, lat: 0, lon: 0, atStart: true }], config)
    expect(up.battery / up.timeS).toBeGreaterThan(down.battery / down.timeS)
  })

  it('a fixed drain ignores the load', () => {
    const fixed = { ...config, batteryLoad: false }
    const e = estimateRoute({ ...ground, relAltM: 10, inAir: true }, [{ kind: 'vertical', altM: 70, lat: 0, lon: 0, atStart: true }], fixed)
    expect(e.battery).toBeCloseTo(e.timeS / (20 * 60))
  })

  it('flies home like PX4: climb to the return height, cross, descend, land', () => {
    const r = estimateReturn(a, ground, 30, 60, config)
    expect(r.distanceM).toBeGreaterThan(750)
    // 30 m up (10 s), ~800 m (~3.5 min), 50 m down to 10 m (33 s), land 10 m (~10 s).
    expect(r.timeS).toBeGreaterThan(230)
    expect(r.timeS).toBeLessThan(290)
  })

  it('needs enough to get home with the critical level spare', () => {
    const route = { distanceM: 0, climbM: 0, timeS: 0, battery: 0.5 }
    const home = { distanceM: 0, climbM: 0, timeS: 0, battery: 0.3 }
    expect(checkBattery(1, route, home, config)).toMatchObject({ atEnd: 0.5, ok: true })
    expect(checkBattery(0.9, route, home, config).ok).toBe(false) // 10% home < 15%
  })
})

describe('return home', () => {
  const air = { ...ground, relAltM: 30, inAir: true }
  const home = { lat: ground.lat, lon: ground.lon, label: 'Home' }

  it('flies each leg at its height, then lands at home (no descent first)', () => {
    // Out to a detour turning point at 60 m, then home at 90 m.
    const steps = returnSteps(air, [{ ...a, via: true }, home], [60, 90], 20, true)
    expect(steps.map((s) => s.kind)).toEqual(['vertical', 'fly', 'vertical', 'fly', 'land'])
    expect(steps.at(-1)).toEqual({ kind: 'land', lat: home.lat, lon: home.lon })
    expect(returnSteps(air, [home], [0], 20, false).map((s) => s.kind)).toEqual(['fly'])
  })

  it("gives PX4 points with height changes at a spot, not along a leg", () => {
    const steps = returnSteps(air, [{ ...a, via: true }, home], [60, 90], 20, true)
    expect(missionPoints(air, steps)).toEqual([
      { lat: air.lat, lon: air.lon, relAltM: 60 }, // the drone's spot, at the first leg's height
      { lat: a.lat, lon: a.lon, relAltM: 60 },
      { lat: a.lat, lon: a.lon, relAltM: 90 }, // climb at the turning point
      { lat: home.lat, lon: home.lon, relAltM: 90 },
    ])
  })
})

describe('route endings, hovers and circles', () => {
  // A circle: entry stop `e` with orbit, then its points (the last is back at the entry).
  const e = { lat: 43.66, lon: -79.37, label: 'Circle X', orbit: { lat: 43.6605, lon: -79.37, radiusM: 55, laps: 2, clockwise: true } }
  const p1 = { lat: 43.661, lon: -79.37, label: 'Circling X', via: true, circle: true }
  const p2 = { lat: 43.6605, lon: -79.3693, label: 'Circling X', via: true, circle: true }
  const p3 = { ...e, orbit: undefined, label: 'Circling X', via: true, circle: true }

  it('lands at the last stop instead of descending, when the route ends by landing', () => {
    expect(routeSteps(ground, [a], [80], 40, 'land').slice(-1)).toEqual([{ kind: 'land', lat: a.lat, lon: a.lon }])
  })

  it("doesn't descend at the end when it comes home after (Return climbs anyway)", () => {
    expect(routeSteps(ground, [a], [80], 40, 'return').map((s) => s.kind)).toEqual(['takeoff', 'fly'])
  })

  it('hovers at a stop for as long as asked, and counts it in the time and battery', () => {
    const steps = routeSteps(ground, [{ ...a, hoverS: 30 }, b], [0, 0], 30)
    expect(steps.map((s) => s.kind)).toEqual(['takeoff', 'fly', 'hover', 'fly'])
    expect(steps[2]).toMatchObject({ seconds: 30, lat: a.lat, stop: 0 })
    const without = estimateRoute(ground, routeSteps(ground, [a, b], [0, 0], 30))
    const withHover = estimateRoute(ground, steps)
    expect(withHover.timeS - without.timeS).toBeCloseTo(30, 5)
    expect(withHover.battery - without.battery).toBeCloseTo(30 / (DEFAULT_SIM_CONFIG.batteryMin * 60), 5)
  })

  it('flies a circle as one orbit, at the height that clears all its legs', () => {
    const steps = routeSteps(ground, [e, p1, p2, p3, b], [30, 30, 70, 40, 30], 30)
    expect(steps.map((s) => s.kind)).toEqual(['takeoff', 'fly', 'vertical', 'orbit', 'vertical', 'fly'])
    expect(steps[2]).toMatchObject({ altM: 70, lat: e.lat })
    expect(steps[3]).toMatchObject({ kind: 'orbit', lat: e.orbit.lat, radiusM: 55, laps: 2, clockwise: true, altM: 70, stop: 3 })
    // Time: two laps of the circle, not the points' chords.
    const est = estimateRoute(ground, steps)
    expect(est.distanceM).toBeGreaterThan(2 * 2 * Math.PI * 55)
  })

  it('flies the points instead when a detour was added between them (the circle bent round a tower)', () => {
    const detour = { lat: 43.6612, lon: -79.3695, label: 'Detour to Circling X', via: true }
    const steps = routeSteps(ground, [e, p1, detour, p2, p3], [30, 30, 30, 30, 30], 30)
    expect(steps.some((s) => s.kind === 'orbit')).toBe(false)
    expect(steps.filter((s) => s.kind === 'fly')).toHaveLength(5)
  })

  it('hovers after a circle when asked', () => {
    const steps = routeSteps(ground, [e, p1, p2, { ...p3, hoverS: 10 }], [30, 30, 30, 30], 30)
    expect(steps.map((s) => s.kind)).toEqual(['takeoff', 'fly', 'orbit', 'hover'])
  })
})
