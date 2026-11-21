import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Entity,
  GeocodeType,
  HeightReference,
  IonGeocodeProviderType,
  IonGeocoderService,
  LabelStyle,
  Math as CesiumMath,
  Rectangle,
  ScreenSpaceEventType,
  VerticalOrigin,
  type CustomDataSource,
  type Viewer,
} from 'cesium'
import { TORONTO_HOME } from '../config'
import type { BoundaryProps, FeatureCollection, NeighbourhoodProps, Position } from '../data/torontoData'
import { bboxOf, distanceM, pointInRing } from '../places/geo'
import { normalize, titleFor } from '../places/search'
import { centreOf, type MapApi, type Place, type PlaceTarget } from '../places/types'

/**
 * Classic map marker: round head, pointed tip at the bottom, black dot in the head.
 * Drawn at 2× and displayed at MARKER_W × MARKER_H so it stays crisp on high-DPI screens.
 */
const MARKER_W = 32
const MARKER_H = 44
const MARKER_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${MARKER_W * 2}" height="${MARKER_H * 2}" viewBox="0 0 32 44">
  <path d="M16 1.5C8.3 1.5 2 7.6 2 15.2c0 9.9 11.6 24.9 13.1 26.8a1.1 1.1 0 0 0 1.8 0C18.4 40.1 30 25.1 30 15.2 30 7.6 23.7 1.5 16 1.5z"
    fill="#e63946" stroke="#ffffff" stroke-width="2"/>
  <circle cx="16" cy="15" r="5.2" fill="#111111"/>
