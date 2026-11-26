/**
 * Routes described in words ("go to the eaton centre, circle around it, go two blocks
 * north and then land"). Claude turns the words into a step list (ComposePlan, below);
 * this file turns that list into a route the planner already knows how to check and fly:
 * stops, with circles as hidden turning points (like detours), plus how it ends.
 *
 * Claude never gives coordinates. Places are looked up here (by name with the geocoder,
 * "the nearest hospital" from the OpenStreetMap place list), and moves, circles and
 * blocks are worked out from where the drone will be at that point in the route.
 */
import { CATEGORY_LABEL, PLACE_CATEGORIES, type NearbyResult, type PlaceCategory } from '../places/nearby'
import type { FlyToTarget } from './droneView'
import { formatDistance, formatLatLon, ROUTE_MAX_STOPS } from './routePlan'
import { ROUTE_CORRIDOR_M, type LatLon } from './routeSafety'

const M_PER_DEG_LAT = 110_574
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

/** A Toronto city block, metres ("go two blocks north"). Downtown blocks run ~100–250 m. */
export const BLOCK_M = 150
/** Longest single move, metres. */
export const MOVE_MAX_M = 10_000
/** Circles: never tighter than this, metres. */
export const CIRCLE_MIN_RADIUS_M = 15
/** Circles sized automatically clear the place's edge by the route corridor plus this, metres. */
const CIRCLE_CLEARANCE_M = 10
/** Circles larger than this need the pilot to give a radius (it's a big place, not a building). */
export const CIRCLE_MAX_AUTO_RADIUS_M = 400
/** Most laps of a circle. */
export const CIRCLE_MAX_LAPS = 5
/** Spacing of the turning points round a circle, metres (between 8 and 16 points a lap). */
const CIRCLE_POINT_SPACING_M = 30
/** Longest hover, seconds. */
export const HOVER_MAX_S = 300
/** Lowest height a route can be flown at, metres above home. */
export const ROUTE_MIN_ALT_M = 5

// --- The step list (what Claude returns: the JSON schema in the bridge mirrors this) ---

export const COMPOSE_ACTIONS = ['fly_to', 'move', 'circle', 'height', 'hover', 'land', 'return_home'] as const
export const COMPOSE_DIRECTIONS = [
  'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest',
  'forward', 'back', 'left', 'right',
] as const
export const COMPOSE_UNITS = ['m', 'km', 'blocks'] as const
export const COMPOSE_PLACE_KINDS = ['name', 'nearest', 'here'] as const

export type ComposeAction = (typeof COMPOSE_ACTIONS)[number]
export type ComposeDirection = (typeof COMPOSE_DIRECTIONS)[number]

/** One step. Every field is present; the ones an action doesn't use are null. */
export type ComposeStep = {
  action: ComposeAction
  /** fly_to, circle: a named place, the nearest place of a category, or the drone's spot ("here"). */
  place_kind: (typeof COMPOSE_PLACE_KINDS)[number] | null
  /** The place's name as the pilot said it ("Eaton Centre"), for place_kind "name". */
  place: string | null
  /** For place_kind "nearest". */
  category: PlaceCategory | null
  /** move */
  direction: ComposeDirection | null
  distance: number | null
  unit: (typeof COMPOSE_UNITS)[number] | null
  /** circle: null to size it to the place. */
  radius_m: number | null
  laps: number | null
  clockwise: boolean | null
  /** height: metres above home. */
  rel_alt_m: number | null
  /** hover */
  seconds: number | null
}

export type ComposePlan = {
  /** The plan restated in one plain sentence. */
  summary: string
  /** Things Claude needs the pilot to clear up first (no steps are flown while there are any). */
  questions: string[]
  steps: ComposeStep[]
}

const STEP_KEYS = [
  'action', 'place_kind', 'place', 'category', 'direction', 'distance', 'unit',
  'radius_m', 'laps', 'clockwise', 'rel_alt_m', 'seconds',
] as const satisfies readonly (keyof ComposeStep)[]

/**
 * A plan from the bridge, checked: the shape, and every enum value one the app knows.
 * (Claude's structured output already matches the bridge's schema; this guards against
 * the two drifting apart.) Null if it isn't a plan.
 */
