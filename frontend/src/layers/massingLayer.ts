import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  Entity,
  GeometryInstance,
  Math as CesiumMath,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  PrimitiveCollection,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium'
import { TORONTO_GEOID_OFFSET_M } from '../config'
import { cellKey, cellOf, MASSING_GRID } from '../data/massingGrid'
import { loadMassingTile, type MassingIndex, type MassingProps, type Position } from '../data/torontoData'

/** Load tiles whose buildings are within this distance of the camera's focus point. */
const LOAD_RADIUS_M = 2500
/** Unload tiles once they're this far away (bigger than LOAD_RADIUS_M so tiles don't flicker at the edge). */
const UNLOAD_RADIUS_M = 4000
/** Above this camera height, buildings are too small to matter; nothing new is loaded. */
const MAX_CAMERA_HEIGHT_M = 8000
const MAX_CONCURRENT_LOADS = 4

const BUILDING_COLOUR = Color.fromCssColorString('#e6e8eb').withAlpha(0.6)

/** What a picked massing building's `id` looks like. */
export type MassingPick = { kind: 'massing'; tile: string } & MassingProps

type TileState =
  | { state: 'loading'; abort: AbortController }
  | { state: 'ready'; primitive: Primitive }

/**
 * City of Toronto 3D Massing, loaded in ~1 km tiles around the camera and drawn
 * as one batched Primitive per tile (much faster than one Entity per building).
 */
export class MassingLayer {
  private readonly collection = new PrimitiveCollection()
  private readonly tiles = new Map<string, TileState>()
  private queue: string[] = []
  private active = 0
  private destroyed = false
  private readonly removeListeners: (() => void)[] = []
  private readonly viewer: Viewer
  private readonly index: MassingIndex

  constructor(viewer: Viewer, index: MassingIndex, show = true) {
    this.viewer = viewer
    this.index = index
    this.collection.show = show
    viewer.scene.primitives.add(this.collection)

    // Re-check which tiles are needed whenever the camera stops, and during long moves.
    const camera = viewer.camera
    camera.percentageChanged = 0.2
    const update = () => this.update()
    this.removeListeners.push(camera.moveEnd.addEventListener(update), camera.changed.addEventListener(update))
    this.update()
  }

  get show() {
    return this.collection.show
  }

  set show(value: boolean) {
    this.collection.show = value
    if (value) this.update()
  }

  /** Point on the ground the camera is looking at, or under it if looking at the sky. */
  private focusPoint(): Cartographic | undefined {
    const { camera, scene } = this.viewer
    const canvas = scene.canvas
    const centre = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
    const hit = camera.pickEllipsoid(centre, scene.globe.ellipsoid)
    const below = camera.positionCartographic
    if (hit) {
      const target = Cartographic.fromCartesian(hit)
      // Looking almost at the horizon puts the hit far away; prefer the point below then.
      if (Cartesian3.distance(hit, camera.positionWC) < LOAD_RADIUS_M * 2) return target
    }
    return below
  }

  private update() {
    if (this.destroyed || !this.collection.show) return
    const focus = this.focusPoint()
    if (!focus) return
    const lon = CesiumMath.toDegrees(focus.longitude)
    const lat = CesiumMath.toDegrees(focus.latitude)
    const tooHigh = this.viewer.camera.positionCartographic.height > MAX_CAMERA_HEIGHT_M

    // Unload far tiles.
    for (const [key, tile] of this.tiles) {
      if (distanceToBboxM(lon, lat, this.index.tiles[key].bbox) <= UNLOAD_RADIUS_M) continue
      if (tile.state === 'loading') tile.abort.abort()
      else this.collection.remove(tile.primitive) // collection destroys it
      this.tiles.delete(key)
    }

    if (tooHigh) {
      this.queue = []
      return
    }

    // Queue nearby tiles, closest first.
    const { cellLon, cellLat } = MASSING_GRID
    const dCol = Math.ceil(LOAD_RADIUS_M / (111_320 * Math.cos(CesiumMath.toRadians(lat)) * cellLon)) + 1
    const dRow = Math.ceil(LOAD_RADIUS_M / (110_574 * cellLat)) + 1
    const { col, row } = cellOf(lon, lat)
    const wanted: { key: string; d: number }[] = []
    for (let c = col - dCol; c <= col + dCol; c++) {
      for (let r = row - dRow; r <= row + dRow; r++) {
        const key = cellKey(c, r)
        const info = this.index.tiles[key]
        if (!info || this.tiles.has(key)) continue
        const d = distanceToBboxM(lon, lat, info.bbox)
        if (d <= LOAD_RADIUS_M) wanted.push({ key, d })
      }
    }
    this.queue = wanted.sort((a, b) => a.d - b.d).map((w) => w.key)
    this.pump()
  }

