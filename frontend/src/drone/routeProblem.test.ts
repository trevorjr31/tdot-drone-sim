import { describe, expect, it } from 'vitest'
import { crossingAltM, routeProblem, type RouteCheckInfo } from './useDrone'

// The route crosses a building that needs 99 m; the destination itself needs 20 m.
const check: Extract<RouteCheckInfo, { status: 'done' }> = {
  status: 'done',
  minSafeRelAltM: 99,
  highest: { name: 'Old City Hall', heightM: 91 },
  destMinSafeRelAltM: 20,
  destHighest: { name: 'Podium', heightM: 8 },
  legMinSafeM: [99],
  returnMinSafeM: 99,
  path: [{ lat: 43.65, lon: -79.38, label: 'Destination' }],
  detours: [],
}

describe('routeProblem', () => {
  it('allows any end height that clears the destination (the autopilot picks the crossing height)', () => {
    expect(routeProblem(check, 40)).toBeNull()
    expect(routeProblem(check, 20)).toBeNull()
  })

  it('refuses an end height too low for the destination', () => {
    expect(routeProblem(check, 10)).toEqual({ kind: 'destination', needM: 20 })
  })

  it('refuses routes that need more than the ceiling', () => {
    expect(routeProblem({ ...check, minSafeRelAltM: 140 }, 120)?.kind).toBe('ceiling')
  })
})

describe('crossingAltM', () => {
  it('climbs above the chosen height when buildings on the way need it', () => {
    expect(crossingAltM(40, null, 99)).toBe(99)
  })

  it('from the air, never descends before arriving', () => {
    expect(crossingAltM(40, 105, 99)).toBe(105)
  })

  it('uses the chosen height when it already clears everything', () => {
    expect(crossingAltM(60, 30, 20)).toBe(60)
  })
})
