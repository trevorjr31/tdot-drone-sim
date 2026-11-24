/**
 * The simulated drone's settings: speeds, battery behaviour, the geofence ceiling and
 * breach action, and what happens after a return. The bridge owns them (CONFIG_SPEC in
 * sim/bridge/bridge.py: same names, ranges and defaults), saves them and applies them to
 * PX4; the app shows and edits them in Settings and uses them for its estimates.
 */

export type LowBatteryAction = 'return' | 'land' | 'warn'
export type FenceAction = 'return' | 'hold' | 'land' | 'warn'
export type AfterReturn = 'land' | 'hover'

export type SimConfig = {
  /** Fly-to, routes and Return (PX4 MPC_XY_CRUISE), m/s. */
  cruiseMs: number
  /** Climbing in auto modes (MPC_Z_V_AUTO_UP), m/s. */
  climbMs: number
  /** Descending in auto modes (MPC_Z_V_AUTO_DN), m/s. */
  descendMs: number
  /** Take-off climb (MPC_TKO_SPEED), m/s. */
  takeoffMs: number
  /** Final landing descent (MPC_LAND_SPEED), m/s. */
  landMs: number
  /** Keyboard flying, horizontal, m/s. */
  keyboardMs: number
  /** Minutes of hovering from a full battery to empty. */
  batteryMin: number
  /** The drain follows the load (climbing costs more); off: a fixed rate. */
  batteryLoad: boolean
  /** PX4 warns (BAT_LOW_THR), %. */
  batteryLowPct: number
  /** PX4 acts (BAT_CRIT_THR): returns home or lands, %. */
  batteryCriticalPct: number
  /** PX4 lands where it is (BAT_EMERGEN_THR), %. */
  batteryEmergencyPct: number
  /** What PX4 does at the critical level (COM_LOW_BAT_ACT). */
  lowBatteryAction: LowBatteryAction
  /** Geofence height ceiling above home (GF_MAX_VER_DIST), m. */
  ceilingM: number
  /** What a geofence breach does (GF_ACTION). */
  fenceAction: FenceAction
  /** Once Return reaches home (RTL_LAND_DELAY). */
  afterReturn: AfterReturn
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  cruiseMs: 5,
  climbMs: 3,
  descendMs: 1.5,
  takeoffMs: 1.5,
  landMs: 0.7,
  keyboardMs: 6,
  batteryMin: 20,
  batteryLoad: true,
  batteryLowPct: 25,
  batteryCriticalPct: 15,
  batteryEmergencyPct: 5,
  lowBatteryAction: 'return',
  ceilingM: 120,
  fenceAction: 'return',
  afterReturn: 'land',
}

type NumberKey = { [K in keyof SimConfig]: SimConfig[K] extends number ? K : never }[keyof SimConfig]

/** The number settings: label, unit, range (the bridge's) and step, for Settings. */
export const NUMBER_FIELDS: { key: NumberKey; label: string; unit: string; min: number; max: number; step: number; help: string }[] = [
  { key: 'cruiseMs', label: 'Cruise speed', unit: 'm/s', min: 1, max: 12, step: 0.5, help: 'Fly-to, routes and Return (PX4 MPC_XY_CRUISE)' },
  { key: 'climbMs', label: 'Climb', unit: 'm/s', min: 0.5, max: 8, step: 0.5, help: 'Climbing on autopilot (MPC_Z_V_AUTO_UP)' },
  { key: 'descendMs', label: 'Descent', unit: 'm/s', min: 0.5, max: 4, step: 0.5, help: 'Descending on autopilot (MPC_Z_V_AUTO_DN)' },
  { key: 'takeoffMs', label: 'Take-off', unit: 'm/s', min: 0.5, max: 5, step: 0.5, help: 'Take-off climb (MPC_TKO_SPEED)' },
  { key: 'landMs', label: 'Landing', unit: 'm/s', min: 0.2, max: 2, step: 0.1, help: 'The last few metres of a landing (MPC_LAND_SPEED)' },
  { key: 'keyboardMs', label: 'Keyboard speed', unit: 'm/s', min: 1, max: 12, step: 0.5, help: 'Flying with the keyboard, forward and sideways' },
  { key: 'batteryMin', label: 'Battery', unit: 'min', min: 2, max: 60, step: 1, help: 'Minutes of hovering from full to empty' },
  { key: 'batteryLowPct', label: 'Low', unit: '%', min: 5, max: 60, step: 1, help: 'PX4 warns (BAT_LOW_THR)' },
  { key: 'batteryCriticalPct', label: 'Critical', unit: '%', min: 3, max: 50, step: 1, help: 'PX4 returns home or lands, as set below (BAT_CRIT_THR)' },
  { key: 'batteryEmergencyPct', label: 'Emergency', unit: '%', min: 1, max: 30, step: 1, help: 'PX4 lands where it is (BAT_EMERGEN_THR)' },
  { key: 'ceilingM', label: 'Ceiling', unit: 'm', min: 20, max: 500, step: 5, help: 'Highest above home (GF_MAX_VER_DIST); Canada allows 122 m above ground' },
]

/** Why a change can't be saved (the bridge checks the same), or null. */
export function configProblem(c: SimConfig): string | null {
  for (const f of NUMBER_FIELDS) {
    const v = c[f.key]
    if (!Number.isFinite(v) || v < f.min || v > f.max) return `${f.label} must be between ${f.min} and ${f.max} ${f.unit}`
  }
  if (!(c.batteryLowPct > c.batteryCriticalPct && c.batteryCriticalPct > c.batteryEmergencyPct))
    return 'Battery levels must go low > critical > emergency'
  return null
}

/** Reads the config the bridge reports, falling back to the defaults for anything missing. */
export function parseSimConfig(raw: unknown): SimConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out = { ...DEFAULT_SIM_CONFIG } as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_SIM_CONFIG)) {
    if (typeof r[key] === typeof out[key]) out[key] = r[key]
  }
  return out as SimConfig
}

/** Highest Return home may fly: under the ceiling, or the return itself breaches it (bridge: RETURN_BELOW_CEILING_M). */
export function returnMaxAltM(c: SimConfig): number {
  return c.ceilingM - 5
}
/** Lowest return height the app sets (bridge: RETURN_ALT_MIN_M). */
export const RETURN_MIN_ALT_M = 20

/**
 * Battery drain relative to hovering (1.0): the bridge's drain_factor, which sets PX4's
 * simulated drain from the load. Idling armed on the ground draws little; climbing costs
 * up to twice as much; descending a bit less; forward flight is slightly cheaper up to
 * ~8 m/s, then drag makes it dearer.
 */
export function drainFactor(inAir: boolean, climbMs: number, speedMs: number): number {
  if (!inAir) return 0.3
  let f = 1
  f += climbMs > 0 ? 0.25 * Math.min(climbMs, 4) : -0.08 * Math.min(-climbMs, 3)
  f += speedMs <= 8 ? (-0.1 * speedMs) / 8 : -0.1 + 0.04 * (speedMs - 8)
  return Math.max(0.3, Math.min(2.5, f))
}
