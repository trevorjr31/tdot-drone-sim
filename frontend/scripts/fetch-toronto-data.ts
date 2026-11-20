/**
 * Downloads City of Toronto Open Data and converts it into small GeoJSON files
 * the app serves from public/data/toronto/.
 *
 *   npm run data            # download (if not cached) and convert
 *   npm run data -- --refresh   # force fresh downloads
 *
 * Why a script instead of fetching in the browser: the City's CKAN API sends no
 * CORS headers, so browsers block direct requests. Preparing files ahead of time
 * also lets us trim and simplify the data so the app loads fast.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CKAN_API = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(ROOT, '.data-cache')
const OUT_DIR = path.join(ROOT, 'public', 'data', 'toronto')
const MAPSHAPER = path.join(ROOT, 'node_modules', '.bin', 'mapshaper')
const REFRESH = process.argv.includes('--refresh')

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

async function processDataset(ds: Dataset) {
  console.log(`\n▸ ${ds.id} (${ds.packageId})`)
  const pkg = await getPackage(ds.packageId)
  const resource = pkg.resources.find(ds.pickResource)
  if (!resource) throw new Error(`No matching resource in ${ds.packageId}: ${pkg.resources.map((r) => r.name).join(', ')}`)

  const cached = path.join(CACHE_DIR, `${ds.id}.${ds.cacheExt}`)
  if (REFRESH || !existsSync(cached)) {
    console.log(`  downloading "${resource.name}"`)
    await download(resource.url, cached)
  } else {
    console.log(`  using cached "${resource.name}" (pass --refresh to re-download)`)
  }

  const input = ds.cacheExt === 'zip' ? await extractShapefile(cached, path.join(CACHE_DIR, ds.id)) : cached
  const out = path.join(OUT_DIR, `${ds.id}.geojson`)
  await run(MAPSHAPER, ['-i', input, ...ds.mapshaper, '-o', out, 'format=geojson', 'geojson-type=FeatureCollection', 'precision=0.000001'])
  console.log(`  wrote ${path.relative(ROOT, out)}`)

  return {
    id: ds.id,
    file: `${ds.id}.geojson`,
    source: `https://open.toronto.ca/dataset/${pkg.name}/`,
    title: pkg.title,
    resource: resource.name,
    lastRefreshed: pkg.last_refreshed ?? resource.last_modified ?? null,
  }
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  const datasets = []
  for (const ds of DATASETS) datasets.push(await processDataset(ds))

  const manifest = {
    generatedAt: new Date().toISOString(),
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
    datasets,
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log('\n✓ Done. Wrote public/data/toronto/manifest.json')
}

main().catch((err) => {
  console.error('\n✗', err instanceof Error ? err.message : err)
  process.exit(1)
})