</svg>`)

/** Results further than this from downtown are wrong-city matches (e.g. "King St, Charleston"). */
const MAX_DISTANCE_FROM_DOWNTOWN_M = 45_000

type Ring = Position[]

/**
 * Everything the search box needs from the map. Data (neighbourhoods, boundary)
 * is attached later via setNeighbourhoods / setBoundary once it has loaded.
 */
export class PlaceNavigator implements MapApi {
  private readonly viewer: Viewer
  private readonly geocoder: IonGeocoderService
  private readonly cache = new Map<string, Awaited<ReturnType<MapApi['searchGoogle']>>>()
  private neighbourhoodPlaces: Place[] = []
  private neighbourhoodLayer?: CustomDataSource
  private boundaryRings: Ring[] = []
  private pin?: Entity

  constructor(viewer: Viewer) {
    this.viewer = viewer
    // Google's terms require the Google geocoder when using Google 3D Tiles.
    this.geocoder = new IonGeocoderService({ scene: viewer.scene, geocodeProviderType: IonGeocodeProviderType.GOOGLE })
  }

  setNeighbourhoods(data: FeatureCollection<NeighbourhoodProps>, layer: CustomDataSource) {
    this.neighbourhoodLayer = layer
    this.neighbourhoodPlaces = data.features.map((f) => {
      const bbox = bboxOf(f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      return {
        id: `neighbourhood:${f.properties.id}`,
        kind: 'neighbourhood',
        title: f.properties.name,
        subtitle: `City of Toronto · #${f.properties.id}`,
        target: { type: 'area', ...bbox },
        neighbourhoodId: f.properties.id,
      } satisfies Place
    })
  }

  setBoundary(data: FeatureCollection<BoundaryProps>) {
    this.boundaryRings = data.features.flatMap((f) =>
      (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings) => rings[0]),
    )
  }

  neighbourhoods = () => this.neighbourhoodPlaces

  searchGoogle = async (query: string) => {
    const key = normalize(query)
    const cached = this.cache.get(key)
    if (cached) return cached

    // The service ignores location-bias parameters, so pin the search to Toronto in the text.
    const text = /\btoronto\b/i.test(query) ? query : `${query}, Toronto, ON`
    const results = await this.geocoder.geocode(text, GeocodeType.SEARCH)

    const places: Place[] = []
    for (const r of results) {
      const target = toTarget(r.destination)
      const { lon, lat } = centreOf(target)
      if (distanceM(lon, lat, TORONTO_HOME.longitude, TORONTO_HOME.latitude) > MAX_DISTANCE_FROM_DOWNTOWN_M) continue
      // A bare "Toronto, ON, Canada" means Google didn't understand the query.
      if (/^Toronto, ON, Canada$/.test(r.displayName) && key !== 'toronto') continue
      const { title, subtitle } = titleFor(query, r.displayName)
      places.push({
        id: `google:${r.displayName}`,
        kind: 'google',
        title,
        subtitle,
        target,
        outsideCity: this.boundaryRings.length > 0 && !this.insideCity(lon, lat),
      })
    }
    // Typed as object[] by Cesium; ion sends { html, collapsible } entries.
    const attributionHtml = ((results[0]?.attributions ?? []) as { html?: unknown }[])
      .map((a) => a.html)
      .filter((h): h is string => typeof h === 'string')
    const result = { places, attributionHtml }
    this.cache.set(key, result)
    return result
  }

  showPlace = (place: Place) => {
    if (this.viewer.isDestroyed()) return
    if (place.neighbourhoodId) {
      this.clearPin()
      // Select it so its outline is highlighted and its details show in the info box.
      const entity = this.neighbourhoodLayer?.entities.getById(`neighbourhood-${place.neighbourhoodId}-0`)
      if (entity && this.neighbourhoodLayer?.show) this.viewer.selectedEntity = entity
    } else {
      // Close any previously selected neighbourhood/building so its info box doesn't linger.
      this.viewer.selectedEntity = undefined
      const { lon, lat } = centreOf(place.target)
      this.showPin(lon, lat, place.title)
    }
  }

  private cancelPick: (() => void) | undefined

  pickLocation = (): Promise<{ lon: number; lat: number } | null> => {
    this.cancelPick?.() // only one pick at a time
    return new Promise((resolve) => {
      const { viewer } = this
      const handler = viewer.screenSpaceEventHandler
      type ClickAction = (click: { position: Cartesian2 }) => void
      const previous = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as ClickAction | undefined
      const canvas = viewer.scene.canvas
      canvas.style.cursor = 'crosshair'

      const finish = (result: { lon: number; lat: number } | null) => {
        this.cancelPick = undefined
        window.removeEventListener('keydown', onKey)
        if (!viewer.isDestroyed()) {
          canvas.style.cursor = ''
          if (previous) handler.setInputAction(previous, ScreenSpaceEventType.LEFT_CLICK)
          else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
        }
        resolve(result)
      }
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(null)
      window.addEventListener('keydown', onKey)
      this.cancelPick = () => finish(null)

      handler.setInputAction((click: { position: Cartesian2 }) => {
        // The 3D surface under the cursor (Google mesh, terrain, buildings), else the ellipsoid.
        const hit =
          (viewer.scene.pickPositionSupported ? viewer.scene.pickPosition(click.position) : undefined) ??
          viewer.camera.pickEllipsoid(click.position)
        if (!hit) return // clicked the sky: keep waiting
        const c = Cartographic.fromCartesian(hit)
        finish({ lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) })
      }, ScreenSpaceEventType.LEFT_CLICK)
    })
  }

  clearPin = () => {
    if (this.pin && !this.viewer.isDestroyed()) this.viewer.entities.remove(this.pin)
    this.pin = undefined
  }

  private showPin(lon: number, lat: number, title: string) {
    this.clearPin()
    this.pin = this.viewer.entities.add({
      name: title,
      position: Cartesian3.fromDegrees(lon, lat),
      billboard: {
        image: MARKER_IMAGE,
        width: MARKER_W,
        height: MARKER_H,
        verticalOrigin: VerticalOrigin.BOTTOM,
        // Sit on whatever is there: Google mesh roofs/streets or terrain.
        heightReference: HeightReference.CLAMP_TO_GROUND,
        // Keep the pin visible even when a building is in front of it.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: title,
        font: '600 14px system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#1d1d1f'),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -(MARKER_H + 6)),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private insideCity(lon: number, lat: number): boolean {
    return this.boundaryRings.some((ring) => pointInRing(lon, lat, ring))
  }
}

function toTarget(destination: Rectangle | Cartesian3): PlaceTarget {
  if (destination instanceof Rectangle) {
    return {
      type: 'area',
      west: CesiumMath.toDegrees(destination.west),
      south: CesiumMath.toDegrees(destination.south),
      east: CesiumMath.toDegrees(destination.east),
      north: CesiumMath.toDegrees(destination.north),
    }
  }
  const c = Cartographic.fromCartesian(destination)
  return { type: 'point', lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) }
}
