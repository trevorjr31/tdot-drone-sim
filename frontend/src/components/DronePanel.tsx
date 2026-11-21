import { useState } from 'react'
import { CAMERA_MODES, type CameraMode } from '../drone/types'

type Props = {
  sourceName: string
  /** Demo flight state. */
  running: boolean
  finished: boolean
  inAir: boolean
  onStart: () => void
  onPause: () => void
  onReset: () => void
  cameraMode: CameraMode
  onCameraMode: (mode: CameraMode) => void
  trailVisible: boolean
  onTrailVisible: (show: boolean) => void
}

export function DronePanel(props: Props) {
  const [open, setOpen] = useState(true)
  const { running, finished, inAir } = props
  const startLabel = finished ? 'Fly again' : running ? 'Flying…' : inAir ? 'Resume' : 'Start flight'

  return (
    <section className={`layer-panel drone-panel${open ? '' : ' is-collapsed'}`} aria-label="Drone">
      <button type="button" className="layer-panel__header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>Drone</span>
        <span className="layer-panel__chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="drone-panel__body">
          <div className="drone-panel__source">{props.sourceName}</div>

          <div className="drone-panel__buttons">
            <button type="button" className="btn btn--primary" onClick={props.onStart} disabled={running}>
              {startLabel}
            </button>
            <button type="button" className="btn" onClick={props.onPause} disabled={!running}>
              Pause
            </button>
            <button type="button" className="btn" onClick={props.onReset} disabled={!running && !inAir && !finished}>
              Reset
            </button>
          </div>

          <div className="drone-panel__label">
            Camera <kbd className="layer-row__key">C</kbd>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Camera">
            {CAMERA_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={props.cameraMode === m.id}
                className={`segmented__option${props.cameraMode === m.id ? ' is-active' : ''}`}
                title={m.hint}
                onClick={() => props.onCameraMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="layer-row drone-panel__trail">
            <input type="checkbox" checked={props.trailVisible} onChange={(e) => props.onTrailVisible(e.target.checked)} />
            <span className="layer-row__swatch" style={{ background: '#ffd166' }} aria-hidden />
            <span className="layer-row__label">Flight trail</span>
          </label>
        </div>
      )}
    </section>
  )
}
