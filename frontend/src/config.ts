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
