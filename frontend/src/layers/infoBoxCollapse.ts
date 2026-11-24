import type { Viewer } from 'cesium'

/**
 * Makes Cesium's info box (building / neighbourhood details) collapsible: a chevron
 * button, or a click on the title, opens or folds it. It starts folded (just the
 * title) for every newly clicked building or neighbourhood.
 */
export function installInfoBoxCollapse(viewer: Viewer): () => void {
  const box = viewer.infoBox?.container.querySelector<HTMLElement>('.cesium-infoBox')
  const title = box?.querySelector<HTMLElement>('.cesium-infoBox-title')
  if (!box || !title) return () => {}

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'cesium-button infobox-toggle'
  box.insertBefore(toggle, title.nextSibling)

  const setCollapsed = (collapsed: boolean) => {
    box.classList.toggle('is-collapsed', collapsed)
    toggle.textContent = collapsed ? '▸' : '▾'
    toggle.title = collapsed ? 'Show details' : 'Hide details'
    toggle.setAttribute('aria-label', toggle.title)
    toggle.setAttribute('aria-expanded', String(!collapsed))
  }
  const flip = () => setCollapsed(!box.classList.contains('is-collapsed'))
  setCollapsed(true)
  const offSelect = viewer.selectedEntityChanged.addEventListener(() => setCollapsed(true))

  toggle.addEventListener('click', flip)
  title.addEventListener('click', flip)
  return () => {
    offSelect()
    toggle.removeEventListener('click', flip)
    title.removeEventListener('click', flip)
    toggle.remove()
    box.classList.remove('is-collapsed')
  }
}
