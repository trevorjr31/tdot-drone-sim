import { useEffect, useMemo, useRef, useState } from 'react'
import { PRESETS, type Preset } from '../places/presets'
import { addRecent, loadPresetCache, loadRecent, placeType, savePresetCache, searchLocal, type PlaceType } from '../places/search'
import type { MapApi, Place } from '../places/types'

const GOOGLE_DELAY_MS = 450
const GOOGLE_MIN_CHARS = 3

type Row = { place: Place; section: string; preset?: Preset }

type GoogleState =
  | { state: 'idle' }
  | { state: 'loading'; query: string }
  | { state: 'done'; query: string; places: Place[]; attributionHtml: string[] }
  | { state: 'error'; query: string; message: string }

/** Placeholder Place for a preset that hasn't been looked up yet. */
function presetPlace(preset: Preset, cache: Record<string, Place>): Place {
  if ('place' in preset) return preset.place
  return (
    cache[preset.name] ?? {
      id: `preset:${preset.name}`,
      kind: 'preset',
      title: preset.name,
      target: { type: 'point', lon: 0, lat: 0 },
    }
  )
}

export function SearchBox({ api }: { api: MapApi | null }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<Place[]>(loadRecent)
  const [presetCache, setPresetCache] = useState<Record<string, Place>>(loadPresetCache)
  const [google, setGoogle] = useState<GoogleState>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  /** Enter was pressed before Google answered: go to the first result once it does. */
  const [pendingEnter, setPendingEnter] = useState(false)
  /** Type of the place last chosen, shown next to its name until the text is edited. */
  const [chosenType, setChosenType] = useState<PlaceType | null>(null)
  const requestId = useRef(0)

  const trimmed = query.trim()

  // Google results after a short pause in typing (each lookup uses Cesium ion quota).
  useEffect(() => {
    if (!api || trimmed.length < GOOGLE_MIN_CHARS) {
      setGoogle({ state: 'idle' })
      return
    }
    const id = ++requestId.current
    const timer = window.setTimeout(() => runGoogle(trimmed, id), GOOGLE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [trimmed, api])

  function runGoogle(q: string, id = ++requestId.current) {
    if (!api) return
    setGoogle({ state: 'loading', query: q })
    api
      .searchGoogle(q)
      .then((r) => id === requestId.current && setGoogle({ state: 'done', query: q, ...r }))
      .catch((err: unknown) => {
        console.error('Google geocoding failed', err)
        if (id === requestId.current) setGoogle({ state: 'error', query: q, message: 'Search is unavailable right now.' })
      })
  }

  // "/" focuses the search box, like many map apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rows: Row[] = useMemo(() => {
    if (!trimmed) {
      return [
        ...recent.map((place) => ({ place, section: 'Recent' })),
        ...PRESETS.map((preset) => ({ place: presetPlace(preset, presetCache), section: 'Places', preset })),
      ]
    }
    const presetPlaces = PRESETS.map((preset) => presetPlace(preset, presetCache))
    const local = searchLocal(trimmed, [...presetPlaces, ...(api?.neighbourhoods() ?? [])], 6).map((place) => ({
      place,
      section: place.kind === 'neighbourhood' ? 'Neighbourhoods' : 'Places',
      preset: place.kind === 'preset' ? PRESETS.find((p) => presetPlace(p, presetCache).id === place.id) : undefined,
    }))
    // A saved place and Google's result for the same name are the same thing; keep the saved one.
    // A neighbourhood with the same name is a different thing (an area), so keep both.
    const savedTitles = new Set(local.filter((r) => r.place.kind === 'preset').map((r) => r.place.title.toLowerCase()))
    const fromGoogle =
      google.state === 'done' && google.query === trimmed
        ? google.places
            .filter((p) => !savedTitles.has(p.title.toLowerCase()))
            .map((place) => ({ place, section: 'Addresses & landmarks' }))
        : []
    return [...local, ...fromGoogle]
  }, [trimmed, recent, presetCache, google, api])

  useEffect(() => {
    setActive(0)
    setPendingEnter(false)
  }, [trimmed])

  useEffect(() => {
    if (!pendingEnter || google.state === 'loading' || google.state === 'idle') return
    setPendingEnter(false)
    if (rows[0]) void choose(rows[0])
  }, [pendingEnter, google, rows])

  async function choose(row: Row) {
    if (!api) return
    let place = row.place
    // Presets defined by address are looked up once, then cached in this browser.
    if (row.preset && 'query' in row.preset && !presetCache[row.preset.name]) {
      setBusy(true)
      try {
        const { places } = await api.searchGoogle(row.preset.query)
        if (!places[0]) throw new Error(`No result for "${row.preset.query}"`)
        place = { ...places[0], id: `preset:${row.preset.name}`, kind: 'preset', title: row.preset.name, view: row.preset.view }
        const next = { ...presetCache, [row.preset.name]: place }
        setPresetCache(next)
        savePresetCache(next)
      } catch (err) {
        console.error('Preset lookup failed', err)
        setGoogle({ state: 'error', query: trimmed, message: `Couldn't find "${row.preset.name}".` })
        setBusy(false)
        return
      }
      setBusy(false)
    }
    api.flyToPlace(place)
    if (place.kind !== 'preset') setRecent(addRecent(place))
    setQuery(place.title)
    setChosenType(placeType(place))
    setOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const googleAnswered = google.state === 'done' && google.query === trimmed
      // Results are in (or not needed, or the user picked a row with the arrows): go.
      if (googleAnswered || !trimmed || trimmed.length < GOOGLE_MIN_CHARS || active > 0) {
        if (rows[active]) void choose(rows[active])
        return
      }
      // Otherwise search now instead of waiting for the typing pause, then go to the top result.
      setPendingEnter(true)
      if (google.state !== 'loading') runGoogle(trimmed)
    } else if (e.key === 'Escape') {
      if (open) setOpen(false)
      else clear()
      inputRef.current?.blur()
    }
  }

  function clear() {
    setQuery('')
    setChosenType(null)
    setGoogle({ state: 'idle' })
    api?.clearPin()
    inputRef.current?.focus()
  }

  const showGoogleFooter = google.state === 'done' && google.query === trimmed && google.places.length > 0
  let lastSection = ''

  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <div className="search__field">
        <span className="search__icon" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search address, neighbourhood or landmark"
          aria-label="Search places in Toronto"
          aria-expanded={open}
          aria-controls="search-results"
          role="combobox"
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `search-row-${active}` : undefined}
          disabled={!api}
          onChange={(e) => {
            setQuery(e.target.value)
            setChosenType(null)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {chosenType && <span className={`search__chip search__chip--${typeClass(chosenType)}`}>{chosenType}</span>}
        {query ? (
          <button type="button" className="search__clear" onClick={clear} aria-label="Clear search">
            ×
          </button>
        ) : (
          <kbd className="search__key" aria-hidden>
            /
          </kbd>
        )}
      </div>

      {open && api && (
        <div className="search__results" id="search-results" role="listbox">
          {rows.map((row, i) => {
            const header = row.section !== lastSection ? row.section : null
            lastSection = row.section
            return (
              <div key={`${row.section}:${row.place.id}`}>
                {header && <div className="search__section">{header}</div>}
                <button
                  type="button"
                  id={`search-row-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`search__row${i === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus so onBlur doesn't close first
                  onClick={() => void choose(row)}
                >
                  <PlaceIcon type={placeType(row.place)} saved={row.place.kind === 'preset'} />
                  <span className="search__text">
                    <span className="search__title">{row.place.title}</span>
                    {row.place.subtitle && <span className="search__subtitle">{row.place.subtitle}</span>}
                  </span>
                  <span className="search__meta">
                    <span className={`search__chip search__chip--${typeClass(placeType(row.place))}`}>
                      {placeType(row.place)}
                    </span>
                    {row.place.outsideCity && <span className="search__tag">outside City</span>}
                  </span>
                </button>
              </div>
            )
          })}

          {trimmed.length >= GOOGLE_MIN_CHARS && google.state === 'loading' && (
            <div className="search__status">Searching…</div>
          )}
          {google.state === 'error' && <div className="search__status">{google.message}</div>}
          {busy && <div className="search__status">Looking up place…</div>}
          {trimmed && google.state === 'done' && google.query === trimmed && rows.length === 0 && (
            <div className="search__status">No places found in Toronto.</div>
          )}
          {trimmed && trimmed.length < GOOGLE_MIN_CHARS && rows.length === 0 && (
            <div className="search__status">Keep typing…</div>
          )}

          {showGoogleFooter && (
            <div className="search__footer">
              <GoogleAttribution html={google.attributionHtml} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function typeClass(type: PlaceType): string {
  return type === 'Neighbourhood' || type === 'Area' ? 'area' : 'point'
}

/** Pin for points (addresses, landmarks), outlined area for neighbourhoods, star for saved places. */
function PlaceIcon({ type, saved }: { type: PlaceType; saved?: boolean }) {
  const cls = `search__icon-type search__icon-type--${saved ? 'saved' : typeClass(type)}`
  if (type === 'Neighbourhood' || type === 'Area') {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden>
        <path d="M2.5 4.5 7 2l6.5 2.5-1 7L7 14l-4.5-2.5z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    )
  }
  if (saved) {
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden>
        <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.3 4.5 8.5 4.5 8.5s4.5-5.2 4.5-8.5A4.5 4.5 0 0 0 8 1.5z" fill="currentColor" />
      <circle cx="8" cy="6" r="1.7" fill="#1d1f23" />
    </svg>
  )
}

/** Renders the logos from the geocoder's attribution HTML (images only, never raw HTML). */
function GoogleAttribution({ html }: { html: string[] }) {
  const images = useMemo(() => {
    const parser = new DOMParser()
    return html
      .flatMap((h) => [...parser.parseFromString(h, 'text/html').querySelectorAll('img')])
      .map((img) => ({ src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '' }))
      .filter((img) => img.src.startsWith('https://'))
  }, [html])
  if (!images.length) return null
  return (
    <>
      {images.map((img) => (
        <img key={img.src} src={img.src} alt={img.alt} height={16} />
      ))}
    </>
  )
}
