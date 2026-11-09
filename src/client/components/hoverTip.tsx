import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

const TIP_ID = 'lc-hovertip-bubble'

const GAP = 6
const VIEWPORT_MARGIN = 8

interface ActiveTip {
  anchor: Element
  label: string
  side: 'top' | 'bottom'
  rect: { left: number; top: number; width: number; height: number; bottom: number }
  signature: string
}

interface Measured {
  signature: string
  left: number
  top: number
}

interface TipStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ActiveTip | null
  show: (anchor: Element) => void
  hide: () => void
}

function anchorOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-lc-tip]') : null
}

function tipOf(anchor: Element): ActiveTip | null {
  const label = anchor.getAttribute('data-lc-tip')
  if (label === null || label === '') return null
  const r = anchor.getBoundingClientRect()
  const side = anchor.getAttribute('data-lc-tip-side') === 'bottom' ? 'bottom' : 'top'
  const rect = { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom }
  const signature = JSON.stringify([side, label, rect.left, rect.top, rect.width, rect.bottom, window.innerWidth, window.innerHeight])
  return { anchor, label, side, rect, signature }
}

function createTipStore(): TipStore {
  let tip: ActiveTip | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const hide = (): void => {
    if (tip === null) return
    tip.anchor.removeAttribute('aria-describedby')
    tip = null
    emit()
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => tip,
    show: (anchor) => {
      if (tip?.anchor === anchor) return
      const next = tipOf(anchor)
      if (next === null) {
        hide()
        return
      }
      tip?.anchor.removeAttribute('aria-describedby')
      anchor.setAttribute('aria-describedby', TIP_ID)
      tip = next
      emit()
    },
    hide,
  }
}

function HoverTipBubble(props: { store: TipStore }): ReactElement | null {
  const tip = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)

  useEffect(() => {
    if (tip === null) return undefined
    window.addEventListener('resize', props.store.hide)
    return () => { window.removeEventListener('resize', props.store.hide) }
  }, [tip, props.store])

  useLayoutEffect(() => {
    if (tip === null || measured?.signature === tip.signature) return
    const el = bubbleRef.current
    /* v8 ignore next */
    if (el === null) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const { rect } = tip
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - VIEWPORT_MARGIN))
    let top = tip.side === 'top' ? rect.top - h - GAP : rect.bottom + GAP
    if (tip.side === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + GAP
    else if (tip.side === 'bottom' && top + h > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - h - GAP
    setMeasured({ signature: tip.signature, left, top: Math.max(VIEWPORT_MARGIN, top) })
  }, [tip, measured])

  if (tip === null) return null
  const shown = measured?.signature === tip.signature ? measured : null
  return createPortal(
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
  )
}

export interface HoverTipZone {
  zoneProps: {
    onMouseOver: (ev: React.MouseEvent) => void
    onMouseOut: (ev: React.MouseEvent) => void
    onFocusCapture: (ev: React.FocusEvent) => void
    onBlurCapture: (ev: React.FocusEvent) => void
    onScrollCapture: (ev: React.UIEvent) => void
  }
  bubble: ReactElement
}

export function useHoverTip(): HoverTipZone {
  const storeRef = useRef<TipStore | null>(null)
  if (storeRef.current === null) storeRef.current = createTipStore()
  const store = storeRef.current
  const onMouseOver = useCallback((ev: React.MouseEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) store.show(anchor)
  }, [store])
  const onMouseOut = useCallback((ev: React.MouseEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) store.hide()
  }, [store])
  const onFocusCapture = useCallback((ev: React.FocusEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) store.show(anchor)
  }, [store])
  const onBlurCapture = useCallback((ev: React.FocusEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) store.hide()
  }, [store])
  const onScrollCapture = useCallback((): void => { store.hide() }, [store])
  return {
    zoneProps: { onMouseOver, onMouseOut, onFocusCapture, onBlurCapture, onScrollCapture },
    bubble: <HoverTipBubble store={store} />,
  }
}
