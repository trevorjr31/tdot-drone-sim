import { useState } from 'react'
import type { FlyToTarget } from '../drone/droneView'
import type { BridgeStatus, GeofenceStatus, Px4Command, Px4CommandParams } from '../drone/px4Bridge'
import type { Mission } from '../drone/useDrone'

type Props = {
  /** Hit a building: flying is over until Reset. */
  crashed: boolean
  onReset: () => void

  /** PX4 via the bridge. */
  px4: {
    status: BridgeStatus
    version: string | null
    url: string
    geofence: GeofenceStatus | null
    /** Command currently waiting for PX4's answer. */
    busy: Px4Command | null
    error: string | null
    onCommand: (action: Px4Command, params?: Px4CommandParams) => void

    // Pre-flight
    mission: Mission
    onFreeFly: () => void
    onPlanRoute: () => void
    onBack: () => void
    routeDest: FlyToTarget | null
    onPickRouteDest: () => void
    onRouteToSearched: () => void
    onStartRoute: (altM: number) => void

    // In flight
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
}

const STATUS_TEXT: Record<BridgeStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting to bridge…',
  'bridge-offline': 'Bridge not running',
  'px4-offline': 'Bridge up, waiting for PX4…',
  connected: 'Connected',
}

/**
 * The drone card. Before a flight: status, geofence and a choice between Free fly
 * (takes off straight away) and Plan a route (pick a destination, then height and
 * Take off). In flight: the controls. After a crash: Reset.
 */
