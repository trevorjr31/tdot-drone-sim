import { useCallback, useEffect, useRef, useState } from 'react'
import { centreOf, type MapApi, type Place } from '../places/types'
import type { DroneView, FlyToTarget, HudInfo } from './droneView'
import { KeyboardFlight } from './keyboardFlight'
import { Px4BridgeSource, type BridgeStatus, type Px4Command, type Px4CommandParams } from './px4Bridge'
import type { CrashSite } from './crash'
import { useCollisions } from './useCollisions'

type Options = {
  /** Map click picker (from the map API), for "pick on map" fly-to. */
  pickLocation?: MapApi['pickLocation']
  /** The place last chosen in search, offered as a fly-to destination. */
  searchedPlace?: Place | null
}

/**
 * All drone state for the UI: the PX4 connection (via the bridge), HUD data,
 * PX4 commands, keyboard flying, fly-to, collisions and crash/reset.
 */
export function useDrone({ pickLocation, searchedPlace = null }: Options = {}) {
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

  useEffect(() => {
    if (!droneView) return
    const offHud = droneView.onHud(setHud)
    const offTarget = droneView.onTargetChange(setTarget)
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

  // Fly-to: PX4 flies to the point at its current height.
  const flyTo = useCallback(
    (lat: number, lon: number, label: string) => {
      droneView?.setTarget({ lat, lon, label })
      void px4Command('goto', { lat, lon })
    },
    [droneView, px4Command],
  )

  const pickAndFly = useCallback(async () => {
    if (!pickLocation) return
    setPicking(true)
    const point = await pickLocation()
    setPicking(false)
    if (point) flyTo(point.lat, point.lon, 'map point')
  }, [pickLocation, flyTo])

  const flyToSearched = useCallback(() => {
    if (!searchedPlace) return
    const { lat, lon } = centreOf(searchedPlace.target)
    flyTo(lat, lon, searchedPlace.title)
  }, [searchedPlace, flyTo])

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
  const canFly = px4Status === 'connected' && !crashed && (hud?.state.inAir ?? false)
  useEffect(() => keyboardRef.current?.setEnabled(canFly), [canFly])

  // Building collisions: PX4 doesn't know about buildings, so the app decides it crashed.
  // The drone is drawn falling from the impact point at the wall (never inside), and with
  // PX4 the motors are cut so its own physics drops it too.
  const onBuildingHit = useCallback(
    (site: CrashSite) => {
      keyboardRef.current?.interrupt()
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
        searchedPlaceTitle: searchedPlace?.title ?? null,
        geofence: px4.geofence,
        onPickAndFly: () => void pickAndFly(),
        onFlyToSearched: flyToSearched,
      },
      inAir: hud?.state.inAir ?? false,
      armed: hud?.state.armed ?? false,
      trailVisible,
      onTrailVisible: setTrailVisible,
    },
  }
}
