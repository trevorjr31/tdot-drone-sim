import { describe, expect, it } from 'vitest'
import { PLACE_CATEGORIES, type NearbyResult } from '../places/nearby'
import {
  BLOCK_M,
  bendCircles,
  COMPOSE_ACTIONS,
  COMPOSE_DIRECTIONS,
  COMPOSE_PLACE_KINDS,
  COMPOSE_UNITS,
  compilePlan,
  parseComposePlan,
  directionBearing,
  type ComposeLookups,
  type ComposePlan,
  type ComposeStart,
  type ComposeStep,
} from './routeCompose'
import { ROUTE_CORRIDOR_M } from './routeSafety'
// The bridge's side (it builds the JSON schema Claude answers in), checked against ours below.
import py from '../../../sim/bridge/compose.py?raw'

const LAT = 43.65
const LON = -79.38
const M_LAT = 1 / 110_574
const M_LON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180))
/** A point `x` m east and `y` m north of (LAT, LON). */
const at = (x: number, y: number) => ({ lat: LAT + y * M_LAT, lon: LON + x * M_LON })
/** Where a point is, in metres east/north of (LAT, LON). */
const xy = (p: { lat: number; lon: number }) => [(p.lon - LON) / M_LON, (p.lat - LAT) / M_LAT]

const START: ComposeStart = { ...at(0, 0), headingDeg: 0, home: at(0, 0), ceilingM: 120 }

const EATON = at(400, 600)
const lookups = (over: Partial<ComposeLookups> = {}): ComposeLookups => ({
  findPlace: async (name) => (/eaton/i.test(name) ? { ...EATON, label: 'CF Toronto Eaton Centre' } : null),
  findNearest: async (category) =>
    category === 'hospital'
      ? [{ category, name: "St. Michael's Hospital", ...at(-300, 900), radiusM: 110, distanceM: 949, edgeDistanceM: 839 } as NearbyResult]
      : [],
  buildingAround: async () => ({ centre: EATON, radiusM: 120 }),
  ...over,
})

/** A step with every unused field null, as Claude sends them. */
function step(action: ComposeStep['action'], fields: Partial<ComposeStep> = {}): ComposeStep {
  return {
    action,
    place_kind: null,
    place: null,
    category: null,
    direction: null,
    distance: null,
    unit: null,
    radius_m: null,
    laps: null,
    clockwise: null,
    rel_alt_m: null,
    seconds: null,
    ...fields,
  }
}
const plan = (...steps: ComposeStep[]): ComposePlan => ({ summary: '', questions: [], steps })

async function compiled(p: ComposePlan, l = lookups(), s = START) {
  const result = await compilePlan(p, s, l)
  if (!result.ok) throw new Error(result.problems.join('; '))
  return result.route
}

