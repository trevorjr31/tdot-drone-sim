/** The map layers the user can turn on and off. */
export type LayerId = 'google' | 'neighbourhoods' | 'boundary' | 'massing'

export type LayerVisibility = Record<LayerId, boolean>

export type LayerStatus = 'loading' | 'ready' | 'error'

export const LAYERS: { id: LayerId; label: string; hint: string; shortcut: string; swatch: string }[] = [
  { id: 'google', label: 'Photorealistic 3D', hint: 'Google 3D Tiles. Off shows terrain + satellite instead.', shortcut: 'G', swatch: 'linear-gradient(135deg, #7a9e7e, #a7b6c2)' },
  { id: 'massing', label: 'Building massing', hint: 'City of Toronto 3D Massing, loaded around the camera.', shortcut: 'M', swatch: '#e6e8eb' },
  { id: 'neighbourhoods', label: 'Neighbourhoods', hint: "The City's 158 neighbourhoods. Click one for details.", shortcut: 'N', swatch: 'linear-gradient(135deg, #e07a5f, #81b29a, #3d85c6)' },
  { id: 'boundary', label: 'City boundary', hint: 'Outline of the City of Toronto.', shortcut: 'B', swatch: '#ffd166' },
]

export const DEFAULT_VISIBILITY: LayerVisibility = {
  google: true,
  massing: false,
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
