import { describe, expect, it } from 'vitest'
import { configProblem, DEFAULT_SIM_CONFIG, drainFactor, parseSimConfig, returnMaxAltM } from './simConfig'

describe('sim config', () => {
  it('accepts the defaults and rejects out-of-range or mis-ordered values', () => {
    expect(configProblem(DEFAULT_SIM_CONFIG)).toBeNull()
    expect(configProblem({ ...DEFAULT_SIM_CONFIG, cruiseMs: 20 })).toMatch(/Cruise speed/)
    expect(configProblem({ ...DEFAULT_SIM_CONFIG, cruiseMs: NaN })).toMatch(/Cruise speed/)
    expect(configProblem({ ...DEFAULT_SIM_CONFIG, batteryCriticalPct: 30 })).toMatch(/low > critical > emergency/)
  })

  it('reads what the bridge reports, defaults for anything missing or the wrong type', () => {
    expect(parseSimConfig(null)).toBeNull()
    const c = parseSimConfig({ cruiseMs: 8, batteryLoad: 'yes', ceilingM: 90 })!
    expect(c.cruiseMs).toBe(8)
    expect(c.batteryLoad).toBe(true)
    expect(c.ceilingM).toBe(90)
    expect(returnMaxAltM(c)).toBe(85)
  })

  it("drains like the bridge's drain_factor", () => {
    // Same values the bridge's curve gives (sim/bridge/bridge.py drain_factor).
    expect(drainFactor(false, 0, 0)).toBe(0.3)
    expect(drainFactor(true, 0, 0)).toBe(1)
    expect(drainFactor(true, 2, 0)).toBeCloseTo(1.5)
    expect(drainFactor(true, 4, 0)).toBeCloseTo(2)
    expect(drainFactor(true, -2, 0)).toBeCloseTo(0.84)
    expect(drainFactor(true, 0, 8)).toBeCloseTo(0.9)
    expect(drainFactor(true, 0, 15)).toBeCloseTo(1.18)
  })
})
