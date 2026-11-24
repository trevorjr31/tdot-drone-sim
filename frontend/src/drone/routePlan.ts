/**
 * A planned route with one or more stops, as the steps the autopilot flies, and how far
 * and how long that is. Height changes happen straight up or down, never on the way: each
 * leg is flown at its own crossing height (clear of every building on that leg), changing
 * height over the stop before it, and the drone descends to the chosen height over the
 * last stop.
 */
import { distanceM } from '../places/geo'
import type { FlyToTarget, PreviewPoint, RoutePreview } from './droneView'
import { DEFAULT_SIM_CONFIG, drainFactor, type SimConfig } from './simConfig'

/** Closer than this to a height counts as there (PX4 overshoots/undershoots a little). */
export const ROUTE_HEIGHT_TOLERANCE_M = 2
/** Most stops a route can have. */
export const ROUTE_MAX_STOPS = 8

/**
 * Timing for the estimate, measured flying routes in the sim: a leg averages 80% of the
 * cruise speed including speeding up and slowing down (4 m/s at PX4's default 5), plus
 * ~5 s to settle within reach of the stop before the next leg. Climbs, descents, take-offs
 * and landings run at the sim config's speeds.
 */
const LEG_SPEED_OF_CRUISE = 0.8
const ARRIVE_S = 5
/** Arming and spinning up before a take-off, seconds (on the ground, armed). */
const TAKEOFF_START_S = 2
/** PX4's Return descends at the auto descent speed to this height (RTL_DESCEND_ALT), then lands. */
const RETURN_DESCEND_ALT_M = 10
/** Below this, a landing slows to the landing speed (MPC_LAND_ALT2). */
const LAND_SLOW_ALT_M = 5

export type RouteStart = { lat: number; lon: number; relAltM: number; inAir: boolean }

export type RouteStep =
  /** Take off from the ground to this height. */
  | { kind: 'takeoff'; altM: number }
  /** Climb or descend on the spot (at the start, or over the stop just reached). */
  | { kind: 'vertical'; altM: number; lat: number; lon: number; atStart: boolean }
  /** Fly to stop `stop`, at the current height. */
  | { kind: 'fly'; stop: number; dest: FlyToTarget; altM: number }
  /** Land where it is (the end of a return home). */
  | { kind: 'land'; lat: number; lon: number }

/**
 * Crossing height for each leg. The first leg never descends from the current height
 * before it sets off; later legs fly at the chosen height or higher, as the buildings need.
 * `legMinSafeM[i]` is the lowest safe height for leg i (from the route check, 0 if unknown).
 */
export function legCrossings(start: RouteStart, legMinSafeM: number[], altM: number): number[] {
  return legMinSafeM.map((safe, i) => Math.max(altM, safe, i === 0 && start.inAir ? start.relAltM : 0))
}

/** The steps the autopilot flies, in order. */
export function routeSteps(start: RouteStart, stops: FlyToTarget[], legMinSafeM: number[], altM: number): RouteStep[] {
  const cross = legCrossings(start, legMinSafeM, altM)
  const steps: RouteStep[] = []
  let height = start.inAir ? start.relAltM : 0
  let at = { lat: start.lat, lon: start.lon }
  stops.forEach((dest, i) => {
    if (i === 0 && !start.inAir) steps.push({ kind: 'takeoff', altM: cross[0] })
    else if (Math.abs(cross[i] - height) > ROUTE_HEIGHT_TOLERANCE_M)
      steps.push({ kind: 'vertical', altM: cross[i], lat: at.lat, lon: at.lon, atStart: i === 0 })
    steps.push({ kind: 'fly', stop: i, dest, altM: cross[i] })
    height = cross[i]
    at = dest
  })
  if (stops.length && altM < height - ROUTE_HEIGHT_TOLERANCE_M)
    steps.push({ kind: 'vertical', altM, lat: at.lat, lon: at.lon, atStart: false })
  return steps
}

/**
 * The steps for flying home along `path` (ending at home): each leg at the height that
 * clears its buildings (at least `minAltM`, never descending before the first leg), then
 * land, or stay hovering over home.
 */
export function returnSteps(start: RouteStart, path: FlyToTarget[], legMinSafeM: number[], minAltM: number, land: boolean): RouteStep[] {
  const steps = routeSteps(start, path, legMinSafeM, minAltM)
  if (steps[steps.length - 1]?.kind === 'vertical') steps.pop() // no descent to minAltM: it lands from there
  const home = path[path.length - 1]
  if (land && home) steps.push({ kind: 'land', lat: home.lat, lon: home.lon })
  return steps
}

