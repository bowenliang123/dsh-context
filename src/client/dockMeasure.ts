/**
 * The /context modal's dock inset: the width of the shell's sidebar track, so the fixed backdrop can start at the sidebar's right edge and
 * center the dialog over the main column instead of the whole viewport. The only host anchor is the app frame's inline grid template
 * (`<sidebar>px minmax(0, 1fr) <details>px` — identical on every supported baseline and the sole inline gridTemplateColumns in the dsh
 * client), found by walking up from the backdrop. Anything unresolved — no frame, unparsable template, a hostile node in the chain —
 * degrades to a 0 inset, the full-viewport mask.
 */

/** The dock measure for one backdrop position: the mask inset and the frame to observe for template rewrites. */
export interface DockMeasure {
  /** Mask inset from the viewport's left edge, in px (0 = full-viewport mask). */
  left: number
  /** The element owning the inline grid template; null when unresolved (nothing to observe). */
  frame: HTMLElement | null
}

const LEADING_PX_TRACK = /^(\d+(?:\.\d+)?)px/

/** Measure the sidebar track width from the backdrop's ancestor chain, or resolve to the full-viewport mask. */
export function measureDock(start: HTMLElement | null): DockMeasure {
  try {
    for (let el = start?.parentElement ?? null; el !== null; el = el.parentElement) {
      const template = el.style.gridTemplateColumns
      if (template === '') continue
      const track = LEADING_PX_TRACK.exec(template.trim())
      if (track === null) return { left: 0, frame: null }
      return { left: Number(track[1]), frame: el }
    }
  } catch { /* a hostile node in the chain degrades to the full-viewport mask */ }
  return { left: 0, frame: null }
}
