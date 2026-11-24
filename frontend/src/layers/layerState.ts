/**
 * The map layers the user can turn on and off. The photorealistic 3D tiles are the
 * map itself and always on; the City massing data is never drawn (it's used for
 * collisions and building info), so neither is a layer here.
 */
export type LayerId = 'neighbourhoods' | 'boundary'

export type LayerVisibility = Record<LayerId, boolean>

export type LayerStatus = 'loading' | 'ready' | 'error'

export const LAYERS: { id: LayerId; label: string; hint: string; shortcut: string; swatch: string }[] = [
  { id: 'neighbourhoods', label: 'Neighbourhoods', hint: "The City's 158 neighbourhoods. Click one for details.", shortcut: 'N', swatch: 'linear-gradient(135deg, #e07a5f, #81b29a, #3d85c6)' },
  { id: 'boundary', label: 'City boundary', hint: 'Outline of the City of Toronto.', shortcut: 'B', swatch: '#ffd166' },
]

export const DEFAULT_VISIBILITY: LayerVisibility = {
  neighbourhoods: true,
  boundary: true,
}

const STORAGE_KEY = 'tdot.layers.v1'

/** Remembered per browser for convenience; falls back to defaults if storage is unavailable. */
export function loadVisibility(): LayerVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<LayerVisibility> | null
    if (saved && typeof saved === 'object') {
      const merged = { ...DEFAULT_VISIBILITY }
      for (const { id } of LAYERS) if (typeof saved[id] === 'boolean') merged[id] = saved[id]
      return merged
    }
  } catch {
    // ignore: private mode, blocked storage, bad JSON
  }
  return { ...DEFAULT_VISIBILITY }
}

export function saveVisibility(visibility: LayerVisibility) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility))
  } catch {
    // ignore
  }
}
