import { useCallback, useEffect, useMemo, useState } from 'react'
import { CesiumViewer, type TilesStatus } from './components/CesiumViewer'
import { DroneHud } from './components/DroneHud'
import { DronePanel } from './components/DronePanel'
import { GeofenceInfo } from './components/GeofenceInfo'
import { LayerList } from './components/LayerList'
import { SettingsMenu, SettingsSection } from './components/SettingsMenu'
import { useDrone } from './drone/useDrone'
import { SearchBox } from './components/SearchBox'
import type { MapApi } from './places/types'
import { LAYERS, loadVisibility, saveVisibility, type LayerId, type LayerStatus, type LayerVisibility } from './layers/layerState'

type LayerStatuses = Partial<Record<LayerId, { status: LayerStatus; message?: string }>>

function App() {
  const [tilesStatus, setTilesStatus] = useState<TilesStatus | null>(null)
  const [visibility, setVisibility] = useState<LayerVisibility>(loadVisibility)
  const [layerStatus, setLayerStatus] = useState<LayerStatuses>({})
  const [mapApi, setMapApi] = useState<MapApi | null>(null)
  const [hudVisible, setHudVisibleState] = useState(loadHudVisible)
  const setHudVisible = useCallback((on: boolean) => {
    setHudVisibleState(on)
    try {
      localStorage.setItem(HUD_KEY, on ? '1' : '0')
    } catch {
      // ignore: private mode, blocked storage
    }
  }, [])

  const drone = useDrone({ pickLocation: mapApi?.pickLocation })

  // The search box lives in the drone card's Plan a route step: a chosen place is marked
  // on the map and becomes the route's destination.
  const { routeToPlace } = drone
  const searchApi = useMemo<MapApi | null>(
    () =>
      mapApi && {
        ...mapApi,
        showPlace: (place) => {
          mapApi.showPlace(place)
          routeToPlace(place)
        },
      },
    [mapApi, routeToPlace],
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
  const dataError = layerStatus.neighbourhoods?.status === 'error' ? layerStatus.neighbourhoods.message : undefined

  return (
    <>
      <CesiumViewer
        visibility={visibility}
        onTilesStatus={setTilesStatus}
        onLayerStatus={onLayerStatus}
        onMapReady={setMapApi}
        droneSource={drone.source}
        onDroneView={drone.setDroneView}
      />
      <aside className="sidebar">
        <DronePanel {...drone.panel} routeSearch={<SearchBox api={searchApi} />} />
      </aside>
      <SettingsMenu>
        <SettingsSection title="Layers">
          <LayerList visibility={visibility} status={layerStatus} onToggle={toggle} />
        </SettingsSection>
        <SettingsSection title="Drone">
          <ul className="layer-panel__list">
            <li>
              <label className="layer-row" title="Height, speed, battery and other readouts (bottom right). Warnings show either way.">
                <input type="checkbox" checked={hudVisible} onChange={(e) => setHudVisible(e.target.checked)} />
                <span className="layer-row__swatch" style={{ background: '#9aa4b2' }} aria-hidden />
                <span className="layer-row__label">Flight readouts</span>
              </label>
            </li>
            <li>
              <label className="layer-row" title="The yellow line showing where the drone has flown">
                <input type="checkbox" checked={drone.trailVisible} onChange={(e) => drone.setTrailVisible(e.target.checked)} />
                <span className="layer-row__swatch" style={{ background: '#ffd166' }} aria-hidden />
                <span className="layer-row__label">Flight trail</span>
              </label>
            </li>
          </ul>
        </SettingsSection>
        <SettingsSection title="Geofence">
          <GeofenceInfo status={drone.panel.px4.status} geofence={drone.panel.px4.geofence} returnPlan={drone.returnPlan} />
        </SettingsSection>
        <p className="layer-panel__footer">
          City data:{' '}
          <a href="https://open.toronto.ca/" target="_blank" rel="noopener noreferrer">
            City of Toronto Open Data
          </a>{' '}
          (OGL – Toronto)
        </p>
      </SettingsMenu>
      <DroneHud info={drone.hud} collision={drone.collision} battery={drone.battery} showReadouts={hudVisible} />
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

const HUD_KEY = 'tdot.hudVisible'

/** Flight readouts on/off, remembered in this browser (on by default). */
function loadHudVisible(): boolean {
  try {
    return localStorage.getItem(HUD_KEY) !== '0'
  } catch {
    return true
  }
}

export default App
