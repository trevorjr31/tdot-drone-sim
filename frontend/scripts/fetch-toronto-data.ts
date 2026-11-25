/**
 * Downloads City of Toronto Open Data and converts it into small GeoJSON files
 * the app serves from public/data/toronto/. Also a list of places by type (hospitals,
 * parks, …) from OpenStreetMap, for "fly to the nearest hospital" (places.json).
 *
 *   npm run data            # download (if not cached) and convert
 *   npm run data -- --refresh   # force fresh downloads
 *   npm run data -- --only=boundary-fence   # just some datasets (comma-separated ids; used by CI)
 *
 * Why a script instead of fetching in the browser: the City's CKAN API sends no
 * CORS headers, so browsers block direct requests. Preparing files ahead of time
 * also lets us trim and simplify the data so the app loads fast.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  MAPSHAPER_CELL_EXPRESSION,
  MASSING_GRID,
  type MassingIndex,
  type MassingProps,
  type MassingTileInfo,
} from '../src/data/massingGrid.ts'
import { joinAddresses, parseCsv, type AddressPoint, type Footprint } from '../src/data/addressJoin.ts'
import { buildingsFromTile } from '../src/drone/collision.ts'
import { CATEGORY_LABEL, overpassQuery, placesFile, placesFromOsm, PLACE_CATEGORIES } from '../src/places/nearby.ts'

const run = promisify(execFile)

const CKAN_API = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(ROOT, '.data-cache')
const OUT_DIR = path.join(ROOT, 'public', 'data', 'toronto')
const MAPSHAPER = path.join(ROOT, 'node_modules', 'mapshaper', 'bin', 'mapshaper')
const REFRESH = process.argv.includes('--refresh')
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean)
const wanted = (id: string) => !ONLY || ONLY.includes(id)

type CkanResource = { id: string; name: string; format: string; url: string; last_modified?: string }
type CkanPackage = { name: string; title: string; last_refreshed?: string; resources: CkanResource[] }

type Dataset = {
  /** Output file name (without extension) in public/data/toronto/. */
  id: string
  /** CKAN package id on open.toronto.ca. */
  packageId: string
  /** Picks which file in the package to download. */
  pickResource: (r: CkanResource) => boolean
  /** Extension of the downloaded file in the cache. */
  cacheExt: string
  /** mapshaper commands applied between input and output. */
  mapshaper: string[]
}

const DATASETS: Dataset[] = [
  {
    id: 'boundary',
    packageId: 'regional-municipal-boundary',
    pickResource: (r) => r.format.toUpperCase() === 'SHP',
    cacheExt: 'zip',
    // Only the outline matters: merge into one shape and replace the attributes with a name.
    mapshaper: ['-proj', 'wgs84', '-dissolve', '-each', 'name="City of Toronto"', '-simplify', 'dp', 'interval=2'],
  },
  {
    // The same boundary, simplified to fit PX4's geofence (max 64 points): ~50 points,
    // within ~500 m of the true line. The bridge uploads it to PX4 as an inclusion fence.
    id: 'boundary-fence',
    packageId: 'regional-municipal-boundary',
    pickResource: (r) => r.format.toUpperCase() === 'SHP',
    cacheExt: 'zip',
    mapshaper: ['-proj', 'wgs84', '-dissolve', '-each', 'name="City of Toronto (geofence)"', '-simplify', 'dp', 'interval=500'],
  },
  {
    id: 'neighbourhoods',
    packageId: 'neighbourhoods',
    // The current 158 neighbourhoods, in lat/long (EPSG:4326).
    pickResource: (r) => r.name === 'Neighbourhoods - 4326.geojson',
    cacheExt: 'geojson',
    mapshaper: [
      '-filter-fields', 'AREA_SHORT_CODE,AREA_NAME,CLASSIFICATION',
      '-rename-fields', 'id=AREA_SHORT_CODE,name=AREA_NAME,classification=CLASSIFICATION',
      // ~2 m tolerance: invisible at city scale, roughly halves the file size.
      // mapshaper keeps shared borders shared, so neighbours still meet exactly.
      '-simplify', 'dp', 'interval=2', 'keep-shapes',
    ],
  },
]

