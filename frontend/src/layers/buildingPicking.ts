import { Cartesian2, Cartographic, Entity, Math as CesiumMath, ScreenSpaceEventType, type Viewer } from 'cesium'
import { loadMassingIndex, loadMassingTile } from '../data/torontoData'
import { BuildingCollider, type Building } from '../drone/collision'

/** How long to wait for the building data around a click to load before giving up. */
const LOAD_WAIT_MS = 2000

/**
 * Click info for the photorealistic map, at any zoom:
 *  - on a building: its heights (City of Toronto 3D Massing) and the neighbourhood it's in;
 *  - anywhere else: the neighbourhood (the Viewer's normal selection).
 *
 * Buildings are found by whether the clicked point is inside a City footprint,
 * ignoring the clicked height: from far away the 3D click position is too imprecise
 * vertically (tens of metres) to tell roof from ground reliably.
 */
export function installBuildingPicking(viewer: Viewer): () => void {
  let collider: BuildingCollider | null = null
  let disposed = false
  loadMassingIndex()
    .then((index) => {
      if (!disposed) collider = new BuildingCollider(index, loadMassingTile, 50)
    })
    .catch((err: unknown) => console.warn('Building info off: massing data unavailable', err))

  const handler = viewer.screenSpaceEventHandler
  type ClickAction = (click: { position: Cartesian2 }) => void
  const original = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as ClickAction | undefined

  handler.setInputAction(async (click: { position: Cartesian2 }) => {
    const { scene } = viewer
    const position =
      (scene.pickPositionSupported ? scene.pickPosition(click.position) : undefined) ??
      viewer.camera.pickEllipsoid(click.position)
    const c = collider
    if (!position || !c) {
      original?.(click)
      return
    }
    const carto = Cartographic.fromCartesian(position)
    const lon = CesiumMath.toDegrees(carto.longitude)
    const lat = CesiumMath.toDegrees(carto.latitude)

    // The neighbourhood under the cursor (its fill drapes over buildings and streets alike).
    const picked = scene.pick(click.position)
    const pickedEntity = picked?.id instanceof Entity ? picked.id : undefined
    const neighbourhood = typeof pickedEntity?.id === 'string' && pickedEntity.id.startsWith('neighbourhood-') ? pickedEntity : undefined

    c.setPosition(lon, lat)
    const start = performance.now()
    while (!c.ready && performance.now() - start < LOAD_WAIT_MS) await new Promise((r) => setTimeout(r, 50))
    if (disposed || viewer.isDestroyed()) return

    const building = buildingAt(c, lon, lat)
    if (!building) {
      original?.(click) // e.g. selects the neighbourhood
      return
    }
    viewer.selectedEntity = new Entity({
      name: `Building (${(building.roofM - building.groundM).toFixed(0)} m)`,
      position,
      description: buildingDescription(building, neighbourhood),
    })
  }, ScreenSpaceEventType.LEFT_CLICK)

  return () => {
    disposed = true
    if (viewer.isDestroyed()) return
    if (original) handler.setInputAction(original, ScreenSpaceEventType.LEFT_CLICK)
    else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
  }
}

/** The building whose footprint contains the point (the tallest, if footprints overlap). */
function buildingAt(c: BuildingCollider, lon: number, lat: number): Building | null {
  const hits = c.footprintsAt(lon, lat)
  return hits.reduce<Building | null>((best, b) => (!best || b.roofM > best.roofM ? b : best), null)
}

function buildingDescription(b: Building, neighbourhood: Entity | undefined): string {
  const height = b.roofM - b.groundM
  const number = neighbourhood ? String(neighbourhood.id).split('-')[1] : null
  return `
    <table class="cesium-infoBox-defaultTable"><tbody>
      <tr><th>Height (highest point)</th><td>${height.toFixed(1)} m</td></tr>
      <tr><th>Ground elevation</th><td>${b.groundM.toFixed(1)} m above sea level</td></tr>
      <tr><th>Roof elevation</th><td>${b.roofM.toFixed(1)} m above sea level</td></tr>
      ${neighbourhood ? `<tr><th>Neighbourhood</th><td>${escapeHtml(neighbourhood.name ?? '')}${number ? ` (#${number})` : ''}</td></tr>` : ''}
      <tr><th>Source</th><td>City of Toronto 3D Massing</td></tr>
    </tbody></table>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}
