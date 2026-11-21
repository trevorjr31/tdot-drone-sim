import { TORONTO_HOME } from '../config'
import type { Place } from './types'

/**
 * Quick-jump places shown when the search box is empty.
 *
 * Two kinds:
 *  - `query`: looked up with the Google geocoder the first time it's used, then
 *    cached in this browser. Change a place by changing its text.
 *    Be specific: a bare name can resolve to a district, not the landmark
 *    ("Casa Loma" → the Casa Loma area, ~500 m from the castle; "Casa Loma castle"
 *    → 1 Austin Terrace). Check new entries land where you expect.
 *  - `place`: a fixed camera view (for views that aren't "an address").
 */
export type Preset =
  | { name: string; query: string; view?: Place['view'] }
  | { name: string; place: Place }

export const PRESETS: Preset[] = [
  {
    name: 'Downtown',
    place: {
      id: 'preset:downtown',
      kind: 'preset',
      title: 'Downtown',
      subtitle: 'Skyline from the harbour',
      target: { type: 'point', lon: TORONTO_HOME.longitude, lat: TORONTO_HOME.latitude },
      camera: {
        lon: TORONTO_HOME.longitude,
        lat: TORONTO_HOME.latitude,
        height: TORONTO_HOME.height,
        headingDeg: TORONTO_HOME.headingDeg,
        pitchDeg: TORONTO_HOME.pitchDeg,
      },
    },
  },
  { name: 'CN Tower', query: 'CN Tower', view: { headingDeg: 20, pitchDeg: -20, rangeM: 900 } },
  { name: 'Financial District', query: 'King St W & Bay St', view: { headingDeg: 200, pitchDeg: -25, rangeM: 700 } },
  { name: 'Billy Bishop Airport', query: 'Billy Bishop Toronto City Airport', view: { headingDeg: 340, pitchDeg: -30, rangeM: 2200 } },
  { name: 'Toronto Islands', query: 'Centre Island', view: { headingDeg: 10, pitchDeg: -20, rangeM: 3000 } },
  { name: 'Casa Loma', query: 'Casa Loma castle' },
  { name: 'Yonge & Eglinton', query: 'Yonge St & Eglinton Ave' },
  { name: 'North York Centre', query: 'Mel Lastman Square' },
  { name: 'High Park', query: 'High Park' },
  { name: 'Scarborough Bluffs', query: 'Scarborough Bluffs' },
  {
    name: 'Whole city',
    place: {
      id: 'preset:city',
      kind: 'preset',
      title: 'Whole city',
      subtitle: 'City of Toronto from above',
      target: { type: 'area', west: -79.6393, south: 43.581, east: -79.1152, north: 43.8555 },
      view: { headingDeg: 0, pitchDeg: -55, rangeM: 42000 },
    },
  },
]
