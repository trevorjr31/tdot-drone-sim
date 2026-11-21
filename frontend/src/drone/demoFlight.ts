import type { DroneSource, DroneState } from './types'

/**
 * A scripted stand-in for PX4 so the 3D view can be built and tested without
 * the simulator running. It follows waypoints with simple quadcopter-like
 * kinematics (limited speed, acceleration, climb and turn rate; tilts into
 * acceleration) and produces the same DroneState that PX4 telemetry will.
 *
 * Replaced by the PX4 bridge in chunk 4c; nothing else needs to change.
 */

export type Waypoint = { lat: number; lon: number; relAltM: number; label: string }

export type DemoFlightOptions = {
  home: { lat: number; lon: number; altAmslM: number }
  /** Visited in order after takeoff; the flight then returns home and lands. */
  waypoints: Waypoint[]
  takeoffAltM?: number
  maxSpeedMs?: number
  maxAccelMs2?: number
  maxClimbMs?: number
  landingSpeedMs?: number
  maxYawRateDegS?: number
}

/**
 * Nathan Phillips Square → west along Queen St W → Trinity Bellwoods Park → back.
 * Queen West is mostly low-rise, so the route stays clear of towers below the
 * 122 m drone ceiling (there are no collisions yet; that's chunk 4e).
 * Home matches the PX4 container's home (docker-compose.yml).
 */
export const DOWNTOWN_DEMO: DemoFlightOptions = {
  home: { lat: 43.65255, lon: -79.3833, altAmslM: 92 },
  takeoffAltM: 70,
  waypoints: [
    { lat: 43.6513, lon: -79.3878, relAltM: 75, label: 'Queen & University (Osgoode Hall)' },
    { lat: 43.6487, lon: -79.3961, relAltM: 70, label: 'Queen & Spadina' },
    { lat: 43.6468, lon: -79.4058, relAltM: 60, label: 'Queen & Bathurst' },
    { lat: 43.6475, lon: -79.4135, relAltM: 50, label: 'Trinity Bellwoods Park' },
    { lat: 43.6466, lon: -79.4086, relAltM: 70, label: 'Queen W (heading back)' },
  ],
}

type Phase = 'idle' | 'takeoff' | 'mission' | 'return' | 'land' | 'landed'

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Ready',
  takeoff: 'Takeoff',
  mission: 'Mission',
  return: 'Return',
  land: 'Land',
  landed: 'Landed',
}

const G = 9.81
const M_PER_DEG_LAT = 110_574

/** Pure simulation, stepped by `step(dt)`; no timers, so it's easy to test. */
export class DemoFlight {
  readonly options: Required<DemoFlightOptions>
  private x = 0 // metres east of home
  private y = 0 // metres north of home
  private z = 0 // metres above home
  private vx = 0
  private vy = 0
  private vz = 0
  private ax = 0
  private ay = 0
  private headingDeg = 0
  private battery = 1
  private timeS = 0
  private phase: Phase = 'idle'
  private target = 0
  /** Height kept on the way home (the last cruise height), so it doesn't drop into the towers by home. */
  private returnAltM = 0

  constructor(options: DemoFlightOptions) {
    this.options = {
      takeoffAltM: 30,
      maxSpeedMs: 12,
      maxAccelMs2: 3,
      maxClimbMs: 3,
      landingSpeedMs: 1.2,
      maxYawRateDegS: 60,
      ...options,
    }
  }

  get finished() {
    return this.phase === 'landed'
  }

  get phaseLabel() {
    return PHASE_LABEL[this.phase]
  }

  start() {
    if (this.phase === 'idle') this.phase = 'takeoff'
  }

  step(dt: number) {
    this.timeS += dt
    if (this.phase === 'idle' || this.phase === 'landed') return

    if (this.phase === 'takeoff') {
      this.climbTo(this.options.takeoffAltM, dt)
      this.hold(dt)
      if (Math.abs(this.z - this.options.takeoffAltM) < 0.5) this.phase = 'mission'
    } else if (this.phase === 'mission' || this.phase === 'return') {
      const wp =
        this.phase === 'mission'
          ? this.local(this.options.waypoints[this.target])
          : { x: 0, y: 0, z: this.returnAltM }
      const dist = this.flyTo(wp.x, wp.y, dt)
      this.climbTo(wp.z, dt)
      if (dist < 3 && Math.abs(this.z - wp.z) < 2) {
        if (this.phase === 'return') this.phase = 'land'
        else if (++this.target >= this.options.waypoints.length) {
          this.phase = 'return'
          this.returnAltM = Math.max(this.z, this.options.takeoffAltM)
        }
      }
    } else if (this.phase === 'land') {
      this.hold(dt)
      // Descend briskly up high, gently near the ground (like PX4's land mode).
      this.vz = -Math.min(this.z > 10 ? this.options.maxClimbMs * 0.8 : this.options.landingSpeedMs, Math.max(0.3, this.z * 0.5))
      this.z = Math.max(0, this.z + this.vz * dt)
      if (this.z <= 0.05) {
        this.z = 0
        this.vz = 0
        this.phase = 'landed'
      }
    }

    // ~25 minutes of flight on a full battery, typical for a consumer quadcopter.
    if (this.phase !== 'landed') this.battery = Math.max(0, this.battery - dt / (25 * 60))
  }

