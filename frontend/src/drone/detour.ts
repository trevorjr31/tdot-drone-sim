/**
 * The shortest way around buildings too tall to fly over. Used when a route leg can't be
 * flown straight under the ceiling: the obstacles are the buildings taller than the
 * highest the drone may cross at, and the path keeps a corridor's width from each.
 *
 * Grid search (A*, 8 directions) over the area around the leg, then the path is
 * straightened into as few turning points as possible, each straight piece checked
 * exactly against the obstacles. Close to the true shortest path (within a few percent
 * of a cell size per turn).
 */
import type { Building } from './collision'
import { highestOnRoute, type LatLon } from './routeSafety'

const M_PER_DEG_LAT = 110_574
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)

export type DetourOptions = {
  /** Keep this far from every obstacle, metres (the route corridor). */
  corridorM: number
  /** Grid cell size, metres. */
  cellM?: number
  /** Search this far around the leg's straight line, metres. */
  marginM?: number
}

/**
 * Turning points (not including `from` and `to`) of the shortest path from `from` to
 * `to` that stays `corridorM` from every obstacle, or null if there's none within the
 * searched area. An empty list means the straight line is already clear.
 */
export function findDetour(obstacles: Building[], from: LatLon, to: LatLon, opts: DetourOptions): LatLon[] | null {
  const { corridorM } = opts
  const clear = (a: LatLon, b: LatLon) => highestOnRoute(obstacles, a, b, corridorM) === null
  if (clear(from, to)) return []
  const cell = opts.cellM ?? 8
  const margin = opts.marginM ?? 400

  // Local metres around `from`.
  const kx = mPerDegLon(from.lat)
  const toXY = (p: LatLon): [number, number] => [(p.lon - from.lon) * kx, (p.lat - from.lat) * M_PER_DEG_LAT]
  const toLatLon = (x: number, y: number): LatLon => ({ lat: from.lat + y / M_PER_DEG_LAT, lon: from.lon + x / kx })
  const [tx, ty] = toXY(to)
  const x0 = Math.min(0, tx) - margin
  const y0 = Math.min(0, ty) - margin
  const cols = Math.ceil((Math.max(0, tx) + margin - x0) / cell) + 1
  const rows = Math.ceil((Math.max(0, ty) + margin - y0) / cell) + 1
  const cx = (c: number) => x0 + c * cell
  const cy = (r: number) => y0 + r * cell

  // Blocked cells: within the corridor (plus half a cell, to be safe) of an obstacle.
  const blocked = new Uint8Array(cols * rows)
  const reach = corridorM + cell * 0.75
  for (const b of obstacles) {
    const ring = b.outer.map(([lon, lat]) => toXY({ lon, lat }))
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ring) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    const c0 = Math.max(0, Math.floor((minX - reach - x0) / cell))
    const c1 = Math.min(cols - 1, Math.ceil((maxX + reach - x0) / cell))
    const r0 = Math.max(0, Math.floor((minY - reach - y0) / cell))
    const r1 = Math.min(rows - 1, Math.ceil((maxY + reach - y0) / cell))
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c
        if (blocked[i]) continue
        const x = cx(c)
        const y = cy(r)
        if (insideRing(x, y, ring) || ringDistance(x, y, ring) <= reach) blocked[i] = 1
      }
    }
  }

  const cellOf = (x: number, y: number) => {
    const c = Math.max(0, Math.min(cols - 1, Math.round((x - x0) / cell)))
    const r = Math.max(0, Math.min(rows - 1, Math.round((y - y0) / cell)))
    return r * cols + c
  }
  // Start or end inside an obstacle's corridor (e.g. right beside a tower): from the nearest free cell.
  const start = nearestFree(blocked, cols, rows, cellOf(0, 0))
  const goal = nearestFree(blocked, cols, rows, cellOf(tx, ty))
  if (start < 0 || goal < 0) return null

  const cells = aStar(blocked, cols, rows, start, goal)
  if (!cells) return null

  // The grid path's corners (where its direction changes), then straightened.
  const corners: LatLon[] = [from]
  for (let k = 1; k < cells.length - 1; k++) {
    const [a, b, c] = [cells[k - 1], cells[k], cells[k + 1]]
    if (b - a !== c - b) corners.push(toLatLon(cx(b % cols), cy(Math.floor(b / cols))))
  }
  if (cells.length > 1) {
    const s = cells[0]
    const e = cells[cells.length - 1]
    // The free cells next to `from`/`to` when those were inside a corridor.
    if (s !== cellOf(0, 0)) corners.splice(1, 0, toLatLon(cx(s % cols), cy(Math.floor(s / cols))))
    if (e !== cellOf(tx, ty)) corners.push(toLatLon(cx(e % cols), cy(Math.floor(e / cols))))
  }
  corners.push(to)

  const out: LatLon[] = []
  let i = 0
  while (i < corners.length - 1) {
    let j = corners.length - 1
    while (j > i + 1 && !clear(corners[i], corners[j])) j--
    if (j < corners.length - 1) out.push(corners[j])
    i = j
  }
  return out
}

