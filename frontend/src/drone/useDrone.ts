import { useCallback, useEffect, useRef, useState } from 'react'
import { centreOf, type MapApi, type Place } from '../places/types'
import type { DroneView, FlyToTarget, HudInfo, RoutePreview } from './droneView'
import { BatteryEstimator, batteryThresholds, type BatteryInfo } from './battery'
import { DEFAULT_SIM_CONFIG, RETURN_MIN_ALT_M, returnMaxAltM, type SimConfig } from './simConfig'
import { KeyboardFlight } from './keyboardFlight'
import { Px4BridgeSource, type BridgeStatus, type Px4Command, type Px4CommandParams } from './px4Bridge'
import type { CrashSite } from './crash'
import { useCollisions } from './useCollisions'
import { loadMassingIndex, loadMassingTile } from '../data/torontoData'
import { buildingName, type Building } from './collision'
import { RouteSafety } from './routeSafety'
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
  stepStop,
  type BatteryCheck,
  type RouteEstimate,
  type RouteStart,
  type RouteStep,
} from './routePlan'

/** Where the autopilot is in a planned route. */
export type RoutePhase = 'climbing' | 'flying' | 'descending' | 'arrived'

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
      /** Lowest safe height for the flight home from the last stop (Return's height there). */
      returnMinSafeM: number
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
}

/** A planned route being flown: its steps, the one in progress, and the stops. */
type RouteRun = { steps: RouteStep[]; i: number; stops: FlyToTarget[]; altM: number; phase: RoutePhase }

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
}

/** Pre-flight choice: free flying with the keyboard, or a planned route to a destination. */
export type Mission = 'choose' | 'free' | 'route'

/** Free fly takes off straight away to this height (above the launch point). */
const FREE_FLY_ALT_M = 30

type Options = {
  /** Map click picker (from the map API), for "pick on map" fly-to. */
  pickLocation?: MapApi['pickLocation']
}

/**
 * All drone state for the UI: the PX4 connection (via the bridge), HUD data,
 * PX4 commands, keyboard flying, fly-to, collisions and crash/reset.
 */
