import { useEffect, useRef } from 'react'
import {
  Cartesian3,
  Credit,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Viewer,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { loadPhotorealisticTiles } from '../cesium/photorealisticTiles'
import { loadBoundary, loadManifest, loadNeighbourhoods } from '../data/torontoData'
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

    // React StrictMode mounts effects twice in dev, so always clean up.
    return () => {
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  return <div ref={containerRef} className="cesium-container" />
}
