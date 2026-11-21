import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../test/memoryStorage'
import { DEFAULT_VISIBILITY, LAYERS, loadVisibility, saveVisibility } from './layerState'

describe('layer visibility settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('starts with the defaults (massing off, everything else on)', () => {
    expect(loadVisibility()).toEqual({ google: true, massing: false, neighbourhoods: true, boundary: true })
  })

  it('round-trips saved choices', () => {
    const choice = { google: false, massing: true, neighbourhoods: false, boundary: true }
    saveVisibility(choice)
    expect(loadVisibility()).toEqual(choice)
  })

  it('fills in layers missing from older saved settings and ignores junk values', () => {
    localStorage.setItem('tdot.layers.v1', JSON.stringify({ google: false, massing: 'yes', unknown: true }))
    expect(loadVisibility()).toEqual({ ...DEFAULT_VISIBILITY, google: false })
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
