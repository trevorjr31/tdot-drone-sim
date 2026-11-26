import { useCallback, useEffect, useRef, useState } from 'react'
import { centreOf, type MapApi, type Place } from '../places/types'
import type { DroneView, FlyToTarget, HudInfo, RoutePreview } from './droneView'
import { BatteryEstimator, batteryThresholds, type BatteryInfo } from './battery'
import { DEFAULT_SIM_CONFIG, RETURN_MIN_ALT_M, returnMaxAltM, type SimConfig } from './simConfig'
import { KeyboardFlight } from './keyboardFlight'
import { Px4BridgeSource, type BridgeStatus, type Px4Command, type Px4CommandParams } from './px4Bridge'
import type { CrashSite } from './crash'
import { useCollisions } from './useCollisions'
import { loadMassingIndex, loadMassingTile, loadPlaces } from '../data/torontoData'
import { namedPlace, nearestPlaces } from '../places/nearby'
import { bendCircles, compilePlan, type ComposeLookups } from './routeCompose'
import { buildingName, type Building } from './collision'
import { RouteSafety, type LatLon, type RouteCheck } from './routeSafety'
import { pathLengthM } from './detour'
import { distanceM } from '../places/geo'
import {
  checkBattery,
  estimateReturn,
  estimateRoute,
  formatLatLon,
  planPreview,
  remainingPreview,
  ROUTE_HEIGHT_TOLERANCE_M,
  ROUTE_MAX_STOPS,
  routeSteps,
  realStops,
  returnSteps,
  missionPoints,
  stepStop,
  type BatteryCheck,
  type RouteEstimate,
  type RouteStart,
  type RouteStep,
} from './routePlan'

/** Where the autopilot is in a planned route. */
export type RoutePhase = 'climbing' | 'flying' | 'descending' | 'landing' | 'arrived'

/** Buildings along the planned route (see routeSafety.ts). */
export type RouteCheckInfo =
  | { status: 'checking' }
  | { status: 'error' }
  | {
      status: 'done'
      /** Lowest safe height above home for crossing, metres (0 = nothing in the way). */
      minSafeRelAltM: number
      highest: { name: string | null; heightM: number } | null
      /** Lowest safe height to end at, over the destination. */
      destMinSafeRelAltM: number
      destHighest: { name: string | null; heightM: number } | null
      /** Lowest safe crossing height for each leg (drone → stop 1, stop 1 → stop 2, …). */
      legMinSafeM: number[]
      /** Lowest safe height for the straight line home from the last stop (PX4's own Return height there). */
      returnMinSafeM: number
      /**
       * The way home from the last stop, as Return flies it: straight, or round buildings too
       * tall to fly over (via points), ending at home; homeLegMinSafeM is per leg. null if
       * there's no way round (PX4 would fly straight).
       */
      homePath: FlyToTarget[] | null
      homeLegMinSafeM: number[]
      /**
       * The route as flown: the stops, with turning points (`via`) added where a leg goes
       * round buildings too tall to cross under the ceiling. legMinSafeM is per leg of this.
       */
      path: FlyToTarget[]
      /** Legs that go round buildings: the tallest one in the way, and how much longer it is. */
      detours: { around: { name: string | null; heightM: number } | null; extraM: number }[]
    }

/**
 * Why a route ending at `altM` can't be flown, or null if it can. The autopilot picks
 * its own crossing height (see crossingAltM), so only two things block a route: it
 * needs more than the ceiling, or `altM` is too low for the destination itself.
 */
export function routeProblem(
  c: Extract<RouteCheckInfo, { status: 'done' }>,
  altM: number,
  ceilingM: number = DEFAULT_SIM_CONFIG.ceilingM,
): { kind: 'ceiling' | 'destination'; needM: number } | null {
  if (c.minSafeRelAltM > ceilingM) return { kind: 'ceiling', needM: c.minSafeRelAltM }
  if (altM < c.destMinSafeRelAltM) return { kind: 'destination', needM: c.destMinSafeRelAltM }
  return null
}

/**
 * Height the autopilot crosses at: the chosen height, the current height (from the air,
 * it never descends before arriving), or the route's minimum safe height, whichever is
 * highest. It descends to the chosen height once over the destination.
 */
export function crossingAltM(altM: number, currentAltM: number | null, minSafeRelAltM: number): number {
  return Math.max(altM, currentAltM ?? 0, minSafeRelAltM)
}

/** A planned route's battery: what the route and the flight home after it use, and whether it's enough. */
export type RouteBattery = BatteryCheck & {
  /** Flying home from the last stop (PX4's Return). */
  home: RouteEstimate
}

/** Return home's height, kept clear of the buildings between the drone and home. */
export type ReturnPlan = {
  /** Height PX4 returns at, metres above home. */
  altM: number
  /** Tallest building on the straight line home, if any. */
  highest: { name: string | null; heightM: number } | null
  /** False when that building is too tall to clear under the ceiling. */
  safe: boolean
  /** Highest Return may fly (5 m under the geofence ceiling). */
  maxM: number
  /**
   * A path home round the buildings is loaded in PX4, so its own Return follows it (true),
   * there's no way round (false), or not known yet / not flying (null).
   */
  pathHome: boolean | null
}

/** A planned route being flown: its steps, the one in progress, and the stops. */
type RouteRun = {
  steps: RouteStep[]
  i: number
  stops: FlyToTarget[]
  altM: number
  phase: RoutePhase
  /** A planned route, or flying home (the Return button). */
  kind: 'route' | 'return'
}