/**
 * The return path as points for PX4's mission-based Return (drone → home): the drone's
 * spot at the first leg's height, then each stop and height change. A height change gets
 * a second point at the same spot, so PX4 climbs or descends there rather than along the
 * next leg (where the building check doesn't cover it).
 */
export function missionPoints(start: LatLon, steps: RouteStep[]): { lat: number; lon: number; relAltM: number }[] {
  const first = steps.find((s) => s.kind === 'fly')
  if (!first || first.kind !== 'fly') return []
  const pts = [{ lat: start.lat, lon: start.lon, relAltM: first.altM }]
  for (const step of steps) {
    if (step.kind === 'fly') pts.push({ lat: step.dest.lat, lon: step.dest.lon, relAltM: step.altM })
    else if (step.kind === 'vertical' && !step.atStart) pts.push({ lat: step.lat, lon: step.lon, relAltM: step.altM })
  }
  return pts
}

type LatLon = { lat: number; lon: number }

export type RouteEstimate = {
  /** Along the ground, metres. */
  distanceM: number
  /** Up and down, metres. */
  climbM: number
  /** Flight time, seconds. */
  timeS: number
  /** Battery it uses, as a fraction of a full battery (0–1). */
  battery: number
}

/**
 * Time and battery as the drone flies, piece by piece: `time` seconds at a drain of
 * `factor` × hovering (from the bridge's load model, or 1 with a fixed drain rate).
 */
class Tally {
  timeS = 0
  battery = 0
  private readonly c: SimConfig
  constructor(c: SimConfig) {
    this.c = c
  }
  add(timeS: number, inAir: boolean, climbMs: number, speedMs: number) {
    const factor = this.c.batteryLoad ? drainFactor(inAir, climbMs, speedMs) : 1
    this.timeS += timeS
    this.battery += (timeS * factor) / (this.c.batteryMin * 60)
  }
  /** Climb or descend `dh` metres at the auto speeds. */
  vertical(dh: number) {
    if (dh > 0) this.add(dh / this.c.climbMs, true, this.c.climbMs, 0)
    else if (dh < 0) this.add(-dh / this.c.descendMs, true, -this.c.descendMs, 0)
  }
  /** Fly `d` metres to a stop and settle there. */
  leg(d: number) {
    const speed = this.c.cruiseMs * LEG_SPEED_OF_CRUISE
    this.add(d / speed, true, 0, speed)
    this.add(ARRIVE_S, true, 0, 0)
  }
}

/** How far, how long and how much battery the steps take from `start`, at the sim's speeds. */
export function estimateRoute(start: RouteStart, steps: RouteStep[], config: SimConfig = DEFAULT_SIM_CONFIG): RouteEstimate {
  const t = new Tally(config)
  let distance = 0
  let climb = 0
  let height = start.inAir ? start.relAltM : 0
  let at = { lat: start.lat, lon: start.lon }
  for (const step of steps) {
    if (step.kind === 'fly') {
      const d = distanceM(at.lon, at.lat, step.dest.lon, step.dest.lat)
      distance += d
      t.leg(d)
      at = step.dest
    } else if (step.kind === 'land') {
      // Descent speed down to 5 m, then the landing speed (as PX4 lands).
      const slow = Math.min(height, LAND_SLOW_ALT_M)
      t.add((height - slow) / config.descendMs, true, -config.descendMs, 0)
      t.add(slow / config.landMs, true, -config.landMs, 0)
      climb += height
      height = 0
    } else {
      const dh = step.altM - height
      climb += Math.abs(dh)
      if (step.kind === 'takeoff') {
        t.add(TAKEOFF_START_S, false, 0, 0)
        t.add(Math.max(0, dh) / config.takeoffMs, true, config.takeoffMs, 0)
      } else t.vertical(dh)
      height = step.altM
    }
  }
  return { distanceM: distance, climbM: climb, timeS: t.timeS, battery: t.battery }
}

/**
 * PX4's Return from `from` (at `relAltM`): climb to the return height if lower, fly
 * straight home, descend, land. `returnAltM` is the height the app would set there.
 */