async function getPackage(packageId: string): Promise<CkanPackage> {
  const res = await fetch(`${CKAN_API}/package_show?id=${encodeURIComponent(packageId)}`)
  if (!res.ok) throw new Error(`CKAN package_show ${packageId} failed: HTTP ${res.status}`)
  const body = (await res.json()) as { success: boolean; result: CkanPackage }
  if (!body.success) throw new Error(`CKAN package_show ${packageId} returned success=false`)
  return body.result
}

async function download(url: string, dest: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

/**
 * Unzips just the shapefile parts and returns the .shp path. mapshaper can read
 * zips directly, but it also treats stray files (readmes etc.) as extra layers.
 */
async function extractShapefile(zipPath: string, destDir: string): Promise<string> {
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })
  await run('unzip', ['-o', '-j', '-q', zipPath, '*.shp', '*.shx', '*.dbf', '*.prj', '*.cpg', '-d', destDir]).catch((err) => {
    // unzip exits 11 when an optional pattern (e.g. *.cpg) has no match; that's fine.
    if (err?.code !== 11) throw err
  })
  const shps = (await readdir(destDir)).filter((f) => f.toLowerCase().endsWith('.shp'))
  if (shps.length !== 1) throw new Error(`Expected one .shp in ${zipPath}, found: ${shps.join(', ') || 'none'}`)
  return path.join(destDir, shps[0])
}

/** Runs mapshaper with enough memory for the citywide massing file. */
function mapshaper(args: string[]) {
  return run(process.execPath, ['--max-old-space-size=8192', MAPSHAPER, ...args], { maxBuffer: 64 * 1024 * 1024 })
}

/** Finds a resource in a CKAN package and downloads it to the cache (unless already cached). */
async function fetchResource(
  packageId: string,
  pick: (resources: CkanResource[]) => CkanResource | undefined,
  cacheName: (r: CkanResource) => string,
) {
  const pkg = await getPackage(packageId)
  const resource = pick(pkg.resources)
  if (!resource) throw new Error(`No matching resource in ${packageId}: ${pkg.resources.map((r) => r.name).join(', ')}`)

  const cached = path.join(CACHE_DIR, cacheName(resource))
  if (REFRESH || !existsSync(cached)) {
    console.log(`  downloading "${resource.name}"`)
    await download(resource.url, cached)
  } else {
    console.log(`  using cached "${resource.name}" (pass --refresh to re-download)`)
  }
  return { pkg, resource, cached }
}

function manifestEntry(id: string, file: string, pkg: CkanPackage, resource: CkanResource) {
  return {
    id,
    file,
    source: `https://open.toronto.ca/dataset/${pkg.name}/`,
    title: pkg.title,
    resource: resource.name,
    lastRefreshed: pkg.last_refreshed ?? resource.last_modified ?? null,
  }
}

async function processDataset(ds: Dataset) {
  console.log(`\n▸ ${ds.id} (${ds.packageId})`)
  const { pkg, resource, cached } = await fetchResource(
    ds.packageId,
    (rs) => rs.find(ds.pickResource),
    () => `${ds.id}.${ds.cacheExt}`,
  )

  const input = ds.cacheExt === 'zip' ? await extractShapefile(cached, path.join(CACHE_DIR, ds.id)) : cached
  const out = path.join(OUT_DIR, `${ds.id}.geojson`)
  await mapshaper(['-i', input, ...ds.mapshaper, '-o', out, 'format=geojson', 'geojson-type=FeatureCollection', 'precision=0.000001'])
  console.log(`  wrote ${path.relative(ROOT, out)}`)

  return manifestEntry(ds.id, `${ds.id}.geojson`, pkg, resource)
}

/**
 * 3D Massing: ~430k building footprints with heights. Too big for one file, so
 * it's split into ~1 km grid tiles (see src/data/massingGrid.ts) that the app
 * loads around the camera, plus massing/index.json describing every tile.
 */
