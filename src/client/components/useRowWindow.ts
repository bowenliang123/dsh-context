import { useLayoutEffect, useState, type RefObject } from 'react'

export const ROW_WINDOW_OVERSCAN = 8

export interface RowRange {
  from: number
  to: number
}

export function rowWindowFor(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  if (count <= 0 || rowHeight <= 0 || viewport <= 0) return { from: 0, to: Math.max(0, count - 1) }
  const from = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  const to = Math.min(count - 1, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  return { from, to: Math.max(from, to) }
}

const UNMEASURED: RowRange = { from: 0, to: -1 }

export function useRowWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  const full: RowRange = { from: 0, to: Math.max(0, count - 1) }
  const [range, setRange] = useState<RowRange | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled) {
      setRange(null)
      return
    }
    if (el === null) {
      setRange(current => (current !== null && current.from === full.from && current.to === full.to ? current : full))
      return
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const next = rowWindowFor(el.scrollTop, el.clientHeight, rowHeight, count, overscan)
      setRange(current => (current !== null && current.from === next.from && current.to === next.to ? current : next))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', schedule, { passive: true })
    /* v8 ignore start */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(el)
    /* v8 ignore stop */
    update()
    return () => {
      el.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      /* v8 ignore next */
      observer?.disconnect()
    }
  }, [ref, count, rowHeight, enabled, overscan, full.from, full.to])
  return enabled ? (range ?? UNMEASURED) : full
}
