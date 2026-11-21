import { useCallback, useEffect, useMemo, useState } from 'react'
import { CesiumViewer, type TilesStatus } from './components/CesiumViewer'
import { DroneHud } from './components/DroneHud'
import { DronePanel } from './components/DronePanel'
import { LayerPanel } from './components/LayerPanel'
import { DemoFlightSource } from './drone/demoFlight'
import type { DroneView, HudInfo } from './drone/droneView'
import { CAMERA_MODES, type CameraMode } from './drone/types'
import { SearchBox } from './components/SearchBox'
import type { MapApi } from './places/types'
import { LAYERS, loadVisibility, saveVisibility, type LayerId, type LayerStatus, type LayerVisibility } from './layers/layerState'

type LayerStatuses = Partial<Record<LayerId, { status: LayerStatus; message?: string }>>

function App() {
  const [tilesStatus, setTilesStatus] = useState<TilesStatus | null>(null)
  const [visibility, setVisibility] = useState<LayerVisibility>(loadVisibility)
  const [layerStatus, setLayerStatus] = useState<LayerStatuses>({})
  const [mapApi, setMapApi] = useState<MapApi | null>(null)

  // Drone: the demo flight stands in for PX4 until the bridge exists (chunk 4c).
  const [demo] = useState(() => new DemoFlightSource())
  const [droneView, setDroneView] = useState<DroneView | null>(null)
  const [cameraMode, setCameraMode] = useState<CameraMode>('free')
  const [hud, setHud] = useState<HudInfo | null>(null)
  const [trailVisible, setTrailVisible] = useState(true)

  useEffect(() => {
    if (!droneView) return
    const offMode = droneView.onCameraModeChange(setCameraMode)
    const offHud = droneView.onHud(setHud)
    return () => {
      offMode()
      offHud()
    }
  }, [droneView])

  useEffect(() => () => demo.pause(), [demo])
  // Dev only: poke at the drone from the browser console (window.tdot).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { tdot: unknown }).tdot = { demo, droneView }
  }, [demo, droneView])
  useEffect(() => droneView?.setTrailVisible(trailVisible), [droneView, trailVisible])

  const changeCamera = useCallback((mode: CameraMode) => droneView?.setCameraMode(mode), [droneView])

  const startFlight = useCallback(() => {
    if (demo.finished) droneView?.clearTrail()
    demo.start()
    if (droneView?.cameraMode === 'free') droneView.setCameraMode('chase')
  }, [demo, droneView])

  const resetFlight = useCallback(() => {
    demo.reset()
    droneView?.clearTrail()
  }, [demo, droneView])

  // Jumping to a searched place needs the map camera, not the drone's.
  const searchApi = useMemo<MapApi | null>(
    () =>
      mapApi && {
        ...mapApi,
        flyToPlace: (place) => {
          droneView?.setCameraMode('free')
          mapApi.flyToPlace(place)
        },
        flyHome: () => {
          droneView?.setCameraMode('free')
          mapApi.flyHome()
        },
      },
    [mapApi, droneView],
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

  useEffect(() => saveVisibility(visibility), [visibility])

  const toggle = useCallback((id: LayerId) => setVisibility((v) => ({ ...v, [id]: !v[id] })), [])

  const onLayerStatus = useCallback((id: LayerId, status: LayerStatus, message?: string) => {
    setLayerStatus((s) => ({ ...s, [id]: { status, message } }))
  }, [])

  // Keyboard shortcuts: the letter shown next to each layer in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const layer = LAYERS.find((l) => l.shortcut.toLowerCase() === e.key.toLowerCase())
      if (layer && layerStatus[layer.id]?.status !== 'error') toggle(layer.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, layerStatus])

  // A missing data file affects all City layers the same way; show it once.
  const dataError = (['neighbourhoods', 'massing'] as const)
    .map((id) => layerStatus[id])
    .find((s) => s?.status === 'error')?.message

  return (
    <>
      <CesiumViewer
        visibility={visibility}
        onTilesStatus={setTilesStatus}
        onLayerStatus={onLayerStatus}
        onMapReady={setMapApi}
        droneSource={demo}
        onDroneView={setDroneView}
      />
      <aside className="sidebar">
        <SearchBox api={searchApi} />
        <LayerPanel visibility={visibility} status={layerStatus} onToggle={toggle} />
        <DronePanel
          sourceName={demo.name}
          running={demo.running}
          finished={demo.finished}
          inAir={hud?.state.inAir ?? false}
          onStart={startFlight}
          onPause={() => demo.pause()}
          onReset={resetFlight}
          cameraMode={cameraMode}
          onCameraMode={changeCamera}
          trailVisible={trailVisible}
          onTrailVisible={setTrailVisible}
        />
      </aside>
      <DroneHud info={hud} />
      {tilesStatus?.state === 'loading' && <div className="banner banner-info">Loading 3D Toronto…</div>}
      {tilesStatus?.state === 'error' && (
        <div className="banner">
          Couldn't load photorealistic 3D tiles{tilesStatus.source ? ` (via ${tilesStatus.source})` : ''}:{' '}
          {tilesStatus.message}
          <br />
          Check <code>VITE_CESIUM_ION_TOKEN</code> / <code>VITE_GOOGLE_MAPS_API_KEY</code> in{' '}
          <code>frontend/.env.local</code> and restart the dev server.
        </div>
      )}
      {dataError && <div className="banner banner-bottom">City of Toronto layers unavailable: {dataError}</div>}
    </>
  )
}

export default App
