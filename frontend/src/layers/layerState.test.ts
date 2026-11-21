import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../test/memoryStorage'
import { DEFAULT_VISIBILITY, LAYERS, loadVisibility, saveVisibility } from './layerState'

describe('layer visibility settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('starts with both overlays on', () => {
    expect(loadVisibility()).toEqual({ neighbourhoods: true, boundary: true })
  })

  it('round-trips saved choices', () => {
    const choice = { neighbourhoods: false, boundary: true }
    saveVisibility(choice)
    expect(loadVisibility()).toEqual(choice)
  })

  it('fills in missing layers, ignores junk and drops layers that no longer exist', () => {
    // Older versions also saved "google" and "massing" toggles; they're gone now.
    localStorage.setItem('tdot.layers.v1', JSON.stringify({ google: false, massing: true, boundary: false, neighbourhoods: 'yes' }))
    expect(loadVisibility()).toEqual({ ...DEFAULT_VISIBILITY, boundary: false })
  })

  it('falls back to defaults on corrupt data', () => {
    localStorage.setItem('tdot.layers.v1', 'not json')
    expect(loadVisibility()).toEqual(DEFAULT_VISIBILITY)
  })

  it('gives every layer a unique one-letter shortcut', () => {
    const keys = LAYERS.map((l) => l.shortcut.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => /^[a-z]$/.test(k))).toBe(true)
  })
})
