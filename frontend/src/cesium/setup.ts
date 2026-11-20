// Must be imported before anything that imports 'cesium'.
// Tells Cesium where vite-plugin-static-copy put its Workers/Assets/Widgets.
declare global {
  interface Window {
    CESIUM_BASE_URL: string
  }
}

window.CESIUM_BASE_URL = '/cesium/'

export {}