export function useDrone({ pickLocation }: Options = {}) {
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
  /** The route being flown (state for rendering, ref for event handlers). */
  const [routeRun, setRouteRun] = useState<RouteRun | null>(null)
  const routeRunRef = useRef<RouteRun | null>(null)
  const updateRun = useCallback((run: RouteRun | null) => {
    routeRunRef.current = run
    setRouteRun(run)
  }, [])
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
        step.kind === 'fly' ? 'flying' : step.kind === 'vertical' && s && step.altM < s.relAltM ? 'descending' : 'climbing'
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
    checkRoute(routeSafety, s, routeStops)
      .then((info) => !cancelled && setCheckResult({ key: checkKey, info }))
      .catch(() => !cancelled && setCheckResult({ key: checkKey, info: { status: 'error' } }))
    return () => {
      cancelled = true
    }
  }, [checkKey, routeSafety, routeStops])
  // Return home: PX4 climbs to its return height and flies straight home, not knowing about
  // buildings. Keep that height clear of the buildings between the drone and home, rechecked
  // every ~10 m the drone moves (left alone during a return, which has already started).
  const [returnPlan, setReturnPlan] = useState<ReturnPlan | null>(null)
  const returnSending = useRef(false)
  const returnKey =
    px4Status === 'connected' && hud && !crashed && hud.state.flightMode !== 'Return'
      ? `${hud.state.lat.toFixed(4)},${hud.state.lon.toFixed(4)}|${hud.state.home.lat.toFixed(5)},${hud.state.home.lon.toFixed(5)}`
      : null
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
        setReturnPlan({ altM, highest: describe(r.highest), safe: r.minSafeRelAltM <= max, maxM: max })
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
  }, [returnKey, routeSafety, px4, simConfig.ceilingM])

  const routeCheck: RouteCheckInfo | null = !checkKey
    ? null
    : checkResult?.key === checkKey
      ? checkResult.info
      : { status: 'checking' }

  // While planning: the steps it would fly (from the planner's height and, once known, each
  // leg's safe height), how far and how long that is, and a grey preview on the map. In
  // flight: the same for what's left.
  const [planAltM, setPlanAltM] = useState(30)
  const start: RouteStart | null = hud
    ? { lat: hud.state.lat, lon: hud.state.lon, relAltM: hud.state.relAltM, inAir: hud.state.inAir }
    : null
  const legMinSafeM = routeCheck?.status === 'done' ? routeCheck.legMinSafeM : routeStops.map(() => 0)
  const planSteps = planning && start ? routeSteps(start, routeStops, legMinSafeM, planAltM) : null
  const routeEstimate = planSteps && start ? estimateRoute(start, planSteps, simConfig) : null
  const routeBattery =
    planSteps && start && hud && routeEstimate && routeCheck?.status === 'done'
      ? batteryFor(routeEstimate, routeStops, routeCheck.returnMinSafeM, planAltM, hud.state, simConfig)
      : null
  const preview = planSteps
    ? planPreview(routeStops, planSteps)
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
    const stopIndex = stepStop(steps, Math.max(0, i), stops.length)
    const step = steps[i]
    routeProgress = {
      phase,
      stopIndex,
      stopCount: stops.length,
      stopLabel: stops[stopIndex]?.label ?? 'the destination',
      heightM: step ? step.altM : routeRun.altM,
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
  }, [])

  const addStop = useCallback((stop: FlyToTarget) => {
    setRouteStops((stops) => (stops.length < ROUTE_MAX_STOPS ? [...stops, stop] : stops))
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

  const removeStop = useCallback((i: number) => setRouteStops((stops) => stops.filter((_, k) => k !== i)), [])
  /** Move stop i one place earlier. */
  const moveStopUp = useCallback(
    (i: number) =>
      setRouteStops((stops) => (i < 1 ? stops : [...stops.slice(0, i - 1), stops[i], stops[i - 1], ...stops.slice(i + 1)])),
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
      if (routeSafety) {
        const check = await checkRoute(routeSafety, s, routeStops).catch(() => null)
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
          // Enough battery for the route and the flight home after it?
          const steps = routeSteps(start, routeStops, legMinSafe, altM)
          const b = batteryFor(estimateRoute(start, steps, config), routeStops, check.returnMinSafeM, altM, s, config)
          if (!b.ok) {
            setPx4Error(
              `Not enough battery: this route and the flight home would leave ${pct(b.atHome)}, under the ${pct(b.reserve)} reserve.`,
            )
            return
          }
        }
      }
      const steps = routeSteps(start, routeStops, legMinSafe, altM)
      setAutopilot(true)
      updateRun({ steps, i: -1, stops: routeStops, altM, phase: 'climbing' })
      runStepRef.current(0)
    },
    [routeStops, routeSafety, updateRun],
  )

  /** Leave the autopilot: the drone holds where it is and the manual controls take over. */
  const takeOver = useCallback(() => {
    updateRun(null)
    setAutopilot(false)
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
        routeStops,
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
  returnMinSafeM: number,
  endAltM: number,
  s: HudInfo['state'],
  config: SimConfig,
): RouteBattery {
  const last = stops[stops.length - 1]
  const returnAltM = Math.max(RETURN_MIN_ALT_M, Math.min(returnMaxAltM(config), returnMinSafeM))
  const home = estimateReturn(last, s.home ?? { lat: s.lat, lon: s.lon }, endAltM, returnAltM, config)
  return { ...checkBattery(s.battery, route, home, config), home }
}

/** Buildings along each leg of the route (drone → first stop → … → last stop), as the panel shows them. */
async function checkRoute(safety: RouteSafety, s: HudInfo['state'], stops: FlyToTarget[]): Promise<RouteCheckInfo> {
  const homeAmslM = s.home?.altAmslM ?? s.altAmslM - s.relAltM
  const points = [{ lat: s.lat, lon: s.lon }, ...stops]
  const homePoint = s.home ?? { lat: s.lat, lon: s.lon }
  const [home, ...legs] = await Promise.all([
    safety.check(stops[stops.length - 1], homePoint, homeAmslM),
    ...stops.map((stop, i) => safety.check(points[i], stop, homeAmslM)),
  ])
  const worst = legs.reduce((w, r) => (r.minSafeRelAltM > w.minSafeRelAltM ? r : w), legs[0])
  const last = legs[legs.length - 1]
  return {
    status: 'done',
    minSafeRelAltM: worst.minSafeRelAltM,
    highest: describe(worst.highest),
    destMinSafeRelAltM: last.destMinSafeRelAltM,
    destHighest: describe(last.destHighest),
    legMinSafeM: legs.map((r) => r.minSafeRelAltM),
    returnMinSafeM: home.minSafeRelAltM,
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
