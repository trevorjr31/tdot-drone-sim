import { useState } from 'react'
import type { FlyToTarget } from '../drone/droneView'
import type { BridgeStatus, Px4Command, Px4CommandParams } from '../drone/px4Bridge'
import { CAMERA_MODES, type CameraMode } from '../drone/types'

export type SourceId = 'demo' | 'px4'

type Props = {
  source: SourceId
  onSource: (source: SourceId) => void

  /** Demo flight. */
  demo: {
    running: boolean
    finished: boolean
    onStart: () => void
    onPause: () => void
    onReset: () => void
  }

  /** PX4 via the bridge. */
  px4: {
    status: BridgeStatus
    version: string | null
    url: string
    /** Command currently waiting for PX4's answer. */
    busy: Px4Command | null
    error: string | null
    onCommand: (action: Px4Command, params?: Px4CommandParams) => void
    /** Connected and airborne: keyboard flying and fly-to are available. */
    canFly: boolean
    /** A flight key is held right now. */
    keysActive: boolean
    target: FlyToTarget | null
    /** Waiting for a click on the map. */
    picking: boolean
    searchedPlaceTitle: string | null
    onPickAndFly: () => void
    onFlyToSearched: () => void
  }

  inAir: boolean
  armed: boolean
  cameraMode: CameraMode
  onCameraMode: (mode: CameraMode) => void
  trailVisible: boolean
  onTrailVisible: (show: boolean) => void
}

const STATUS_TEXT: Record<BridgeStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting to bridge…',
  'bridge-offline': 'Bridge not running',
  'px4-offline': 'Bridge up, waiting for PX4…',
  connected: 'Connected',
}

export function DronePanel(props: Props) {
  const [open, setOpen] = useState(true)
  const [takeoffAlt, setTakeoffAlt] = useState(30)

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
          <div className="segmented" role="radiogroup" aria-label="Drone source">
            {(
              [
                ['demo', 'Demo flight'],
                ['px4', 'PX4 (live)'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={props.source === id}
                className={`segmented__option${props.source === id ? ' is-active' : ''}`}
                onClick={() => props.onSource(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {props.source === 'demo' ? <DemoControls {...props.demo} inAir={props.inAir} /> : <Px4Controls {...props.px4} inAir={props.inAir} armed={props.armed} takeoffAlt={takeoffAlt} onTakeoffAlt={setTakeoffAlt} />}

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

function DemoControls({ running, finished, inAir, onStart, onPause, onReset }: Props['demo'] & { inAir: boolean }) {
  const startLabel = finished ? 'Fly again' : running ? 'Flying…' : inAir ? 'Resume' : 'Start flight'
  return (
    <>
      <div className="drone-panel__source">Scripted route along Queen St W (no PX4 needed)</div>
      <div className="drone-panel__buttons">
        <button type="button" className="btn btn--primary" onClick={onStart} disabled={running}>
          {startLabel}
        </button>
        <button type="button" className="btn" onClick={onPause} disabled={!running}>
          Pause
        </button>
        <button type="button" className="btn" onClick={onReset} disabled={!running && !inAir && !finished}>
          Reset
        </button>
      </div>
    </>
  )
}

function Px4Controls(p: Props['px4'] & { inAir: boolean; armed: boolean; takeoffAlt: number; onTakeoffAlt: (m: number) => void }) {
  const ready = p.status === 'connected'
  const busy = p.busy !== null
  return (
    <>
      <div className={`drone-panel__status is-${p.status}`}>
        <span className="drone-panel__dot" aria-hidden />
        {STATUS_TEXT[p.status]}
        {ready && p.version ? ` · PX4 ${p.version}` : ''}
      </div>
      {p.status === 'bridge-offline' && (
        <div className="drone-panel__hint">
          Start it with <code>docker compose up -d</code> ({p.url})
        </div>
      )}

      <div className="drone-panel__buttons">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!ready || busy || p.inAir}
          onClick={() => p.onCommand('takeoff', { altitudeM: p.takeoffAlt })}
        >
          {p.busy === 'takeoff' ? 'Taking off…' : 'Take off'}
        </button>
        <label className="drone-panel__alt" title="Takeoff height above the launch point">
          <input
            type="number"
            min={2}
            max={120}
            step={5}
            value={p.takeoffAlt}
            onChange={(e) => p.onTakeoffAlt(Math.max(2, Math.min(120, Number(e.target.value) || 30)))}
            aria-label="Takeoff height in metres"
          />
          m
        </label>
      </div>
      <div className="drone-panel__buttons">
        <button type="button" className="btn" disabled={!ready || busy || !p.inAir} onClick={() => p.onCommand('hold')}>
          Hold
        </button>
        <button type="button" className="btn" disabled={!ready || busy || !p.inAir} onClick={() => p.onCommand('rtl')}>
          Return
        </button>
        <button type="button" className="btn" disabled={!ready || busy || !p.inAir} onClick={() => p.onCommand('land')}>
          Land
        </button>
      </div>
      {p.canFly && (
        <>
          <div className="drone-panel__label">Fly to</div>
          {p.target ? (
            <div className="drone-panel__flying">
              <span>
                Flying to <strong>{p.target.label}</strong>…
              </span>
              <button type="button" className="btn btn--small" onClick={() => p.onCommand('hold')}>
                Stop
              </button>
            </div>
          ) : (
            <div className="drone-panel__buttons">
              <button type="button" className="btn" onClick={p.onPickAndFly} disabled={p.picking || p.busy !== null}>
                {p.picking ? 'Click the map… (Esc)' : 'Pick on map'}
              </button>
              {p.searchedPlaceTitle && (
                <button
                  type="button"
                  className="btn"
                  onClick={p.onFlyToSearched}
                  disabled={p.picking || p.busy !== null}
                  title={`Fly to ${p.searchedPlaceTitle}`}
                >
                  <span className="btn__ellipsis">{p.searchedPlaceTitle}</span>
                </button>
              )}
            </div>
          )}

          <div className={`drone-panel__keys${p.keysActive ? ' is-active' : ''}`} aria-label="Keyboard flying">
            <div className="drone-panel__label">Keyboard {p.keysActive ? '· flying' : ''}</div>
            <dl>
              <dt>
                <kbd>W</kbd>
                <kbd>S</kbd>
              </dt>
              <dd>forward / back</dd>
              <dt>
                <kbd>A</kbd>
                <kbd>D</kbd>
              </dt>
              <dd>slide left / right</dd>
              <dt>
                <kbd>←</kbd>
                <kbd>→</kbd>
              </dt>
              <dd>turn</dd>
              <dt>
                <kbd>Space</kbd>
                <kbd>Shift</kbd>
              </dt>
              <dd>up / down</dd>
            </dl>
            <div className="drone-panel__hint">Let go to hover. Idle for 3 s hands back to Hold.</div>
          </div>
        </>
      )}

      {p.error && (
        <div className="drone-panel__error" role="alert">
          {p.error}
        </div>
      )}
    </>
  )
}