describe('compilePlan', () => {
  it('"go north 100m, go in a circle 20m in radius, go back home"', async () => {
    const route = await compiled(
      plan(
        step('move', { direction: 'north', distance: 100, unit: 'm' }),
        step('circle', { place_kind: 'here', radius_m: 20, laps: 1 }),
        step('return_home'),
      ),
    )
    const real = route.stops.filter((s) => !s.via)
    expect(real.map((s) => s.label)).toEqual(['100 m north', 'Circle (20 m radius)'])
    expect(xy(real[0])[0]).toBeCloseTo(0, 3)
    expect(xy(real[0])[1]).toBeCloseTo(100, 3)

    // The circle: centred on where the drone was (100 m north), every point 20 m out, back to the start.
    const [circle] = route.circles
    expect(xy(circle.centre)[1]).toBeCloseTo(100, 3)
    const pts = route.stops.slice(circle.firstStop, circle.lastStop + 1)
    expect(pts.length).toBeGreaterThanOrEqual(9) // entry + at least 8 turning points
    for (const p of pts) {
      const [x, y] = xy(p)
      expect(Math.hypot(x, y - 100)).toBeCloseTo(20, 1)
    }
    const [ex, ey] = xy(pts[0])
    const [lx, ly] = xy(pts[pts.length - 1])
    expect(Math.hypot(ex - lx, ey - ly)).toBeLessThan(0.01)
    expect(pts.slice(1).every((p) => p.via && p.circle)).toBe(true)
    // Flown as an orbit round the centre.
    expect(pts[0].orbit).toMatchObject({ radiusM: 20, laps: 1, clockwise: true })
    expect(xy(pts[0].orbit!)[1]).toBeCloseTo(100, 3)
    expect(route.ending).toBe('return')
  })

  it('"go to the eaton centre, circle around it, go two blocks north and then land"', async () => {
    const route = await compiled(
      plan(
        step('fly_to', { place_kind: 'name', place: 'Eaton Centre' }),
        step('circle', { place_kind: 'name', place: 'Eaton Centre', laps: 1, clockwise: true }),
        step('move', { direction: 'north', distance: 2, unit: 'blocks' }),
        step('land'),
      ),
    )
    const real = route.stops.filter((s) => !s.via)
    // Straight to the circle: it doesn't fly over the Eaton Centre's middle first.
    expect(real.map((s) => s.label)).toEqual([
      'Circle CF Toronto Eaton Centre (145 m radius)',
      `2 blocks (${2 * BLOCK_M} m) north`,
    ])
    const [circle] = route.circles
    // Sized to the building (120 m) plus the corridor and a margin, rounded up to 5 m.
    expect(circle.radiusM).toBe(Math.ceil((120 + ROUTE_CORRIDOR_M + 10) / 5) * 5)
    expect(xy(circle.centre)).toEqual(xy(EATON))
    // Entered on the side facing the drone (it comes from the south-west).
    const [ex, ey] = xy(route.stops[circle.firstStop])
    expect(ex).toBeLessThan(400)
    expect(ey).toBeLessThan(600)
    // Two blocks north of where the circle ends (its entry point).
    const [mx, my] = xy(real[1])
    expect(mx).toBeCloseTo(ex, 3)
    expect(my).toBeCloseTo(ey + 2 * BLOCK_M, 3)
    expect(route.ending).toBe('land')
  })

  it('"fly to the nearest hospital" looks it up from where the drone will be, and says which', async () => {
    let searchedFrom: { lat: number; lon: number } | null = null
    const route = await compiled(
      plan(step('move', { direction: 'east', distance: 1, unit: 'km' }), step('fly_to', { place_kind: 'nearest', category: 'hospital' })),
      lookups({
        findNearest: async (category, near) => {
          searchedFrom = near
          return [{ category, name: "St. Michael's Hospital", ...at(-300, 900), radiusM: 110, distanceM: 1300, edgeDistanceM: 1190 }]
        },
      }),
    )
    expect(xy(searchedFrom!)[0]).toBeCloseTo(1000, 3)
    expect(route.stops[1].label).toBe("St. Michael's Hospital")
    expect(route.notes).toEqual(["Nearest hospital: St. Michael's Hospital, 1.3 km away"])
    expect(route.ending).toBe('hover')
  })

  it('moves forward, left and right from the way the drone is heading', async () => {
    const route = await compiled(
      plan(
        step('move', { direction: 'forward', distance: 100, unit: 'm' }), // heading east: 100 m east
        step('move', { direction: 'left', distance: 50, unit: 'm' }), // now facing east: left is north
      ),
      lookups(),
      { ...START, headingDeg: 90 },
    )
    expect(xy(route.stops[0])[0]).toBeCloseTo(100, 3)
    const [x, y] = xy(route.stops[1])
    expect(x).toBeCloseTo(100, 3)
    expect(y).toBeCloseTo(50, 3)
    expect(directionBearing('back', 350)).toBe(170)
  })

  it('takes a height before setting off, and hovers', async () => {
    const route = await compiled(
      plan(step('height', { rel_alt_m: 50 }), step('fly_to', { place: 'Eaton Centre', place_kind: 'name' }), step('hover', { seconds: 30 })),
    )
    expect(route.altM).toBe(50)
    expect(route.stops[0].hoverS).toBe(30)
  })

  it('centres the circle on the building, not the address point at its entrance', async () => {
    const route = await compiled(
      plan(step('circle', { place: 'Eaton Centre', place_kind: 'name' })),
      lookups({ buildingAround: async () => ({ centre: at(400, 700), radiusM: 50 }) }),
    )
    expect(xy(route.circles[0].centre)).toEqual(xy(at(400, 700)))
    expect(route.circles[0].radiusM).toBe(75)
  })

  it('circles a place as many times as asked, the other way round when asked', async () => {
    const route = await compiled(plan(step('circle', { place: 'Eaton Centre', place_kind: 'name', laps: 2, clockwise: false, radius_m: 60 })))
    const [c] = route.circles
    expect(c).toMatchObject({ radiusM: 60, laps: 2, clockwise: false })
    expect(route.stops.filter((s) => s.via)).toHaveLength(2 * 13) // 2π·60 / 30 m ≈ 13 points a lap
    // Anticlockwise seen from above: the bearing from the centre goes down.
    const b = (p: { lat: number; lon: number }) => {
      const [x, y] = xy(p)
      const [cx, cy] = xy(c.centre)
      return Math.atan2(x - cx, y - cy)
    }
    const d = b(route.stops[1]) - b(route.stops[0])
    expect(Math.sin(d)).toBeLessThan(0)
  })

  it('reports every problem together', async () => {
    const result = await compilePlan(
      plan(
        step('fly_to', { place_kind: 'name', place: 'Atlantis' }),
        step('move', { direction: 'north', distance: null }),
        step('fly_to', { place_kind: 'nearest', category: 'stadium' }),
        step('height', { rel_alt_m: 200 }),
      ),
      START,
      lookups(),
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        'Step 1: couldn\'t find "Atlantis".',
        'Step 2: how far?',
        "Step 3: couldn't find a stadium nearby.",
        'Step 4: 200 m is above the 120 m ceiling.',
      ],
    })
  })

  it('refuses a height change partway through', async () => {
    const result = await compilePlan(
      plan(step('move', { direction: 'north', distance: 25, unit: 'm' }), step('height', { rel_alt_m: 60 })),
      START,
      lookups(),
    )
    expect(result).toEqual({
      ok: false,
      problems: ["Step 2: changing height partway through a route isn't supported yet; give one height for the whole route."],
    })
  })

  it('labels moves with the distance given, not rounded', async () => {
    const route = await compiled(plan(step('move', { direction: 'west', distance: 25, unit: 'm' }), step('move', { direction: 'south', distance: 1.25, unit: 'km' })))
    expect(route.stops.map((s) => s.label)).toEqual(['25 m west', '1.25 km south'])
  })

  it('refuses steps after landing or going home, and too many stops', async () => {
    const after = await compilePlan(plan(step('land'), step('move', { direction: 'north', distance: 10, unit: 'm' })), START, lookups())
    expect(after.ok).toBe(false)
    const many = Array.from({ length: 9 }, () => step('move', { direction: 'north', distance: 50, unit: 'm' }))
    const tooMany = await compilePlan(plan(...many), START, lookups())
    expect(tooMany).toEqual({ ok: false, problems: ["That's 9 stops; a route can have at most 8."] })
  })

  it('refuses circles too big to size automatically, and absurd moves', async () => {
    const park = await compilePlan(plan(step('circle', { place: 'Eaton Centre', place_kind: 'name' })), START, lookups({ buildingAround: async () => ({ centre: EATON, radiusM: 2000 }) }))
    expect(park.ok).toBe(false)
    const far = await compilePlan(plan(step('move', { direction: 'north', distance: 50, unit: 'km' })), START, lookups())
    expect(far.ok).toBe(false)
  })

  it('"just go home" is a route of its own', async () => {
    const route = await compiled(plan(step('return_home')))
    expect(route.stops).toEqual([])
    expect(route.ending).toBe('return')
  })
})

