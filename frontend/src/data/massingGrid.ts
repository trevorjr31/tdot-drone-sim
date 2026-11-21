/**
 * Grid used to split the 3D Massing buildings into tiles. Shared by the data
 * script (which writes the tiles) and the app (which decides which to load),
 * so the two can never disagree.
 *
 * Cells are 0.0125° lon × 0.01° lat, about 1.0 km × 1.1 km at Toronto's latitude.
 * A building belongs to the cell containing its centroid, so it's never split.
 */
export const MASSING_GRID = {
  originLon: -79.64,
  originLat: 43.58,
  cellLon: 0.0125,
  cellLat: 0.01,
} as const

export function cellKey(col: number, row: number): string {
  return `${col}_${row}`
}

export function cellOf(lon: number, lat: number): { col: number; row: number } {
  return {
    col: Math.floor((lon - MASSING_GRID.originLon) / MASSING_GRID.cellLon),
    row: Math.floor((lat - MASSING_GRID.originLat) / MASSING_GRID.cellLat),
  }
}

/** Same formula as cellOf, as a mapshaper -each expression (uses the feature centroid). */
export const MAPSHAPER_CELL_EXPRESSION =
  `Math.floor((this.centroidX - (${MASSING_GRID.originLon})) / ${MASSING_GRID.cellLon}) + "_" + ` +
  `Math.floor((this.centroidY - ${MASSING_GRID.originLat}) / ${MASSING_GRID.cellLat})`

export type MassingTileInfo = {
  /** Number of buildings. */
  n: number
  /** Tallest building top in the tile, metres above ground. */
  maxTop: number
  /** Actual extent of the tile's buildings: [west, south, east, north] in degrees. */
  bbox: [number, number, number, number]
}

export type MassingIndex = {
  grid: typeof MASSING_GRID
  /** Dataset year, e.g. 2025. */
  year: number
  buildings: number
  tiles: Record<string, MassingTileInfo>
}

export type MassingProps = {
  /** Height above ground used for drawing (City's AVG_HEIGHT), metres. */
  h: number
  /** Highest point above ground (max of AVG_HEIGHT, MAX_HEIGHT), for collision checks. */
  top: number
  /** Ground elevation above sea level (SURF_ELEV), metres. Filled from the tile median when missing. */
  g: number
}
