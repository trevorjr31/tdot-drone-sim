/**
 * A planned route with one or more stops, as the steps the autopilot flies, and how far
 * and how long that is. Height changes happen straight up or down, never on the way: each
 * leg is flown at its own crossing height (clear of every building on that leg), changing
 * height over the stop before it, and the drone descends to the chosen height over the
 * last stop.
 */
import { distanceM } from '../places/geo'
import type { FlyToTarget, PreviewPoint, RoutePreview } from './droneView'

/** Closer than this to a height counts as there (PX4 overshoots/undershoots a little). */
export const ROUTE_HEIGHT_TOLERANCE_M = 2
/** Most stops a route can have. */
export const ROUTE_MAX_STOPS = 8

/**
 * Speeds for the estimate, measured flying routes in the sim with PX4 v1.16's defaults:
 * a leg averages 4 m/s including speeding up and slowing down (cruise is 5 m/s,
 * MPC_XY_CRUISE), plus ~5 s to settle within reach of the stop before the next leg.
 * Climbs and descents run at MPC_Z_V_AUTO_UP / _DN, take-offs at MPC_TKO_SPEED.
 */
const LEG_MS = 4
const ARRIVE_S = 5
const CLIMB_MS = 3
const DESCEND_MS = 1.5
const TAKEOFF_MS = 1.5
/** Arming and spinning up before a take-off, seconds. */
const TAKEOFF_START_S = 2

export type RouteStart = { lat: number; lon: number; relAltM: number; inAir: boolean }

export type RouteStep =
  /** Take off from the ground to this height. */
  | { kind: 'takeoff'; altM: number }
  /** Climb or descend on the spot (at the start, or over the stop just reached). */
  | { kind: 'vertical'; altM: number; lat: number; lon: number; atStart: boolean }
  /** Fly to stop `stop`, at the current height. */
  | { kind: 'fly'; stop: number; dest: FlyToTarget; altM: number }

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

export type RouteEstimate = {
  /** Along the ground, metres. */
  distanceM: number
  /** Up and down, metres. */
  climbM: number
  /** Flight time, seconds. */
  timeS: number
}

/** How far and how long the steps take from `start`, at PX4's speeds. */
export function estimateRoute(start: RouteStart, steps: RouteStep[]): RouteEstimate {
  let distance = 0
  let climb = 0
  let time = 0
  let height = start.inAir ? start.relAltM : 0
  let at = { lat: start.lat, lon: start.lon }
  for (const step of steps) {
    if (step.kind === 'fly') {
      const d = distanceM(at.lon, at.lat, step.dest.lon, step.dest.lat)
      distance += d
      time += d / LEG_MS + ARRIVE_S
      at = step.dest
    } else {
      const dh = step.altM - height
      climb += Math.abs(dh)
      time += step.kind === 'takeoff' ? TAKEOFF_START_S + dh / TAKEOFF_MS : dh > 0 ? dh / CLIMB_MS : -dh / DESCEND_MS
      height = step.altM
    }
  }
  return { distanceM: distance, climbM: climb, timeS: time }
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
  if (step.kind === 'takeoff' || step.atStart) return { atDrone: true, relAltM: step.altM }
  return { lat: step.lat, lon: step.lon, relAltM: step.altM }
}

function stopLabel(stops: FlyToTarget[], i: number): string {
  const s = stops[i]
  const name = s.building ? `${s.label} (building, ${s.building.heightM} m)` : s.label
  return stops.length > 1 ? `${i + 1}. ${name}` : `Destination: ${name}`
}

/** The whole route, from the drone, while it's being planned. */
export function planPreview(stops: FlyToTarget[], steps: RouteStep[]): RoutePreview {
  return {
    markers: stops.map((s, i) => ({ lat: s.lat, lon: s.lon, label: stopLabel(stops, i) })),
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
  const markers = stops.flatMap((s, i) => (i > heading ? [{ lat: s.lat, lon: s.lon, label: stopLabel(stops, i) }] : []))
  return markers.length || path.length > 1 ? { markers, path, fromDrone: false } : null
}

/** The stop a step belongs to: the one it flies to, or (climbing, descending) the next one, else the last. */
export function stepStop(steps: RouteStep[], i: number, stopCount: number): number {
  const next = steps.find((s, k) => k >= i && s.kind === 'fly')
  return next && next.kind === 'fly' ? next.stop : stopCount - 1
}
