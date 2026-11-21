import { describe, expect, it } from 'vitest'
import { distanceM } from '../places/geo'
import { DemoFlight, DOWNTOWN_DEMO } from './demoFlight'
import type { DroneState } from './types'

/** Runs the whole demo at 20 Hz and returns every state. */
function fly(maxSeconds = 1200): DroneState[] {
  const flight = new DemoFlight(DOWNTOWN_DEMO)
  flight.start()
  const states: DroneState[] = []
  for (let t = 0; t < maxSeconds && !flight.finished; t += 0.05) {
    flight.step(0.05)
    states.push(flight.state())
  }
  return states
}

describe('DemoFlight', () => {
  const states = fly()
  const last = states[states.length - 1]
  const { home } = DOWNTOWN_DEMO

  it('starts on the ground at home, disarmed', () => {
    const s = new DemoFlight(DOWNTOWN_DEMO).state()
    expect(s.inAir).toBe(false)
    expect(s.armed).toBe(false)
    expect(s.relAltM).toBe(0)
    expect(s.altAmslM).toBe(home.altAmslM)
  })

  it('completes the flight and lands back at home, disarmed', () => {
    expect(last.flightMode).toBe('Landed')
    expect(last.armed).toBe(false)
    expect(last.relAltM).toBe(0)
    expect(distanceM(last.lon, last.lat, home.lon, home.lat)).toBeLessThan(5)
  })

  it('takes a few minutes, like the real route would', () => {
    const minutes = last.timeMs / 60_000
    expect(minutes).toBeGreaterThan(2)
    expect(minutes).toBeLessThan(10)
  })

  it('passes close to every waypoint', () => {
    for (const wp of DOWNTOWN_DEMO.waypoints) {
      const closest = Math.min(...states.map((s) => distanceM(s.lon, s.lat, wp.lon, wp.lat)))
      expect(closest, wp.label).toBeLessThan(5)
    }
  })

  it('goes through takeoff, mission, return and land in order', () => {
    const modes = states.map((s) => s.flightMode).filter((m, i, all) => m !== all[i - 1])
    expect(modes).toEqual(['Takeoff', 'Mission', 'Return', 'Land', 'Landed'])
  })

  it('stays within quadcopter limits', () => {
    for (const s of states) {
      expect(s.groundSpeedMs).toBeLessThanOrEqual(12.01)
      expect(Math.abs(s.climbRateMs)).toBeLessThanOrEqual(3.01)
      expect(Math.abs(s.rollDeg)).toBeLessThanOrEqual(25)
      expect(Math.abs(s.pitchDeg)).toBeLessThanOrEqual(25)
      expect(s.relAltM).toBeGreaterThanOrEqual(0)
      expect(s.headingDeg).toBeGreaterThanOrEqual(0)
      expect(s.headingDeg).toBeLessThan(360)
    }
  })

  it('stays below the 122 m (400 ft) drone ceiling', () => {
    expect(Math.max(...states.map((s) => s.relAltM))).toBeLessThan(122)
  })

  it('tilts nose-down when speeding up while facing where it is going', () => {
    // Like PX4, it may start moving before it has turned to face the waypoint
    // (then it is accelerating backwards and tilts nose-up), so only check once aligned.
    const travelDeg = (s: DroneState, prev: DroneState) =>
      ((Math.atan2((s.lon - prev.lon) * Math.cos((s.lat * Math.PI) / 180), s.lat - prev.lat) * 180) / Math.PI + 360) % 360
    const accelerating = states.filter((s, i) => {
      if (i === 0 || s.flightMode !== 'Mission') return false
      const prev = states[i - 1]
      const facing = Math.abs(((s.headingDeg - travelDeg(s, prev) + 540) % 360) - 180) < 15
      return facing && s.groundSpeedMs - prev.groundSpeedMs > 0.1
    })
    expect(accelerating.length).toBeGreaterThan(0)
    for (const s of accelerating) expect(s.pitchDeg).toBeLessThan(0)
  })

  it('drains the battery while flying', () => {
    expect(last.battery).toBeLessThan(1)
    expect(last.battery).toBeGreaterThan(0.2)
  })
})