  state(): DroneState {
    const { home } = this.options
    const lat = home.lat + this.y / M_PER_DEG_LAT
    const lon = home.lon + this.x / mPerDegLon(home.lat)
    // Body-frame acceleration → tilt: a quad pitches nose-down to speed up, banks into turns.
    const h = (this.headingDeg * Math.PI) / 180
    const aForward = this.ax * Math.sin(h) + this.ay * Math.cos(h)
    const aRight = this.ax * Math.cos(h) - this.ay * Math.sin(h)
    const clampTilt = (deg: number) => Math.max(-25, Math.min(25, deg))
    return {
      timeMs: this.timeS * 1000,
      lat,
      lon,
      altAmslM: home.altAmslM + this.z,
      relAltM: this.z,
      headingDeg: this.headingDeg,
      rollDeg: clampTilt((Math.atan2(aRight, G) * 180) / Math.PI),
      pitchDeg: clampTilt((-Math.atan2(aForward, G) * 180) / Math.PI),
      groundSpeedMs: Math.hypot(this.vx, this.vy),
      climbRateMs: this.vz,
      battery: this.battery,
      armed: this.phase !== 'idle' && this.phase !== 'landed',
      inAir: this.z > 0.1,
      flightMode: this.phaseLabel,
      home: { ...home },
    }
  }

  private local(wp: Waypoint) {
    const { home } = this.options
    return { x: (wp.lon - home.lon) * mPerDegLon(home.lat), y: (wp.lat - home.lat) * M_PER_DEG_LAT, z: wp.relAltM }
  }

  /** Accelerates toward the target, slowing in time to stop on it. Returns the remaining distance. */
  private flyTo(tx: number, ty: number, dt: number): number {
    const dx = tx - this.x
    const dy = ty - this.y
    const dist = Math.hypot(dx, dy)
    const { maxSpeedMs, maxAccelMs2 } = this.options
    const speed = Math.min(maxSpeedMs, Math.sqrt(2 * maxAccelMs2 * Math.max(dist - 1, 0)))
    const desiredVx = dist > 0.01 ? (dx / dist) * speed : 0
    const desiredVy = dist > 0.01 ? (dy / dist) * speed : 0
    this.accelerateToward(desiredVx, desiredVy, dt)
    if (dist > 2) this.turnToward((Math.atan2(dx, dy) * 180) / Math.PI, dt)
    return dist
  }

  private hold(dt: number) {
    this.accelerateToward(0, 0, dt)
  }

  private accelerateToward(desiredVx: number, desiredVy: number, dt: number) {
    let ax = (desiredVx - this.vx) / dt
    let ay = (desiredVy - this.vy) / dt
    const a = Math.hypot(ax, ay)
    if (a > this.options.maxAccelMs2) {
      ax = (ax / a) * this.options.maxAccelMs2
      ay = (ay / a) * this.options.maxAccelMs2
    }
    this.ax = ax
    this.ay = ay
    this.vx += ax * dt
    this.vy += ay * dt
    this.x += this.vx * dt
    this.y += this.vy * dt
  }

  private climbTo(targetZ: number, dt: number) {
    const dz = targetZ - this.z
    const { maxClimbMs } = this.options
    const desired = Math.max(-maxClimbMs, Math.min(maxClimbMs, dz * 0.8))
    this.vz += Math.max(-2 * dt, Math.min(2 * dt, desired - this.vz))
    this.z = Math.max(0, this.z + this.vz * dt)
  }

  private turnToward(targetDeg: number, dt: number) {
    const delta = ((((targetDeg - this.headingDeg) % 360) + 540) % 360) - 180
    const maxStep = this.options.maxYawRateDegS * dt
    this.headingDeg = (((this.headingDeg + Math.max(-maxStep, Math.min(maxStep, delta))) % 360) + 360) % 360
  }
}

function mPerDegLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180)
}

/** Runs a DemoFlight in real time and publishes its state at `rateHz`, like telemetry. */
export class DemoFlightSource implements DroneSource {
  readonly name = 'Demo flight (downtown)'
  private flight: DemoFlight
  private readonly options: DemoFlightOptions
  private readonly listeners = new Set<(s: DroneState) => void>()
  private timer: number | undefined
  private readonly rateHz: number
  private _latest: DroneState | null = null

  constructor(options: DemoFlightOptions = DOWNTOWN_DEMO, rateHz = 20) {
    this.options = options
    this.rateHz = rateHz
    this.flight = new DemoFlight(options)
  }

  get latest() {
    return this._latest
  }

  get running() {
    return this.timer !== undefined
  }

  get finished() {
    return this.flight.finished
  }

  subscribe(listener: (s: DroneState) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Starts (or resumes) the flight; restarts from home if the last one finished. */
  start() {
    if (this.running) return
    if (this.flight.finished) this.flight = new DemoFlight(this.options)
    this.flight.start()
    const dt = 1 / this.rateHz
    this.publish()
    this.timer = window.setInterval(() => {
      this.flight.step(dt)
      this.publish()
      if (this.flight.finished) this.pause()
    }, 1000 / this.rateHz)
  }

  pause() {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
    this.publish()
  }

  /** Back on the ground at home, ready to start again. */
  reset() {
    this.pause()
    this.flight = new DemoFlight(this.options)
    this.publish()
  }

  private publish() {
    this._latest = this.flight.state()
    for (const listener of this.listeners) listener(this._latest)
  }
}
