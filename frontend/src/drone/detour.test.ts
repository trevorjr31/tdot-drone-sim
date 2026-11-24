import { describe, expect, it } from 'vitest'
import type { Building } from './collision'
import { findDetour, pathLengthM } from './detour'
import { highestOnRoute } from './routeSafety'

const LAT = 43.65
const LON = -79.38
const M_LAT = 1 / 110_574
const M_LON = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180))

/** A square tower `size` metres across, centred `x` m east and `y` m north of (LAT, LON). */
function tower(x: number, y: number, size: number, roofM = 300): Building {
  const h = size / 2
  const outer: [number, number][] = [
    [LON + (x - h) * M_LON, LAT + (y - h) * M_LAT],
    [LON + (x + h) * M_LON, LAT + (y - h) * M_LAT],
    [LON + (x + h) * M_LON, LAT + (y + h) * M_LAT],
    [LON + (x - h) * M_LON, LAT + (y + h) * M_LAT],
    [LON + (x - h) * M_LON, LAT + (y - h) * M_LAT],
  ]
  return {
    outer,
    holes: [],
    bbox: [LON + (x - h) * M_LON, LAT + (y - h) * M_LAT, LON + (x + h) * M_LON, LAT + (y + h) * M_LAT],
    groundM: 90,
    roofM,
  }
}

const at = (x: number, y: number) => ({ lat: LAT + y * M_LAT, lon: LON + x * M_LON })
const CORRIDOR = 15

describe('findDetour', () => {
  it('returns no turns when the straight line is clear', () => {
    expect(findDetour([tower(0, 200, 40)], at(0, 0), at(500, 0), { corridorM: CORRIDOR })).toEqual([])
  })

  it('goes round a tower in the way, keeping the corridor clear, not much longer than needed', () => {
    const obstacles = [tower(250, 0, 60)]
    const from = at(0, 0)
    const to = at(500, 0)
    const via = findDetour(obstacles, from, to, { corridorM: CORRIDOR })!
    expect(via.length).toBeGreaterThan(0)
    expect(via.length).toBeLessThanOrEqual(3)
    const path = [from, ...via, to]
    for (let i = 1; i < path.length; i++) expect(highestOnRoute(obstacles, path[i - 1], path[i], CORRIDOR)).toBeNull()
    // Shortest way round: up the side to clear the tower's corner by the corridor and back,
    // about 520 m. Allow a little for the grid.
    const length = pathLengthM(path)
    expect(length).toBeGreaterThan(500)
    expect(length).toBeLessThan(560)
  })

  it('threads between two towers when the gap is wide enough', () => {
    // Towers 60 m wide spanning 50–110 m either side of the line, and a 4 m mast on it: the
    // gaps beside the mast are clear 17–35 m out (corridor 15 m), so it can slip past the mast
    // (~501 m) instead of going round the outside of the towers (~560 m).
    const obstacles = [tower(250, 80, 60), tower(250, -80, 60), tower(250, 0, 4)]
    const via = findDetour(obstacles, at(0, 0), at(500, 0), { corridorM: CORRIDOR })!
    const length = pathLengthM([at(0, 0), ...via, at(500, 0)])
    expect(length).toBeLessThan(520)
  })

  it('gives up when there is no way round within the search area', () => {
    const wall = Array.from({ length: 30 }, (_, i) => tower(250, -600 + i * 40, 42))
    expect(findDetour(wall, at(0, 0), at(500, 0), { corridorM: CORRIDOR, marginM: 300 })).toBeNull()
  })
})
