import { describe, expect, it } from 'vitest'
import { DEFAULT_SPEEDS, velocityFromKeys, ZERO } from './keyboardFlight'

const keys = (...codes: string[]) => new Set(codes)
const { horizontalMs: H, verticalMs: V, yawRateDegS: Y } = DEFAULT_SPEEDS

describe('velocityFromKeys', () => {
  it('hovers with no keys held', () => {
    expect(velocityFromKeys(keys())).toEqual(ZERO)
  })

  it('maps WASD to forward/back and sideways', () => {
    expect(velocityFromKeys(keys('KeyW')).forwardMs).toBe(H)
    expect(velocityFromKeys(keys('KeyS')).forwardMs).toBe(-H)
    expect(velocityFromKeys(keys('KeyD')).rightMs).toBe(H)
    expect(velocityFromKeys(keys('KeyA')).rightMs).toBe(-H)
  })

  it('accepts arrow keys for forward/back and turning', () => {
    expect(velocityFromKeys(keys('ArrowUp')).forwardMs).toBe(H)
    expect(velocityFromKeys(keys('ArrowLeft')).yawRateDegS).toBe(-Y)
    expect(velocityFromKeys(keys('KeyE')).yawRateDegS).toBe(Y)
  })

  it('climbs with Space and descends with Shift (down is positive, as PX4 expects)', () => {
    expect(velocityFromKeys(keys('Space')).downMs).toBe(-V)
    expect(velocityFromKeys(keys('ShiftLeft')).downMs).toBe(V)
    expect(velocityFromKeys(keys('ShiftRight')).downMs).toBe(V)
  })

  it('cancels out opposite keys', () => {
    expect(velocityFromKeys(keys('KeyW', 'KeyS')).forwardMs).toBe(0)
    expect(velocityFromKeys(keys('Space', 'ShiftLeft')).downMs).toBe(0)
  })

  it("doesn't go faster diagonally", () => {
    const v = velocityFromKeys(keys('KeyW', 'KeyD'))
    expect(Math.hypot(v.forwardMs, v.rightMs)).toBeCloseTo(H)
  })

  it('ignores unrelated keys', () => {
    expect(velocityFromKeys(keys('KeyG', 'KeyM', 'KeyC'))).toEqual(ZERO)
  })
})
