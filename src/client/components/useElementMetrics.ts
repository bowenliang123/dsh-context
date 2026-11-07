import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface ElementSize {
  width: number
  height: number
}

export interface ScrollMetrics extends ElementSize {
  scrollTop: number
  scrollLeft: number
  measured: boolean
}

const EMPTY_SIZE: ElementSize = { width: 0, height: 0 }
const EMPTY_METRICS: ScrollMetrics = { width: 0, height: 0, scrollTop: 0, scrollLeft: 0, measured: false }

export type SizeMode = 'client' | 'content'

function pxOf(value: string): number {
  return Number.parseFloat(value) || 0
}

function contentSizeOf(el: HTMLElement): ElementSize {
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const padX = pxOf(style.paddingLeft) + pxOf(style.paddingRight)
  const padY = pxOf(style.paddingTop) + pxOf(style.paddingBottom)
  return { width: Math.round(rect.width - padX), height: Math.round(rect.height - padY) }
}

export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  mode: SizeMode = 'client',
  enabled = true,
): ElementSize {
  const [size, setSize] = useState<ElementSize>(EMPTY_SIZE)
  useLayoutEffect(() => {
    if (!enabled) {
      setSize(prev => (prev.width === 0 && prev.height === 0 ? prev : EMPTY_SIZE))
      return undefined
    }
    const el = ref.current
    /* v8 ignore next 1 */
    if (el === null) return undefined
    const sync = (): void => {
      const next = mode === 'content' ? contentSizeOf(el) : { width: el.clientWidth, height: el.clientHeight }
      setSize(prev => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    sync()
    /* v8 ignore start */
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => { observer.disconnect() }
    /* v8 ignore stop */
  }, [enabled, mode, ref])
  return size
}

export function useScrollMetrics(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): ScrollMetrics {
  const [metrics, setMetrics] = useState<ScrollMetrics>(EMPTY_METRICS)
  const frame = useRef(0)
  useLayoutEffect(() => {
    if (!enabled) {
      setMetrics(prev => (prev === EMPTY_METRICS ? prev : EMPTY_METRICS))
      return undefined
    }
    const el = ref.current
    /* v8 ignore next 1 */
    if (el === null) return undefined
    const sync = (): void => {
      frame.current = 0
      setMetrics(prev => (
        prev.measured
        && prev.width === el.clientWidth
        && prev.height === el.clientHeight
        && prev.scrollTop === el.scrollTop
        && prev.scrollLeft === el.scrollLeft
          ? prev
          : { width: el.clientWidth, height: el.clientHeight, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, measured: true }
      ))
    }
    const schedule = (): void => { if (frame.current === 0) frame.current = requestAnimationFrame(sync) }
    el.addEventListener('scroll', schedule, { passive: true })
    sync()
    /* v8 ignore start */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(el)
    /* v8 ignore stop */
    return () => {
      el.removeEventListener('scroll', schedule)
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
      /* v8 ignore next */
      observer?.disconnect()
    }
  }, [enabled, ref])
  return metrics
}