export function estimateReturn(
  from: { lat: number; lon: number },
  home: { lat: number; lon: number },
  relAltM: number,
  returnAltM: number,
  config: SimConfig = DEFAULT_SIM_CONFIG,
): RouteEstimate {
  const t = new Tally(config)
  const d = distanceM(from.lon, from.lat, home.lon, home.lat)
  const flyAt = Math.max(relAltM, returnAltM)
  t.vertical(flyAt - relAltM)
  if (d > 1) t.leg(d)
  const slow = Math.min(flyAt, RETURN_DESCEND_ALT_M)
  t.vertical(-(flyAt - slow))
  // Landing: descent speed down to 5 m, then the landing speed.
  const lowSlow = Math.min(slow, LAND_SLOW_ALT_M)
  t.add((slow - lowSlow) / config.descendMs, true, -config.descendMs, 0)
  t.add(lowSlow / config.landMs, true, -config.landMs, 0)
  return { distanceM: d, climbM: Math.abs(flyAt - relAltM) + flyAt, timeS: t.timeS, battery: t.battery }
}

export type BatteryCheck = {
  /** Battery now, at the last stop, and back home after a Return from there (fractions). */
  now: number
  atEnd: number
  atHome: number
  /** The least it should land with: the critical level, where PX4 would act on its own. */
  reserve: number
  /** Enough to fly the route and get home with the reserve left. */
  ok: boolean
}

/** Whether the battery covers the route and the flight home after it, with the critical level spare. */
export function checkBattery(now: number, route: RouteEstimate, home: RouteEstimate, config: SimConfig): BatteryCheck {
  const reserve = config.batteryCriticalPct / 100
  const atEnd = now - route.battery
  const atHome = atEnd - home.battery
  return { now, atEnd, atHome, reserve, ok: atHome >= reserve }
}

/**
 * A place with no name or address: its coordinates, to about 10 m ("43.6526, -79.3833"),
 * short enough for a stop's row in the panel. It's only the label: the stop keeps the exact point.
 */
export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
}

/** "850 m", "2.4 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`
}

/** "45 s", "6 min", "1 h 10 min". */
export function formatDuration(s: number): string {
  if (s < 60) return `${Math.max(5, Math.round(s / 5) * 5)} s`
  const min = Math.round(s / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

/** Where a step ends, for drawing the path (take-offs and climbs at the start sit over the drone). */
function stepPoint(step: RouteStep): PreviewPoint {
  if (step.kind === 'fly') return { lat: step.dest.lat, lon: step.dest.lon, relAltM: step.altM }
  if (step.kind === 'land') return { lat: step.lat, lon: step.lon, relAltM: 0 }
  if (step.kind === 'takeoff' || step.atStart) return { atDrone: true, relAltM: step.altM }
  return { lat: step.lat, lon: step.lon, relAltM: step.altM }
}

/** The stops the user chose, leaving out detour turning points: [path index, stop number (0-based)]. */
export function realStops(stops: FlyToTarget[]): [number, number][] {
  const out: [number, number][] = []
  stops.forEach((s, i) => !s.via && out.push([i, out.length]))
  return out
}

function stopLabel(stops: FlyToTarget[], i: number): string {
  const s = stops[i]
  const real = realStops(stops)
  const n = real.findIndex(([k]) => k === i)
  const name = s.building ? `${s.label} (building, ${s.building.heightM} m)` : s.label
  return real.length > 1 ? `${n + 1}. ${name}` : `Destination: ${name}`
}

/** The whole route, from the drone, while it's being planned. */
export function planPreview(stops: FlyToTarget[], steps: RouteStep[]): RoutePreview {
  return {
    markers: stops.flatMap((s, i) => (s.via ? [] : [{ lat: s.lat, lon: s.lon, label: stopLabel(stops, i) }])),
    path: steps.map(stepPoint),
    fromDrone: true,
  }
}

/**
 * In flight, the rest of the route after the stop it's heading for (that one shows as the
 * blue fly-to target): its later stops and path. Null once there's nothing left to show.
 */
export function remainingPreview(stops: FlyToTarget[], steps: RouteStep[], current: number): RoutePreview | null {
  const j = steps.findIndex((s, k) => k >= current && s.kind === 'fly')
  if (j < 0) return null
  const heading = (steps[j] as Extract<RouteStep, { kind: 'fly' }>).stop
  const path = steps.slice(j).map(stepPoint)
  const markers = stops.flatMap((s, i) => (i > heading && !s.via ? [{ lat: s.lat, lon: s.lon, label: stopLabel(stops, i) }] : []))
  return markers.length || path.length > 1 ? { markers, path, fromDrone: false } : null
}

/** The stop a step belongs to: the one it flies to, or (climbing, descending) the next one, else the last. */
export function stepStop(steps: RouteStep[], i: number, stopCount: number): number {
  const next = steps.find((s, k) => k >= i && s.kind === 'fly')
  return next && next.kind === 'fly' ? next.stop : stopCount - 1
}