/** A planned route in flight, as the panel shows it. */
export type RouteProgress = {
  phase: RoutePhase
  /** The stop it's flying to (or climbing/descending for, or arrived at), 0-based. */
  stopIndex: number
  stopCount: number
  stopLabel: string
  /** Height of the current climb, descent or leg, metres above home. */
  heightM: number
  /** Distance and time still to go (null once arrived). */
  remaining: RouteEstimate | null
  /** Descending over the last stop (no more legs to fly). */
  finalDescent: boolean
  /** On a detour round buildings too tall to fly over. */
  detour: boolean
  /** Flying home (the Return button) rather than a planned route. */
  returning: boolean
}

/** Pre-flight choice: free flying with the keyboard, or a planned route to a destination. */
export type Mission = 'choose' | 'free' | 'route'

/** Free fly takes off straight away to this height (above the launch point). */
const FREE_FLY_ALT_M = 30

type Options = {
  /** Map click picker (from the map API), for "pick on map" fly-to. */
  pickLocation?: MapApi['pickLocation']
  /** Place search by name (the geocoder), for routes described in words. */
  searchPlace?: MapApi['searchGoogle']
}

/** A route described in words: asking Claude, its questions, a problem, or the route it made. */
export type ComposeStatus =
  | { state: 'idle' }
  | { state: 'asking'; text: string }
  | { state: 'questions'; text: string; questions: string[] }
  | { state: 'error'; text: string; message: string; problems: string[] }
  | {
      state: 'done'
      text: string
      summary: string
      /** What was looked up ("Nearest hospital: …"). */
      notes: string[]
      /** Parts of the request the autopilot doesn't fly yet (hovering, landing at the end, …). */
      notYet: string[]
    }

/** Real stops with the circle points after each, so a circle moves and goes as one. */
function stopGroups(stops: FlyToTarget[]): FlyToTarget[][] {
  const groups: FlyToTarget[][] = []
  for (const s of stops) {
    if (s.via && groups.length) groups[groups.length - 1].push(s)
    else groups.push([s])
  }
  return groups
}

/**
 * All drone state for the UI: the PX4 connection (via the bridge), HUD data,
 * PX4 commands, keyboard flying, fly-to, collisions and crash/reset.
 */
