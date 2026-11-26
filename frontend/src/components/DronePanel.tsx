import { useEffect, useState, type ReactNode } from 'react'
import type { FlyToTarget } from '../drone/droneView'
import { formatMinutes, type BatteryInfo } from '../drone/battery'
import type { SimConfig } from '../drone/simConfig'
import type { BridgeStatus, GeofenceStatus, Px4Command, Px4CommandParams } from '../drone/px4Bridge'
import { formatDistance, formatDuration, ROUTE_MAX_STOPS, type RouteEnding, type RouteEstimate } from '../drone/routePlan'
import {
  crossingAltM,
  routeProblem,
  type ComposeStatus,
  type Mission,
  type ReturnPlan,
  type RouteBattery,
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
    /** The bridge can plan routes described in words (Claude): show the box. */
    ai: boolean
    compose: ComposeStatus
    /** A height the described route asked for (the planner switches to it; `id` changes each time). */
    composedAltM: { altM: number; id: number } | null
    onComposeRoute: (text: string) => void
    onComposeClear: () => void
    /** After the last stop: hover there, land there, or come home. */
    routeEnding: RouteEnding
    onRouteEnding: (ending: RouteEnding) => void
    /** Add a stop by clicking the map. */
    onPickRouteStop: () => void
    onRemoveStop: (i: number) => void
    onMoveStopUp: (i: number) => void
    /** The planner's chosen height changed (for the estimate and the route preview on the map). */
    onPlanAltM: (altM: number) => void
    onStartRoute: (altM: number) => void
    /** How far and how long the route being planned is. */
    routeEstimate: RouteEstimate | null
    /** Its battery: the route plus the flight home, and whether that's enough. */
    routeBattery: RouteBattery | null
    /** Geofence height ceiling above home (from the sim config). */
    ceilingM: number
    /** The simulated drone's settings (battery levels and what PX4 does at them). */
    simConfig: SimConfig
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
    /** Fly home on autopilot, round tall buildings, then land (the Return button). */
    onReturnHome: () => void

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
  // A described route asked for a height ("at 50 m"): use it.
  const [composedAltId, setComposedAltId] = useState(p.composedAltM?.id ?? 0)
  if (p.composedAltM && p.composedAltM.id !== composedAltId) {
    setComposedAltId(p.composedAltM.id)
    setAltM(Math.round(p.composedAltM.altM))
  }
  return (
    <>
      <div className="drone-panel__label">
        Plan a route
        <button type="button" className="drone-panel__back" onClick={p.onBack}>
          ← Back
        </button>
      </div>

      {p.ai && <ComposeBox status={p.compose} onCompose={p.onComposeRoute} onClear={p.onComposeClear} />}

      <div className="drone-panel__step">{p.routeStops.length > 1 ? 'Stops' : 'Destination'}</div>
      {p.routeStops.length > 0 && (
        <ol className="drone-panel__stops">
          {p.routeStops.map((stop, i) => (
            <li key={`${i}:${stop.lat},${stop.lon}`} className="drone-panel__dest">
              {p.routeStops.length > 1 && <span className="drone-panel__stop-num">{i + 1}</span>}
              <span className="drone-panel__stop-name" title={stop.label}>
                <span className="btn__ellipsis">{stop.label}</span>
                {stop.building && <span className="drone-panel__stop-tag">Building · {stop.building.heightM} m</span>}
                {stop.hoverS ? <span className="drone-panel__stop-tag">Hovers {formatDuration(stop.hoverS)}</span> : null}
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
          <RouteCheck
            check={p.routeCheck}
            altM={altM}
            currentAltM={p.currentAltM}
            onUse={setAltM}
            stops={p.routeStops.length}
            ceilingM={p.ceilingM}
          />
          <div className="drone-panel__step">At the end</div>
          <div className="segmented" role="radiogroup" aria-label="After the last stop">
            {(
              [
                ['hover', 'Hover'],
                ['land', 'Land'],
                ['return', 'Come home'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={p.routeEnding === value}
                className={`segmented__option${p.routeEnding === value ? ' is-active' : ''}`}
                onClick={() => p.onRouteEnding(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {p.routeEnding === 'land' && p.routeCheck?.status === 'done' && p.routeCheck.landOn && (
            <div className="drone-panel__check is-bad" role="alert">
              <span>
                The last stop is on {p.routeCheck.landOn.name ?? 'a building'} ({p.routeCheck.landOn.heightM} m): it would land on
                the roof. Choose another last stop, or another ending.
              </span>
            </div>
          )}
          {!tooHigh(p.routeCheck, p.ceilingM) && (
            <RouteSummary estimate={p.routeEstimate} battery={p.routeBattery} stops={p.routeStops.length} />
          )}
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={
              !p.ready ||
              p.busy !== null ||
              routeBlocked(p.routeCheck, altM, p.ceilingM) ||
              p.routeBattery?.ok === false ||
              (p.routeEnding === 'land' && p.routeCheck?.status === 'done' && !!p.routeCheck.landOn)
            }
            onClick={() => p.onStartRoute(altM)}
          >
            {p.airborne ? 'Fly there' : p.busy === 'takeoff' ? 'Taking off…' : 'Take off'}
          </button>
        </>
      )}
    </>
  )
}

const COMPOSE_EXAMPLES = ['go north 100 m, circle 20 m round, then come home', 'fly to the nearest hospital and circle it']

/**
 * Describe your route: the pilot's words go to Claude (through the bridge), which turns
 * them into steps; the planner shows the stops it made, or Claude's questions, or why it
 * couldn't. Replaces the stops already planned.
 */
function ComposeBox({ status, onCompose, onClear }: { status: ComposeStatus; onCompose: (text: string) => void; onClear: () => void }) {
  const [text, setText] = useState(status.state === 'idle' ? '' : status.text)
  const [answer, setAnswer] = useState('')
  const asking = status.state === 'asking'
  const send = () => text.trim() && !asking && onCompose(text.trim())
  const reply = () => {
    if (status.state !== 'questions' || !answer.trim()) return
    // Stateless: the original words, Claude's questions and the answer go together as a new request.
    const full = `${status.text}\n(Asked: ${status.questions.join(' ')} Answer: ${answer.trim()})`
    setText(full)
    setAnswer('')
    onCompose(full)
  }
  return (
    <div className="compose">
      <div className="drone-panel__step">Describe your route</div>
      <textarea
        className="compose__text"
        rows={2}
        maxLength={600}
        value={text}
        placeholder={`e.g. “${COMPOSE_EXAMPLES[0]}”`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        disabled={asking}
        aria-label="Describe your route in words"
      />
      <div className="drone-panel__buttons">
        <button type="button" className="btn" onClick={send} disabled={asking || !text.trim()}>
          {asking ? 'Planning…' : 'Plan it'}
        </button>
        {status.state !== 'idle' && !asking && (
          <button type="button" className="btn btn--small" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {status.state === 'questions' && (
        <div className="compose__questions" role="status">
          {status.questions.map((q) => (
            <p key={q}>{q}</p>
          ))}
          <div className="compose__reply">
            <input
              type="text"
              value={answer}
              placeholder="Your answer"
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && reply()}
              aria-label="Answer Claude's question"
            />
            <button type="button" className="btn btn--small" onClick={reply} disabled={!answer.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
      {status.state === 'error' && (
        <div className="drone-panel__check is-bad" role="alert">
          <span>
            {status.message}
            {status.problems.length > 0 && (
              <ul className="compose__problems">
                {status.problems.map((pr) => (
                  <li key={pr}>{pr}</li>
                ))}
              </ul>
            )}
          </span>
        </div>
      )}
      {status.state === 'done' && (
        <div className="compose__done" role="status">
          {status.summary && <p className="compose__summary">{status.summary}</p>}
          {status.notes.map((n) => (
            <p key={n} className="compose__note">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
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
        <button
          type="button"
          className="btn"
          disabled={busy || !p.canFly}
          onClick={p.onReturnHome}
          title="Fly home round any buildings too tall to cross, then land"
        >
          {p.busy === 'rtl' ? 'Planning…' : 'Return'}
        </button>
        <button type="button" className="btn" disabled={busy || !p.canFly} onClick={land}>
          Land
        </button>
      </div>

      <BatteryWarning battery={p.battery} config={p.simConfig} />
      <ReturnWarning plan={p.returnPlan} />

      {below && (
        <div className="drone-panel__check is-bad" role="alert">
          <span>
            Over <strong>{below.name ?? 'a building'}</strong> ({below.heightM} m tall). PX4 lands straight down and
            doesn't know the building is there, so the drone would crash onto the roof.
          </span>
          <div className="drone-panel__buttons">
            <button type="button" className="btn" onClick={() => (setConfirmLand(false), p.onReturnHome())}>
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
  const round = r?.detour && ', round tall buildings'
  const status = !r ? (
    <>Flying…</>
  ) : r.returning ? (
    r.phase === 'climbing' ? (
      <>Climbing to {h}, then flying home…</>
    ) : r.phase === 'flying' ? (
      <>Flying home{round}…</>
    ) : r.phase === 'descending' ? (
      <>Descending to {h}, then flying home…</>
    ) : r.phase === 'landing' ? (
      <>Landing at home…</>
    ) : (
      <>Home: hovering here (Settings → Simulation: after return)</>
    )
  ) : r.phase === 'hovering' ? (
    <>Hovering at {stop}…</>
  ) : r.phase === 'circling' ? (
    <>Circling {stop} at {h}…</>
  ) : r.phase === 'landing' ? (
    <>Landing at {stop}…</>
  ) : r.phase === 'climbing' ? (
    <>Climbing to {h}, then flying to {stop}…</>
  ) : r.phase === 'flying' ? (
    <>
      Flying to {stop}
      {round}…
    </>
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
      <div className="drone-panel__label">{r?.returning ? 'Returning home' : 'Autopilot'}</div>
      <div className="drone-panel__flying">
        <span>{status}</span>
      </div>
      {r?.remaining && (
        <div className="drone-panel__hint">
          {formatDistance(r.remaining.distanceM)} to go · about {formatDuration(r.remaining.timeS)}
        </div>
      )}
      <BatteryWarning battery={p.battery} config={p.simConfig} />
      {!r?.returning && <ReturnWarning plan={p.returnPlan} />}
      <button type="button" className="btn btn--primary btn--block" onClick={p.onTakeOver} disabled={p.busy === 'hold'}>
        Take over controls
      </button>
      <div className="drone-panel__hint">Stops the autopilot (the drone holds where it is) and gives you the controls.</div>
    </>
  )
}

/** Low battery: what PX4 will do (or is doing) about it, and how long until it does. */
function BatteryWarning({ battery: b, config: c }: { battery: BatteryInfo | null; config: SimConfig }) {
  if (!b || b.level === 'ok') return null
  // What PX4 does at the critical level (Settings → Simulation).
  const act = { return: 'flies home', land: 'lands where it is', warn: "only warns (it won't act)" }[c.lowBatteryAction]
  const acting = { return: 'PX4 is flying home.', land: 'PX4 is landing where it is.', warn: 'Land now: PX4 is set to only warn.' }[
    c.lowBatteryAction
  ]
  if (b.level === 'emergency')
    return (
      <div className="drone-panel__check is-bad" role="alert">
        <strong>Battery empty:</strong>{' '}
        {c.lowBatteryAction === 'warn' ? 'land now, PX4 is set to only warn.' : 'PX4 is landing where it is.'}
      </div>
    )
  if (b.level === 'critical')
    return (
      <div className="drone-panel__check is-bad" role="alert">
        <strong>Battery critical:</strong> {acting}{' '}
        {c.lowBatteryAction === 'return' && b.minToLand !== null && (
          <>
            At {c.batteryEmergencyPct}% ({formatMinutes(b.minToLand)}) it lands wherever it is.
          </>
        )}
      </div>
    )
  return (
    <div className="drone-panel__check is-warn" role="alert">
      <strong>Battery low:</strong> head home soon. At {c.batteryCriticalPct}%
      {b.minToReturn !== null && <> ({formatMinutes(b.minToReturn)})</>} PX4 {act}.
    </div>
  )
}

/** Shown in flight when there's no way home round the buildings under the ceiling. */
function ReturnWarning({ plan }: { plan: ReturnPlan | null }) {
  if (!plan || plan.safe || plan.pathHome !== false || !plan.highest) return null
  return (
    <div className="drone-panel__check is-bad" role="alert">
      No way home round <strong>{plan.highest.name ?? 'a building'}</strong> ({plan.highest.heightM} m) found under the
      ceiling: a return would fly straight at {plan.maxM} m, into it. Move away from it first.
    </div>
  )
}

/** The route can't be flown at any height under the ceiling (no point estimating it). */
function tooHigh(c: RouteCheckInfo | null, ceilingM: number): boolean {
  return c?.status === 'done' && c.minSafeRelAltM > ceilingM
}

/** Whether the route's height is unsafe (or still being checked). */
function routeBlocked(c: RouteCheckInfo | null, altM: number, ceilingM: number): boolean {
  if (c?.status === 'checking') return true
  return c?.status === 'done' && routeProblem(c, altM, ceilingM) !== null
}

/** The buildings along the route vs the chosen height. */
function RouteCheck({
  check: c,
  altM,
  currentAltM,
  onUse,
  stops,
  ceilingM,
}: {
  check: RouteCheckInfo | null
  altM: number
  currentAltM: number | null
  onUse: (m: number) => void
  /** Number of stops (the text differs for a multi-stop route). */
  stops: number
  ceilingM: number
}) {
  if (!c) return null
  if (c.status === 'checking') return <div className="drone-panel__hint">Checking the buildings along the route…</div>
  if (c.status === 'error')
    return <div className="drone-panel__check is-warn">Couldn't check the buildings on the route. Fly high to be safe.</div>
  if (!c.highest && !c.detours.length) return <div className="drone-panel__check is-ok">No buildings on the way.</div>
  const name = (b: { name: string | null; heightM: number }) => (
    <>
      <strong>{b.name ?? 'a building'}</strong>, {b.heightM} m tall
    </>
  )
  const what = c.highest ? name(c.highest) : null
  const problem = routeProblem(c, altM, ceilingM)
  if (problem?.kind === 'ceiling')
    return (
      <div className="drone-panel__check is-bad">
        The route passes {what}: too tall to clear under the {ceilingM} m ceiling. Choose another destination.
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
  const detour = c.detours.length > 0 && (
    <div className="drone-panel__check is-ok">
      {c.detours.length === 1 ? (
        <>
          Goes round <strong>{c.detours[0].around?.name ?? 'a building'}</strong>
          {c.detours[0].around && <>, {c.detours[0].around.heightM} m tall</>}: too tall to fly over under the {ceilingM} m
          ceiling.{' '}
          {c.detours[0].extraM < 10 ? 'The way round is hardly any longer.' : <>The way round adds {formatDistance(c.detours[0].extraM)}.</>}
        </>
      ) : (
        <>
          Goes round {c.detours.length} buildings too tall to fly over under the {ceilingM} m ceiling, adding{' '}
          {formatDistance(c.detours.reduce((t, d) => t + d.extraM, 0))}.
        </>
      )}
    </div>
  )
  if (detour)
    return (
      <>
        {detour}
        <div className="drone-panel__check is-ok">
          Flies as high as {cross} m{c.highest && <> to clear {what}</>}, and ends at {altM} m over the{' '}
          {stops > 1 ? 'last stop' : 'destination'}.
        </div>
      </>
    )
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

/**
 * The planned route's length, flight time and battery: what's left at the last stop and
 * back home after it (PX4's Return). Take off is refused when home would be under the
 * reserve (the critical level, where PX4 acts on its own).
 */
function RouteSummary({ estimate: e, battery: b, stops }: { estimate: RouteEstimate | null; battery: RouteBattery | null; stops: number }) {
  if (!e) return null
  const pct = (x: number) => `${Math.max(0, Math.round(x * 100))}%`
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
      {b && (
        <div
          className={`drone-panel__check ${b.ok ? (b.atHome < b.reserve + 0.1 ? 'is-warn' : 'is-ok') : 'is-bad'}`}
          aria-label="Battery estimate"
        >
          <span>
            Battery {pct(b.now)} → <strong>{pct(b.atEnd)}</strong> at the {stops > 1 ? 'last stop' : 'destination'},{' '}
            <strong>{pct(b.atHome)}</strong> back home ({formatDuration(b.home.timeS)} more).
            {!b.ok && <> Not enough: it must get home with at least {pct(b.reserve)}. Choose fewer or nearer stops.</>}
          </span>
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