describe('parseComposePlan', () => {
  it('accepts a plan from the bridge, filling missing fields with null', () => {
    const p = parseComposePlan({
      summary: 'Go north.',
      questions: [],
      steps: [{ action: 'move', direction: 'north', distance: 100, unit: 'm' }],
    })
    expect(p).toEqual({
      summary: 'Go north.',
      questions: [],
      steps: [step('move', { direction: 'north', distance: 100, unit: 'm' })],
    })
  })

  it('rejects anything with a value the app does not know', () => {
    expect(parseComposePlan(null)).toBeNull()
    expect(parseComposePlan({ steps: [], questions: 'x' })).toBeNull()
    expect(parseComposePlan({ steps: [{ action: 'teleport' }], questions: [] })).toBeNull()
    expect(parseComposePlan({ steps: [{ action: 'fly_to', place_kind: 'nearest', category: 'aquarium' }], questions: [] })).toBeNull()
    expect(parseComposePlan({ steps: [{ action: 'move', direction: 'up', distance: 5 }], questions: [] })).toBeNull()
    expect(parseComposePlan({ steps: [{ action: 'move', direction: 'north', distance: '5' }], questions: [] })).toBeNull()
  })
})

describe('the bridge asks Claude for the same steps', () => {
  // sim/bridge/compose.py builds the JSON schema Claude answers in; its lists must match ours.
  const list = (name: string) => {
    const m = new RegExp(`^${name} = \\[([^\\]]*)\\]`, 'm').exec(py)
    if (!m) throw new Error(`${name} not found in compose.py`)
    return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])
  }
  it.each([
    ['ACTIONS', COMPOSE_ACTIONS],
    ['PLACE_KINDS', COMPOSE_PLACE_KINDS],
    ['CATEGORIES', PLACE_CATEGORIES],
    ['DIRECTIONS', COMPOSE_DIRECTIONS],
    ['UNITS', COMPOSE_UNITS],
  ])('%s', (name, ours) => {
    expect(list(name)).toEqual([...ours])
  })

  it('every step field', () => {
    const block = /^STEP_FIELDS = \{([\s\S]*?)^\}/m.exec(py)?.[1] ?? ''
    const fields = [...block.matchAll(/^ {4}"([a-z_]+)":/gm)].map((x) => x[1])
    expect(fields).toEqual(Object.keys(step('land')))
  })
})

