import { describe, expect, it } from 'vitest'
import { lerpAngleDeg, StateBuffer } from './interpolate'
import type { DroneState } from './types'

function state(timeMs: number, extra: Partial<DroneState> = {}): DroneState {
  return {
    timeMs,
    lat: 43.65,
    lon: -79.38,
    altAmslM: 100,
    relAltM: 10,
    headingDeg: 0,
    rollDeg: 0,
    pitchDeg: 0,
    groundSpeedMs: 0,
    climbRateMs: 0,
    battery: 1,
    armed: true,
    inAir: true,
    flightMode: 'Mission',
    home: { lat: 43.65, lon: -79.38, altAmslM: 90 },
    ...extra,
  }
}

describe('lerpAngleDeg', () => {
  it('takes the short way round through north', () => {
    expect(lerpAngleDeg(350, 10, 0.5)).toBeCloseTo(0)
    expect(lerpAngleDeg(10, 350, 0.25)).toBeCloseTo(5)
  })

  it('interpolates normally otherwise', () => {
    expect(lerpAngleDeg(90, 180, 0.5)).toBeCloseTo(135)
  })
})

describe('StateBuffer', () => {
  it('returns null before any state arrives', () => {
    expect(new StateBuffer().sample(1000)).toBeNull()
  })

  it('renders slightly in the past, interpolating between samples', () => {
    const buf = new StateBuffer(100)
    buf.push(state(0, { relAltM: 10 }), 1000)
    buf.push(state(50, { relAltM: 20 }), 1050)
    // now=1125 → render time 1025, halfway between the samples
    expect(buf.sample(1125)?.relAltM).toBeCloseTo(15)
  })

  it('holds the newest sample when telemetry stalls', () => {
    const buf = new StateBuffer(100)
    buf.push(state(0, { relAltM: 10 }), 1000)
    buf.push(state(50, { relAltM: 20 }), 1050)
    expect(buf.sample(5000)?.relAltM).toBe(20)
  })

  it('interpolates heading across north without spinning', () => {
    const buf = new StateBuffer(0)
    buf.push(state(0, { headingDeg: 350 }), 0)
    buf.push(state(50, { headingDeg: 10 }), 50)
    expect(buf.sample(25)?.headingDeg).toBeCloseTo(0)
  })

  it('starts over when the source restarts (time goes backwards)', () => {
    const buf = new StateBuffer(0)
    buf.push(state(5000, { relAltM: 80 }), 0)
    buf.push(state(0, { relAltM: 0 }), 10)
    expect(buf.sample(10)?.relAltM).toBe(0)
  })
})