export function useDrone({ pickLocation, searchPlace }: Options = {}) {
  const [px4] = useState(() => new Px4BridgeSource())
  const [droneView, setDroneView] = useState<DroneView | null>(null)
  const [hud, setHud] = useState<HudInfo | null>(null)
  const [trailVisible, setTrailVisible] = useState(true)
  const [px4Status, setPx4Status] = useState<BridgeStatus>(px4.status)
  const [px4Busy, setPx4Busy] = useState<Px4Command | null>(null)
  const [px4Error, setPx4Error] = useState<string | null>(null)
  const [keysActive, setKeysActive] = useState(false)
  const [target, setTarget] = useState<FlyToTarget | null>(null)
  const [picking, setPicking] = useState(false)
  const [crashed, setCrashed] = useState(false)
  const [mission, setMission] = useState<Mission>('choose')
  /** The route being planned: its stops, in order. */
  const [routeStops, setRouteStops] = useState<FlyToTarget[]>([])
  /** A route described in words, and a height it asked for (the planner takes it). */
  const [compose, setCompose] = useState<ComposeStatus>({ state: 'idle' })
  const [composedAltM, setComposedAltM] = useState<{ altM: number; id: number } | null>(null)
  /** The route being flown (state for rendering, ref for event handlers). */
  const [routeRun, setRouteRun] = useState<RouteRun | null>(null)
  const routeRunRef = useRef<RouteRun | null>(null)
  const updateRun = useCallback((run: RouteRun | null) => {
    routeRunRef.current = run
    setRouteRun(run)
  }, [])
  /** The last planned route flown: where it started and its path (Return can retrace it). */
  const lastRoute = useRef<{ start: LatLon; path: FlyToTarget[] } | null>(null)
  /** Starts step i of the route being flown (set in an effect: it needs the command helpers). */
  const runStepRef = useRef<(i: number) => void>(() => {})
  const [routeSafety, setRouteSafety] = useState<RouteSafety | null>(null)
  /** Battery level and minutes left (from the drain rate) while flying. */
  const [battery, setBattery] = useState<BatteryInfo | null>(null)
  /** The simulated drone's settings, as the bridge reports them (defaults until it does). */
  const [simConfig, setSimConfig] = useState<SimConfig>(() => px4.config ?? DEFAULT_SIM_CONFIG)
  const simConfigRef = useRef(simConfig)
  useEffect(() => {
    simConfigRef.current = simConfig
  }, [simConfig])
  useEffect(() => px4.onConfig((c) => setSimConfig(c ?? DEFAULT_SIM_CONFIG)), [px4])
  const [checkResult, setCheckResult] = useState<{ key: string; info: RouteCheckInfo } | null>(null)
  /** Latest drone state, for commands that need the current position. */
  const stateRef = useRef<HudInfo['state'] | null>(null)
  /** The autopilot is flying a planned route (until landing or "Take over controls"). */
  const [autopilot, setAutopilot] = useState(false)
  const inAirRef = useRef(false)

  useEffect(() => {
    if (!droneView) return
    let wasFlying = false
    const batteryEstimator = new BatteryEstimator()
    const offHud = droneView.onHud((h) => {
      setHud(h)
      const b = h
        ? batteryEstimator.update(h.state.timeMs, h.state.battery, h.state.armed, batteryThresholds(simConfigRef.current))
        : null
      setBattery((prev) => (sameBattery(prev, b) ? prev : b))
      const flying = !!h && (h.state.armed || h.state.inAir)
      inAirRef.current = !!h?.state.inAir
      stateRef.current = h?.state ?? null
      // Landed after a flight: back to the pre-flight choice.
      if (wasFlying && h && !flying) {
        setMission('choose')
        setRouteStops([])
        setCompose({ state: 'idle' })
        updateRun(null)
        setAutopilot(false)
      }
      wasFlying = flying
      // Planned route: a take-off, climb or descent is done once at its height.
      const run = routeRunRef.current
      const step = run?.steps[run.i]
      if (run && step && h) {
        const rel = h.state.relAltM
        const done =
          step.kind === 'takeoff'
            ? h.state.inAir && rel >= step.altM - ROUTE_HEIGHT_TOLERANCE_M
            : step.kind === 'vertical' && Math.abs(rel - step.altM) <= ROUTE_HEIGHT_TOLERANCE_M
        if (done) runStepRef.current(run.i + 1)
      }
    })
    const offTarget = droneView.onTargetChange((t) => {
      setTarget(t)
      // Reached a stop: fly-to targets clear themselves on arrival. Only during a flying
      // leg: other commands (e.g. the take-off) clear the target too.
      const run = routeRunRef.current
      if (t || run?.phase !== 'flying') return
      runStepRef.current(run.i + 1)
    })
    return () => {
      offHud()
      offTarget()
    }
  }, [droneView, updateRun])

  // Connect to the bridge (and keep reconnecting) for as long as the app is open.
  useEffect(() => {
    px4.connect()
    return () => px4.disconnect()
  }, [px4])
  useEffect(() => px4.onStatus(setPx4Status), [px4])
  useEffect(() => px4.onNotice(setPx4Error), [px4])
  useEffect(() => droneView?.setTrailVisible(trailVisible), [droneView, trailVisible])

  // Dev only: poke at the drone from the browser console (window.tdot).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { tdot: unknown }).tdot = { px4, droneView }
  }, [px4, droneView])

  /** Sends a PX4 command; resolves true if PX4 accepted it (errors show in the panel). */
  const px4Command = useCallback(
    (action: Px4Command, params?: Px4CommandParams): Promise<boolean> => {
      setPx4Busy(action)
      setPx4Error(null)
      if (action === 'takeoff') droneView?.clearTrail()
      if (action !== 'goto') droneView?.setTarget(null) // a new command replaces any fly-to
      return px4
        .command(action, params)
        .then(() => true)
        .catch((err: unknown) => {
          setPx4Error(err instanceof Error ? err.message : String(err))
          if (action === 'goto') droneView?.setTarget(null)
          return false
        })
        .finally(() => setPx4Busy(null))
    },
    [px4, droneView],
  )

  // Fly-to: PX4 flies to the point, at its current height unless one is given.
  const flyTo = useCallback(
    (lat: number, lon: number, label: string, relAltM?: number) => {
      droneView?.setTarget({ lat, lon, label })
      return px4Command('goto', { lat, lon, relAltM })
    },
    [droneView, px4Command],
  )

  useEffect(() => {
    runStepRef.current = (i) => {
      const run = routeRunRef.current
      if (!run) return
      const fail = (ok: boolean) => {
        if (ok || routeRunRef.current !== next) return
        updateRun(null)
        setAutopilot(false)
      }
      const step = run.steps[i]
      if (!step) {
        updateRun({ ...run, i, phase: 'arrived' })
        return
      }
      const nextFly = run.steps.find((st, k) => k > i && st.kind === 'fly')
      const s = stateRef.current
      const phase: RoutePhase =
        step.kind === 'fly'
          ? 'flying'
          : step.kind === 'land'
            ? 'landing'
            : step.kind === 'vertical' && s && step.altM < s.relAltM
              ? 'descending'
              : 'climbing'
      const next = { ...run, i, phase }
      updateRun(next)
      if (step.kind === 'fly') {
        void flyTo(step.dest.lat, step.dest.lon, step.dest.label).then(fail)
      } else if (step.kind === 'takeoff') {
        void px4Command('takeoff', { altitudeM: step.altM }).then((ok) => {
          fail(ok)
          // Show where it's heading (the take-off command clears any fly-to target).
          if (ok && nextFly?.kind === 'fly') droneView?.setTarget(nextFly.dest)
        })
      } else if (step.kind === 'land') {
        void px4Command('land').then(fail) // done once landed (the HUD listener resets the run)
      } else {
        if (nextFly?.kind === 'fly') droneView?.setTarget(nextFly.dest)
        const at = step.atStart && s ? s : step
        void px4Command('goto', { lat: at.lat, lon: at.lon, relAltM: step.altM }).then(fail)
      }
    }
  }, [flyTo, px4Command, droneView, updateRun])

  // Building data for route checks.
  useEffect(() => {
    let cancelled = false
    loadMassingIndex()
      .then((index) => !cancelled && setRouteSafety(new RouteSafety(index, loadMassingTile)))
      .catch((err: unknown) => console.warn('Route checks off: massing data unavailable', err))
    return () => {
      cancelled = true
    }
  }, [])

  // While planning a route: the buildings along each leg.
  // Rechecked when the stops change or the drone moves ~100 m.
  const planning = mission === 'route' && !autopilot && routeStops.length > 0
  const posKey = hud ? `${hud.state.lat.toFixed(3)},${hud.state.lon.toFixed(3)}` : null
  const stopsKey = routeStops.map((st) => `${st.lat},${st.lon}`).join(';')
  const checkKey = planning && posKey && routeSafety ? `${stopsKey}|${posKey}` : null
  useEffect(() => {
    const s = stateRef.current
    if (!checkKey || !routeSafety || !routeStops.length || !s) return
    let cancelled = false
    checkRoute(routeSafety, s, routeStops, simConfigRef.current.ceilingM)
      .then((info) => !cancelled && setCheckResult({ key: checkKey, info }))
      .catch(() => !cancelled && setCheckResult({ key: checkKey, info: { status: 'error' } }))
    return () => {
      cancelled = true
    }
  }, [checkKey, routeSafety, routeStops])
  // Return home: PX4 climbs to its return height and flies straight home, not knowing about
  // buildings. Keep that height clear of the buildings between the drone and home, rechecked
  // every ~10 m the drone moves (left alone during a return, which has already started).
  // While flying, also keep a path home round any buildings too tall to fly over loaded in
  // PX4 (as a mission its Return follows), re-sent every RETURN_PATH_EVERY_M or so.
  const [returnPlan, setReturnPlan] = useState<ReturnPlan | null>(null)
  const returnSending = useRef(false)
  /** The return path last sent to PX4: from where, and its points (to skip unchanged ones). */
  const returnPathSent = useRef<{ lat: number; lon: number; sig: string } | null>(null)
  const returnKey =
    px4Status === 'connected' && hud && !crashed && !RETURN_BUSY_MODES.has(hud.state.flightMode)
      ? `${hud.state.lat.toFixed(4)},${hud.state.lon.toFixed(4)}|${hud.state.home.lat.toFixed(5)},${hud.state.home.lon.toFixed(5)}`
      : null
  /** Sends PX4 a path home round tall buildings, or clears it (on the ground, or no way round). */
  const updateReturnPath = useCallback(
    async (s: HudInfo['state']) => {
      // PX4 restarted (or the bridge did): it has no path any more, whatever was sent.
      if (returnPathSent.current && returnPathSent.current.sig.startsWith('[') && px4.returnPathPoints === 0)
        returnPathSent.current = null
      const sent = returnPathSent.current
      const send = (points: { lat: number; lon: number; relAltM: number }[], sig: string) => {
        returnPathSent.current = { lat: s.lat, lon: s.lon, sig }
        return px4.command('returnPath', { points }).catch((err: unknown) => console.warn('Could not set the return path', err))
      }
      if (!s.inAir || !routeSafety) {
        if (sent && sent.sig !== '') await send([], '')
        return
      }
      if (sent && sent.sig !== '' && distanceM(sent.lon, sent.lat, s.lon, s.lat) < RETURN_PATH_EVERY_M) return
      const config = simConfigRef.current
      const home: FlyToTarget = { lat: s.home.lat, lon: s.home.lon, label: 'Home' }
      const check = await checkRoute(routeSafety, s, [home], config.ceilingM).catch(() => null)
      if (check?.status !== 'done') return
      if (routeProblem(check, 0, config.ceilingM)?.kind === 'ceiling') {
        setReturnPlan((p) => (p ? { ...p, pathHome: false } : p))
        await send([], 'none') // no way round: PX4's straight return is all there is
        return
      }
      const start = { lat: s.lat, lon: s.lon, relAltM: s.relAltM, inAir: true }
      const points = missionPoints(s, returnSteps(start, check.path, check.legMinSafeM, RETURN_MIN_ALT_M, false))
      setReturnPlan((p) => (p ? { ...p, pathHome: true } : p))
      await send(points, JSON.stringify(points))
    },
    [px4, routeSafety],
  )
  useEffect(() => {
    const s = stateRef.current
    if (!returnKey || !routeSafety || !s) return
    let cancelled = false
    routeSafety
      .check({ lat: s.lat, lon: s.lon }, s.home, s.home.altAmslM)
      .then((r) => {
        if (cancelled) return
        const max = returnMaxAltM(simConfigRef.current)
        const altM = Math.max(RETURN_MIN_ALT_M, Math.min(max, r.minSafeRelAltM))
        setReturnPlan((prev) => ({
          altM,
          highest: describe(r.highest),
          safe: r.minSafeRelAltM <= max,
          maxM: max,
          pathHome: s.inAir ? (prev?.pathHome ?? null) : null,
        }))
        void updateReturnPath(s)
        // Tell PX4 when it changed (the bridge reports what's set, so a PX4 restart is picked up).
        if (returnSending.current || Math.abs((px4.returnAltM ?? -1) - altM) < 1) return
        returnSending.current = true
        px4
          .command('returnAlt', { relAltM: altM })
          .catch((err: unknown) => console.warn('Could not set the return height', err))
          .finally(() => (returnSending.current = false))
      })
      .catch((err: unknown) => console.warn('Return height check failed', err))
    return () => {
      cancelled = true
    }
    // simConfig.ceilingM: a new ceiling changes the highest Return may fly.
  }, [returnKey, routeSafety, px4, simConfig.ceilingM, updateReturnPath])

  const routeCheck: RouteCheckInfo | null = !checkKey
    ? null
    : checkResult?.key === checkKey
      ? checkResult.info
      : { status: 'checking' }

  // While planning: the steps it would fly (from the planner's height and, once known, each
  // leg's safe height), how far and how long that is, and a grey preview on the map. In
  // flight: the same for what's left.
  const [planAltM, setPlanAltM] = useState(30)
  const planAltRef = useRef(planAltM)
  useEffect(() => {
    planAltRef.current = planAltM
  }, [planAltM])
  const start: RouteStart | null = hud
    ? { lat: hud.state.lat, lon: hud.state.lon, relAltM: hud.state.relAltM, inAir: hud.state.inAir }
    : null
  // The route as flown: with detours round tall buildings once the check has found them.
  const planPath = routeCheck?.status === 'done' ? routeCheck.path : routeStops
  const legMinSafeM = routeCheck?.status === 'done' ? routeCheck.legMinSafeM : routeStops.map(() => 0)
  const planSteps = planning && start ? routeSteps(start, planPath, legMinSafeM, planAltM) : null
  const routeEstimate = planSteps && start ? estimateRoute(start, planSteps, simConfig) : null
  const routeBattery =
    planSteps && start && hud && routeEstimate && routeCheck?.status === 'done'
      ? batteryFor(routeEstimate, planPath, routeCheck, planAltM, hud.state, simConfig)
      : null
  const preview = planSteps
    ? planPreview(planPath, planSteps)
    : autopilot && routeRun
      ? remainingPreview(routeRun.stops, routeRun.steps, routeRun.i)
      : null
  const previewKey = JSON.stringify(preview)
  useEffect(() => {
    droneView?.setPreview(previewKey === 'null' ? null : (JSON.parse(previewKey) as RoutePreview))
  }, [droneView, previewKey])

  let routeProgress: RouteProgress | null = null
  if (autopilot && routeRun) {
    const { steps, stops, i, phase } = routeRun
    // Count only the stops the user chose: a detour's turning points belong to the stop after them.
    const at = stepStop(steps, Math.max(0, i), stops.length)
    const real = realStops(stops)
    const next = real.find(([k]) => k >= at) ?? real[real.length - 1]
    const step = steps[i]
    routeProgress = {
      phase,
      stopIndex: next[1],
      stopCount: real.length,
      stopLabel: stops[next[0]]?.label ?? 'the destination',
      detour: !!stops[at]?.via,
      returning: routeRun.kind === 'return',
      heightM: step ? ('altM' in step ? step.altM : 0) : routeRun.altM,
      remaining: step && start ? estimateRoute(start, steps.slice(i), simConfig) : null,
      finalDescent: phase === 'descending' && !steps.some((st, k) => k > i && st.kind === 'fly'),
    }
  }

  /** Change sim settings: the bridge checks, saves and applies them (rejects with its reason). */
  const updateSimConfig = useCallback((changes: Partial<SimConfig>) => px4.command('config', { config: changes }), [px4])

  // --- pre-flight -----------------------------------------------------------

  /** Free fly: take off straight away and hand over the controls. */
  const freeFly = useCallback(async () => {
    setMission('free')
    if (!(await px4Command('takeoff', { altitudeM: FREE_FLY_ALT_M }))) setMission('choose')
  }, [px4Command])

  /** Back out of Plan a route: to the pre-flight choice, or (in the air) to the manual controls. */
  const backToChoose = useCallback(() => {
    setMission(inAirRef.current ? 'free' : 'choose')
    setRouteStops([])
    setCompose({ state: 'idle' })
  }, [])

  const addStop = useCallback((stop: FlyToTarget) => {
    setRouteStops((stops) => (stopGroups(stops).length < ROUTE_MAX_STOPS ? [...stops, stop] : stops))
  }, [])

  const pickRouteStop = useCallback(async () => {
    if (!pickLocation) return
    setPicking(true)
    const point = await pickLocation()
    setPicking(false)
    if (!point) return
    // Named after the building there (its name or address), else its coordinates.
    const building = await routeSafety?.buildingAt(point).catch(() => null)
    addStop({
      lat: point.lat,
      lon: point.lon,
      label: building?.name ?? formatLatLon(point.lat, point.lon),
      ...(building && { building: { heightM: building.heightM } }),
    })
  }, [pickLocation, addStop, routeSafety])

  /** Plan a route: a place chosen in the route's search box is added as the next stop. */
  const routeToPlace = useCallback(
    (place: Place) => {
      const { lat, lon } = centreOf(place.target)
      addStop({ lat, lon, label: place.title })
    },
    [addStop],
  )

  /** Stop i (counting real stops: a circle is one) is removed, with its circle points. */
  const removeStop = useCallback((i: number) => setRouteStops((stops) => stopGroups(stops).filter((_, k) => k !== i).flat()), [])
  /** Move stop i one place earlier. */
  const moveStopUp = useCallback(
    (i: number) =>
      setRouteStops((stops) => {
        const g = stopGroups(stops)
        return i < 1 || i >= g.length ? stops : [...g.slice(0, i - 1), g[i], g[i - 1], ...g.slice(i + 1)].flat()
      }),
    [],
  )

  /**
   * Planned route on autopilot, ending at `altM` above home over the last stop. Height
   * changes happen straight up or down, never on the way (see routePlan.ts): each leg is
   * flown at a height that clears every building on it.
   */
  const startRoute = useCallback(
    async (altM: number) => {
      const s = stateRef.current
      if (!routeStops.length || !s) return
      // Recheck from exactly where the drone is now.
      const config = simConfigRef.current
      const start = { lat: s.lat, lon: s.lon, relAltM: s.relAltM, inAir: inAirRef.current }
      let legMinSafe = routeStops.map(() => 0)
      let path = routeStops
      if (routeSafety) {
        const check = await checkRoute(routeSafety, s, routeStops, config.ceilingM).catch(() => null)
        if (check?.status === 'done') {
          const problem = routeProblem(check, altM, config.ceilingM)
          if (problem) {
            setPx4Error(
              problem.kind === 'ceiling'
                ? `This route needs ${problem.needM} m to clear the buildings on the way, above the ${config.ceilingM} m ceiling.`
                : `Too low for the destination: it needs at least ${problem.needM} m.`,
            )
            return
          }
          legMinSafe = check.legMinSafeM
          path = check.path
          // Enough battery for the route and the flight home after it?
          const steps = routeSteps(start, path, legMinSafe, altM)
          const b = batteryFor(estimateRoute(start, steps, config), path, check, altM, s, config)
          if (!b.ok) {
            setPx4Error(
              `Not enough battery: this route and the flight home would leave ${pct(b.atHome)}, under the ${pct(b.reserve)} reserve.`,
            )
            return
          }
        }
      }
      const steps = routeSteps(start, path, legMinSafe, altM)
      setAutopilot(true)
      lastRoute.current = { start: { lat: s.lat, lon: s.lon }, path }
      updateRun({ steps, i: -1, stops: path, altM, phase: 'climbing', kind: 'route' })
      runStepRef.current(0)
    },
    [routeStops, routeSafety, updateRun],
  )

  /** Leave the autopilot: the drone holds where it is and the manual controls take over. */
  const takeOver = useCallback(() => {
    updateRun(null)
    setAutopilot(false)
    setRouteStops([]) // a new plan from here starts empty
    setMission('free')
    droneView?.setTarget(null)
    void px4Command('hold')
  }, [droneView, px4Command, updateRun])

  // Keyboard flying, enabled while PX4 is connected and the drone is airborne.
  const droneViewRef = useRef(droneView)
  useEffect(() => {
    droneViewRef.current = droneView
  }, [droneView])
  const keyboardRef = useRef<KeyboardFlight | null>(null)
  useEffect(() => {
    // Created in an effect (not during render) so React dev mode's double render can't leak listeners.
    const keyboard = new KeyboardFlight(
      (v) => px4.sendVelocity(v),
      (active) => {
        setKeysActive(active)
        if (active) droneViewRef.current?.setTarget(null) // taking the sticks cancels a fly-to
      },
    )
    keyboardRef.current = keyboard
    return () => {
      keyboard.destroy()
      keyboardRef.current = null
    }
  }, [px4])
  // No keyboard while the autopilot flies a planned route (until "Take over controls").
  const canFly = px4Status === 'connected' && !crashed && !autopilot && (hud?.state.inAir ?? false)
  useEffect(() => keyboardRef.current?.setEnabled(canFly), [canFly])
  useEffect(() => keyboardRef.current?.setHorizontalSpeed(simConfig.keyboardMs), [simConfig.keyboardMs])

  /**
   * Return button: fly home from wherever the drone is, on autopilot. Straight if nothing
   * is in the way under the ceiling; else the shortest way round the buildings (as planned
   * routes do); else back the way the last route came. Then land (or hover, per the sim
   * config). PX4's own straight-line Return is the last resort.
   */
  const returnHome = useCallback(async () => {
    const s = stateRef.current
    const config = simConfigRef.current
    const pxReturn = (why: string | null) => {
      if (why) setPx4Error(why)
      void px4Command('rtl')
    }
    if (!s?.home || !routeSafety) return pxReturn(null)
    keyboardRef.current?.interrupt()
    setPx4Busy('rtl')
    const home: FlyToTarget = { lat: s.home.lat, lon: s.home.lon, label: 'Home' }
    let check = await checkRoute(routeSafety, s, [home], config.ceilingM).catch(() => null)
    const blocked = (c: RouteCheckInfo | null) => c?.status !== 'done' || routeProblem(c, 0, config.ceilingM)?.kind === 'ceiling'
    const last = lastRoute.current
    if (blocked(check) && last) {
      // Back the way the last route came: its stops in reverse, its start, then home.
      const back = [...last.path].reverse().slice(1)
      const retrace = [...back, { ...last.start, label: 'Start', via: true }, home]
      check = await checkRoute(routeSafety, s, retrace, config.ceilingM).catch(() => null)
    }
    setPx4Busy(null)
    if (!check || check.status !== 'done' || blocked(check))
      return pxReturn('No way home round the buildings found: PX4 is flying straight home (watch for tall buildings).')
    const start = { lat: s.lat, lon: s.lon, relAltM: s.relAltM, inAir: inAirRef.current }
    const steps = returnSteps(start, check.path, check.legMinSafeM, RETURN_MIN_ALT_M, config.afterReturn === 'land')
    setMission('free')
    setRouteStops([])
    setAutopilot(true)
    updateRun({ steps, i: -1, stops: check.path, altM: RETURN_MIN_ALT_M, phase: 'climbing', kind: 'return' })
    runStepRef.current(0)
  }, [routeSafety, px4Command, updateRun])

  // Building collisions: PX4 doesn't know about buildings, so the app decides it crashed.
  // The drone is drawn falling from the impact point at the wall (never inside), and with
  // PX4 the motors are cut so its own physics drops it too.
  const onBuildingHit = useCallback(
    (site: CrashSite) => {
      keyboardRef.current?.interrupt()
      updateRun(null)
      droneView?.crash(site)
      setCrashed(true)
      void px4Command('crash')
    },
    [droneView, px4Command, updateRun],
  )
  const collision = useCollisions(px4, onBuildingHit, !crashed)

  /** Back to the start: PX4 restarts with the drone at home, and the wreck is cleared. */
  const resetAfterCrash = useCallback(async () => {
    if (!(await px4Command('reset'))) return
    droneView?.clearCrash()
    setCrashed(false)
    setMission('choose')
    setRouteStops([])
    updateRun(null)
    setAutopilot(false)
  }, [px4Command, droneView, updateRun])

  /**
   * A route described in words: Claude (via the bridge) turns the text into steps, and the
   * steps become the planned stops (places looked up, moves and circles worked out from
   * where the drone will be), replacing any stops already planned. The usual route check,
   * preview and battery estimate then apply.
   */
  const composeRoute = useCallback(
    async (text: string) => {
      const s = stateRef.current
      if (!s) {
        setCompose({ state: 'error', text, message: 'Waiting for the drone’s position.', problems: [] })
        return
      }
      setCompose({ state: 'asking', text })
      const config = simConfigRef.current
      let plan
      try {
        plan = await px4.composeRoute(text, {
          inAir: inAirRef.current,
          relAltM: Math.round(s.relAltM),
          plannerAltM: planAltRef.current,
          ceilingM: config.ceilingM,
        })
      } catch (e) {
        setCompose({ state: 'error', text, message: e instanceof Error ? e.message : String(e), problems: [] })
        return
      }
      if (plan.questions.length) {
        setCompose({ state: 'questions', text, questions: plan.questions })
        return
      }
      const lookups: ComposeLookups = {
        findPlace: async (name) => {
          if (!searchPlace) return null
          const found = (await searchPlace(name)).places[0]
          if (!found) return null
          const at = centreOf(found.target)
          // The same place in the OpenStreetMap list, if it's there: its outline's centre and size
          // (the geocoder gives a point, often an entrance), so a circle goes round all of it.
          const listed = namedPlace(await loadPlaces().catch(() => []), name, at)
          return listed && listed.radiusM > 0
            ? { lat: listed.lat, lon: listed.lon, label: found.title, radiusM: listed.radiusM }
            : { ...at, label: found.title }
        },
        findNearest: async (category, near) => nearestPlaces(await loadPlaces(), category, near),
        buildingAround: async (at) => (routeSafety ? routeSafety.buildingAround(at) : null),
      }
      const home = s.home ?? { lat: s.lat, lon: s.lon }
      let result
      try {
        result = await compilePlan(plan, { lat: s.lat, lon: s.lon, headingDeg: s.headingDeg, home, ceilingM: config.ceilingM }, lookups)
      } catch (e) {
        setCompose({ state: 'error', text, message: `Couldn't look up the places: ${e instanceof Error ? e.message : e}`, problems: [] })
        return
      }
      if (!result.ok) {
        setCompose({ state: 'error', text, message: "Couldn't make that into a route:", problems: result.problems })
        return
      }
      const { route } = result
      if (!route.stops.length) {
        // Only "go home".
        if (inAirRef.current) {
          setCompose({ state: 'idle' })
          void returnHome()
        } else setCompose({ state: 'error', text, message: 'The drone is already home.', problems: [] })
        return
      }
      const notYet = [
        ...(route.hovers.length ? ['hovering'] : []),
        ...(route.ending === 'land' ? ['landing at the end (press Land when it gets there)'] : []),
        ...(route.ending === 'return' ? ['coming home at the end (press Return when it gets there)'] : []),
      ]
      // Circles passing right beside a building too tall to cross under the ceiling bend
      // round it (see bendCircles) instead of the route being refused.
      let stops = route.stops
      if (routeSafety && route.circles.length) {
        const homeAmslM = s.home?.altAmslM ?? s.altAmslM - s.relAltM
        const maxCrossM = config.ceilingM - DETOUR_BELOW_CEILING_M
        const bent = await bendCircles(route, (at) =>
          routeSafety.check(at, at, homeAmslM).then((c) => c.destMinSafeRelAltM > maxCrossM, () => false),
        )
        if (!bent) {
          setCompose({ state: 'error', text, message: 'Tall buildings stand all round that circle; try a wider one.', problems: [] })
          return
        }
        if (bent.bent) route.notes.push('The circle bends round tall buildings beside it.')
        stops = bent.stops
      }
      setRouteStops(stops)
      if (route.altM !== null) setComposedAltM((prev) => ({ altM: route.altM!, id: (prev?.id ?? 0) + 1 }))
      setCompose({ state: 'done', text, summary: plan.summary, notes: route.notes, notYet })
    },
    [px4, searchPlace, routeSafety, returnHome],
  )

  return {
    /** Drone state for the 3D view (CesiumViewer prop). */
    source: px4,
    setDroneView,
    droneView,
    hud,
    collision,
    crashed,
    panel: {
      crashed,
      onReset: () => void resetAfterCrash(),
      px4: {
        status: px4Status,
        version: px4.px4Version,
        url: px4.url,
        busy: px4Busy,
        error: px4Error,
        onCommand: (action: Px4Command, params?: Px4CommandParams) => void px4Command(action, params),
        canFly,
        keysActive,
        target,
        picking,
        geofence: px4.geofence,
        mission,
        onFreeFly: () => void freeFly(),
        onPlanRoute: () => setMission('route'),
        onBack: backToChoose,
        // The stops the pilot sees (circles as one stop; their turning points are hidden).
        routeStops: routeStops.filter((st) => !st.via),
        ai: px4.ai,
        compose,
        composedAltM,
        onComposeRoute: (text: string) => void composeRoute(text),
        onComposeClear: () => setCompose({ state: 'idle' }),
        onPickRouteStop: () => void pickRouteStop(),
        onRemoveStop: removeStop,
        onMoveStopUp: moveStopUp,
        onPlanAltM: setPlanAltM,
        onStartRoute: (altM: number) => void startRoute(altM),
        routeEstimate,
        routeBattery,
        routeProgress,
        ceilingM: simConfig.ceilingM,
        simConfig,
        routeCheck,
        overBuilding: collision.below,
        returnPlan,
        battery,
        autopilot,
        onTakeOver: takeOver,
        onReturnHome: () => void returnHome(),
      },
      inAir: hud?.state.inAir ?? false,
      armed: hud?.state.armed ?? false,
      relAltM: hud?.state.relAltM ?? null,
    },
    trailVisible,
    /** Return home's building-aware height (for Settings). */
    returnPlan,
    battery,
    setTrailVisible,
    /** For the route planner's search box. */
    routeToPlace,
    /** The simulated drone's settings (Settings → Simulation), and changing them. */
    simConfig,
    updateSimConfig,
  }
}