export function parseComposePlan(raw: unknown): ComposePlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.steps) || !Array.isArray(r.questions)) return null
  const oneOf = (v: unknown, list: readonly string[]) => v === null || v === undefined || (typeof v === 'string' && list.includes(v))
  const num = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v))
  const steps: ComposeStep[] = []
  for (const s of r.steps) {
    if (!s || typeof s !== 'object') return null
    const t = s as Record<string, unknown>
    const ok =
      typeof t.action === 'string' && (COMPOSE_ACTIONS as readonly string[]).includes(t.action) &&
      oneOf(t.place_kind, COMPOSE_PLACE_KINDS) &&
      oneOf(t.category, PLACE_CATEGORIES) &&
      oneOf(t.direction, COMPOSE_DIRECTIONS) &&
      oneOf(t.unit, COMPOSE_UNITS) &&
      (t.place == null || typeof t.place === 'string') &&
      (t.clockwise == null || typeof t.clockwise === 'boolean') &&
      [t.distance, t.radius_m, t.laps, t.rel_alt_m, t.seconds].every(num)
    if (!ok) return null
    steps.push(Object.fromEntries(STEP_KEYS.map((k) => [k, t[k] ?? null])) as ComposeStep)
  }
  return {
    summary: typeof r.summary === 'string' ? r.summary : '',
    questions: r.questions.filter((q): q is string => typeof q === 'string'),
    steps,
  }
}

// --- What it compiles to ---

export type ComposeStart = LatLon & {
  /** Which way the drone faces, degrees from north (for forward/back/left/right). */
  headingDeg: number
  home: LatLon
  ceilingM: number
}

/** Where to find places. Injected so the conversion is testable without the map. */
export type ComposeLookups = {
  /** A place by name (the geocoder), preferring results near `near`; null if not found. */
  findPlace: (name: string, near: LatLon) => Promise<{ lat: number; lon: number; label: string; radiusM?: number } | null>
  /** Places of a category nearest `near`, nearest first (nearestPlaces on the place list). */
  findNearest: (category: PlaceCategory, near: LatLon) => Promise<NearbyResult[]>
  /** The building at (or right beside) a point: its centre and how far it reaches from there, metres. To circle it. */
  buildingAround: (at: LatLon) => Promise<{ centre: LatLon; radiusM: number } | null>
}

export type ComposedCircle = {
  centre: LatLon
  radiusM: number
  laps: number
  clockwise: boolean
  /** Its points in `stops`: the entry (a real stop) and the turning points after it, back to the entry. */
  firstStop: number
  lastStop: number
}

export type ComposedRoute = {
  /**
   * Stops in order: hovers as `hoverS` on their stop, circles as an entry stop with `orbit`
   * and its points after it marked `via` and `circle` (hidden, like detour points).
   */
  stops: FlyToTarget[]
  /** A route height asked for before setting off ("at 50 m"), else null (the planner's height). */
  altM: number | null
  circles: ComposedCircle[]
  /** After the last stop: stay hovering there, land there, or come home (Return). */
  ending: 'hover' | 'land' | 'return'
  /** What was looked up, for the summary ("Nearest hospital: St. Michael's Hospital, 950 m away"). */
  notes: string[]
}

export type ComposeResult = { ok: true; route: ComposedRoute } | { ok: false; problems: string[] }

type Place = { centre: LatLon; label: string; radiusM: number; key: string }

/**
 * Turns Claude's step list into a route from `start`. Every step is checked; all the
 * problems are reported together (a place not found, a step the planner can't fly yet).
 * Whether the route clears buildings, the ceiling and the battery is the planner's usual
 * check, done afterwards on the stops.
 */
