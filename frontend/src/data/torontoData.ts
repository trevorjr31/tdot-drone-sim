/**
 * The one place that knows where City of Toronto data comes from.
 *
 * Today: static GeoJSON produced by `npm run data` and served from /data/toronto/.
 * Later: swap these functions to call the backend (e.g. PostGIS) and nothing
 * else in the app needs to change.
 */

import type { MassingIndex, MassingProps } from './massingGrid'
import { parsePlaces, type NearbyPlace, type PlacesFile } from '../places/nearby'

// Minimal GeoJSON types for the shapes we produce (Polygon / MultiPolygon only).
export type Position = [number, number] | [number, number, number]
export type PolygonGeometry =
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
export type Feature<P> = { type: 'Feature'; properties: P; geometry: PolygonGeometry }
export type FeatureCollection<P> = { type: 'FeatureCollection'; features: Feature<P>[] }

export type BoundaryProps = { name: string }
export type NeighbourhoodProps = {
  /** City's neighbourhood number, e.g. "174". */
  id: string
  name: string
  /** e.g. "Neighbourhood Improvement Area", "Emerging Neighbourhood". */
  classification: string
}

export type DataManifest = {
  generatedAt: string
  attribution: string
  datasets: { id: string; file: string; source: string; title: string; lastRefreshed: string | null }[]
}

const BASE = `${import.meta.env.BASE_URL}data/toronto/`

export class MissingDataError extends Error {
  constructor(file: string) {
    super(`Toronto data file "${file}" not found. Run \`npm run data\` in frontend/.`)
    this.name = 'MissingDataError'
  }
}

async function getJson<T>(file: string): Promise<T> {
  const res = await fetch(BASE + file)
  // Vite's dev server answers unknown paths with index.html (200, text/html),
  // so a missing file shows up as HTML rather than a 404.
  const isJson = (res.headers.get('content-type') ?? '').match(/json|geo\+json|octet-stream/)
  if (res.status === 404 || !isJson) throw new MissingDataError(file)
  if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export const loadManifest = () => getJson<DataManifest>('manifest.json')
export const loadBoundary = () => getJson<FeatureCollection<BoundaryProps>>('boundary.geojson')
export const loadNeighbourhoods = () => getJson<FeatureCollection<NeighbourhoodProps>>('neighbourhoods.geojson')

/** Places by type from OpenStreetMap (hospitals, parks, …), for "the nearest X". Loaded once. */
let placesPromise: Promise<NearbyPlace[]> | null = null
export function loadPlaces(): Promise<NearbyPlace[]> {
  placesPromise ??= getJson<PlacesFile>('places.json').then(parsePlaces)
  placesPromise.catch(() => (placesPromise = null)) // retry next time
  return placesPromise
}

// --- 3D Massing (tiled) ---------------------------------------------------

export type { MassingIndex, MassingProps, MassingTileInfo } from './massingGrid'

export const loadMassingIndex = () => getJson<MassingIndex>('massing/index.json')

export async function loadMassingTile(key: string, signal?: AbortSignal): Promise<FeatureCollection<MassingProps>> {
  const res = await fetch(`${BASE}massing/${key}.json`, { signal })
  if (!res.ok) throw new Error(`Failed to load massing tile ${key}: HTTP ${res.status}`)
  return (await res.json()) as FeatureCollection<MassingProps>
}
