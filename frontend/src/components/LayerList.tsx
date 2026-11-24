import { LAYERS, type LayerId, type LayerStatus, type LayerVisibility } from '../layers/layerState'

type Props = {
  visibility: LayerVisibility
  status: Partial<Record<LayerId, { status: LayerStatus; message?: string }>>
  onToggle: (id: LayerId) => void
}

/** Overlay toggles (neighbourhoods, city boundary), shown in the Settings menu. */
export function LayerList({ visibility, status, onToggle }: Props) {
  return (
    <ul className="layer-panel__list">
      {LAYERS.map((layer) => {
        const s = status[layer.id]
        const failed = s?.status === 'error'
        return (
          <li key={layer.id}>
            <label className={`layer-row${failed ? ' is-failed' : ''}`} title={failed ? s?.message : layer.hint}>
              <input type="checkbox" checked={visibility[layer.id]} disabled={failed} onChange={() => onToggle(layer.id)} />
              <span className="layer-row__swatch" style={{ background: layer.swatch }} aria-hidden />
              <span className="layer-row__label">
                {layer.label}
                {s?.status === 'loading' && <span className="layer-row__note"> loading…</span>}
                {failed && <span className="layer-row__note"> unavailable</span>}
              </span>
              <kbd className="layer-row__key">{layer.shortcut}</kbd>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
