import { describe, expect, it } from 'vitest'
import { BatteryEstimator, batteryLevel, formatMinutes } from './battery'

describe('batteryLevel', () => {
  it('matches PX4: warn at 25%, Return at 15%, land at 5%', () => {
    expect(batteryLevel(0.8)).toBe('ok')
    expect(batteryLevel(0.25)).toBe('low')
    expect(batteryLevel(0.12)).toBe('critical')
    expect(batteryLevel(0.05)).toBe('emergency')
  })
})

describe('BatteryEstimator', () => {
  // 20 minutes from full to empty: 5% a minute.
  const drain = (tMs: number) => 1 - tMs / 1_200_000

  it('has no estimate for the first few seconds', () => {
    const e = new BatteryEstimator()
    for (let t = 0; t <= 5000; t += 500) expect(e.update(t, drain(t), true).minToLand).toBeNull()
  })

  it('estimates minutes until Return and landing from the drain rate', () => {
    const e = new BatteryEstimator()
    let info = e.update(0, 1, true)
    for (let t = 0; t <= 120_000; t += 500) info = e.update(t, drain(t), true)
    // At 2 min: 90% left, 5%/min → 15 min to 15%, 17 min to 5%.
    expect(info.minToReturn).toBeCloseTo(15, 1)
    expect(info.minToLand).toBeCloseTo(17, 1)
  })

  it('starts over when the drone disarms (PX4 refills the battery)', () => {
    const e = new BatteryEstimator()
    for (let t = 0; t <= 60_000; t += 500) e.update(t, drain(t), true)
    expect(e.update(61_000, 1, false).minToLand).toBeNull()
    expect(e.update(62_000, 1, true).minToLand).toBeNull()
  })

  it('reports the level even without an estimate', () => {
    expect(new BatteryEstimator().update(0, 0.1, true)).toEqual({ level: 'critical', minToReturn: null, minToLand: null })
  })
})

describe('formatMinutes', () => {
  it('rounds to whole minutes', () => {
    expect(formatMinutes(11.6)).toBe('about 12 min')
    expect(formatMinutes(0.4)).toBe('under a minute')
  })
})
