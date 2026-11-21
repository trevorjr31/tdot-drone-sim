import type { Place } from './types'

export type PlaceType = 'Neighbourhood' | 'Area' | 'Address' | 'Intersection' | 'Street' | 'Place'

/** Results bigger than this (diagonal) without a street number are districts/areas, not a specific place. */
const AREA_MIN_DIAGONAL_M = 1000

const STREET_WORDS =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|cres|crescent|ct|court|pl|place|ln|lane|way|pkwy|parkway|hwy|highway|trl|trail|terr|terrace|sq|square|gdns|gardens|cir|circle|gate|grove)\b\.?( (n|s|e|w|east|west|north|south))?$/i

/**
 * What kind of thing a result is, shown as a label so same-named results can be
 * told apart (e.g. Casa Loma the castle vs Casa Loma the neighbourhood).
 * Whether it's saved is shown separately (star icon), not as its type.
 */
export function placeType(place: Place): PlaceType {
  if (place.kind === 'neighbourhood' || place.neighbourhoodId) return 'Neighbourhood'
  const title = place.title.trim()
  if (/&| and /i.test(title) && STREET_WORDS.test(title.split(/&| and /i)[0].trim())) return 'Intersection'
  if (/^\d+[a-z]?\s/i.test(title)) return 'Address'
  if (STREET_WORDS.test(title)) return 'Street'
  if (diagonalM(place) > AREA_MIN_DIAGONAL_M) return 'Area'
  return 'Place'
}

function diagonalM(place: Place): number {
  const t = place.target
  if (t.type === 'point') return 0
  const x = (t.east - t.west) * 111_320 * Math.cos((((t.north + t.south) / 2) * Math.PI) / 180)
  const y = (t.north - t.south) * 110_574
  return Math.hypot(x, y)
}

/** Lower-case, strip accents and punctuation so "Yonge–Eglinton" matches "yonge eglinton". */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Ranks local places (neighbourhoods, presets) for a query: prefix matches of the
 * whole name first, then names where every query word starts some word.
 */
export function searchLocal(query: string, places: Place[], limit = 5): Place[] {
  const q = normalize(query)
  if (!q) return []
  const qWords = q.split(' ')
  const scored: { place: Place; score: number }[] = []
  for (const place of places) {
    const name = normalize(place.title)
    const words = name.split(' ')
    let score = -1
    if (name.startsWith(q)) score = 3
    else if (qWords.every((qw) => words.some((w) => w.startsWith(qw)))) score = 2
    else if (name.includes(q)) score = 1
    if (score >= 0) scored.push({ place, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.place.title.localeCompare(b.place.title))
    .slice(0, limit)
    .map((s) => s.place)
}

/**
 * Turns a geocoder label into a title/subtitle pair. Landmarks come back as their
 * street address ("CN Tower" → "290 Bremner Blvd, …"), so when the label doesn't
 * contain what was typed, show the typed text as the title and the address below.
 */
export function titleFor(query: string, label: string): { title: string; subtitle?: string } {
  const clean = label.replace(/, Canada$/, '')
  const [first, ...rest] = clean.split(', ')
  const q = normalize(query)
  if (normalize(clean).includes(q) || normalize(first).startsWith(q.split(' ')[0] ?? '')) {
    return { title: first, subtitle: rest.join(', ') || undefined }
  }
  return { title: query.trim(), subtitle: clean }
}

// --- Recent searches (per browser) -----------------------------------------

const RECENT_KEY = 'tdot.recentPlaces.v1'
const RECENT_MAX = 5

export function loadRecent(): Place[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Place[]
    return Array.isArray(saved) ? saved.filter((p) => p && p.id && p.title && p.target).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

export function addRecent(place: Place): Place[] {
  const entry: Place = { ...place, kind: 'recent', id: `recent:${place.id.replace(/^recent:/, '')}` }
  const next = [entry, ...loadRecent().filter((p) => p.id !== entry.id)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}

// --- Preset lookups cache (per browser) ------------------------------------

// Bump the version whenever preset queries change, so stale lookups are dropped.
const PRESET_CACHE_KEY = 'tdot.presetPlaces.v2'

export function loadPresetCache(): Record<string, Place> {
  try {
    localStorage.removeItem('tdot.presetPlaces.v1') // lookups from older preset queries
    const saved = JSON.parse(localStorage.getItem(PRESET_CACHE_KEY) ?? '{}') as Record<string, Place>
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

export function savePresetCache(cache: Record<string, Place>) {
  try {
    localStorage.setItem(PRESET_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // ignore
  }
}