export function DronePanel(props: Props) {
  const [open, setOpen] = useState(true)
  const p = props.px4
  const ready = p.status === 'connected'
  const flying = props.armed || props.inAir || p.busy === 'takeoff'

  let body
  if (props.crashed) body = <CrashBox resetting={p.busy === 'reset'} error={p.error} onReset={props.onReset} />
  else if (flying) body = <FlightControls {...p} />
  else if (p.mission === 'route') body = <RoutePlanner {...p} ready={ready} />
  else body = <ChooseMission {...p} ready={ready} />

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
          <Status {...p} ready={ready} />
          {body}
          {p.error && !props.crashed && (
            <div className="drone-panel__error" role="alert">
              {p.error}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Status(p: Props['px4'] & { ready: boolean }) {
  return (
    <>
      <div className={`drone-panel__status is-${p.status}`}>
        <span className="drone-panel__dot" aria-hidden />
        {STATUS_TEXT[p.status]}
        {p.ready && p.version ? ` · PX4 ${p.version}` : ''}
      </div>
      {p.ready && p.geofence && (
        <div className={`drone-panel__fence${p.geofence.uploaded ? '' : ' is-missing'}`} title={p.geofence.error ?? undefined}>
          {p.geofence.uploaded
            ? `Geofence: City of Toronto boundary · ${p.geofence.ceilingM.toFixed(0)} m ceiling · breach returns home`
            : `No geofence: ${p.geofence.error ?? 'not uploaded'}`}
        </div>
      )}
      {p.status === 'bridge-offline' && (
        <div className="drone-panel__hint">
          Start it with <code>docker compose up -d</code> ({p.url})
        </div>
      )}
    </>
  )
}

/** Step 1: how do you want to fly? */
function ChooseMission(p: Props['px4'] & { ready: boolean }) {
  return (
    <div className="drone-panel__choices">
      <button type="button" className="drone-panel__choice" onClick={p.onFreeFly} disabled={!p.ready || p.busy !== null}>
        <strong>Free fly</strong>
        <span>Take off now and fly with the keyboard</span>
      </button>
      <button type="button" className="drone-panel__choice" onClick={p.onPlanRoute} disabled={!p.ready}>
        <strong>Plan a route</strong>
        <span>Choose a destination, then take off and fly there</span>
      </button>
    </div>
  )
}

/** Plan a route: destination first, then height and Take off. */
function RoutePlanner(p: Props['px4'] & { ready: boolean }) {
  const [altM, setAltM] = useState(30)
  return (
    <>
      <div className="drone-panel__label">
        Plan a route
        <button type="button" className="drone-panel__back" onClick={p.onBack}>
          ← Back
        </button>
      </div>

      <div className="drone-panel__step">Destination</div>
      {p.routeDest ? (
        <div className="drone-panel__dest">
          <span className="btn__ellipsis" title={p.routeDest.label}>
            {p.routeDest.label}
          </span>
          <button type="button" className="btn btn--small" onClick={p.onPickRouteDest} disabled={p.picking}>
            Change
          </button>
        </div>
      ) : null}
      {!p.routeDest && (
        <div className="drone-panel__buttons">
          <button type="button" className="btn" onClick={p.onPickRouteDest} disabled={p.picking}>
            {p.picking ? 'Click the map… (Esc)' : 'Pick on map'}
          </button>
          {p.searchedPlaceTitle && (
            <button type="button" className="btn" onClick={p.onRouteToSearched} disabled={p.picking} title={`Use ${p.searchedPlaceTitle}`}>
              <span className="btn__ellipsis">{p.searchedPlaceTitle}</span>
            </button>
          )}
        </div>
      )}
      {!p.routeDest && !p.searchedPlaceTitle && <div className="drone-panel__hint">Or search for a place, then choose it here.</div>}

      {p.routeDest && (
        <>
          <div className="drone-panel__step">Height</div>
          <div className="drone-panel__buttons">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!p.ready || p.busy !== null}
              onClick={() => p.onStartRoute(altM)}
            >
              {p.busy === 'takeoff' ? 'Taking off…' : 'Take off'}
            </button>
            <label className="drone-panel__alt" title="Height above the launch point to fly at">
              <input
                type="number"
                min={2}
                max={120}
                step={5}
                value={altM}
                onChange={(e) => setAltM(Math.max(2, Math.min(120, Number(e.target.value) || 30)))}
                aria-label="Flight height in metres"
              />
              m
            </label>
          </div>
        </>
      )}
    </>
  )
}

/** In flight: stop/return/land, fly-to, keyboard. */
function FlightControls(p: Props['px4']) {
  const busy = p.busy !== null
  return (
    <>
      <div className="drone-panel__buttons">
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={() => p.onCommand('hold')}>
          Hold
        </button>
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={() => p.onCommand('rtl')}>
          Return
        </button>
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={() => p.onCommand('land')}>
          Land
        </button>
      </div>

      {p.busy === 'takeoff' || (!p.canFly && !p.target) ? (
        <div className="drone-panel__hint">Taking off… the controls unlock once airborne.</div>
      ) : null}

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
        p.canFly && (
          <>
            <div className="drone-panel__label">Fly to</div>
            <div className="drone-panel__buttons">
              <button type="button" className="btn" onClick={p.onPickAndFly} disabled={p.picking || busy}>
                {p.picking ? 'Click the map… (Esc)' : 'Pick on map'}
              </button>
              {p.searchedPlaceTitle && (
                <button type="button" className="btn" onClick={p.onFlyToSearched} disabled={p.picking || busy} title={`Fly to ${p.searchedPlaceTitle}`}>
                  <span className="btn__ellipsis">{p.searchedPlaceTitle}</span>
                </button>
              )}
            </div>
          </>
        )
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
  )
}

function CrashBox({ resetting, error, onReset }: { resetting: boolean; error: string | null; onReset: () => void }) {
  return (
    <div className="drone-panel__crash" role="alert">
      <strong>Crashed into a building</strong>
      <span>Motors cut. Reset restarts PX4 with the drone back at home (takes a few seconds).</span>
      <button type="button" className="btn btn--primary" onClick={onReset} disabled={resetting}>
        {resetting ? 'Resetting…' : 'Reset drone'}
      </button>
      {error && <span className="drone-panel__crash-error">{error}</span>}
    </div>
  )
}