  private pump() {
    while (!this.destroyed && this.active < MAX_CONCURRENT_LOADS && this.queue.length) {
      const key = this.queue.shift()!
      if (this.tiles.has(key)) continue
      void this.loadTile(key)
    }
  }

  private async loadTile(key: string) {
    const abort = new AbortController()
    this.tiles.set(key, { state: 'loading', abort })
    this.active++
    try {
      const data = await loadMassingTile(key, abort.signal)
      if (this.destroyed || abort.signal.aborted) return
      const primitive = this.collection.add(buildTilePrimitive(key, data.features))
      this.tiles.set(key, { state: 'ready', primitive })
    } catch (err) {
      if (!abort.signal.aborted) {
        console.warn(`Massing tile ${key} failed to load`, err)
        this.tiles.delete(key)
      }
    } finally {
      this.active--
      this.pump()
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.removeListeners.forEach((remove) => remove())
    for (const tile of this.tiles.values()) if (tile.state === 'loading') tile.abort.abort()
    this.tiles.clear()
    if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.collection)
  }
}

function buildTilePrimitive(key: string, features: { properties: MassingProps; geometry: { type: string; coordinates: unknown } }[]) {
  const colour = ColorGeometryInstanceAttribute.fromColor(BUILDING_COLOUR)
  const instances: GeometryInstance[] = []
  for (const { properties, geometry } of features) {
    const base = properties.g + TORONTO_GEOID_OFFSET_M
    const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as Position[][][]
    for (const [outer, ...holes] of polygons) {
      const pick: MassingPick = { kind: 'massing', tile: key, ...properties }
      instances.push(
        new GeometryInstance({
          id: pick,
          geometry: new PolygonGeometry({
            polygonHierarchy: new PolygonHierarchy(
              toCartesians(outer),
              holes.map((h) => new PolygonHierarchy(toCartesians(h))),
            ),
            height: base,
            extrudedHeight: base + properties.h,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: colour },
        }),
      )
    }
  }
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ translucent: true, closed: true }),
    // Build geometry in Cesium's web workers so the UI doesn't stall.
    asynchronous: true,
    releaseGeometryInstances: true,
  })
}

function toCartesians(ring: Position[]): Cartesian3[] {
  return Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]))
}

/** Approximate ground distance in metres from a point to a lon/lat bbox (0 if inside). */
function distanceToBboxM(lon: number, lat: number, [w, s, e, n]: [number, number, number, number]): number {
  const dLon = lon < w ? w - lon : lon > e ? lon - e : 0
  const dLat = lat < s ? s - lat : lat > n ? lat - n : 0
  const x = dLon * 111_320 * Math.cos(CesiumMath.toRadians(lat))
  const y = dLat * 110_574
  return Math.hypot(x, y)
}

/**
 * Clicking a massing building shows its heights in Cesium's info box. The Viewer
 * only knows how to select Entities, so we wrap its click handler: massing
 * picks get a stand-in Entity, everything else falls through unchanged.
 */
export function installMassingPicking(viewer: Viewer): () => void {
  const handler = viewer.screenSpaceEventHandler
  type ClickAction = (click: { position: Cartesian2 }) => void
  const original = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as ClickAction | undefined
  handler.setInputAction((click: { position: Cartesian2 }) => {
    const picked = viewer.scene.pick(click.position)
    const id = picked?.id as MassingPick | undefined
    if (id?.kind !== 'massing') {
      original?.(click)
      return
    }
    const position = viewer.scene.pickPosition(click.position)
    viewer.selectedEntity = new Entity({
      name: `Building (${id.h.toFixed(1)} m)`,
      position,
      description: `
        <table class="cesium-infoBox-defaultTable"><tbody>
          <tr><th>Height (average)</th><td>${id.h.toFixed(1)} m</td></tr>
          <tr><th>Height (highest point)</th><td>${id.top.toFixed(1)} m</td></tr>
          <tr><th>Ground elevation</th><td>${id.g.toFixed(1)} m above sea level</td></tr>
          <tr><th>Roof elevation</th><td>${(id.g + id.h).toFixed(1)} m above sea level</td></tr>
          <tr><th>Tile</th><td>${id.tile}</td></tr>
        </tbody></table>`,
    })
  }, ScreenSpaceEventType.LEFT_CLICK)
  return () => {
    if (viewer.isDestroyed()) return
    if (original) handler.setInputAction(original, ScreenSpaceEventType.LEFT_CLICK)
    else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
  }
}
