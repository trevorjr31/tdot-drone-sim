import { CesiumViewer } from './components/CesiumViewer'
import { config } from './config'

function App() {
  return (
    <>
      <CesiumViewer />
      {!config.cesiumIonToken && (
        <div className="banner">
          No Cesium ion token found. Using OpenStreetMap imagery. Add <code>VITE_CESIUM_ION_TOKEN</code> to{' '}
          <code>frontend/.env.local</code> and restart the dev server.
        </div>
      )}
    </>
  )
}

export default App
