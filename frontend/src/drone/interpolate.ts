import type { DroneState } from './types'

/**
 * Telemetry arrives at ~10–20 Hz but the screen draws at 60 Hz. To keep motion
 * smooth, we render slightly in the past (`delayMs`) and interpolate between
 * the two samples either side of that moment, like a video buffer.
 */
export class StateBuffer {
  private readonly samples: { at: number; state: DroneState }[] = []
  private readonly delayMs: number
  private readonly maxSamples: number

  constructor(delayMs = 120, maxSamples = 60) {
    this.delayMs = delayMs
    this.maxSamples = maxSamples
  }

  /** Record a state, stamped with the local time it arrived. */
  push(state: DroneState, receivedAt: number) {
    const last = this.samples[this.samples.length - 1]
    // A restarted source (new flight) jumps back in time: start over.
    if (last && state.timeMs < last.state.timeMs) this.samples.length = 0
    this.samples.push({ at: receivedAt, state })
    if (this.samples.length > this.maxSamples) this.samples.shift()
  }

  clear() {
    this.samples.length = 0
  }

  /** Interpolated state for local time `now`, or null if nothing has arrived. */
  sample(now: number): DroneState | null {
    const n = this.samples.length
    if (n === 0) return null
    const t = now - this.delayMs
    if (n === 1 || t <= this.samples[0].at) return this.samples[0].state
    for (let i = n - 1; i > 0; i--) {
      const a = this.samples[i - 1]
      const b = this.samples[i]
      if (t >= a.at) {
        if (t >= b.at) return b.state // ran out of samples: hold the newest
        return lerpState(a.state, b.state, (t - a.at) / (b.at - a.at))
      }
    }
    return this.samples[n - 1].state
  }
}

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f
}

/** Interpolates angles in degrees the short way round (350° → 10° passes 0°, not 180°). */
export function lerpAngleDeg(a: number, b: number, f: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180
  return (((a + delta * f) % 360) + 360) % 360
}

export function lerpState(a: DroneState, b: DroneState, f: number): DroneState {
  const k = Math.min(Math.max(f, 0), 1)
  return {
    ...b,
    timeMs: lerp(a.timeMs, b.timeMs, k),
    lat: lerp(a.lat, b.lat, k),
    lon: lerp(a.lon, b.lon, k),
    altAmslM: lerp(a.altAmslM, b.altAmslM, k),
    relAltM: lerp(a.relAltM, b.relAltM, k),
    headingDeg: lerpAngleDeg(a.headingDeg, b.headingDeg, k),
    rollDeg: lerp(a.rollDeg, b.rollDeg, k),
    pitchDeg: lerp(a.pitchDeg, b.pitchDeg, k),
    groundSpeedMs: lerp(a.groundSpeedMs, b.groundSpeedMs, k),
    climbRateMs: lerp(a.climbRateMs, b.climbRateMs, k),
    battery: lerp(a.battery, b.battery, k),
  }
}