export async function compilePlan(plan: ComposePlan, start: ComposeStart, lookups: ComposeLookups): Promise<ComposeResult> {
  const stops: FlyToTarget[] = []
  const circles: ComposedCircle[] = []
  const notes: string[] = []
  const problems: string[] = []
  let altM: number | null = null
  let ending: ComposedRoute['ending'] = 'hover'
  let at: LatLon = { lat: start.lat, lon: start.lon }
  let headingDeg = start.headingDeg
  /** The place the last fly_to went to, and its stop, so "circle around it" circles it instead of flying over it first. */
  let lastPlace: { place: Place; stop: number; from: LatLon; headingDeg: number } | null = null

  const goTo = (to: FlyToTarget) => {
    if (distance(at, to) >= 1) headingDeg = bearing(at, to)
    stops.push(to)
    at = { lat: to.lat, lon: to.lon }
  }

  if (!plan.steps.length) problems.push('There are no steps in that route.')

  for (const [n, step] of plan.steps.entries()) {
    const which = plan.steps.length > 1 ? `Step ${n + 1}: ` : ''
    const fail = (msg: string) => problems.push(which + msg)
    if (ending !== 'hover') {
      fail(ending === 'land' ? 'nothing can come after landing.' : 'nothing can come after going home.')
      break
    }
    switch (step.action) {
      case 'fly_to': {
        const place = await resolvePlace(step, at, lookups, notes)
        if (typeof place === 'string') {
          fail(place)
          break
        }
        lastPlace = { place, stop: stops.length, from: at, headingDeg }
        goTo({ lat: place.centre.lat, lon: place.centre.lon, label: place.label })
        break
      }

      case 'move': {
        const metres = moveMetres(step)
        if (typeof metres === 'string') {
          fail(metres)
          break
        }
        const dir = step.direction
        if (!dir) {
          fail('which way to move?')
          break
        }
        const b = directionBearing(dir, headingDeg)
        const to = offset(at, b, metres)
        const amount = step.unit === 'blocks' ? `${plural(step.distance!, 'block')} (${exact(metres)})` : exact(metres)
        stops.push({ ...to, label: `${amount} ${dir}` })
        at = to
        headingDeg = b
        break
      }

      case 'circle': {
        // Around the place just flown to: circle it instead of flying over its middle first.
        let place: Place | string
        let reused = false
        if (lastPlace && stops.length - 1 === lastPlace.stop && samePlace(step, lastPlace.place) && !stops[lastPlace.stop].hoverS) {
          place = lastPlace.place
          stops.pop()
          at = lastPlace.from
          headingDeg = lastPlace.headingDeg
          reused = true
        } else if (step.place_kind === 'here' || (!step.place_kind && !step.place)) {
          place = { centre: at, label: 'here', radiusM: 0, key: 'here' }
        } else {
          place = await resolvePlace(step, at, lookups, notes)
        }
        if (typeof place === 'string') {
          fail(place)
          break
        }
        const circle = await sizeCircle(step, place, lookups)
        if (typeof circle === 'string') {
          fail(circle)
          break
        }
        place = { ...place, centre: circle.centre }
        const { radiusM, laps, clockwise } = circle
        // Enter on the side the drone comes from (straight out ahead if it's at the centre).
        const fromCentre = distance(place.centre, at) >= 1 ? bearing(place.centre, at) : headingDeg
        const perLap = Math.max(8, Math.min(16, Math.round((2 * Math.PI * radiusM) / CIRCLE_POINT_SPACING_M)))
        const what = place.label === 'here' ? 'Circle' : `Circle ${place.label}`
        const firstStop = stops.length
        goTo({
          ...offset(place.centre, fromCentre, radiusM),
          label: `${what} (${exact(radiusM)} radius${laps > 1 ? `, ${laps} laps` : ''})`,
          orbit: { ...place.centre, radiusM, laps, clockwise },
        })
        for (let k = 1; k <= perLap * laps; k++) {
          const b = fromCentre + ((clockwise ? 1 : -1) * 360 * k) / perLap
          goTo({ ...offset(place.centre, b, radiusM), label: `Circling ${place.label}`, via: true, circle: true })
        }
        circles.push({ centre: place.centre, radiusM, laps, clockwise, firstStop, lastStop: stops.length - 1 })
        if (reused) lastPlace = null
        break
      }

      case 'height': {
        const h = step.rel_alt_m
        if (h == null || !Number.isFinite(h)) fail('what height?')
        else if (stops.length) fail("changing height partway through a route isn't supported yet; give one height for the whole route.")
        else if (h < ROUTE_MIN_ALT_M) fail(`the lowest a route can be flown is ${ROUTE_MIN_ALT_M} m.`)
        else if (h > start.ceilingM) fail(`${Math.round(h)} m is above the ${start.ceilingM} m ceiling.`)
        else altM = h
        break
      }

      case 'hover': {
        const s = step.seconds
        if (s == null || !Number.isFinite(s) || s <= 0) fail('how long to hover?')
        else if (s > HOVER_MAX_S) fail(`the longest hover is ${HOVER_MAX_S / 60} minutes.`)
        else if (!stops.length) fail('hover after going somewhere (it hovers when it gets there).')
        else {
          const last = stops[stops.length - 1]
          stops[stops.length - 1] = { ...last, hoverS: (last.hoverS ?? 0) + Math.round(s) }
        }
        break
      }

      case 'land':
        ending = 'land'
        break

      case 'return_home':
        ending = 'return'
        break

      default:
        fail(`unknown step "${String((step as { action: unknown }).action)}".`)
    }
  }

  const real = stops.filter((s) => !s.via).length
  if (real > ROUTE_MAX_STOPS) problems.push(`That's ${real} stops; a route can have at most ${ROUTE_MAX_STOPS}.`)
  if (!problems.length && !stops.length && ending !== 'return') problems.push("That route doesn't go anywhere.")
  if (problems.length) return { ok: false, problems }
  return { ok: true, route: { stops, altM, circles, ending, notes } }
}

