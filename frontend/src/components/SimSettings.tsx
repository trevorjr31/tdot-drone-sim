import { useState } from 'react'
import {
  configProblem,
  DEFAULT_SIM_CONFIG,
  NUMBER_FIELDS,
  type AfterReturn,
  type FenceAction,
  type LowBatteryAction,
  type SimConfig,
} from '../drone/simConfig'

type Props = {
  config: SimConfig
  /** Sends changes to the bridge, which checks, saves and applies them to PX4. */
  onSave: (changes: Partial<SimConfig>) => Promise<void>
  /** The bridge is reachable (it saves settings even while PX4 is away). */
  canSave: boolean
}

const GROUPS: { title: string; keys: (typeof NUMBER_FIELDS)[number]['key'][] }[] = [
  { title: 'Speeds', keys: ['cruiseMs', 'climbMs', 'descendMs', 'takeoffMs', 'landMs', 'keyboardMs'] },
  { title: 'Battery', keys: ['batteryMin', 'batteryLowPct', 'batteryCriticalPct', 'batteryEmergencyPct'] },
  { title: 'Geofence', keys: ['ceilingM'] },
]

/**
 * Settings → Simulation: the simulated drone's speeds, battery and failsafes. Edits are a
 * draft until Apply; the bridge then saves them and sets PX4's parameters, live (even
 * mid-flight) and after restarts. Remounted (key) whenever the bridge reports new values.
 */
export function SimSettings({ config, onSave, canSave }: Props) {
  const [draft, setDraft] = useState<SimConfig>(config)
  const [state, setState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null })
  const changes = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => config[k as keyof SimConfig] !== v),
  ) as Partial<SimConfig>
  const dirty = Object.keys(changes).length > 0
  const problem = configProblem(draft)
  const isDefault = (Object.keys(DEFAULT_SIM_CONFIG) as (keyof SimConfig)[]).every((k) => draft[k] === DEFAULT_SIM_CONFIG[k])

  const set = <K extends keyof SimConfig>(key: K, value: SimConfig[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const save = () => {
    setState({ saving: true, error: null })
    onSave(changes).then(
      () => setState({ saving: false, error: null }),
      (err: unknown) => setState({ saving: false, error: err instanceof Error ? err.message : String(err) }),
    )
  }

  return (
    <form
      className="sim-settings"
      onSubmit={(e) => {
        e.preventDefault()
        if (dirty && !problem && canSave) save()
      }}
    >
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="sim-settings__group">
          <legend>{g.title}</legend>
          {g.keys.map((key) => {
            const f = NUMBER_FIELDS.find((x) => x.key === key)!
            return (
              <label key={key} className="sim-settings__row" title={f.help}>
                <span>{f.label}</span>
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={Number.isFinite(draft[key]) ? draft[key] : ''}
                  onChange={(e) => set(key, e.target.value === '' ? NaN : Number(e.target.value))}
                />
                <span className="sim-settings__unit">{f.unit}</span>
              </label>
            )
          })}
          {g.title === 'Battery' && (
            <>
              <label className="sim-settings__row" title="What PX4 does when the battery reaches the critical level (COM_LOW_BAT_ACT)">
                <span>At critical</span>
                <select value={draft.lowBatteryAction} onChange={(e) => set('lowBatteryAction', e.target.value as LowBatteryAction)}>
                  <option value="return">Return home, then land at emergency</option>
                  <option value="land">Land where it is</option>
                  <option value="warn">Only warn</option>
                </select>
              </label>
              <label className="sim-settings__check" title="Climbing drains the battery faster, descending and cruising a little slower (off: a fixed rate)">
                <input type="checkbox" checked={draft.batteryLoad} onChange={(e) => set('batteryLoad', e.target.checked)} />
                Drain follows the load
              </label>
            </>
          )}
          {g.title === 'Geofence' && (
            <>
              <label className="sim-settings__row" title="What PX4 does when the drone leaves the City or goes above the ceiling (GF_ACTION)">
                <span>On breach</span>
                <select value={draft.fenceAction} onChange={(e) => set('fenceAction', e.target.value as FenceAction)}>
                  <option value="return">Return home</option>
                  <option value="hold">Hold where it is</option>
                  <option value="land">Land where it is</option>
                  <option value="warn">Only warn</option>
                </select>
              </label>
              <label className="sim-settings__row" title="Once Return reaches home (RTL_LAND_DELAY)">
                <span>After return</span>
                <select value={draft.afterReturn} onChange={(e) => set('afterReturn', e.target.value as AfterReturn)}>
                  <option value="land">Land</option>
                  <option value="hover">Hover over home</option>
                </select>
              </label>
            </>
          )}
        </fieldset>
      ))}

      {problem && <div className="sim-settings__msg is-bad">{problem}</div>}
      {state.error && <div className="sim-settings__msg is-bad">Not saved: {state.error}</div>}
      {!canSave && <div className="sim-settings__msg">Start the bridge to change these.</div>}
      <div className="sim-settings__buttons">
        <button type="button" className="btn" disabled={isDefault || state.saving} onClick={() => setDraft(DEFAULT_SIM_CONFIG)}>
          Defaults
        </button>
        <button type="button" className="btn" disabled={!dirty || state.saving} onClick={() => setDraft(config)}>
          Undo
        </button>
        <button type="submit" className="btn btn--primary" disabled={!dirty || !!problem || !canSave || state.saving}>
          {state.saving ? 'Applying…' : 'Apply'}
        </button>
      </div>
      <p className="sim-settings__note">Applied to PX4 straight away, even mid-flight, and kept by the bridge.</p>
    </form>
  )
}
