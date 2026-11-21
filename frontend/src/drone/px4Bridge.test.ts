import { describe, expect, it } from 'vitest'
import { parseServerMessage } from './px4Bridge'

const state = {
  timeMs: 1000,
  lat: 43.65255,
  lon: -79.3833,
  altAmslM: 92,
  relAltM: 0,
  headingDeg: 12,
  rollDeg: 0,
  pitchDeg: 0,
  groundSpeedMs: 0,
  climbRateMs: 0,
  battery: 1,
  armed: false,
  inAir: false,
  flightMode: 'Hold',
  home: { lat: 43.65255, lon: -79.3833, altAmslM: 92 },
}

describe('parseServerMessage', () => {
  it('accepts the bridge message types', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'state', state }))).toEqual({ type: 'state', state })
    expect(parseServerMessage('{"type":"status","px4Connected":true,"px4Version":"1.16.2"}')?.type).toBe('status')
    expect(parseServerMessage('{"type":"ack","id":"abc","ok":false,"error":"Arming denied"}')?.type).toBe('ack')
    expect(parseServerMessage('{"type":"notice","level":"error","message":"Take off first"}')?.type).toBe('notice')
  })

  it('rejects malformed or unknown messages instead of crashing the view', () => {
    expect(parseServerMessage('not json')).toBeNull()
    expect(parseServerMessage('{"type":"bogus"}')).toBeNull()
    expect(parseServerMessage('null')).toBeNull()
    expect(parseServerMessage(JSON.stringify({ type: 'state', state: { ...state, lat: 'north' } }))).toBeNull()
    expect(parseServerMessage(JSON.stringify({ type: 'state', state: { ...state, armed: undefined } }))).toBeNull()
  })

  it('rejects states with NaN or infinite numbers (PX4 sends NaN before a GPS fix)', () => {
    // JSON can't carry NaN, so the bridge would send null; make sure that's rejected too.
    expect(parseServerMessage(JSON.stringify({ type: 'state', state: { ...state, lat: null } }))).toBeNull()
  })
})
