import { useState } from 'react'
import { LAYERS, type LayerId, type LayerStatus, type LayerVisibility } from '../layers/layerState'

type Props = {
  visibility: LayerVisibility
  status: Partial<Record<LayerId, { status: LayerStatus; message?: string }>>
  onToggle: (id: LayerId) => void
}

export function LayerPanel({ visibility, status, onToggle }: Props) {
  const [open, setOpen] = useState(true)

  return (
    <section className={`layer-panel${open ? '' : ' is-collapsed'}`} aria-label="Map layers">
      <button type="button" className="layer-panel__header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>Layers</span>
        <span className="layer-panel__chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <>
          <ul className="layer-panel__list">
            {LAYERS.map((layer) => {
              const s = status[layer.id]
              const failed = s?.status === 'error'
              return (
                <li key={layer.id}>
                  <label className={`layer-row${failed ? ' is-failed' : ''}`} title={failed ? s?.message : layer.hint}>
                    <input
                      type="checkbox"
                      checked={visibility[layer.id]}
                      disabled={failed}
                      onChange={() => onToggle(layer.id)}
                    />
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
          <p className="layer-panel__footer">
            City data:{' '}
            <a href="https://open.toronto.ca/" target="_blank" rel="noopener noreferrer">
              City of Toronto Open Data
            </a>{' '}
            (OGL – Toronto)
          </p>
        </>
      )}
    </section>
  )
}