async function processMassing() {
  console.log('\n▸ massing (3d-massing)')
  // Newest year of the extruded-footprint shapefile, e.g. 3DMassingShapefile_2025_WGS84.zip.
  const yearOf = (r: CkanResource) => Number(/^3DMassingShapefile_(\d{4})_WGS84\.zip$/.exec(r.name)?.[1] ?? 0)
  const { pkg, resource, cached } = await fetchResource(
    '3d-massing',
    (rs) => rs.filter(yearOf).sort((a, b) => yearOf(b) - yearOf(a))[0],
    (r) => `massing-${yearOf(r)}.zip`,
  )
  const year = yearOf(resource)
  const shp = await extractShapefile(cached, path.join(CACHE_DIR, 'massing'))

  // Write to a temp dir, then swap in, so a failed run never leaves half a tile set.
  const outDir = path.join(OUT_DIR, 'massing')
  const tmpDir = `${outDir}.tmp`
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })

  console.log('  reprojecting, simplifying and splitting into tiles (~15 s)…')
  await mapshaper([
    '-i', shp,
    // Despite "WGS84" in the file name, the data is Web Mercator metres.
    '-proj', 'wgs84',
    // 0.5 m tolerance removes redundant vertices without visibly changing footprints.
    '-simplify', 'dp', 'interval=0.5', 'keep-shapes',
    '-each', [
      `cell = ${MAPSHAPER_CELL_EXPRESSION}`,
      'h = Math.round(AVG_HEIGHT * 10) / 10',
      'top = Math.round(Math.max(AVG_HEIGHT, MAX_HEIGHT) * 10) / 10',
      // SURF_ELEV is 0 when unknown (~3k buildings); filled in below.
      'g = SURF_ELEV > 0 ? Math.round(SURF_ELEV * 100) / 100 : null',
    ].join(', '),
    '-filter-fields', 'cell,h,top,g',
    '-split', 'cell',
    '-o', `${tmpDir}/`, 'format=geojson', 'precision=0.000001',
  ])

  // Post-process each tile: fill missing ground elevations, drop the cell field.
  type Props = Pick<MassingProps, 'h' | 'top' | 'g'>
  type Feat = { type: 'Feature'; properties: Props; geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } }
  const tileFeatures = new Map<string, Feat[]>()
  let filled = 0
  for (const file of (await readdir(tmpDir)).filter((f) => f.endsWith('.json')).sort()) {
    const key = file.replace(/\.json$/, '')
    const fc = JSON.parse(await readFile(path.join(tmpDir, file), 'utf8')) as {
      type: 'FeatureCollection'
      features: { properties: Partial<MassingProps> & { cell?: string; g: number | null }; geometry: Feat['geometry'] }[]
    }
    await rm(path.join(tmpDir, file))

    const grounds = fc.features.map((f) => f.properties.g).filter((g): g is number => g != null).sort((a, b) => a - b)
    const medianGround = grounds.length ? grounds[Math.floor(grounds.length / 2)] : null

    const features: Feat[] = []
    for (const f of fc.features) {
      const { h, top } = f.properties
      let g = f.properties.g
      if (g == null) {
        if (medianGround == null) continue // no way to place it vertically
        g = medianGround
        filled++
      }
      features.push({ type: 'Feature', properties: { h: h!, top: top!, g }, geometry: f.geometry })
    }
    if (features.length) tileFeatures.set(key, features)
  }

  // Addresses: the City's address points matched to footprints, across all tiles at once
  // (a point near a tile edge may belong to a building in the next tile).
  const addressPoints = await loadAddressPoints()
  const all: Feat[] = [...tileFeatures.values()].flat()
  const footprints: Footprint[] = []
  all.forEach((f, owner) => {
    for (const b of buildingsFromTile({ type: 'FeatureCollection', features: [f] } as never)) footprints.push({ ...b, owner })
  })
  console.log(`  matching ${addressPoints.points.length.toLocaleString()} addresses to ${all.length.toLocaleString()} buildings…`)
  const joined = joinAddresses(footprints, addressPoints.points)
  const wards = [...new Set([...joined.values()].map((j) => j.ward).filter((w): w is string => !!w))].sort()
  const wardIndex = new Map(wards.map((w, i) => [w, i]))

  const tiles: Record<string, MassingTileInfo> = {}
  let buildings = 0
  let owner = 0
  for (const [key, features] of tileFeatures) {
    let maxTop = 0
    const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
    const out = features.map((f) => {
      const j = joined.get(owner++)
      maxTop = Math.max(maxTop, f.properties.top ?? 0)
      extendBbox(bbox, f.geometry.coordinates)
      const props: MassingProps = { ...f.properties }
      if (j) {
        props.a = j.addresses
        if (j.count > j.addresses.length) props.an = j.count
        if (j.place) props.p = j.place
        if (j.ward) props.w = wardIndex.get(j.ward)
      }
      return { ...f, properties: props }
    })
    await writeFile(path.join(tmpDir, `${key}.json`), JSON.stringify({ type: 'FeatureCollection', features: out }))
    tiles[key] = { n: out.length, maxTop, bbox: bbox.map((v) => Math.round(v * 1e6) / 1e6) as MassingTileInfo['bbox'] }
    buildings += out.length
  }
  console.log(`  ${joined.size.toLocaleString()} buildings have an address (${((joined.size / buildings) * 100).toFixed(0)}%)`)

  const index: MassingIndex = { grid: MASSING_GRID, year, buildings, tiles, wards }
  await writeFile(path.join(tmpDir, 'index.json'), JSON.stringify(index))
  await rm(outDir, { recursive: true, force: true })
  await rename(tmpDir, outDir)

  console.log(`  wrote ${Object.keys(tiles).length} tiles, ${buildings.toLocaleString()} buildings (${filled.toLocaleString()} ground elevations filled from tile median)`)
  return [
    manifestEntry('massing', 'massing/index.json', pkg, resource),
    manifestEntry('addresses', 'massing/index.json', addressPoints.pkg, addressPoints.resource),
  ]
}

