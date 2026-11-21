import { useEffect, useRef } from 'react'
import {
  Cartesian3,
  Credit,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Terrain,
  Viewer,
  type Cesium3DTileset,
  type CustomDataSource,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { loadPhotorealisticTiles } from '../cesium/photorealisticTiles'
import { loadBoundary, loadManifest, loadMassingIndex, loadNeighbourhoods } from '../data/torontoData'
import type { LayerId, LayerStatus, LayerVisibility } from '../layers/layerState'
import { installMassingPicking, MassingLayer } from '../layers/massingLayer'
import { createBoundaryLayer, createNeighbourhoodsLayer } from '../layers/torontoLayers'
import { config, TORONTO_HOME } from '../config'

export type TilesStatus =
  | { state: 'loading'; source: TilesSource }
  | { state: 'ready'; source: TilesSource }
  | { state: 'error'; source: TilesSource | null; message: string }

export type TilesSource = 'google' | 'ion'

type Props = {
  visibility: LayerVisibility
  onTilesStatus?: (status: TilesStatus) => void
  onLayerStatus?: (layer: LayerId, status: LayerStatus, message?: string) => void
}

/** Cesium objects behind each toggleable layer, filled in as they finish loading. */
type LayerHandles = {
  viewer?: Viewer
  google?: Cesium3DTileset
  neighbourhoods?: CustomDataSource
  boundary?: CustomDataSource
  massing?: MassingLayer
}

function applyVisibility(h: LayerHandles, v: LayerVisibility) {
  if (!h.viewer || h.viewer.isDestroyed()) return
  if (h.google) {
    h.google.show = v.google
    // With the Google mesh hidden, show the terrain globe so there's ground to stand on.
    h.viewer.scene.globe.show = !v.google
  }
  if (h.neighbourhoods) h.neighbourhoods.show = v.neighbourhoods
  if (h.boundary) h.boundary.show = v.boundary
  if (h.massing) h.massing.show = v.massing
}

export function CesiumViewer({ visibility, onTilesStatus, onLayerStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handles = useRef<LayerHandles>({})
  // Keep the latest props without re-running the setup effect (which would rebuild the viewer).
  const visibilityRef = useRef(visibility)
  visibilityRef.current = visibility
  const onStatusRef = useRef(onTilesStatus)
  onStatusRef.current = onTilesStatus
  const onLayerStatusRef = useRef(onLayerStatus)
  onLayerStatusRef.current = onLayerStatus

  // Apply toggles whenever they change.
  useEffect(() => applyVisibility(handles.current, visibility), [visibility])

  useEffect(() => {
    if (!containerRef.current) return
    const report = (s: TilesStatus) => onStatusRef.current?.(s)
    const layerStatus = (id: LayerId, s: LayerStatus, err?: unknown) =>
      onLayerStatusRef.current?.(id, s, err === undefined ? undefined : err instanceof Error ? err.message : String(err))

    const hasIon = Boolean(config.cesiumIonToken)
    const hasGoogleKey = Boolean(config.googleMapsApiKey)
    if (hasIon) Ion.defaultAccessToken = config.cesiumIonToken

    const viewer = new Viewer(containerRef.current, {
      // Fallback globe imagery, shown when the 3D tiles are off or fail to load.
      baseLayer: hasIon
        ? undefined
        : new ImageryLayer(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
      // Real ground heights for when the Google tiles are hidden (massing blocks then stand on terrain).
      terrain: hasIon ? Terrain.fromWorldTerrain() : undefined,
      baseLayerPicker: false,
      // Google's terms only allow the Google geocoder with these tiles; we use none.
      geocoder: false,
      timeline: false,
      animation: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
    })
    const h: LayerHandles = { viewer }
    handles.current = h
    /** Registers a loaded layer and immediately applies the current toggles to it. */
    const ready = (id: LayerId, assign: () => void) => {
      assign()
      applyVisibility(h, visibilityRef.current)
      layerStatus(id, 'ready')
    }

    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(TORONTO_HOME.longitude, TORONTO_HOME.latitude, TORONTO_HOME.height),
      orientation: {
        heading: CesiumMath.toRadians(TORONTO_HOME.headingDeg),
        pitch: CesiumMath.toRadians(TORONTO_HOME.pitchDeg),
        roll: 0,
      },
      duration: 3,
    })

    // Dev only: lets you poke at the scene from the browser console (window.viewer).
    if (import.meta.env.DEV) (window as unknown as { viewer: Viewer }).viewer = viewer

    // --- Google Photorealistic 3D Tiles ---
    const source: TilesSource | null = hasGoogleKey ? 'google' : hasIon ? 'ion' : null
    if (!source) {
      report({ state: 'error', source: null, message: 'No Cesium ion token or Google Maps key set.' })
      layerStatus('google', 'error', 'No Cesium ion token or Google Maps key set.')
    } else {
      report({ state: 'loading', source })
      layerStatus('google', 'loading')
      // With a Google key, tiles stream straight from Google; otherwise from Cesium ion.
      loadPhotorealisticTiles(hasGoogleKey ? config.googleMapsApiKey : undefined)
        .then((tileset) => {
          if (viewer.isDestroyed()) {
            tileset.destroy()
            return
          }
          ready('google', () => (h.google = viewer.scene.primitives.add(tileset)))
          report({ state: 'ready', source })
        })
        .catch((err: unknown) => {
          console.error('Failed to load Google Photorealistic 3D Tiles', err)
          if (viewer.isDestroyed()) return
          report({ state: 'error', source, message: err instanceof Error ? err.message : String(err) })
          layerStatus('google', 'error', err)
        })
    }

    // --- City of Toronto boundary + neighbourhoods ---
    layerStatus('neighbourhoods', 'loading')
    layerStatus('boundary', 'loading')
    Promise.all([loadBoundary(), loadNeighbourhoods(), loadManifest()])
      .then(([boundary, neighbourhoods, manifest]) => {
        if (viewer.isDestroyed()) return
        const neighbourhoodsLayer = createNeighbourhoodsLayer(neighbourhoods)
        const boundaryLayer = createBoundaryLayer(boundary)
        void viewer.dataSources.add(neighbourhoodsLayer)
        void viewer.dataSources.add(boundaryLayer)
        ready('neighbourhoods', () => (h.neighbourhoods = neighbourhoodsLayer))
        ready('boundary', () => (h.boundary = boundaryLayer))
        // The Open Government Licence – Toronto requires attribution.
        viewer.creditDisplay.addStaticCredit(
          new Credit(`<a href="https://open.toronto.ca/" target="_blank" rel="noopener">${manifest.attribution}</a>`),
        )
      })
      .catch((err: unknown) => {
        console.error('Failed to load City of Toronto data', err)
        if (viewer.isDestroyed()) return
        layerStatus('neighbourhoods', 'error', err)
        layerStatus('boundary', 'error', err)
      })

    // --- 3D Massing, loaded in tiles around the camera ---
    const uninstallPicking = installMassingPicking(viewer)
    layerStatus('massing', 'loading')
    loadMassingIndex()
      .then((index) => {
        if (viewer.isDestroyed()) return
        // Start hidden if toggled off, so no tiles are fetched until it's turned on.
        const layer = new MassingLayer(viewer, index, visibilityRef.current.massing)
        ready('massing', () => (h.massing = layer))
      })
      .catch((err: unknown) => {
        console.error('Failed to load massing index', err)
        if (viewer.isDestroyed()) return
        layerStatus('massing', 'error', err)
      })

    // React StrictMode mounts effects twice in dev, so always clean up.
    return () => {
      uninstallPicking()
      h.massing?.destroy()
      if (!viewer.isDestroyed()) viewer.destroy()
      if (handles.current === h) handles.current = {}
    }
  }, [])

  return <div ref={containerRef} className="cesium-container" />
}
