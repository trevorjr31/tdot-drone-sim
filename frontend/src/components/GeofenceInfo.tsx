import type { BridgeStatus, GeofenceStatus } from '../drone/px4Bridge'

/**
 * Read-only summary of the geofence the bridge uploads to PX4 (Settings menu).
 * PX4 enforces it itself; the app only reports it.
 */
export function GeofenceInfo({ status, geofence }: { status: BridgeStatus; geofence: GeofenceStatus | null }) {
  const state =
    status !== 'connected' || !geofence
      ? { text: 'Waiting for PX4', cls: '' }
      : geofence.uploaded
        ? { text: 'Active', cls: ' is-ok' }
        : { text: `Not uploaded${geofence.error ? `: ${geofence.error}` : ''}`, cls: ' is-bad' }
  return (
    <dl className="settings__facts">
      <dt>Status</dt>
      <dd className={`settings__fact${state.cls}`}>{state.text}</dd>
      <dt>Area</dt>
      <dd>City of Toronto boundary</dd>
      <dt>Ceiling</dt>
      <dd>{geofence ? `${geofence.ceilingM.toFixed(0)} m above home` : '—'}</dd>
      <dt>On breach</dt>
      <dd>Return home</dd>
    </dl>
  )
}