/**
 * Circles that pass right beside buildings too tall to cross: the blocked points are left
 * out (the route check goes round the building between the points either side), and if the
 * entry is blocked the circle starts at the next clear point instead, keeping its label.
 * `blocked(stop)` says whether a point is too close to such a building. Returns the new
 * stops and whether anything changed; null if a whole circle is blocked.
 */
export async function bendCircles(
  route: Pick<ComposedRoute, 'stops' | 'circles'>,
  blocked: (at: LatLon) => Promise<boolean>,
): Promise<{ stops: FlyToTarget[]; bent: boolean } | null> {
  const out: FlyToTarget[] = []
  let bent = false
  let next = 0
  for (const c of route.circles) {
    out.push(...route.stops.slice(next, c.firstStop))
    // The circle's distinct points (its last point is the entry again).
    const ring = route.stops.slice(c.firstStop, c.lastStop)
    const flags = await Promise.all(ring.map((p) => blocked(p)))
    const start = flags.indexOf(false)
    if (start < 0) return null
    if (flags.some(Boolean)) bent = true
    if (!flags.some(Boolean)) {
      out.push(...route.stops.slice(c.firstStop, c.lastStop + 1))
      next = c.lastStop + 1
      continue
    }
    // Bent: flown point to point (round the building), not as an orbit.
    const order = [...ring.slice(start), ...ring.slice(0, start)].filter((_, k) => !flags[(start + k) % ring.length])
    const { orbit: _orbit, ...first } = ring[0]
    void _orbit
    const entry: FlyToTarget = { ...first, lat: order[0].lat, lon: order[0].lon, via: undefined, circle: undefined }
    const pointLabel = ring[1]?.label ?? entry.label
    const closing = route.stops[c.lastStop]
    out.push(
      entry,
      ...order.slice(1).map((p) => ({ lat: p.lat, lon: p.lon, label: pointLabel, via: true, circle: true })),
      { lat: entry.lat, lon: entry.lon, label: pointLabel, via: true, circle: true, ...(closing.hoverS && { hoverS: closing.hoverS }) },
    )
    next = c.lastStop + 1
  }
  out.push(...route.stops.slice(next))
  // Drop undefined flags, so unchanged stops compare equal.
  return { stops: out.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as FlyToTarget), bent }
}

/** A fly_to or circle place: looked up by name or as the nearest of a category. Returns a problem as a string. */
async function resolvePlace(step: ComposeStep, near: LatLon, lookups: ComposeLookups, notes: string[]): Promise<Place | string> {
  if (step.place_kind === 'nearest' || (step.category && !step.place)) {
    const category = step.category
    if (!category || !(PLACE_CATEGORIES as readonly string[]).includes(category)) return 'which kind of place?'
    const found = (await lookups.findNearest(category, near))[0]
    const label = CATEGORY_LABEL[category]
    if (!found) return `couldn't find a ${label} nearby.`
    const name = found.name ?? `${label} at ${formatLatLon(found.lat, found.lon)}`
    notes.push(`Nearest ${label}: ${name}, ${formatDistance(found.distanceM)} away`)
    return { centre: { lat: found.lat, lon: found.lon }, label: name, radiusM: found.radiusM, key: `nearest:${category}` }
  }
  const name = step.place?.trim()
  if (!name) return 'where to?'
  if (step.place_kind === 'here' || /^here$/i.test(name)) return { centre: near, label: 'here', radiusM: 0, key: 'here' }
  const found = await lookups.findPlace(name, near)
  if (!found) return `couldn't find "${name}".`
  return { centre: { lat: found.lat, lon: found.lon }, label: found.label, radiusM: found.radiusM ?? 0, key: `name:${normalize(name)}` }
}