describe('bendCircles', () => {
  async function circleRoute() {
    return compiled(
      plan(step('move', { direction: 'north', distance: 50, unit: 'm' }), step('circle', { place_kind: 'here', radius_m: 60 }), step('land')),
    )
  }
  it('leaves the circle alone when nothing is in the way', async () => {
    const route = await circleRoute()
    const r = (await bendCircles(route, async () => false))!
    expect(r.bent).toBe(false)
    expect(r.stops).toEqual(route.stops)
  })

  it('leaves out blocked points, and starts at the next clear one when the entry is blocked', async () => {
    const route = await circleRoute()
    // Enter on the east side: the drone comes from the east.
    const fromEast = await compiled(
      plan(step('circle', { place_kind: 'name', place: 'Eaton Centre', radius_m: 60 })),
      lookups({ buildingAround: async () => null }),
      { ...START, ...at(400 + 300, 600) },
    )
    for (const r0 of [route, fromEast]) {
      // A tower on the east side of the circle.
      const cx = xy(r0.circles[0].centre)[0]
      const east = (p: { lat: number; lon: number }) => xy(p)[0] > cx + 30
      const r = (await bendCircles(r0, async (p) => east(p)))!
      expect(r.bent).toBe(true)
      expect(r.stops.some(east)).toBe(false)
      // Bent: flown point to point, not as an orbit.
      expect(r.stops.some((p) => p.orbit)).toBe(false)
      // Still one labelled stop for the circle, closing back on itself.
      const real = r.stops.filter((p) => !p.via && p.label.startsWith('Circle'))
      expect(real).toHaveLength(1)
      expect(xy(r.stops[r.stops.length - 1])).toEqual(xy(real[0]))
      expect(r.stops.length).toBeLessThan(r0.stops.length)
    }
  })

  it('gives up when the whole circle is blocked', async () => {
    expect(await bendCircles(await circleRoute(), async () => true)).toBeNull()
  })
})
