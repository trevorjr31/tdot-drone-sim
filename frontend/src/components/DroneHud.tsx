import type { HudInfo } from '../drone/droneView'

/** Transport Canada's normal ceiling for drones: 122 m (400 ft) above ground. */
const ALTITUDE_LIMIT_M = 122

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function cardinal(deg: number) {
  return CARDINALS[Math.round(deg / 45) % 8]
}

export function DroneHud({ info }: { info: HudInfo | null }) {
  if (!info) return null
  const { state, aglM, distanceFromHomeM } = info
  // The legal limit is height above ground; fall back to height above launch if ground is unknown.
  const heightM = aglM ?? state.relAltM
  const overLimit = state.inAir && heightM > ALTITUDE_LIMIT_M
  const battery = Math.round(state.battery * 100)
  const climb = Math.abs(state.climbRateMs) < 0.05 ? 0 : state.climbRateMs

  return (
    <section className="hud" aria-label="Drone status" aria-live="off">
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
      </div>

      {overLimit && <div className="hud__warning">Above the 122 m (400 ft) drone height limit</div>}
    </section>
  )
}

function Readout({ label, value, unit, big, warn }: { label: string; value: string; unit: string; big?: boolean; warn?: boolean }) {
  return (
    <div className={`hud__readout${big ? ' is-big' : ''}${warn ? ' is-warn' : ''}`}>
      <span className="hud__label">{label}</span>
      <span className="hud__value">
        {value}
        <span className="hud__unit">{unit}</span>
      </span>
    </div>
  )
}
