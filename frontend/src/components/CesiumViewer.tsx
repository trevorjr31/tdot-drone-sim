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
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { loadPhotorealisticTiles } from '../cesium/photorealisticTiles'
import { loadBoundary, loadManifest, loadMassingIndex, loadNeighbourhoods } from '../data/torontoData'
import { installMassingPicking, MassingLayer } from '../layers/massingLayer'
import { createBoundaryLayer, createNeighbourhoodsLayer } from '../layers/torontoLayers'
import { config, TORONTO_HOME } from '../config'

export type TilesStatus =
  | { state: 'loading'; source: TilesSource }
  | { state: 'ready'; source: TilesSource }
  | { state: 'error'; source: TilesSource | null; message: string }

export type TilesSource = 'google' | 'ion'

type Props = {
  onTilesStatus?: (status: TilesStatus) => void
  onDataError?: (message: string) => void
}

export function CesiumViewer({ onTilesStatus, onDataError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep the latest callbacks without re-running the effect (which would rebuild the viewer).
  const onStatusRef = useRef(onTilesStatus)
  onStatusRef.current = onTilesStatus
  const onDataErrorRef = useRef(onDataError)
  onDataErrorRef.current = onDataError

  useEffect(() => {
    if (!containerRef.current) return
    const report = (s: TilesStatus) => onStatusRef.current?.(s)

    const hasIon = Boolean(config.cesiumIonToken)
    const hasGoogleKey = Boolean(config.googleMapsApiKey)
    if (hasIon) Ion.defaultAccessToken = config.cesiumIonToken

    const viewer = new Viewer(containerRef.current, {
      // Fallback globe imagery, only visible if the 3D tiles fail to load.
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

    let googleTiles: Cesium3DTileset | undefined
    let massing: MassingLayer | undefined

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
          googleTiles = viewer.scene.primitives.add(tileset)
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

    // City of Toronto layers, drawn onto the 3D tiles. Independent of the tiles
    // loading, so they appear as soon as both are ready.
    Promise.all([loadBoundary(), loadNeighbourhoods(), loadManifest()])
      .then(([boundary, neighbourhoods, manifest]) => {
        if (viewer.isDestroyed()) return
        viewer.dataSources.add(createNeighbourhoodsLayer(neighbourhoods))
        viewer.dataSources.add(createBoundaryLayer(boundary))
        // The Open Government Licence – Toronto requires attribution.
        viewer.creditDisplay.addStaticCredit(
          new Credit(`<a href="https://open.toronto.ca/" target="_blank" rel="noopener">${manifest.attribution}</a>`),
        )
      })
      .catch((err: unknown) => {
        console.error('Failed to load City of Toronto data', err)
        if (viewer.isDestroyed()) return
        onDataErrorRef.current?.(err instanceof Error ? err.message : String(err))
      })

    // 3D Massing buildings, loaded in tiles around the camera.
    const uninstallPicking = installMassingPicking(viewer)
    loadMassingIndex()
      .then((index) => {
        if (viewer.isDestroyed()) return
        massing = new MassingLayer(viewer, index)
      })
      .catch((err: unknown) => {
        console.error('Failed to load massing index', err)
        if (viewer.isDestroyed()) return
        onDataErrorRef.current?.(err instanceof Error ? err.message : String(err))
      })

    // Temporary keyboard toggles until the layer panel exists (chunk 3c):
    //   G = Google 3D tiles (shows the terrain globe instead), M = massing buildings.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement) return
      const key = e.key.toLowerCase()
      if (key === 'g' && googleTiles) {
        googleTiles.show = !googleTiles.show
        viewer.scene.globe.show = !googleTiles.show
      } else if (key === 'm' && massing) {
        massing.show = !massing.show
      }
    }
    window.addEventListener('keydown', onKey)

    // React StrictMode mounts effects twice in dev, so always clean up.
    return () => {
      window.removeEventListener('keydown', onKey)
      uninstallPicking()
      massing?.destroy()
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  return <div ref={containerRef} className="cesium-container" />
}
