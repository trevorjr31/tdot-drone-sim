/**
 * One snapshot of the drone, in the units PX4/MAVSDK telemetry uses, so the
 * PX4 bridge (chunk 4c) can feed this directly.
 */
export type DroneState = {
  /** Sample time, milliseconds (any monotonic clock; only differences matter). */
  timeMs: number
  lat: number
  lon: number
  /** Metres above mean sea level (PX4's absolute altitude). */
  altAmslM: number
  /** Metres above the home/launch point. */
  relAltM: number
  /** Compass heading, degrees clockwise from north (0–360). */
  headingDeg: number
  /** Degrees; positive = right side down. */
  rollDeg: number
  /** Degrees; positive = nose up. */
  pitchDeg: number
  /** Horizontal speed, m/s. */
  groundSpeedMs: number
  /** Vertical speed, m/s; positive = climbing. */
  climbRateMs: number
  /** Remaining battery, 0–1. */
  battery: number
  armed: boolean
  inAir: boolean
  /** Human-readable flight mode, e.g. "Takeoff", "Mission", "Land". */
  flightMode: string
  home: { lat: number; lon: number; altAmslM: number }
}

/** Anything that produces drone states: the demo flight now, the PX4 bridge later. */
export interface DroneSource {
  /** Human-readable name shown in the UI. */
  readonly name: string
  /** Most recent state, or null before the first one. */
  readonly latest: DroneState | null
  /** Called with every new state. Returns an unsubscribe function. */
  subscribe(listener: (state: DroneState) => void): () => void
}
