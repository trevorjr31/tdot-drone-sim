import type { HudInfo } from '../drone/droneView'
import type { CollisionInfo } from '../drone/useCollisions'

/** Transport Canada's normal ceiling for drones: 122 m (400 ft) above ground. */
const ALTITUDE_LIMIT_M = 122

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function cardinal(deg: number) {
  return CARDINALS[Math.round(deg / 45) % 8]
}

/**
 * Flight readouts (bottom right). With `showReadouts` off (Settings), only the crash,
 * collision and height-limit warnings appear, when there are any.
 */
export function DroneHud({
  info,
  collision,
  showReadouts = true,
}: {
  info: HudInfo | null
  collision?: CollisionInfo
  showReadouts?: boolean
}) {
  if (!info) return null
  const { state, aglM, distanceFromHomeM } = info
  // The legal limit is height above ground; fall back to height above launch if ground is unknown.
  const heightM = aglM ?? state.relAltM
  const overLimit = state.inAir && heightM > ALTITUDE_LIMIT_M
  const battery = Math.round(state.battery * 100)
  const climb = Math.abs(state.climbRateMs) < 0.05 ? 0 : state.climbRateMs
  const nearest = collision?.available ? collision.nearestM : null
  const crashed = state.flightMode === 'Crashed'
  const showCollision = !crashed && (collision?.warning ?? false)
  if (!showReadouts && !crashed && !showCollision && !overLimit) return null

  return (
    <section className="hud" aria-label="Drone status" aria-live="off">
      {showReadouts && (
        <>
          <div className="hud__status">
            <span className={`hud__mode${state.armed ? ' is-armed' : ''}`}>{state.flightMode}</span>
            <span className="hud__armed">{state.armed ? 'ARMED' : 'DISARMED'}</span>
          </div>

          <div className="hud__grid">
            <Readout label="Height" value={aglM === null ? '—' : aglM.toFixed(0)} unit="m AGL" big warn={overLimit} />
            <Readout label="Altitude" value={state.altAmslM.toFixed(0)} unit="m ASL" />
            <Readout label="Speed" value={(state.groundSpeedMs * 3.6).toFixed(0)} unit="km/h" big />
            <Readout label="Climb" value={`${climb > 0 ? '+' : ''}${climb.toFixed(1)}`} unit="m/s" />
            <Readout label="Heading" value={`${state.headingDeg.toFixed(0)}°`} unit={cardinal(state.headingDeg)} />
            <Readout label="Home" value={distanceFromHomeM < 1000 ? distanceFromHomeM.toFixed(0) : (distanceFromHomeM / 1000).toFixed(2)} unit={distanceFromHomeM < 1000 ? 'm' : 'km'} />
            <Readout label="Battery" value={`${battery}`} unit="%" warn={battery < 20} />
            <Readout
              label="Building"
              value={nearest === null ? '—' : nearest < 0.5 ? '0' : nearest.toFixed(0)}
              unit={nearest === null ? '' : 'm'}
              warn={nearest !== null && nearest < 5}
              caution={nearest !== null && nearest >= 5 && nearest < 15}
            />
          </div>
        </>
      )}

      {crashed && (
        <div className="hud__collision hud__collision--crash" role="alert">
          Crashed into a building{state.inAir ? '' : ': reset the drone in the Drone panel'}
        </div>
      )}

      {showCollision && (
        <div className="hud__collision" role="alert">
          {collision?.colliding ? 'Collision: inside a building' : 'Collision with a building'}
          {collision?.lastHitRoofM !== null && collision?.lastHitRoofM !== undefined
            ? ` (roof ${Math.max(0, collision.lastHitRoofM - (state.altAmslM - state.relAltM)).toFixed(0)} m above home)`
            : ''}
          {state.armed ? '. Drone stopped; fly out or land.' : ''}
        </div>
      )}

      {overLimit && <div className="hud__warning">Above the 122 m (400 ft) drone height limit</div>}
    </section>
  )
}

function Readout({
  label,
  value,
  unit,
  big,
  warn,
  caution,
}: {
  label: string
  value: string
  unit: string
  big?: boolean
  warn?: boolean
  caution?: boolean
}) {
  return (
    <div className={`hud__readout${big ? ' is-big' : ''}${warn ? ' is-warn' : ''}${caution ? ' is-caution' : ''}`}>
      <span className="hud__label">{label}</span>
      <span className="hud__value">
        {value}
        <span className="hud__unit">{unit}</span>
      </span>
    </div>
  )
}
