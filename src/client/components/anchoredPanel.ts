import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { clampPopoverLeft } from './tip'

const GAP = 6
const MARGIN = 8

export interface PanelSpot {
  left: number
  top: number
}

export function useAnchoredPanel(
  open: boolean,
  anchorRef: MutableRefObject<HTMLElement | null>,
  panelRef: MutableRefObject<HTMLElement | null>,
  onClose: () => void,
): PanelSpot | null {
  const [spot, setSpot] = useState<PanelSpot | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const onDown = (ev: MouseEvent): void => {
      const target = ev.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
      close.current()
    }
    const dismiss = (): void => { close.current() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, anchorRef, panelRef])
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!open || anchor === null || panel === null) return
    const rect = anchor.getBoundingClientRect()
    const left = clampPopoverLeft(rect.right, panel.offsetWidth, window.innerWidth, MARGIN)
    const below = rect.bottom + GAP
    const top = below + panel.offsetHeight > window.innerHeight - MARGIN
      ? Math.max(MARGIN, rect.top - panel.offsetHeight - GAP)
      : below
    setSpot(current => current !== null && current.left === left && current.top === top ? current : { left, top })
  })
  return open ? spot : null
}
