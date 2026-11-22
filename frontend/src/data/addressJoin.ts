/**
 * Matches City of Toronto address points to 3D Massing building footprints, for
 * the data script. The massing data has no addresses, so each building gets the
 * addresses of the points inside its footprint. Many points sit in the middle of
 * the lot rather than on the building, so a point inside no footprint goes to the
 * nearest building within `maxDistanceM`, but only if that building has no
 * address of its own (so a lot point never overrides a building's real address).
 */
import { distanceToRingM, footprintContains, type Building } from '../drone/collision'

export type AddressPoint = {
  lon: number
  lat: number
  /** e.g. "32 Nineteenth St". */
  address: string
  /** Named place, e.g. "Old City Hall". */
  place: string | null
  ward: string | null
  /** Lower sorts first when a building has several addresses. */
  rank: number
}

/** A footprint part and the building (feature) it belongs to. */
export type Footprint = Pick<Building, 'outer' | 'holes' | 'bbox'> & { owner: number }

export type BuildingAddresses = {
  /** Up to `keep` addresses, best first. */
  addresses: string[]
  /** Total number of addresses (can be more than `addresses.length`). */
  count: number
  place: string | null
  ward: string | null
}

/** Spatial hash bucket size in degrees (~80 m × 110 m). */
const BUCKET_DEG = 0.001

const bucketKey = (bx: number, by: number) => `${bx},${by}`

export function joinAddresses(
  footprints: Footprint[],
  points: AddressPoint[],
  { maxDistanceM = 15, keep = 5 }: { maxDistanceM?: number; keep?: number } = {},
): Map<number, BuildingAddresses> {
  // Each footprint goes in every bucket its bounding box touches.
  const buckets = new Map<string, Footprint[]>()
  for (const f of footprints) {
    const [w, s, e, n] = f.bbox
    for (let bx = Math.floor(w / BUCKET_DEG); bx <= Math.floor(e / BUCKET_DEG); bx++)
      for (let by = Math.floor(s / BUCKET_DEG); by <= Math.floor(n / BUCKET_DEG); by++) {
        const k = bucketKey(bx, by)
        const list = buckets.get(k)
        if (list) list.push(f)
        else buckets.set(k, [f])
      }
  }

  const contained = new Map<number, AddressPoint[]>()
  const outside: AddressPoint[] = []
  for (const p of points) {
    const owners = new Set<number>()
    for (const f of buckets.get(bucketKey(Math.floor(p.lon / BUCKET_DEG), Math.floor(p.lat / BUCKET_DEG))) ?? [])
      if (!owners.has(f.owner) && footprintContains(f, p.lon, p.lat)) owners.add(f.owner)
    if (!owners.size) outside.push(p)
    // Overlapping footprints (e.g. a tower over its podium) all get the address.
    for (const o of owners) {
      const list = contained.get(o)
      if (list) list.push(p)
      else contained.set(o, [p])
    }
  }

  // Points outside every footprint: the nearest building within reach that has no address yet.
  const nearby = new Map<number, AddressPoint[]>()
  const reachDeg = maxDistanceM / 75_000 // generous: 1° lon ≈ 80 km at Toronto
  for (const p of outside) {
    let best: { owner: number; d: number } | null = null
    const seen = new Set<Footprint>()
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(bucketKey(Math.floor(p.lon / BUCKET_DEG) + dx, Math.floor(p.lat / BUCKET_DEG) + dy))
        for (const f of list ?? []) {
          if (seen.has(f)) continue
          seen.add(f)
          const [w, s, e, n] = f.bbox
          if (p.lon < w - reachDeg || p.lon > e + reachDeg || p.lat < s - reachDeg || p.lat > n + reachDeg) continue
          const d = distanceToRingM(p.lon, p.lat, f.outer)
          if (d <= maxDistanceM && (!best || d < best.d)) best = { owner: f.owner, d }
        }
      }
    if (!best || contained.has(best.owner)) continue
    const list = nearby.get(best.owner)
    if (list) list.push(p)
    else nearby.set(best.owner, [p])
  }

  const out = new Map<number, BuildingAddresses>()
  for (const [owner, list] of [...contained, ...nearby]) {
    // Duplicate address strings happen (e.g. a structure point and its entrance).
    const sorted = [...list].sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address, 'en', { numeric: true }))
    const unique = [...new Set(sorted.map((p) => p.address))]
    out.set(owner, {
      addresses: unique.slice(0, keep),
      count: unique.length,
      place: sorted.find((p) => p.place)?.place ?? null,
      ward: sorted.find((p) => p.ward)?.ward ?? null,
    })
  }
  return out
}

/** Minimal CSV parser (RFC 4180: quoted fields, doubled quotes, commas and newlines in quotes). */
export function* parseCsv(text: string): Generator<string[]> {
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true // only a field that starts with a quote is quoted
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      yield row
      row = []
      field = ''
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    yield row
  }
}