function pct(x: number) {
  return `${Math.max(0, Math.round(x * 100))}%`
}

/**
 * Battery for a planned route: the route itself, then PX4's Return from the last stop
 * (at the height that clears the buildings home), checked against the reserve.
 */
function batteryFor(
  route: RouteEstimate,
  stops: FlyToTarget[],
  check: Extract<RouteCheckInfo, { status: 'done' }>,
  endAltM: number,
  s: HudInfo['state'],
  config: SimConfig,
): RouteBattery {
  const last = stops[stops.length - 1]
  let home: RouteEstimate
  if (check.homePath) {
    // As Return flies it from the last stop: each leg at its height, round any tall buildings, then land.
    const from = { lat: last.lat, lon: last.lon, relAltM: endAltM, inAir: true }
    const land = config.afterReturn === 'land'
    home = estimateRoute(from, returnSteps(from, check.homePath, check.homeLegMinSafeM, RETURN_MIN_ALT_M, land), config)
  } else {
    // No way round: PX4's straight Return at its highest.
    const returnAltM = Math.max(RETURN_MIN_ALT_M, Math.min(returnMaxAltM(config), check.returnMinSafeM))
    home = estimateReturn(last, s.home ?? { lat: s.lat, lon: s.lon }, endAltM, returnAltM, config)
  }
  return { ...checkBattery(s.battery, route, home, config), home }
}

