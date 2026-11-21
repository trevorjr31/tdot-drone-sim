import { useCallback, useEffect, useState } from 'react'
import type { SourceId } from '../components/DronePanel'
import { DemoFlightSource } from './demoFlight'
import type { DroneView, HudInfo } from './droneView'
import { Px4BridgeSource, type BridgeStatus, type Px4Command } from './px4Bridge'
import { CAMERA_MODES, type CameraMode } from './types'

const SOURCE_KEY = 'tdot.droneSource.v1'

function loadSource(): SourceId {
  try {
    return localStorage.getItem(SOURCE_KEY) === 'px4' ? 'px4' : 'demo'
  } catch {
    return 'demo'
  }
}

/**
 * All drone state for the UI: the two sources (demo flight, PX4 via the bridge),
 * which one feeds the 3D view, camera mode, HUD data and PX4 commands.
 */
export function useDrone() {
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

  const source = sourceId === 'demo' ? demo : px4

  useEffect(() => {
    if (!droneView) return
    const offMode = droneView.onCameraModeChange(setCameraMode)
    const offHud = droneView.onHud(setHud)
    return () => {
      offMode()
      offHud()
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
    (action: Px4Command, params?: { altitudeM?: number }) => {
      setPx4Busy(action)
      setPx4Error(null)
      if (action === 'takeoff') droneView?.clearTrail()
      px4
        .command(action, params)
        .then(() => {
          if (action === 'takeoff') followDrone()
        })
        .catch((err: unknown) => setPx4Error(err instanceof Error ? err.message : String(err)))
        .finally(() => setPx4Busy(null))
    },
    [px4, droneView, followDrone],
  )

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
