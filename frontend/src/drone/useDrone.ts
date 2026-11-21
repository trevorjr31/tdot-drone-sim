import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceId } from '../components/DronePanel'
import { DemoFlightSource } from './demoFlight'
import { centreOf, type MapApi, type Place } from '../places/types'
import type { DroneView, FlyToTarget, HudInfo } from './droneView'
import { KeyboardFlight } from './keyboardFlight'
import { Px4BridgeSource, type BridgeStatus, type Px4Command, type Px4CommandParams } from './px4Bridge'
import { CAMERA_MODES, type CameraMode } from './types'

const SOURCE_KEY = 'tdot.droneSource.v1'

function loadSource(): SourceId {
  try {
    return localStorage.getItem(SOURCE_KEY) === 'px4' ? 'px4' : 'demo'
  } catch {
    return 'demo'
  }
}

type Options = {
  /** Map click picker (from the map API), for "pick on map" fly-to. */
  pickLocation?: MapApi['pickLocation']
  /** The place last chosen in search, offered as a fly-to destination. */
  searchedPlace?: Place | null
}

/**
 * All drone state for the UI: the two sources (demo flight, PX4 via the bridge),
 * which one feeds the 3D view, camera mode, HUD data, PX4 commands, keyboard
 * flying and fly-to.
 */
export function useDrone({ pickLocation, searchedPlace = null }: Options = {}) {
  const [demo] = useState(() => new DemoFlightSource())
  const [px4] = useState(() => new Px4BridgeSource())
  const [sourceId, setSourceId] = useState<SourceId>(loadSource)
  const [droneView, setDroneView] = useState<DroneView | null>(null)
  const [cameraMode, setCameraMode] = useState<CameraMode>('free')
  const [hud, setHud] = useState<HudInfo | null>(null)
  const [trailVisible, setTrailVisible] = useState(true)
  const [px4Status, setPx4Status] = useState<BridgeStatus>(px4.status)
  const [px4Busy, setPx4Busy] = useState<Px4Command | null>(null)
  const [px4Error, setPx4Error] = useState<string | null>(null)
  const [keysActive, setKeysActive] = useState(false)
  const [target, setTarget] = useState<FlyToTarget | null>(null)
  const [picking, setPicking] = useState(false)

  const source = sourceId === 'demo' ? demo : px4

  useEffect(() => {
    if (!droneView) return
    const offMode = droneView.onCameraModeChange(setCameraMode)
    const offHud = droneView.onHud(setHud)
    const offTarget = droneView.onTargetChange(setTarget)
    return () => {
      offMode()
      offHud()
      offTarget()
    }
  }, [droneView])

  // Feed the selected source to the 3D view; only keep the bridge connection open while PX4 is selected.
  useEffect(() => {
    droneView?.setSource(source)
  }, [droneView, source])

  useEffect(() => {
    try {
      localStorage.setItem(SOURCE_KEY, sourceId)
    } catch {
      // ignore
    }
    if (sourceId === 'px4') {
      demo.pause()
      px4.connect()
    } else {
      px4.disconnect()
    }
  }, [sourceId, demo, px4])

  const selectSource = useCallback((id: SourceId) => {
    setSourceId(id)
    setPx4Error(null) // an error from the other source no longer applies
  }, [])

  useEffect(() => px4.onStatus(setPx4Status), [px4])
  useEffect(() => px4.onNotice(setPx4Error), [px4])
  useEffect(
    () => () => {
      demo.pause()
      px4.disconnect()
    },
    [demo, px4],
  )
  useEffect(() => droneView?.setTrailVisible(trailVisible), [droneView, trailVisible])

  // Dev only: poke at the drone from the browser console (window.tdot).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { tdot: unknown }).tdot = { demo, px4, droneView }
  }, [demo, px4, droneView])

  const changeCamera = useCallback((mode: CameraMode) => droneView?.setCameraMode(mode), [droneView])

  /** Following the drone is the natural view once it starts flying. */
  const followDrone = useCallback(() => {
    if (droneView?.cameraMode === 'free') droneView.setCameraMode('chase')
  }, [droneView])

  const startDemo = useCallback(() => {
    if (demo.finished) droneView?.clearTrail()
    demo.start()
    followDrone()
  }, [demo, droneView, followDrone])

  const resetDemo = useCallback(() => {
    demo.reset()
    droneView?.clearTrail()
  }, [demo, droneView])

  const px4Command = useCallback(
    (action: Px4Command, params?: Px4CommandParams) => {
      setPx4Busy(action)
      setPx4Error(null)
      if (action === 'takeoff') droneView?.clearTrail()
      if (action !== 'goto') droneView?.setTarget(null) // a new command replaces any fly-to
      px4
        .command(action, params)
        .then(() => {
          if (action === 'takeoff' || action === 'goto') followDrone()
        })
        .catch((err: unknown) => {
          setPx4Error(err instanceof Error ? err.message : String(err))
          if (action === 'goto') droneView?.setTarget(null)
        })
        .finally(() => setPx4Busy(null))
    },
    [px4, droneView, followDrone],
  )

  // Fly-to: PX4 flies to the point at its current height.
  const flyTo = useCallback(
    (lat: number, lon: number, label: string) => {
      droneView?.setTarget({ lat, lon, label })
      px4Command('goto', { lat, lon })
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
  const followRef = useRef(followDrone)
  const droneViewRef = useRef(droneView)
  useEffect(() => {
    followRef.current = followDrone
    droneViewRef.current = droneView
  }, [followDrone, droneView])
  const keyboardRef = useRef<KeyboardFlight | null>(null)
  useEffect(() => {
    // Created in an effect (not during render) so React dev mode's double render can't leak listeners.
    const keyboard = new KeyboardFlight(
      (v) => px4.sendVelocity(v),
      (active) => {
        setKeysActive(active)
        if (active) {
          followRef.current()
          droneViewRef.current?.setTarget(null) // taking the sticks cancels a fly-to
        }
      },
    )
    keyboardRef.current = keyboard
    return () => {
      keyboard.destroy()
      keyboardRef.current = null
    }
  }, [px4])
  const canFly = sourceId === 'px4' && px4Status === 'connected' && (hud?.state.inAir ?? false)
  useEffect(() => keyboardRef.current?.setEnabled(canFly), [canFly])

  // C cycles the camera: chase → FPV → free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'c' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const order = CAMERA_MODES.map((m) => m.id)
      changeCamera(order[(order.indexOf(cameraMode) + 1) % order.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cameraMode, changeCamera])

  return {
    /** Source the 3D view starts with (CesiumViewer prop). */
    initialSource: demo,
    setDroneView,
    droneView,
    hud,
    panel: {
      source: sourceId,
      onSource: selectSource,
      demo: {
        running: demo.running,
        finished: demo.finished,
        onStart: startDemo,
        onPause: () => demo.pause(),
        onReset: resetDemo,
      },
      px4: {
        status: px4Status,
        version: px4.px4Version,
        url: px4.url,
        busy: px4Busy,
        error: px4Error,
        onCommand: px4Command,
        canFly,
        keysActive,
        target,
        picking,
        searchedPlaceTitle: searchedPlace?.title ?? null,
        onPickAndFly: () => void pickAndFly(),
        onFlyToSearched: flyToSearched,
      },
      inAir: hud?.state.inAir ?? false,
      armed: hud?.state.armed ?? false,
      cameraMode,
      onCameraMode: changeCamera,
      trailVisible,
      onTrailVisible: setTrailVisible,
    },
  }
}
