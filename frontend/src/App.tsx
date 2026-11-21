import { useCallback, useEffect, useMemo, useState } from 'react'
import { CesiumViewer, type TilesStatus } from './components/CesiumViewer'
import { DroneHud } from './components/DroneHud'
import { DronePanel } from './components/DronePanel'
import { LayerPanel } from './components/LayerPanel'
import { useDrone } from './drone/useDrone'
import { SearchBox } from './components/SearchBox'
import type { MapApi, Place } from './places/types'
import { LAYERS, loadVisibility, saveVisibility, type LayerId, type LayerStatus, type LayerVisibility } from './layers/layerState'

type LayerStatuses = Partial<Record<LayerId, { status: LayerStatus; message?: string }>>

function App() {
  const [tilesStatus, setTilesStatus] = useState<TilesStatus | null>(null)
  const [visibility, setVisibility] = useState<LayerVisibility>(loadVisibility)
  const [layerStatus, setLayerStatus] = useState<LayerStatuses>({})
  const [mapApi, setMapApi] = useState<MapApi | null>(null)

  // The last place chosen in search, offered to the drone as a fly-to destination.
  const [searchedPlace, setSearchedPlace] = useState<Place | null>(null)
  const drone = useDrone({ pickLocation: mapApi?.pickLocation, searchedPlace })
  const { droneView } = drone

  // Jumping to a searched place needs the map camera, not the drone's.
  const searchApi = useMemo<MapApi | null>(
    () =>
      mapApi && {
        ...mapApi,
        flyToPlace: (place) => {
          droneView?.setCameraMode('free')
          mapApi.flyToPlace(place)
          setSearchedPlace(place)
        },
        flyHome: () => {
          droneView?.setCameraMode('free')
          mapApi.flyHome()
        },
        clearPin: () => {
          mapApi.clearPin()
          setSearchedPlace(null)
        },
      },
    [mapApi, droneView],
  )


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
        droneSource={drone.initialSource}
        onDroneView={drone.setDroneView}
      />
      <aside className="sidebar">
        <SearchBox api={searchApi} />
        <LayerPanel visibility={visibility} status={layerStatus} onToggle={toggle} />
        <DronePanel {...drone.panel} />
      </aside>
      <DroneHud info={drone.hud} />
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
