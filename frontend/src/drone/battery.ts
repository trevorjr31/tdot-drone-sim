/**
 * Battery levels and flight time left. PX4's simulated battery drains steadily while
 * armed (the bridge sets it to run out, see bridge.py "Battery") and PX4 acts on these
 * levels itself: a warning, then Return home, then landing wherever it is.
 */

/** PX4 warns (bridge: BATTERY_LOW_THR). */
export const BATTERY_LOW = 0.25
/** PX4 flies home (bridge: BATTERY_CRIT_THR). */
export const BATTERY_CRITICAL = 0.15
/** PX4 lands where it is (bridge: BATTERY_EMERGENCY_THR). */
export const BATTERY_EMERGENCY = 0.05

export type BatteryLevel = 'ok' | 'low' | 'critical' | 'emergency'

export function batteryLevel(battery: number): BatteryLevel {
  if (battery <= BATTERY_EMERGENCY) return 'emergency'
  if (battery <= BATTERY_CRITICAL) return 'critical'
  if (battery <= BATTERY_LOW) return 'low'
  return 'ok'
}

export type BatteryInfo = {
  level: BatteryLevel
  /** Minutes until PX4 flies home on its own (critical level), once the drain rate is known. */
  minToReturn: number | null
  /** Minutes until PX4 lands where it is (emergency level), once the drain rate is known. */
  minToLand: number | null
}

/** Rate is measured over up to this much recent flight. */
const WINDOW_MS = 60_000
/** Before this much flight (or this much drop) there's no estimate. */
const MIN_SPAN_MS = 10_000
const MIN_DROP = 0.002

/**
 * Estimates how long the battery lasts from how fast it has been dropping. Fed every
 * state update; restarts when the drone disarms or the battery goes up (a fresh battery).
 */
export class BatteryEstimator {
  private samples: { t: number; b: number }[] = []

  update(timeMs: number, battery: number, armed: boolean): BatteryInfo {
    const last = this.samples[this.samples.length - 1]
    if (!armed || (last && (battery > last.b + 0.01 || timeMs < last.t))) this.samples = []
    if (armed && (!last || timeMs - last.t >= 1000 || this.samples.length === 0)) this.samples.push({ t: timeMs, b: battery })
    while (this.samples.length > 2 && timeMs - this.samples[1].t >= WINDOW_MS) this.samples.shift()

    const first = this.samples[0]
    const newest = this.samples[this.samples.length - 1]
    let perMin: number | null = null
    if (first && newest && newest.t - first.t >= MIN_SPAN_MS && first.b - newest.b >= MIN_DROP) {
      perMin = ((first.b - newest.b) / (newest.t - first.t)) * 60_000
    }
    const until = (thr: number) => (perMin ? Math.max(0, (battery - thr) / perMin) : null)
    return { level: batteryLevel(battery), minToReturn: until(BATTERY_CRITICAL), minToLand: until(BATTERY_EMERGENCY) }
  }
}

/** "about 12 min", "under a minute". */
export function formatMinutes(min: number): string {
  if (min < 1) return 'under a minute'
  return `about ${Math.round(min)} min`
}
