/**
 * The Context Insights page's hover tips: one fixed bubble, portaled to <body>, driven by event delegation off the page root.
 *
 * The page is the `lc-ov` query container, and its inline-size containment makes the page the containing block
 * for FIXED descendants: an in-tree bubble would paint sidebar-width away from its anchor.
 *
 * Anchors carry `data-lc-tip` (the label) and optional `data-lc-tip-side` ('top' default, 'bottom').
 *
 * @module dsh-context/client/components/hoverTip
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

const TIP_ID = 'lc-hovertip-bubble'

const GAP = 6
const VIEWPORT_MARGIN = 8

interface ActiveTip {
  anchor: Element
  label: string
  side: 'top' | 'bottom'
  rect: { left: number; top: number; width: number; height: number; bottom: number }
}

interface Measured {
  /** The geometry this measurement answers (see tipSignature); a rebuilt tip with the same one must not re-measure. */
  signature: string
  left: number
  top: number
}

function anchorOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-lc-tip]') : null
}

function tipOf(anchor: Element): ActiveTip | null {
  const label = anchor.getAttribute('data-lc-tip')
  if (label === null || label === '') return null
  const r = anchor.getBoundingClientRect()
  return {
    anchor,
    label,
    side: anchor.getAttribute('data-lc-tip-side') === 'bottom' ? 'bottom' : 'top',
    rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
  }
}

/** The geometry a measurement depends on. The tip OBJECT is rebuilt on every `show()`, so a bail-out keyed on
 * object identity re-measures on every hover event the browser replays — and a synchronous replay chain then
 * commits once per measurement until React throws #185 (Maximum update depth exceeded). Key on the geometry
 * instead: an equivalent tip is the same answer, whatever object carries it. */
function tipSignature(tip: ActiveTip): string {
  const { rect } = tip
  return `${tip.side}|${rect.left}|${rect.top}|${rect.width}|${rect.height}|${rect.bottom}`
}

export interface HoverTipZone {
  zoneProps: {
    onMouseOver: (ev: React.MouseEvent) => void
    onMouseOut: (ev: React.MouseEvent) => void
    onFocusCapture: (ev: React.FocusEvent) => void
    onBlurCapture: (ev: React.FocusEvent) => void
    onScrollCapture: (ev: React.UIEvent) => void
  }
  bubble: ReactElement | null
}

/** The bubble renders hidden until the layout effect measures it, so it never flashes at an unmeasured spot. */
export function useHoverTip(): HoverTipZone {
  const [tip, setTip] = useState<ActiveTip | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const show = useCallback((anchor: Element): void => {
    setTip((current) => {
      // Same anchor (moving across its own subtree): keep tip and measure.
      if (current?.anchor === anchor) return current
      current?.anchor.removeAttribute('aria-describedby')
      const next = tipOf(anchor)
      if (next === null) return null
      anchor.setAttribute('aria-describedby', TIP_ID)
      return next
    })
  }, [])

  const hide = useCallback((): void => {
    setTip((current) => {
      current?.anchor.removeAttribute('aria-describedby')
      return null
    })
  }, [])

  // Anchor switching never hides: leaving A for B skips the hide, since B's mouseover re-anchors.
  const onMouseOver = useCallback((ev: React.MouseEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onMouseOut = useCallback((ev: React.MouseEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onFocusCapture = useCallback((ev: React.FocusEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onBlurCapture = useCallback((ev: React.FocusEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onScrollCapture = useCallback((): void => { hide() }, [hide])

  // A viewport resize moves every anchor: retract rather than float detached.
  useEffect(() => {
    if (tip === null) return undefined
    const retract = (): void => { hide() }
    window.addEventListener('resize', retract)
    return () => { window.removeEventListener('resize', retract) }
  }, [tip, hide])

  // Measured once per shown geometry (keyed on the signature, so a same-anchor mousemove — or a tip object the
  // browser's hover replay rebuilt — never re-measures).
  useLayoutEffect(() => {
    if (tip === null) return
    const signature = tipSignature(tip)
    if (measured?.signature === signature) return
    const el = bubbleRef.current
    /* v8 ignore next -- unreachable: the portal commits its ref before layout effects run. */
    if (el === null) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const { rect } = tip
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - VIEWPORT_MARGIN))
    let top = tip.side === 'top' ? rect.top - h - GAP : rect.bottom + GAP
    if (tip.side === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + GAP
    else if (tip.side === 'bottom' && top + h > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - h - GAP
    setMeasured({ signature, left, top: Math.max(VIEWPORT_MARGIN, top) })
  }, [tip, measured])

  const shown = measured !== null && tip !== null && measured.signature === tipSignature(tip) ? measured : null
  return {
    zoneProps: { onMouseOver, onMouseOut, onFocusCapture, onBlurCapture, onScrollCapture },
    bubble: tip === null ? null : createPortal(
      <div
        ref={bubbleRef}
        id={TIP_ID}
        role="tooltip"
        className="lc-tip lc-hovertip"
        style={shown === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: shown.left, top: shown.top, opacity: 1 }}
      >{tip.label}</div>,
      document.body,
    ),
  }
}