/** Re-send the path home to PX4 after the drone moves this far, metres. */
const RETURN_PATH_EVERY_M = 25
/** Flight modes in which PX4 may be flying the return path: it's left alone then. */
const RETURN_BUSY_MODES = new Set(['Return', 'Mission', 'Land'])

/** Detours are flown this far under the ceiling (like Return), well clear of a geofence breach. */
const DETOUR_BELOW_CEILING_M = 5

/**
 * Buildings along each leg of the route (drone → first stop → … → last stop), as the
 * panel shows them. A leg that can't be flown straight under the ceiling goes round the
 * buildings in the way instead, by the shortest path (see detour.ts), if there is one.
 */
/**
 * Legs from `from` through `stops`, each straight if it can be flown under the ceiling,
 * else round the buildings in the way by the shortest path (see detour.ts), if there is one.
 */
async function planLegs(safety: RouteSafety, from: LatLon, stops: FlyToTarget[], homeAmslM: number, ceilingM: number) {
  const points: LatLon[] = [from, ...stops]
  const path: FlyToTarget[] = []
  const legs: RouteCheck[] = []
  const detours: { around: { name: string | null; heightM: number } | null; extraM: number }[] = []
  let blocked: RouteCheck | null = null
  for (let i = 0; i < stops.length; i++) {
    const a = points[i]
    const to = stops[i]
    const direct = await safety.check(a, to, homeAmslM)
    const via = direct.minSafeRelAltM > ceilingM ? await safety.detour(a, to, homeAmslM, ceilingM - DETOUR_BELOW_CEILING_M) : []
    if (!via || (direct.minSafeRelAltM > ceilingM && via.length === 0)) {
      blocked ??= direct // no way round
      path.push(to)
      legs.push(direct)
      continue
    }
    const pts = [a, ...via, to]
    const sub = via.length ? await Promise.all(pts.slice(1).map((p, k) => safety.check(pts[k], p, homeAmslM))) : [direct]
    for (const p of via) path.push({ lat: p.lat, lon: p.lon, label: `Detour to ${to.label}`, via: true })
    path.push(to)
    legs.push(...sub)
    if (via.length) detours.push({ around: describe(direct.highest), extraM: pathLengthM(pts) - pathLengthM([a, to]) })
  }
  return { path, legs, detours, blocked }
}

