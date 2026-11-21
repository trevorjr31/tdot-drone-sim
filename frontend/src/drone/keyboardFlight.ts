/**
 * Keyboard flying: turns held keys into a body-frame velocity command for PX4
 * (sent through the bridge, which streams it in offboard mode).
 *
 *   W / S or ↑ / ↓   forward / back
 *   A / D            slide left / right
 *   Q / E or ← / →   turn left / right
 *   Space / Shift    up / down
 *
 * Releasing every key sends zeros, so the drone brakes and hovers.
 */

export type VelocityCommand = {
  forwardMs: number
  rightMs: number
  /** Positive = down (NED convention, as PX4 expects). */
  downMs: number
  yawRateDegS: number
}

export type FlightSpeeds = { horizontalMs: number; verticalMs: number; yawRateDegS: number }

export const DEFAULT_SPEEDS: FlightSpeeds = { horizontalMs: 6, verticalMs: 2.5, yawRateDegS: 45 }

/** KeyboardEvent.code values this controller uses (layout-independent physical keys). */
export const FLIGHT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight',
])

export const ZERO: VelocityCommand = { forwardMs: 0, rightMs: 0, downMs: 0, yawRateDegS: 0 }

export function velocityFromKeys(pressed: ReadonlySet<string>, speeds: FlightSpeeds = DEFAULT_SPEEDS): VelocityCommand {
  const k = (...codes: string[]) => (codes.some((c) => pressed.has(c)) ? 1 : 0)
  const forward = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown')
  const right = k('KeyD') - k('KeyA')
  const up = k('Space') - k('ShiftLeft', 'ShiftRight')
  const yaw = k('KeyE', 'ArrowRight') - k('KeyQ', 'ArrowLeft')
  // Moving diagonally shouldn't be faster than moving straight.
  const scale = forward !== 0 && right !== 0 ? Math.SQRT1_2 : 1
  return {
    forwardMs: forward * speeds.horizontalMs * scale,
    rightMs: right * speeds.horizontalMs * scale,
    downMs: 0 - up * speeds.verticalMs, // `0 -` avoids -0 when no up/down key is held
    yawRateDegS: yaw * speeds.yawRateDegS,
  }
}

const SEND_INTERVAL_MS = 100 // 10 Hz, comfortably above PX4's 2 Hz offboard minimum
const RELEASE_REPEATS = 5 // send zeros a few times on release so the stop isn't lost

/**
 * Listens for flight keys while enabled and calls `send` at 10 Hz while any are
 * held. Ignores keys typed into inputs and keys held with Cmd/Ctrl/Alt.
 */
export class KeyboardFlight {
  private readonly send: (v: VelocityCommand) => void
  private readonly onActiveChange: (active: boolean) => void
  private readonly pressed = new Set<string>()
  private enabled = false
  /** After interrupt(): ignore held/auto-repeated keys until a fresh press. */
  private suspended = false
  private timer: number | undefined
  private releaseLeft = 0

  constructor(send: (v: VelocityCommand) => void, onActiveChange: (active: boolean) => void = () => {}) {
    this.send = send
    this.onActiveChange = onActiveChange
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.releaseAll)
  }

  /** Only fly when it makes sense (PX4 connected, drone airborne). */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) this.releaseAll()
  }

  /** Stop sending now (e.g. after a collision); held keys are ignored until pressed again. */
  interrupt() {
    this.suspended = true
    this.releaseAll()
  }

  get active() {
    return this.pressed.size > 0
  }

  destroy() {
    this.releaseAll()
    window.clearInterval(this.timer)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.releaseAll)
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled || !FLIGHT_KEYS.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    e.preventDefault() // Space/arrows would otherwise scroll or press focused buttons
    if (this.suspended) {
      if (e.repeat) return // still the same held key
      this.suspended = false
    }
    if (this.pressed.has(e.code)) return
    const wasActive = this.active
    this.pressed.add(e.code)
    if (!wasActive) this.onActiveChange(true)
    this.tick()
    this.ensureTimer()
  }

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (!this.pressed.delete(e.code)) return
    if (!this.active) {
      this.releaseLeft = RELEASE_REPEATS
      this.onActiveChange(false)
    }
    this.tick()
  }

  private readonly releaseAll = () => {
    if (!this.active) return
    this.pressed.clear()
    this.releaseLeft = RELEASE_REPEATS
    this.onActiveChange(false)
    this.tick()
  }

  private ensureTimer() {
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), SEND_INTERVAL_MS)
  }

  private tick() {
    if (this.active) {
      this.send(velocityFromKeys(this.pressed))
    } else if (this.releaseLeft > 0) {
      this.releaseLeft--
      this.send(ZERO)
    } else {
      // Nothing held and the stop has been sent: go quiet so the bridge can hand back to Hold.
      window.clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
