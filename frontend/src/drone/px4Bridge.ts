import type { VelocityCommand } from './keyboardFlight'
import type { DroneSource, DroneState } from './types'

/**
 * Live drone state from PX4 via the bridge (sim/bridge/bridge.py), over a WebSocket.
 * Reconnects with backoff, so it copes with the bridge or PX4 starting later.
 */

export type BridgeStatus =
  /** Not trying to connect (another source is selected). */
  | 'idle'
  | 'connecting'
  /** Can't reach the bridge (is `docker compose up` running?). */
  | 'bridge-offline'
  /** Bridge is up but hasn't found PX4 yet. */
  | 'px4-offline'
  | 'connected'

export type Px4Command = 'takeoff' | 'land' | 'rtl' | 'hold' | 'arm' | 'disarm' | 'goto'

export type Px4CommandParams = {
  /** takeoff: height above launch. */
  altitudeM?: number
  /** goto: destination; height defaults to the current one. */
  lat?: number
  lon?: number
  relAltM?: number
}

type ServerMessage =
  | { type: 'status'; px4Connected: boolean; px4Version: string | null }
  | { type: 'state'; state: DroneState }
  | { type: 'ack'; id: string; ok: boolean; error: string | null }
  | { type: 'notice'; level: string; message: string }

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000]
const COMMAND_TIMEOUT_MS = 30_000

export const DEFAULT_BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL?.trim() || 'ws://localhost:8765'

/** Parses a bridge message, rejecting anything that isn't one of the known shapes. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return null
  const m = msg as Record<string, unknown>
  if (m.type === 'status' && typeof m.px4Connected === 'boolean') return m as ServerMessage
  if (m.type === 'ack' && typeof m.id === 'string' && typeof m.ok === 'boolean') return m as ServerMessage
  if (m.type === 'state' && isDroneState(m.state)) return m as ServerMessage
  if (m.type === 'notice' && typeof m.message === 'string') return m as ServerMessage
  return null
}

function isDroneState(s: unknown): s is DroneState {
  if (!s || typeof s !== 'object') return false
  const d = s as Record<string, unknown>
  const numbers = ['timeMs', 'lat', 'lon', 'altAmslM', 'relAltM', 'headingDeg', 'rollDeg', 'pitchDeg', 'groundSpeedMs', 'climbRateMs', 'battery']
  return (
    numbers.every((k) => typeof d[k] === 'number' && Number.isFinite(d[k])) &&
    typeof d.armed === 'boolean' &&
    typeof d.inAir === 'boolean' &&
    typeof d.flightMode === 'string' &&
    !!d.home &&
    typeof d.home === 'object'
  )
}

export class Px4BridgeSource implements DroneSource {
  readonly name = 'PX4 (live, via bridge)'
  readonly url: string
  private ws: WebSocket | null = null
  private _latest: DroneState | null = null
  private _status: BridgeStatus = 'idle'
  private _px4Version: string | null = null
  private readonly listeners = new Set<(s: DroneState) => void>()
  private readonly statusListeners = new Set<(s: BridgeStatus) => void>()
  private readonly noticeListeners = new Set<(message: string) => void>()
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: number }>()
  private wanted = false
  private attempt = 0
  private retryTimer: number | undefined

  constructor(url = DEFAULT_BRIDGE_URL) {
    this.url = url
  }

  get latest() {
    return this._latest
  }

  get status() {
    return this._status
  }

  get px4Version() {
    return this._px4Version
  }

  subscribe(listener: (s: DroneState) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  onStatus(listener: (s: BridgeStatus) => void) {
    this.statusListeners.add(listener)
    return () => void this.statusListeners.delete(listener)
  }

  /** Problems the bridge reports outside a command reply (e.g. keyboard flying refused). */
  onNotice(listener: (message: string) => void) {
    this.noticeListeners.add(listener)
    return () => void this.noticeListeners.delete(listener)
  }

  /** Keyboard flying: body-frame velocity, fire-and-forget (the bridge streams it to PX4). */
  sendVelocity(v: VelocityCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'velocity', ...v }))
  }

  /** Start connecting (and keep reconnecting) until disconnect(). */
  connect() {
    if (this.wanted) return
    this.wanted = true
    this.attempt = 0
    this.open()
  }

  disconnect() {
    this.wanted = false
    window.clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
    this.failPending('Disconnected')
    this._latest = null
    this.setStatus('idle')
  }

  /** Sends a command to PX4; resolves when PX4 accepts it, rejects with PX4's reason otherwise. */
  command(action: Px4Command, params: Px4CommandParams = {}): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the bridge'))
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`No reply to "${action}" from PX4`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'command', id, action, ...params }))
    })
  }

  private open() {
    if (!this.wanted) return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.setStatus('px4-offline') // until the bridge says PX4 is there
    }
    ws.onmessage = (event) => this.onMessage(String(event.data))
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.failPending('Connection to the bridge was lost')
      this.scheduleReconnect()
    }
    ws.onerror = () => ws.close()
  }

  private scheduleReconnect() {
    if (!this.wanted) return
    this.setStatus('bridge-offline')
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt++, RECONNECT_DELAYS_MS.length - 1)]
    this.retryTimer = window.setTimeout(() => this.open(), delay)
  }

  private onMessage(raw: string) {
    const msg = parseServerMessage(raw)
    if (!msg) return
    if (msg.type === 'status') {
      this._px4Version = msg.px4Version
      this.setStatus(msg.px4Connected ? 'connected' : 'px4-offline')
    } else if (msg.type === 'state') {
      this._latest = msg.state
      if (this._status !== 'connected') this.setStatus('connected')
      for (const listener of this.listeners) listener(msg.state)
    } else if (msg.type === 'notice') {
      for (const listener of this.noticeListeners) listener(msg.message)
    } else if (msg.type === 'ack') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      window.clearTimeout(p.timer)
      if (msg.ok) p.resolve()
      else p.reject(new Error(msg.error ?? 'Command refused'))
    }
  }

  private failPending(reason: string) {
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private setStatus(status: BridgeStatus) {
    if (status === this._status) return
    this._status = status
    for (const listener of this.statusListeners) listener(status)
  }
}