/** Rank of an address point's class: structures before land, entrances last. */
const ADDRESS_CLASS_RANK: Record<string, number> = { Structure: 0, Land: 1, 'Structure Entrance': 2, 'Land Entrance': 3 }

/**
 * City of Toronto Address Points (~525k civic addresses, lat/long), joined onto the
 * massing buildings. The CSV is the smallest download (~175 MB); its geometry column
 * is GeoJSON text.
 */
async function loadAddressPoints() {
  console.log('\n▸ addresses (address-points-municipal-toronto-one-address-repository)')
  const { pkg, resource, cached } = await fetchResource(
    'address-points-municipal-toronto-one-address-repository',
    (rs) => rs.find((r) => r.name === 'Address Points - 4326.csv'),
    () => 'address-points.csv',
  )
  const rows = parseCsv(await readFile(cached, 'utf8'))
  const header = rows.next().value as string[]
  const col = (name: string) => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`Address Points CSV has no ${name} column`)
    return i
  }
  const [iAddr, iPlace, iWard, iClass, iGeom] = ['ADDRESS_FULL', 'PLACE_NAME', 'WARD_NAME', 'ADDRESS_CLASS_DESC', 'geometry'].map(col)
  const clean = (v: string | undefined) => (v && v !== 'None' ? v : null)
  const points: AddressPoint[] = []
  for (const row of rows) {
    const address = clean(row[iAddr])
    if (!address || !row[iGeom]) continue
    const geom = JSON.parse(row[iGeom]) as { type: string; coordinates: number[] | number[][] }
    const coords = (geom.type === 'MultiPoint' ? (geom.coordinates as number[][]) : [geom.coordinates as number[]])[0]
    if (!coords) continue
    points.push({
      lon: coords[0],
      lat: coords[1],
      address,
      place: clean(row[iPlace]),
      ward: clean(row[iWard]),
      // Named places first, then structures before land.
      rank: (clean(row[iPlace]) ? 0 : 10) + (ADDRESS_CLASS_RANK[row[iClass]] ?? 5),
    })
  }
  return { pkg, resource, points }
}

