import { isVerticalWheel, wheelDeltaPx } from './wheel'

export function containHorizontalOverscroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    if (atStart || atEnd) e.preventDefault()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => { el.removeEventListener('wheel', onWheel) }
}

export function panByWheel(el: HTMLElement, e: WheelEvent, max: number): void {
  const next = Math.max(0, Math.min(el.scrollLeft + wheelDeltaPx(e.deltaY, e.deltaMode, el.clientWidth), Math.max(0, max)))
  if (next !== el.scrollLeft) el.scrollLeft = next
}

export const SCROLL_SPACER_PX = 1

export function clampSpacerScroll(el: HTMLElement): void {
  if (el.clientWidth > 0 && el.scrollLeft !== 0 && el.scrollWidth - el.clientWidth <= SCROLL_SPACER_PX) el.scrollLeft = 0
}

export function wheelScrollHorizontally(el: HTMLElement, target: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (!isVerticalWheel(e)) return
    const max = el.scrollWidth - el.clientWidth
    if (max <= SCROLL_SPACER_PX) return
    e.preventDefault()
    panByWheel(el, e, max)
  }
  target.addEventListener('wheel', onWheel, { passive: false })
  return () => { target.removeEventListener('wheel', onWheel) }
}
