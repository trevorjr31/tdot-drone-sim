import { useState } from 'react'
import { CesiumViewer, type TilesStatus } from './components/CesiumViewer'

function App() {
  const [status, setStatus] = useState<TilesStatus | null>(null)

  return (
    <>
      <CesiumViewer onTilesStatus={setStatus} />
      {status?.state === 'loading' && <div className="banner banner-info">Loading 3D Toronto…</div>}
      {status?.state === 'error' && (
        <div className="banner">
          Couldn't load photorealistic 3D tiles{status.source ? ` (via ${status.source})` : ''}: {status.message}
          <br />
          Check <code>VITE_CESIUM_ION_TOKEN</code> / <code>VITE_GOOGLE_MAPS_API_KEY</code> in{' '}
          <code>frontend/.env.local</code> and restart the dev server.
        </div>
      )}
    </>
  )
}

export default App
