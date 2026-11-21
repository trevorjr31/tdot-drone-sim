export const config = {
  cesiumIonToken: import.meta.env.VITE_CESIUM_ION_TOKEN?.trim() || '',
  googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() || '',
}

// Downtown Toronto: camera sits over the lake, south of the CN Tower, looking north.
export const TORONTO_HOME = {
  longitude: -79.3871,
  latitude: 43.622,
  height: 1200, // metres
  headingDeg: 0,
  pitchDeg: -25,
}

/**
 * City of Toronto elevations are metres above sea level; Cesium (and Google's
 * tiles) use height above the WGS84 ellipsoid: ellipsoid height = sea-level height + this.
 *
 * Measured, not assumed: sampling Google 3D Tiles roofs over 200 low/mid-rise
 * buildings in 5 tiles across the city gave a median of -37.2 m (spread about ±1 m).
 */
export const TORONTO_GEOID_OFFSET_M = -37.2