/**
 * Buildings along each leg of the route (drone → first stop → … → last stop), as the
 * panel shows them, going round any too tall to cross under the ceiling; and the way home
 * from the last stop, planned the same way (as Return flies it).
 */
async function checkRoute(
  safety: RouteSafety,
  s: HudInfo['state'],
  stops: FlyToTarget[],
  ceilingM: number,
): Promise<RouteCheckInfo> {
  const homeAmslM = s.home?.altAmslM ?? s.altAmslM - s.relAltM
  const homePoint = s.home ?? { lat: s.lat, lon: s.lon }
  const { path, legs, detours, blocked } = await planLegs(safety, { lat: s.lat, lon: s.lon }, stops, homeAmslM, ceilingM)
  const home: FlyToTarget = { lat: homePoint.lat, lon: homePoint.lon, label: 'Home' }
  const back = await planLegs(safety, stops[stops.length - 1], [home], homeAmslM, ceilingM)
  const worst = blocked ?? legs.reduce((w, r) => (r.minSafeRelAltM > w.minSafeRelAltM ? r : w), legs[0])
  const last = legs[legs.length - 1]
  return {
    status: 'done',
    minSafeRelAltM: worst.minSafeRelAltM,
    highest: describe(worst.highest),
    destMinSafeRelAltM: last.destMinSafeRelAltM,
    destHighest: describe(last.destHighest),
    legMinSafeM: legs.map((r) => r.minSafeRelAltM),
    returnMinSafeM: back.legs.reduce((m, r) => Math.max(m, r.minSafeRelAltM), 0),
    homePath: back.blocked ? null : back.path,
    homeLegMinSafeM: back.legs.map((r) => r.minSafeRelAltM),
    path,
    detours,
  }
}

function describe(b: Building | null) {
  return b ? { name: buildingName(b), heightM: Math.round(b.roofM - b.groundM) } : null
}

/** Same level and the same whole minutes left: no re-render needed. */
function sameBattery(a: BatteryInfo | null, b: BatteryInfo | null): boolean {
  if (!a || !b) return a === b
  const m = (x: number | null) => (x === null ? null : Math.round(x * 2))
  return a.level === b.level && m(a.minToReturn) === m(b.minToReturn) && m(a.minToLand) === m(b.minToLand)
}