/** Path length in metres through the points. */
export function pathLengthM(points: LatLon[]): number {
  let d = 0
  for (let i = 1; i < points.length; i++) {
    const kx = mPerDegLon(points[i].lat)
    d += Math.hypot((points[i].lon - points[i - 1].lon) * kx, (points[i].lat - points[i - 1].lat) * M_PER_DEG_LAT)
  }
  return d
}

function aStar(blocked: Uint8Array, cols: number, rows: number, start: number, goal: number): number[] | null {
  const n = cols * rows
  const g = new Float64Array(n).fill(Infinity)
  const came = new Int32Array(n).fill(-1)
  const closed = new Uint8Array(n)
  const gc = goal % cols
  const gr = Math.floor(goal / cols)
  const h = (i: number) => {
    const dx = Math.abs((i % cols) - gc)
    const dy = Math.abs(Math.floor(i / cols) - gr)
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  }
  const heap = new MinHeap()
  g[start] = 0
  heap.push(start, h(start))
  const steps: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ]
  while (heap.size) {
    const cur = heap.pop()
    if (cur === goal) {
      const path = [cur]
      for (let p = came[cur]; p >= 0; p = came[p]) path.push(p)
      return path.reverse()
    }
    if (closed[cur]) continue
    closed[cur] = 1
    const c = cur % cols
    const r = Math.floor(cur / cols)
    for (const [dc, dr, cost] of steps) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const ni = nr * cols + nc
      if (blocked[ni] || closed[ni]) continue
      // No cutting a blocked corner diagonally.
      if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue
      const ng = g[cur] + cost
      if (ng < g[ni]) {
        g[ni] = ng
        came[ni] = cur
        heap.push(ni, ng + h(ni))
      }
    }
  }
  return null
}

/** The free cell nearest `i` (breadth-first), or -1. */
function nearestFree(blocked: Uint8Array, cols: number, rows: number, i: number): number {
  if (!blocked[i]) return i
  const seen = new Uint8Array(cols * rows)
  const queue = [i]
  seen[i] = 1
  for (let q = 0; q < queue.length; q++) {
    const cur = queue[q]
    if (!blocked[cur]) return cur
    const c = cur % cols
    const r = Math.floor(cur / cols)
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const ni = nr * cols + nc
      if (!seen[ni]) {
        seen[ni] = 1
        queue.push(ni)
      }
    }
  }
  return -1
}

function insideRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function ringDistance(x: number, y: number, ring: [number, number][]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

/** Binary min-heap of cell indices by priority. */
class MinHeap {
  private readonly items: number[] = []
  private readonly prio: number[] = []
  get size() {
    return this.items.length
  }
  push(item: number, p: number) {
    const { items, prio } = this
    items.push(item)
    prio.push(p)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (prio[parent] <= prio[i]) break
      ;[items[i], items[parent]] = [items[parent], items[i]]
      ;[prio[i], prio[parent]] = [prio[parent], prio[i]]
      i = parent
    }
  }
  pop(): number {
    const { items, prio } = this
    const top = items[0]
    const lastItem = items.pop()!
    const lastPrio = prio.pop()!
    if (items.length) {
      items[0] = lastItem
      prio[0] = lastPrio
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < items.length && prio[l] < prio[m]) m = l
        if (r < items.length && prio[r] < prio[m]) m = r
        if (m === i) break
        ;[items[i], items[m]] = [items[m], items[i]]
        ;[prio[i], prio[m]] = [prio[m], prio[i]]
        i = m
      }
    }
    return top
  }
}
