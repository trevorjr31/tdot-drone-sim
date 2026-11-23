import { useCallback, useEffect, useRef, useState } from 'react'
import { centreOf, type MapApi, type Place } from '../places/types'
import type { DroneView, FlyToTarget, HudInfo } from './droneView'
import { KeyboardFlight } from './keyboardFlight'
import { Px4BridgeSource, type BridgeStatus, type Px4Command, type Px4CommandParams } from './px4Bridge'
import type { CrashSite } from './crash'
import { useCollisions } from './useCollisions'
import { loadMassingIndex, loadMassingTile } from '../data/torontoData'
import { buildingName, type Building } from './collision'
import { RouteSafety } from './routeSafety'

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
    }

/**
 * Why a route ending at `altM` can't be flown, or null if it can. The autopilot picks
 * its own crossing height (see crossingAltM), so only two things block a route: it
 * needs more than the ceiling, or `altM` is too low for the destination itself.
 */
export function routeProblem(
  c: Extract<RouteCheckInfo, { status: 'done' }>,
  altM: number,
): { kind: 'ceiling' | 'destination'; needM: number } | null {
  if (c.minSafeRelAltM > ROUTE_MAX_ALT_M) return { kind: 'ceiling', needM: c.minSafeRelAltM }
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

/** Highest a route may fly: PX4's geofence ceiling (the bridge clamps heights to this too). */
export const ROUTE_MAX_ALT_M = 120
/** Highest Return home may fly: under the geofence ceiling, or the return itself breaches it (bridge: RETURN_ALT_MAX_M). */
export const RETURN_MAX_ALT_M = 115
/** Lowest return height the app sets (bridge: RETURN_ALT_MIN_M). */
export const RETURN_MIN_ALT_M = 20

/** Return home's height, kept clear of the buildings between the drone and home. */
export type ReturnPlan = {
  /** Height PX4 returns at, metres above home. */
  altM: number
  /** Tallest building on the straight line home, if any. */
  highest: { name: string | null; heightM: number } | null
  /** False when that building is too tall to clear under the ceiling. */
  safe: boolean
}

/** Pre-flight choice: free flying with the keyboard, or a planned route to a destination. */
export type Mission = 'choose' | 'free' | 'route'

/** Free fly takes off straight away to this height (above the launch point). */
const FREE_FLY_ALT_M = 30
/** A planned route starts its fly-to once within this much of the takeoff height. */
const ROUTE_CLIMB_TOLERANCE_M = 2

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
  const [routeDest, setRouteDest] = useState<FlyToTarget | null>(null)
  /** Planned route on autopilot: climbing, flying, descending or arrived. */
  const [routePhase, setRoutePhase] = useState<RoutePhase | null>(null)
  /** routePhase for event handlers (the target listener must know if the route is in its flying leg). */
  const routePhaseRef = useRef<RoutePhase | null>(null)
  useEffect(() => {
    routePhaseRef.current = routePhase
  }, [routePhase])
  const [routeAltM, setRouteAltM] = useState<number | null>(null)
  /** Height the route crosses at (may be above routeAltM, to clear buildings). */
  const [routeCrossM, setRouteCrossM] = useState<number | null>(null)
  const [routeSafety, setRouteSafety] = useState<RouteSafety | null>(null)
  const [checkResult, setCheckResult] = useState<{ key: string; info: RouteCheckInfo } | null>(null)
  /** Latest drone state, for commands that need the current position. */
  const stateRef = useRef<HudInfo['state'] | null>(null)
  /** Planned route from the air, lower than the current height: descend once over the destination. */
  const pendingDescent = useRef<{ dest: FlyToTarget; altM: number } | null>(null)
  /** Descending over the destination to this height. */
  const descendingTo = useRef<number | null>(null)
  const startDescentRef = useRef<(d: { dest: FlyToTarget; altM: number }) => void>(() => {})
  /** The autopilot is flying a planned route (until landing or "Take over controls"). */
  const [autopilot, setAutopilot] = useState(false)
  const inAirRef = useRef(false)
  /** A planned route waiting for the takeoff to reach height before flying to its destination. */
  const pendingRoute = useRef<{ dest: FlyToTarget; altM: number } | null>(null)
  const startRouteLegRef = useRef<(dest: FlyToTarget) => void>(() => {})

  useEffect(() => {
    if (!droneView) return
    let wasFlying = false
    const offHud = droneView.onHud((h) => {
      setHud(h)
      const flying = !!h && (h.state.armed || h.state.inAir)
      inAirRef.current = !!h?.state.inAir
      stateRef.current = h?.state ?? null
      // Landed after a flight: back to the pre-flight choice.
      if (wasFlying && h && !flying) {
        setMission('choose')
        setRouteDest(null)
        setRoutePhase(null)
        setAutopilot(false)
        pendingRoute.current = null
        pendingDescent.current = null
        descendingTo.current = null
      }
      wasFlying = flying
      // Planned route: once the takeoff has reached height, fly to the destination.
      const route = pendingRoute.current
      if (route && h?.state.inAir && h.state.relAltM >= route.altM - ROUTE_CLIMB_TOLERANCE_M) {
        pendingRoute.current = null
        setRoutePhase('flying')
        startRouteLegRef.current(route.dest)
      }
      // Descending over the destination: done once at height.
      const down = descendingTo.current
      if (down !== null && h && h.state.relAltM <= down + ROUTE_CLIMB_TOLERANCE_M) {
        descendingTo.current = null
        setRoutePhase('arrived')
      }
    })
    const offTarget = droneView.onTargetChange((t) => {
      setTarget(t)
      // Reached the destination: fly-to targets clear themselves on arrival. Only during the
      // flying leg: other commands (e.g. the take-off) clear the target too.
      if (t || routePhaseRef.current !== 'flying') return
      const descent = pendingDescent.current
      if (descent) {
        pendingDescent.current = null
        startDescentRef.current(descent)
      } else setRoutePhase('arrived')
    })
    return () => {
      offHud()
      offTarget()
    }
  }, [droneView])

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
    startRouteLegRef.current = (dest) => void flyTo(dest.lat, dest.lon, dest.label)
    startDescentRef.current = ({ dest, altM }) => {
      descendingTo.current = altM
      setRoutePhase('descending')
      void px4Command('goto', { lat: dest.lat, lon: dest.lon, relAltM: altM })
    }
  }, [flyTo, px4Command])

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

  // While planning a route: the buildings between the drone and the destination.
  // Rechecked when the destination changes or the drone moves ~100 m.
  const planning = mission === 'route' && !autopilot && routeDest !== null
  const posKey = hud ? `${hud.state.lat.toFixed(3)},${hud.state.lon.toFixed(3)}` : null
  const checkKey = planning && routeDest && posKey && routeSafety ? `${routeDest.lat},${routeDest.lon}|${posKey}` : null
  useEffect(() => {
    const s = stateRef.current
    if (!checkKey || !routeSafety || !routeDest || !s) return
    let cancelled = false
    checkRoute(routeSafety, s, routeDest)
      .then((info) => !cancelled && setCheckResult({ key: checkKey, info }))
      .catch(() => !cancelled && setCheckResult({ key: checkKey, info: { status: 'error' } }))
    return () => {
      cancelled = true
    }
  }, [checkKey, routeSafety, routeDest])
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
        const altM = Math.max(RETURN_MIN_ALT_M, Math.min(RETURN_MAX_ALT_M, r.minSafeRelAltM))
        setReturnPlan({ altM, highest: describe(r.highest), safe: r.minSafeRelAltM <= RETURN_MAX_ALT_M })
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
  }, [returnKey, routeSafety, px4])

  const routeCheck: RouteCheckInfo | null = !checkKey
    ? null
    : checkResult?.key === checkKey
      ? checkResult.info
      : { status: 'checking' }

  // --- pre-flight -----------------------------------------------------------

  /** Free fly: take off straight away and hand over the controls. */
  const freeFly = useCallback(async () => {
    setMission('free')
    if (!(await px4Command('takeoff', { altitudeM: FREE_FLY_ALT_M }))) setMission('choose')
  }, [px4Command])

  /** Back out of Plan a route: to the pre-flight choice, or (in the air) to the manual controls. */
  const backToChoose = useCallback(() => {
    setMission(inAirRef.current ? 'free' : 'choose')
    setRouteDest(null)
  }, [])

  const pickRouteDest = useCallback(async () => {
    if (!pickLocation) return
    setPicking(true)
    const point = await pickLocation()
    setPicking(false)
    if (point) setRouteDest({ lat: point.lat, lon: point.lon, label: 'Map point' })
  }, [pickLocation])

  /** Plan a route: a place chosen in the route's search box becomes the destination. */
  const routeToPlace = useCallback((place: Place) => {
    const { lat, lon } = centreOf(place.target)
    setRouteDest({ lat, lon, label: place.title })
  }, [])

  /**
   * Planned route on autopilot, ending at `altM` above home. Height changes happen straight
   * up or down, never on the way: climb (or take off) to the crossing height, which clears
   * every building on the route, fly across, then descend to `altM` over the destination.
   */
  const startRoute = useCallback(
    async (altM: number) => {
      const s = stateRef.current
      if (!routeDest || !s) return
      const inAir = inAirRef.current
      // Recheck from exactly where the drone is now.
      let crossM = crossingAltM(altM, inAir ? s.relAltM : null, 0)
      if (routeSafety) {
        const check = await checkRoute(routeSafety, s, routeDest).catch(() => null)
        if (check?.status === 'done') {
          const problem = routeProblem(check, altM)
          if (problem) {
            setPx4Error(
              problem.kind === 'ceiling'
                ? `This route needs ${problem.needM} m to clear the buildings on the way, above the ${ROUTE_MAX_ALT_M} m ceiling.`
                : `Too low for the destination: it needs at least ${problem.needM} m.`,
            )
            return
          }
          crossM = crossingAltM(altM, inAir ? s.relAltM : null, check.minSafeRelAltM)
        }
      }
      const fail = () => {
        pendingRoute.current = null
        pendingDescent.current = null
        setRoutePhase(null)
        setAutopilot(false)
      }
      setAutopilot(true)
      setRouteAltM(altM)
      setRouteCrossM(crossM)
      if (altM < crossM - ROUTE_CLIMB_TOLERANCE_M) pendingDescent.current = { dest: routeDest, altM }
      if (inAir) {
        if (crossM > s.relAltM + ROUTE_CLIMB_TOLERANCE_M) {
          pendingRoute.current = { dest: routeDest, altM: crossM }
          setRoutePhase('climbing')
          droneView?.setTarget(routeDest)
          if (!(await px4Command('goto', { lat: s.lat, lon: s.lon, relAltM: crossM }))) fail()
          return
        }
        setRoutePhase('flying')
        if (!(await flyTo(routeDest.lat, routeDest.lon, routeDest.label))) fail()
        return
      }
      pendingRoute.current = { dest: routeDest, altM: crossM }
      setRoutePhase('climbing')
      if (await px4Command('takeoff', { altitudeM: crossM })) droneView?.setTarget(routeDest)
      else fail()
    },
    [routeDest, routeSafety, px4Command, droneView, flyTo],
  )

  /** Leave the autopilot: the drone holds where it is and the manual controls take over. */
  const takeOver = useCallback(() => {
    pendingRoute.current = null
    pendingDescent.current = null
    descendingTo.current = null
    setRoutePhase(null)
    setAutopilot(false)
    setMission('free')
    droneView?.setTarget(null)
    void px4Command('hold')
  }, [droneView, px4Command])



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

  // Building collisions: PX4 doesn't know about buildings, so the app decides it crashed.
  // The drone is drawn falling from the impact point at the wall (never inside), and with
  // PX4 the motors are cut so its own physics drops it too.
  const onBuildingHit = useCallback(
    (site: CrashSite) => {
      keyboardRef.current?.interrupt()
      pendingRoute.current = null
      pendingDescent.current = null
      descendingTo.current = null
      droneView?.crash(site)
      setCrashed(true)
      void px4Command('crash')
    },
    [droneView, px4Command],
  )
  const collision = useCollisions(px4, onBuildingHit, !crashed)

  /** Back to the start: PX4 restarts with the drone at home, and the wreck is cleared. */
  const resetAfterCrash = useCallback(async () => {
    if (!(await px4Command('reset'))) return
    droneView?.clearCrash()
    setCrashed(false)
    setMission('choose')
    setRouteDest(null)
    setRoutePhase(null)
    setAutopilot(false)
  }, [px4Command, droneView])

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
        routeDest,
        onPickRouteDest: () => void pickRouteDest(),
        onClearRouteDest: () => setRouteDest(null),
        onStartRoute: (altM: number) => void startRoute(altM),
        routePhase,
        routeAltM,
        routeCrossM,
        routeCheck,
        overBuilding: collision.below,
        returnPlan,
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
    setTrailVisible,
    /** For the route planner's search box. */
    routeToPlace,
  }
}

/** Buildings between the drone and the destination, as the panel shows them. */
async function checkRoute(safety: RouteSafety, s: HudInfo['state'], dest: FlyToTarget): Promise<RouteCheckInfo> {
  const homeAmslM = s.home?.altAmslM ?? s.altAmslM - s.relAltM
  const r = await safety.check({ lat: s.lat, lon: s.lon }, dest, homeAmslM)
  return {
    status: 'done',
    minSafeRelAltM: r.minSafeRelAltM,
    highest: describe(r.highest),
    destMinSafeRelAltM: r.destMinSafeRelAltM,
    destHighest: describe(r.destHighest),
  }
}

function describe(b: Building | null) {
  return b ? { name: buildingName(b), heightM: Math.round(b.roofM - b.groundM) } : null
}
