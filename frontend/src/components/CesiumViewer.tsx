import { useEffect, useRef } from 'react'
import {
  Cartesian3,
  Credit,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventType,
  Terrain,
  Viewer,
  type CustomDataSource,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { PlaceNavigator } from '../cesium/placeNavigation'
import { loadPhotorealisticTiles } from '../cesium/photorealisticTiles'
import { loadBoundary, loadManifest, loadNeighbourhoods } from '../data/torontoData'
import { DroneView } from '../drone/droneView'
import type { DroneSource } from '../drone/types'
import { installBuildingPicking } from '../layers/buildingPicking'
import type { LayerId, LayerStatus, LayerVisibility } from '../layers/layerState'
import { createBoundaryLayer, createNeighbourhoodsLayer } from '../layers/torontoLayers'
import { config, TORONTO_HOME } from '../config'
import type { MapApi } from '../places/types'

export type TilesStatus =
  | { state: 'loading'; source: TilesSource }
  | { state: 'ready'; source: TilesSource }
  | { state: 'error'; source: TilesSource | null; message: string }

export type TilesSource = 'google' | 'ion'

type Props = {
  visibility: LayerVisibility
  onTilesStatus?: (status: TilesStatus) => void
  onLayerStatus?: (layer: LayerId, status: LayerStatus, message?: string) => void
  /** Called once the map can be searched and navigated (and with null when it goes away). */
  onMapReady?: (api: MapApi | null) => void
  /** Where the drone's state comes from (demo flight now, PX4 bridge later). */
  droneSource?: DroneSource
  /** Called with the drone view once created (and null when it goes away). */
  onDroneView?: (view: DroneView | null) => void
}

/** Cesium objects behind each toggleable layer, filled in as they finish loading. */
type LayerHandles = {
  viewer?: Viewer
  neighbourhoods?: CustomDataSource
  boundary?: CustomDataSource
}

function applyVisibility(h: LayerHandles, v: LayerVisibility) {
  if (!h.viewer || h.viewer.isDestroyed()) return
  if (h.neighbourhoods) h.neighbourhoods.show = v.neighbourhoods
  if (h.boundary) h.boundary.show = v.boundary
}

export function CesiumViewer({ visibility, onTilesStatus, onLayerStatus, onMapReady, droneSource, onDroneView }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handles = useRef<LayerHandles>({})
  // Keep the latest props without re-running the setup effect (which would rebuild the viewer).
  const visibilityRef = useRef(visibility)
  visibilityRef.current = visibility
  const onStatusRef = useRef(onTilesStatus)
  onStatusRef.current = onTilesStatus
  const onLayerStatusRef = useRef(onLayerStatus)
  onLayerStatusRef.current = onLayerStatus
  const onMapReadyRef = useRef(onMapReady)
  onMapReadyRef.current = onMapReady
  const droneSourceRef = useRef(droneSource)
  droneSourceRef.current = droneSource
  const onDroneViewRef = useRef(onDroneView)
  onDroneViewRef.current = onDroneView

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
      // Fallback globe imagery, shown only if the photorealistic tiles fail to load.
      baseLayer: hasIon
        ? undefined
        : new ImageryLayer(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
      // Ground heights for the fallback globe, and for placing search results and the camera.
      terrain: hasIon ? Terrain.fromWorldTerrain() : undefined,
      baseLayerPicker: false,
      // Google's terms only allow the Google geocoder with these tiles; we use none.
      geocoder: false,
      timeline: false,
      animation: false,
      sceneModePicker: false,
      // No Home button: the camera always follows the drone.
      homeButton: false,
      navigationHelpButton: false,
      fullscreenButton: false,
    })
    // The camera always chases the drone, so drop Cesium's "focus/track this object" features:
    // double-click to track an entity (the info card's camera button is hidden in CSS).
    viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

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

    // Search (pins and fly-to destinations) and the drone, whose chase camera takes over
    // from the starting view as soon as there's a drone state to follow.
    const navigator = new PlaceNavigator(viewer)
    const droneView = droneSourceRef.current ? new DroneView(viewer, droneSourceRef.current) : undefined
    onMapReadyRef.current?.(navigator)
    onDroneViewRef.current?.(droneView ?? null)

    // Dev only: lets you poke at the scene from the browser console (window.viewer).
    if (import.meta.env.DEV) (window as unknown as { viewer: Viewer }).viewer = viewer

    // --- Google Photorealistic 3D Tiles (always on: this is the map) ---
    const source: TilesSource | null = hasGoogleKey ? 'google' : hasIon ? 'ion' : null
    if (!source) {
      report({ state: 'error', source: null, message: 'No Cesium ion token or Google Maps key set.' })
    } else {
      report({ state: 'loading', source })
      // With a Google key, tiles stream straight from Google; otherwise from Cesium ion.
      loadPhotorealisticTiles(hasGoogleKey ? config.googleMapsApiKey : undefined)
        .then((tileset) => {
          if (viewer.isDestroyed()) {
            tileset.destroy()
            return
          }
          viewer.scene.primitives.add(tileset)
          // The Google mesh includes its own ground, so hide the globe underneath it.
          viewer.scene.globe.show = false
          report({ state: 'ready', source })
        })
        .catch((err: unknown) => {
          console.error('Failed to load Google Photorealistic 3D Tiles', err)
          if (viewer.isDestroyed()) return
          report({ state: 'error', source, message: err instanceof Error ? err.message : String(err) })
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
        navigator.setNeighbourhoods(neighbourhoods, neighbourhoodsLayer)
        navigator.setBoundary(boundary)
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

    // City 3D Massing isn't drawn (the map shows only the photorealistic tiles), but it's
    // used for building collisions (useCollisions) and for building info on click.
    const uninstallPicking = installBuildingPicking(viewer)

    // React StrictMode mounts effects twice in dev, so always clean up.
    return () => {
      onMapReadyRef.current?.(null)
      onDroneViewRef.current?.(null)
      droneView?.destroy()
      uninstallPicking()
      if (!viewer.isDestroyed()) viewer.destroy()
      if (handles.current === h) handles.current = {}
    }
  }, [])

  return <div ref={containerRef} className="cesium-container" />
}
