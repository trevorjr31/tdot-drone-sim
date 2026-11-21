import { describe, expect, it } from 'vitest'
import { cellKey, cellOf, MAPSHAPER_CELL_EXPRESSION, MASSING_GRID } from './massingGrid'

/** Evaluates the mapshaper expression the way mapshaper does: `this` is the feature. */
function mapshaperCell(lon: number, lat: number): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`return ${MAPSHAPER_CELL_EXPRESSION}`)
  return fn.call({ centroidX: lon, centroidY: lat }) as string
}

describe('massing grid', () => {
  it('puts the CN Tower in tile 20_6 (the tile with the tallest building)', () => {
    const { col, row } = cellOf(-79.3871, 43.6426)
    expect(cellKey(col, row)).toBe('20_6')
  })

  it('starts counting at the grid origin', () => {
    expect(cellOf(MASSING_GRID.originLon, MASSING_GRID.originLat)).toEqual({ col: 0, row: 0 })
    expect(cellOf(MASSING_GRID.originLon + MASSING_GRID.cellLon * 1.5, MASSING_GRID.originLat + 0.001)).toEqual({
      col: 1,
      row: 0,
    })
  })

  // The data script assigns buildings to tiles with the mapshaper expression; the
  // app finds tiles with cellOf. If they ever disagree, buildings silently go missing.
  it('agrees with the expression the data script uses, across the whole city', () => {
    for (let i = 0; i < 2000; i++) {
      const lon = -79.64 + Math.random() * 0.53
      const lat = 43.58 + Math.random() * 0.28
      const { col, row } = cellOf(lon, lat)
      expect(mapshaperCell(lon, lat)).toBe(cellKey(col, row))
    }
  })
})