/** Overpass servers, tried in turn: the main one is often busy (502/504). */
const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
/** [south, west, north, east] around the City boundary. */
const PLACES_BBOX: [number, number, number, number] = [43.57, -79.65, 43.86, -79.1]

/**
 * Places by type from OpenStreetMap (Overpass API): hospitals, police and fire stations,
 * schools, parks, stations, … with a centre and rough size. ~1 MB download, cached.
 */
async function processPlaces() {
  console.log('\n▸ places (OpenStreetMap via Overpass)')
  const cached = path.join(CACHE_DIR, 'places-overpass.json')
  if (REFRESH || !existsSync(cached)) {
    const query = overpassQuery(PLACES_BBOX)
    let body: string | null = null
    const failures: string[] = []
    for (let attempt = 0; attempt < 2 && !body; attempt++) {
      for (const server of OVERPASS_SERVERS) {
        console.log(`  asking ${new URL(server).host}…`)
        try {
          const res = await fetch(server, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'tdot-drone-sim data script' },
            body: new URLSearchParams({ data: query }),
            signal: AbortSignal.timeout(200_000),
          })
          const text = await res.text()
          if (res.ok && text.trimStart().startsWith('{')) {
            body = text
            break
          }
          failures.push(`${new URL(server).host}: HTTP ${res.status}`)
        } catch (err) {
          failures.push(`${new URL(server).host}: ${err instanceof Error ? err.message : err}`)
        }
      }
      if (!body && attempt === 0) await new Promise((r) => setTimeout(r, 20_000))
    }
    if (!body) throw new Error(`Overpass servers all failed (try again later):\n    ${failures.join('\n    ')}`)
    await writeFile(cached, body)
  } else {
    console.log('  using cached Overpass answer (pass --refresh to re-download)')
  }

  const answer = JSON.parse(await readFile(cached, 'utf8')) as { osm3s?: { timestamp_osm_base?: string }; elements: never[] }
  const places = placesFromOsm(answer.elements)
  const generatedAt = answer.osm3s?.timestamp_osm_base ?? new Date().toISOString()
  await writeFile(path.join(OUT_DIR, 'places.json'), JSON.stringify(placesFile(places, generatedAt)))
  const counts = PLACE_CATEGORIES.map((c) => `${places.filter((p) => p.category === c).length} ${CATEGORY_LABEL[c]}`)
  console.log(`  wrote public/data/toronto/places.json: ${places.length.toLocaleString()} places (${counts.join(', ')})`)
  return {
    id: 'places',
    file: 'places.json',
    source: 'https://www.openstreetmap.org/copyright',
    title: 'OpenStreetMap places (© OpenStreetMap contributors, ODbL)',
    resource: 'Overpass API',
    lastRefreshed: generatedAt,
  }
}

/** Grows bbox to include every [lon, lat] in nested GeoJSON coordinates. */
function extendBbox(bbox: [number, number, number, number], coords: unknown) {
  if (!Array.isArray(coords)) return
  if (typeof coords[0] === 'number') {
    const [lon, lat] = coords as number[]
    if (lon < bbox[0]) bbox[0] = lon
    if (lat < bbox[1]) bbox[1] = lat
    if (lon > bbox[2]) bbox[2] = lon
    if (lat > bbox[3]) bbox[3] = lat
    return
  }
  for (const c of coords) extendBbox(bbox, c)
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  const datasets = []
  for (const ds of DATASETS) if (wanted(ds.id)) datasets.push(await processDataset(ds))
  if (wanted('massing')) datasets.push(...(await processMassing()))
  if (wanted('places')) datasets.push(await processPlaces())

  if (ONLY) {
    // Partial run: leave the full manifest from the last complete run alone.
    console.log(`\n✓ Done (only: ${ONLY.join(', ')})`)
    return
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
    // places.json carries its own (OpenStreetMap, ODbL).
    datasets,
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('\n✓ Done. Wrote public/data/toronto/manifest.json')
}

main().catch((err) => {
  console.error('\n✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
