import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Entity,
  GeocodeType,
  HeadingPitchRange,
  HeightReference,
  IonGeocodeProviderType,
  IonGeocoderService,
  LabelStyle,
  Math as CesiumMath,
  PinBuilder,
  Rectangle,
  sampleTerrainMostDetailed,
  VerticalOrigin,
  type CustomDataSource,
  type Viewer,
} from 'cesium'
import { TORONTO_HOME } from '../config'
import type { BoundaryProps, FeatureCollection, NeighbourhoodProps, Position } from '../data/torontoData'
import { normalize, titleFor } from '../places/search'
import { centreOf, type MapApi, type Place, type PlaceTarget } from '../places/types'

/** Results further than this from downtown are wrong-city matches (e.g. "King St, Charleston"). */
const MAX_DISTANCE_FROM_DOWNTOWN_M = 45_000
/** Typical Toronto ground height above the ellipsoid, if terrain can't be sampled. */
const FALLBACK_GROUND_HEIGHT_M = 90

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

  flyHome = () => {
    this.clearPin()
    this.viewer.selectedEntity = undefined
    const { longitude, latitude, height, headingDeg, pitchDeg } = TORONTO_HOME
    this.flyCamera({ lon: longitude, lat: latitude, height, headingDeg, pitchDeg })
  }

  flyToPlace = (place: Place) => {
    if (this.viewer.isDestroyed()) return
    if (place.camera) {
      this.clearPin()
      this.viewer.selectedEntity = undefined
      this.flyCamera(place.camera)
      return
    }
    const { lon, lat } = centreOf(place.target)
    void this.groundHeight(lon, lat).then((ground) => {
      if (this.viewer.isDestroyed()) return
      const centre = Cartesian3.fromDegrees(lon, lat, ground)
      const view = place.view ?? { headingDeg: 0, pitchDeg: -32, rangeM: defaultRange(place.target) }
      this.viewer.camera.flyToBoundingSphere(new BoundingSphere(centre, 0), {
        offset: new HeadingPitchRange(CesiumMath.toRadians(view.headingDeg), CesiumMath.toRadians(view.pitchDeg), view.rangeM),
        duration: 2.5,
      })
    })

    if (place.neighbourhoodId) {
      this.clearPin()
      // Select it so its outline is highlighted and its details show in the info box.
      const entity = this.neighbourhoodLayer?.entities.getById(`neighbourhood-${place.neighbourhoodId}-0`)
      if (entity && this.neighbourhoodLayer?.show) this.viewer.selectedEntity = entity
    } else {
      // Close any previously selected neighbourhood/building so its info box doesn't linger.
      this.viewer.selectedEntity = undefined
      this.showPin(lon, lat, place.title)
    }
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
        image: new PinBuilder().fromColor(Color.fromCssColorString('#e63946'), 44).toDataURL(),
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
        pixelOffset: new Cartesian2(0, -50),
        heightReference: HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private flyCamera(c: NonNullable<Place['camera']>) {
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(c.lon, c.lat, c.height),
      orientation: { heading: CesiumMath.toRadians(c.headingDeg), pitch: CesiumMath.toRadians(c.pitchDeg), roll: 0 },
      duration: 2.5,
    })
  }

  /** Terrain height at a point (works even while the globe is hidden under the Google tiles). */
  private async groundHeight(lon: number, lat: number): Promise<number> {
    try {
      const [c] = await sampleTerrainMostDetailed(this.viewer.terrainProvider, [Cartographic.fromDegrees(lon, lat)])
      return c.height && Number.isFinite(c.height) && c.height !== 0 ? c.height : FALLBACK_GROUND_HEIGHT_M
    } catch {
      return FALLBACK_GROUND_HEIGHT_M
    }
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

/** Camera distance that fits the place: close for a building, further for a neighbourhood. */
function defaultRange(target: PlaceTarget): number {
  if (target.type === 'point') return 600
  const width = distanceM(target.west, target.south, target.east, target.south)
  const height = distanceM(target.west, target.south, target.west, target.north)
  return Math.min(Math.max(Math.hypot(width, height) * 1.4, 450), 8000)
}

function bboxOf(polygons: Position[][][]) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0]) {
      west = Math.min(west, lon)
      south = Math.min(south, lat)
      east = Math.max(east, lon)
      north = Math.max(north, lat)
    }
  }
  return { west, south, east, north }
}

function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * 111_320 * Math.cos(CesiumMath.toRadians((lat1 + lat2) / 2))
  const y = (lat2 - lat1) * 110_574
  return Math.hypot(x, y)
}

/** Ray-casting point-in-polygon test on a [lon, lat] ring. */
function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