/** "Circle around it" right after flying to a place: the same place. */
function samePlace(step: ComposeStep, place: Place): boolean {
  if (step.place_kind === 'here') return false
  if (step.place_kind === 'nearest' || (step.category && !step.place)) return place.key === `nearest:${step.category}`
  const name = step.place?.trim()
  if (!name || /^(it|there|that)$/i.test(name)) return true
  return place.key === `name:${normalize(name)}` || normalize(place.label) === normalize(name)
}

/** The circle's centre (the building's, when there is one), radius, laps and direction; a problem as a string. */
async function sizeCircle(step: ComposeStep, place: Place, lookups: ComposeLookups) {
  const laps = step.laps ?? 1
  if (!Number.isInteger(laps) || laps < 1) return 'how many times round?'
  if (laps > CIRCLE_MAX_LAPS) return `at most ${CIRCLE_MAX_LAPS} laps.`
  const clockwise = step.clockwise ?? true
  if (step.radius_m != null) {
    if (!Number.isFinite(step.radius_m) || step.radius_m < CIRCLE_MIN_RADIUS_M) return `the tightest circle is ${CIRCLE_MIN_RADIUS_M} m radius.`
    if (step.radius_m > CIRCLE_MAX_AUTO_RADIUS_M * 2.5) return `a ${formatDistance(step.radius_m)} radius is too big a circle.`
  }
  if (place.key === 'here') return { centre: place.centre, radiusM: step.radius_m ?? 20, laps, clockwise }
  // Round the building there (centred on it), or the place's mapped size if that's bigger (a campus, a park).
  const b = await lookups.buildingAround(place.centre).catch(() => null)
  const useBuilding = b !== null && b.radiusM >= place.radiusM
  const centre = useBuilding ? b.centre : place.centre
  if (step.radius_m != null) return { centre, radiusM: step.radius_m, laps, clockwise }
  const size = useBuilding ? b.radiusM : place.radiusM
  // Clear of its edge by the corridor and a margin.
  const radiusM = Math.max(CIRCLE_MIN_RADIUS_M, Math.ceil((size + ROUTE_CORRIDOR_M + CIRCLE_CLEARANCE_M) / 5) * 5)
  if (radiusM > CIRCLE_MAX_AUTO_RADIUS_M) return `${place.label} is too big to circle automatically; say how wide a circle.`
  return { centre, radiusM, laps, clockwise }
}

function moveMetres(step: ComposeStep): number | string {
  const d = step.distance
  if (d == null || !Number.isFinite(d) || d <= 0) return 'how far?'
  const m = step.unit === 'km' ? d * 1000 : step.unit === 'blocks' ? d * BLOCK_M : d
  if (m > MOVE_MAX_M) return `${formatDistance(m)} is too far for one move (at most ${formatDistance(MOVE_MAX_M)}).`
  return m
}

const COMPASS: Partial<Record<ComposeDirection, number>> = {
  north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315,
}
const RELATIVE: Partial<Record<ComposeDirection, number>> = { forward: 0, right: 90, back: 180, left: 270 }

/** Compass bearing for a direction; forward/back/left/right are from the way the drone is heading. */
export function directionBearing(dir: ComposeDirection, headingDeg: number): number {
  const b = COMPASS[dir] ?? headingDeg + (RELATIVE[dir] ?? 0)
  return ((b % 360) + 360) % 360
}

/** The point `distM` metres from `from` on compass bearing `bearingDeg`. */
export function offset(from: LatLon, bearingDeg: number, distM: number): LatLon {
  const r = (bearingDeg * Math.PI) / 180
  return {
    lat: from.lat + (Math.cos(r) * distM) / M_PER_DEG_LAT,
    lon: from.lon + (Math.sin(r) * distM) / mPerDegLon(from.lat),
  }
}

function bearing(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * mPerDegLon(a.lat)
  const y = (b.lat - a.lat) * M_PER_DEG_LAT
  return (((Math.atan2(x, y) * 180) / Math.PI) % 360 + 360) % 360
}

function distance(a: LatLon, b: LatLon): number {
  return Math.hypot((b.lon - a.lon) * mPerDegLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT)
}

const normalize = (s: string) => s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim()
/** Distances the pilot gave, as given: "25 m", "1.25 km" (formatDistance rounds to 10 m, for estimates). */
const exact = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${Math.round(m) / 1000} km`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
