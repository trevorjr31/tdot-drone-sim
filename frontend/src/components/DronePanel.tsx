import { useEffect, useState, type ReactNode } from 'react'
import type { FlyToTarget } from '../drone/droneView'
import { BATTERY_CRITICAL, BATTERY_EMERGENCY, formatMinutes, type BatteryInfo } from '../drone/battery'
import type { BridgeStatus, GeofenceStatus, Px4Command, Px4CommandParams } from '../drone/px4Bridge'
import { formatDistance, formatDuration, ROUTE_MAX_STOPS, type RouteEstimate } from '../drone/routePlan'
import {
  crossingAltM,
  RETURN_MAX_ALT_M,
  ROUTE_MAX_ALT_M,
  routeProblem,
  type Mission,
  type ReturnPlan,
  type RouteCheckInfo,
  type RouteProgress,
} from '../drone/useDrone'

type Props = {
  /** Search box shown in Plan a route, under Pick on map (picking a result adds it as a stop). */
  routeSearch: ReactNode
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
    /** The route being planned: its stops, in order (the last is the destination). */
    routeStops: FlyToTarget[]
    /** Add a stop by clicking the map. */
    onPickRouteStop: () => void
    onRemoveStop: (i: number) => void
    onMoveStopUp: (i: number) => void
    /** The planner's chosen height changed (for the estimate and the route preview on the map). */
    onPlanAltM: (altM: number) => void
    onStartRoute: (altM: number) => void
    /** How far and how long the route being planned is. */
    routeEstimate: RouteEstimate | null
    /** Where the autopilot is in a planned route. */
    routeProgress: RouteProgress | null
    /** Buildings along the route (while planning). */
    routeCheck: RouteCheckInfo | null
    /** The building directly below the drone, if any (for the landing warning). */
    overBuilding: { name: string | null; heightM: number } | null
    /** Return home's height, kept clear of buildings; `safe` false when no straight return clears them. */
    returnPlan: ReturnPlan | null
    /** Battery level and minutes left, while flying. */
    battery: BatteryInfo | null
    /** The autopilot is flying a planned route. */
    autopilot: boolean
    onTakeOver: () => void

    // In flight
    /** Connected and airborne: keyboard flying and fly-to are available. */
    canFly: boolean
    /** A flight key is held right now. */
    keysActive: boolean
    target: FlyToTarget | null
    /** Waiting for a click on the map. */
    picking: boolean
  }

  inAir: boolean
  armed: boolean
  /** Height above home, for the in-flight route planner's default. */
  relAltM: number | null
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
  // Free fly / autopilot chosen: stay on that screen from the moment take-off is sent,
  // not only once telemetry reports the drone armed (that lags PX4's answer by a second or two).
  else if (p.autopilot) body = <Autopilot {...p} />
  else if (p.mission === 'route')
    body = (
      <RoutePlanner
        {...p}
        ready={ready}
        search={props.routeSearch}
        airborne={props.inAir}
        initialAltM={props.inAir && props.relAltM !== null ? props.relAltM : 30}
        currentAltM={props.inAir ? props.relAltM : null}
      />
    )
  else if (flying || p.mission === 'free') body = <FlightControls {...p} />
  else body = <ChooseMission {...p} ready={ready} />

  return (
    <section className={`layer-panel drone-panel${open ? '' : ' is-collapsed'}`} aria-label="Drone">
      <button
        type="button"
        className="layer-panel__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Drone: ${STATUS_TEXT[p.status]}. ${open ? 'Hide' : 'Show'} the drone controls`}
      >
        <span className={`drone-panel__status is-${p.status}`}>
          <span className="drone-panel__dot" aria-hidden />
          {STATUS_TEXT[p.status]}
          {ready && p.version ? ` · PX4 ${p.version}` : ''}
        </span>
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
      {/* The geofence details are in Settings; only a missing fence is worth flagging here. */}
      {p.ready && p.geofence && !p.geofence.uploaded && (
        <div className="drone-panel__fence is-missing" title={p.geofence.error ?? undefined}>
          No geofence: {p.geofence.error ?? 'not uploaded'}
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

/**
 * Plan a route: destination first, then height and Take off. Also opened in the air from
 * the manual controls, where the button is Fly there and Back returns to the controls.
 */
function RoutePlanner(
  p: Props['px4'] & { ready: boolean; search: ReactNode; airborne: boolean; initialAltM: number; currentAltM: number | null },
) {
  const [altM, setAltM] = useState(() => Math.max(5, Math.min(120, Math.round(p.initialAltM))))
  const { onPlanAltM } = p
  useEffect(() => onPlanAltM(altM), [altM, onPlanAltM])
  return (
    <>
      <div className="drone-panel__label">
        Plan a route
        <button type="button" className="drone-panel__back" onClick={p.onBack}>
          ← Back
        </button>
      </div>

      <div className="drone-panel__step">{p.routeStops.length > 1 ? 'Stops' : 'Destination'}</div>
      {p.routeStops.length > 0 && (
        <ol className="drone-panel__stops">
          {p.routeStops.map((stop, i) => (
            <li key={`${i}:${stop.lat},${stop.lon}`} className="drone-panel__dest">
              {p.routeStops.length > 1 && <span className="drone-panel__stop-num">{i + 1}</span>}
              <span className="drone-panel__stop-name" title={stop.label}>
                <span className="btn__ellipsis">{stop.label}</span>
                {stop.building && <span className="drone-panel__stop-tag">Building · {stop.building.heightM} m</span>}
              </span>
              {i > 0 && (
                <button type="button" className="btn btn--small" onClick={() => p.onMoveStopUp(i)} aria-label={`Move ${stop.label} earlier`} title="Move earlier">
                  ↑
                </button>
              )}
              <button type="button" className="btn btn--small" onClick={() => p.onRemoveStop(i)} aria-label={`Remove ${stop.label}`} title="Remove">
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      {p.routeStops.length < ROUTE_MAX_STOPS && (
        <>
          {p.routeStops.length > 0 && <div className="drone-panel__or">Add a stop</div>}
          <div className="drone-panel__buttons">
            <button type="button" className="btn" onClick={p.onPickRouteStop} disabled={p.picking}>
              {p.picking ? 'Click the map… (Esc)' : 'Pick on map'}
            </button>
          </div>
          <div className="drone-panel__or">or search</div>
          {p.search}
        </>
      )}

      {p.routeStops.length > 0 && (
        <>
          <div className="drone-panel__step">Height</div>
          <label className="drone-panel__alt" title="Height above the launch point to fly at">
            <input
              type="number"
              min={p.airborne ? 5 : 2}
              max={120}
              step={5}
              value={altM}
              onChange={(e) => setAltM(Math.max(2, Math.min(120, Number(e.target.value) || 30)))}
              aria-label="Flight height in metres"
            />
            m above {p.airborne ? 'home' : 'the launch point'}
          </label>
          <RouteCheck check={p.routeCheck} altM={altM} currentAltM={p.currentAltM} onUse={setAltM} stops={p.routeStops.length} />
          {!tooHigh(p.routeCheck) && <RouteSummary estimate={p.routeEstimate} battery={p.battery} stops={p.routeStops.length} />}
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={!p.ready || p.busy !== null || routeBlocked(p.routeCheck, altM)}
            onClick={() => p.onStartRoute(altM)}
          >
            {p.airborne ? 'Fly there' : p.busy === 'takeoff' ? 'Taking off…' : 'Take off'}
          </button>
        </>
      )}
    </>
  )
}

/** Manual flight (free fly, or after taking over from the autopilot): stop/return/land and keyboard. */
function FlightControls(p: Props['px4']) {
  const busy = p.busy !== null
  const [confirmLand, setConfirmLand] = useState(false)
  const below = confirmLand ? p.overBuilding : null
  const land = () => (p.overBuilding ? setConfirmLand(true) : p.onCommand('land'))
  return (
    <>
      <div className="drone-panel__buttons">
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={() => p.onCommand('hold')}>
          Hold
        </button>
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={() => p.onCommand('rtl')}>
          Return
        </button>
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={land}>
          Land
        </button>
      </div>

      <BatteryWarning battery={p.battery} />
      <ReturnWarning plan={p.returnPlan} />

      {below && (
        <div className="drone-panel__check is-bad" role="alert">
          <span>
            Over <strong>{below.name ?? 'a building'}</strong> ({below.heightM} m tall). PX4 lands straight down and
            doesn't know the building is there, so the drone would crash onto the roof.
          </span>
          <div className="drone-panel__buttons">
            <button type="button" className="btn" onClick={() => (setConfirmLand(false), p.onCommand('rtl'))}>
              Return home
            </button>
            <button type="button" className="btn" onClick={() => (setConfirmLand(false), p.onCommand('land'))}>
              Land anyway
            </button>
            <button type="button" className="btn" onClick={() => setConfirmLand(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(p.busy === 'takeoff' || !p.canFly) && (
        <div className="drone-panel__hint">Taking off… the controls unlock once airborne.</div>
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

      <button type="button" className="btn btn--block" disabled={!p.canFly} onClick={p.onPlanRoute}>
        Plan a route
      </button>
    </>
  )
}

/** Planned route in flight: the autopilot flies; the only option is to take over. */
function Autopilot(p: Props['px4']) {
  const r = p.routeProgress
  const stop = r ? (
    <>
      {r.stopCount > 1 && `stop ${r.stopIndex + 1} of ${r.stopCount}, `}
      <strong>{r.stopLabel}</strong>
    </>
  ) : (
    <strong>the destination</strong>
  )
  const h = r ? `${Math.round(r.heightM)} m` : 'height'
  const status = !r ? (
    <>Flying…</>
  ) : r.phase === 'climbing' ? (
    <>Climbing to {h}, then flying to {stop}…</>
  ) : r.phase === 'flying' ? (
    <>Flying to {stop}…</>
  ) : r.phase === 'descending' ? (
    r.finalDescent ? (
      <>Descending to {h} over {stop}…</>
    ) : (
      <>Descending to {h}, then flying to {stop}…</>
    )
  ) : (
    <>Arrived at {stop}</>
  )
  return (
    <>
      <div className="drone-panel__label">Autopilot</div>
      <div className="drone-panel__flying">
        <span>{status}</span>
      </div>
      {r?.remaining && (
        <div className="drone-panel__hint">
          {formatDistance(r.remaining.distanceM)} to go · about {formatDuration(r.remaining.timeS)}
        </div>
      )}
      <BatteryWarning battery={p.battery} />
      <ReturnWarning plan={p.returnPlan} />
      <button type="button" className="btn btn--primary btn--block" onClick={p.onTakeOver} disabled={p.busy === 'hold'}>
        Take over controls
      </button>
      <div className="drone-panel__hint">Stops the autopilot (the drone holds where it is) and gives you the controls.</div>
    </>
  )
}

/** Low battery: what PX4 will do (or is doing) about it, and how long until it does. */
function BatteryWarning({ battery: b }: { battery: BatteryInfo | null }) {
  if (!b || b.level === 'ok') return null
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (b.level === 'emergency')
    return (
      <div className="drone-panel__check is-bad" role="alert">
        <strong>Battery empty:</strong> PX4 is landing where it is.
      </div>
    )
  if (b.level === 'critical')
    return (
      <div className="drone-panel__check is-bad" role="alert">
        <strong>Battery critical:</strong> PX4 is flying home.{' '}
        {b.minToLand !== null && <>At {pct(BATTERY_EMERGENCY)} ({formatMinutes(b.minToLand)}) it lands wherever it is.</>}
      </div>
    )
  return (
    <div className="drone-panel__check is-warn" role="alert">
      <strong>Battery low:</strong> head home soon. At {pct(BATTERY_CRITICAL)}
      {b.minToReturn !== null && <> ({formatMinutes(b.minToReturn)})</>} PX4 flies home on its own.
    </div>
  )
}

/** Shown in flight when Return home can't clear the buildings between the drone and home. */
function ReturnWarning({ plan }: { plan: ReturnPlan | null }) {
  if (!plan || plan.safe || !plan.highest) return null
  return (
    <div className="drone-panel__check is-bad" role="alert">
      No safe return from here: <strong>{plan.highest.name ?? 'a building'}</strong> ({plan.highest.heightM} m) is in the way
      home, too tall to clear under {RETURN_MAX_ALT_M} m. Move away from it before Return (or a geofence return).
    </div>
  )
}

/** The route can't be flown at any height under the ceiling (no point estimating it). */
function tooHigh(c: RouteCheckInfo | null): boolean {
  return c?.status === 'done' && c.minSafeRelAltM > ROUTE_MAX_ALT_M
}

/** Whether the route's height is unsafe (or still being checked). */
function routeBlocked(c: RouteCheckInfo | null, altM: number): boolean {
  if (c?.status === 'checking') return true
  return c?.status === 'done' && routeProblem(c, altM) !== null
}

/** The buildings along the route vs the chosen height. */
function RouteCheck({
  check: c,
  altM,
  currentAltM,
  onUse,
  stops,
}: {
  check: RouteCheckInfo | null
  altM: number
  currentAltM: number | null
  onUse: (m: number) => void
  /** Number of stops (the text differs for a multi-stop route). */
  stops: number
}) {
  if (!c) return null
  if (c.status === 'checking') return <div className="drone-panel__hint">Checking the buildings along the route…</div>
  if (c.status === 'error')
    return <div className="drone-panel__check is-warn">Couldn't check the buildings on the route. Fly high to be safe.</div>
  if (!c.highest) return <div className="drone-panel__check is-ok">No buildings on the way.</div>
  const name = (b: { name: string | null; heightM: number }) => (
    <>
      <strong>{b.name ?? 'a building'}</strong>, {b.heightM} m tall
    </>
  )
  const what = name(c.highest)
  const problem = routeProblem(c, altM)
  if (problem?.kind === 'ceiling')
    return (
      <div className="drone-panel__check is-bad">
        The route passes {what}: too tall to clear under the {ROUTE_MAX_ALT_M} m ceiling. Choose another destination.
      </div>
    )
  if (problem)
    return (
      <div className="drone-panel__check is-bad">
        <span>
          Too low for the destination: {name(c.destHighest!)} is there. End at {problem.needM} m or higher.
        </span>
        <button type="button" className="btn btn--small" onClick={() => onUse(problem.needM)}>
          Use {problem.needM} m
        </button>
      </div>
    )
  const cross = Math.round(crossingAltM(altM, currentAltM, c.minSafeRelAltM))
  if (cross > altM + 2)
    return (
      <div className="drone-panel__check is-ok">
        {stops > 1 ? (
          <>
            Flies as high as {cross} m to clear {what}, and ends at {altM} m over the last stop.
          </>
        ) : (
          <>
            Crosses at {cross} m to clear {what}, then descends to {altM} m over the destination.
          </>
        )}
      </div>
    )
  return (
    <div className="drone-panel__check is-ok">
      Clears the tallest building on the way: {what} (needs {c.minSafeRelAltM} m).
    </div>
  )
}

/** The planned route's length and flight time, and whether the battery lasts that long. */
function RouteSummary({ estimate: e, battery, stops }: { estimate: RouteEstimate | null; battery: BatteryInfo | null; stops: number }) {
  if (!e) return null
  const short = battery?.minToReturn != null && e.timeS / 60 > battery.minToReturn
  return (
    <>
      <div className="drone-panel__summary" aria-label="Route estimate">
        <span>
          <strong>{formatDistance(e.distanceM)}</strong> {stops > 1 ? `· ${stops} stops` : ''}
        </span>
        <span>
          about <strong>{formatDuration(e.timeS)}</strong>
        </span>
      </div>
      {short && (
        <div className="drone-panel__check is-warn">
          Not enough battery: PX4 will turn for home in {formatMinutes(battery!.minToReturn!)}, before this route ends.
        </div>
      )}
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
