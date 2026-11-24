import { Cartesian2, Cartographic, Entity, Math as CesiumMath, ScreenSpaceEventType, type Viewer } from 'cesium'
import { loadMassingIndex, loadMassingTile } from '../data/torontoData'
import { BuildingCollider, type Building } from '../drone/collision'

/** How long to wait for the building data around a click to load before giving up. */
const LOAD_WAIT_MS = 2000

/**
 * Click info for the photorealistic map, at any zoom:
 *  - on a building: its name and address (City of Toronto Address Points), heights
 *    (3D Massing) and the neighbourhood it's in;
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
      name: buildingTitle(building),
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

/** Infobox title: the place name, else the address, else the height. */
function buildingTitle(b: Building): string {
  const a = b.address
  if (a?.place) return a.place
  if (a) return a.count > 1 ? `${a.addresses[0]} (+${a.count - 1} more)` : a.addresses[0]
  return `Building (${(b.roofM - b.groundM).toFixed(0)} m)`
}

function buildingDescription(b: Building, neighbourhood: Entity | undefined): string {
  const height = b.roofM - b.groundM
  const number = neighbourhood ? String(neighbourhood.id).split('-')[1] : null
  const a = b.address
  const more = a && a.count > a.addresses.length ? `<br>…and ${a.count - a.addresses.length} more` : ''
  const row = (label: string, value: string) => `<tr><th>${label}</th><td>${value}</td></tr>`
  return `
    <table class="cesium-infoBox-defaultTable"><tbody>
      ${a ? row(a.count > 1 ? 'Addresses' : 'Address', a.addresses.map(escapeHtml).join('<br>') + more) : row('Address', 'Not on record')}
      ${neighbourhood ? row('Neighbourhood', `${escapeHtml(neighbourhood.name ?? '')}${number ? ` (#${number})` : ''}`) : ''}
      ${a?.ward ? row('Ward', escapeHtml(a.ward)) : ''}
      ${row('Height', `${height.toFixed(1)} m (highest point)`)}
      ${row('Ground', `${b.groundM.toFixed(1)} m above sea level`)}
      ${row('Roof', `${b.roofM.toFixed(1)} m above sea level`)}
      ${row('Source', 'City of Toronto 3D Massing and Address Points')}
    </tbody></table>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}
