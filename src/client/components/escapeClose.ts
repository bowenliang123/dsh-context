/**
 * The shared Escape-to-close contract of the plugin's overlays (the /context
 * modal and the baseline-gate dialog): capture-phase keydown on window, so
 * the composer's own key handling never swallows Escape first; on close, focus
 * returns to the element that held it when the overlay opened (skipped when
 * that element left the document).
 */

import { React } from '../react'

/** Close on Escape while `active`; restores the pre-open focus on cleanup. */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  React.useEffect(() => {
    if (!active) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active, onClose])
}
