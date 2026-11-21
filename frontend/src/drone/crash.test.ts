import { describe, expect, it } from 'vitest'
import { crashState, WRECK_HEIGHT_M, type CrashSite } from './crash'

const site: CrashSite = { lat: 43.651, lon: -79.384, altAmslM: 122, groundAmslM: 92, headingDeg: 190 }
const fallSeconds = Math.sqrt((2 * (122 - 92 - WRECK_HEIGHT_M)) / 9.81) // ≈ 2.46 s from 30 m

describe('crashState', () => {
  it('starts at the impact point, disarmed and marked as crashed', () => {
    const s = crashState(site, 0, null)
    expect(s.lat).toBe(site.lat)
    expect(s.lon).toBe(site.lon)
    expect(s.altAmslM).toBe(122)
    expect(s.armed).toBe(false)
    expect(s.flightMode).toBe('Crashed')
  })

  it('falls under gravity without moving sideways (it stays at the wall)', () => {
    const s = crashState(site, 1000, null)
    expect(s.altAmslM).toBeCloseTo(122 - 0.5 * 9.81, 1)
    expect(s.lat).toBe(site.lat)
    expect(s.lon).toBe(site.lon)
    expect(s.inAir).toBe(true)
  })

  it('comes to rest on the ground after the fall time, and stays there', () => {
    const landed = crashState(site, (fallSeconds + 0.1) * 1000, null)
    const later = crashState(site, 60_000, null)
    for (const s of [landed, later]) {
      expect(s.altAmslM).toBeCloseTo(92 + WRECK_HEIGHT_M)
      expect(s.inAir).toBe(false)
      expect(s.climbRateMs).toBe(0)
    }
    expect(later.rollDeg).toBe(landed.rollDeg) // lying still
  })

  it('keeps battery and home from the live source', () => {
    const live = { ...crashState(site, 0, null), battery: 0.42, home: { lat: 43.65, lon: -79.38, altAmslM: 92 } }
    const s = crashState(site, 500, live)
    expect(s.battery).toBe(0.42)
    expect(s.home).toEqual(live.home)
    expect(s.relAltM).toBeCloseTo(s.altAmslM - 92)
  })
})
