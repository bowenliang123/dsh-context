import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'

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

function useScrollWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  size: number,
  enabled: boolean,
  axis: 'row' | 'column',
  overscan: number,
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
      const next = rowWindowFor(
        axis === 'row' ? el.scrollTop : el.scrollLeft,
        axis === 'row' ? el.clientHeight : el.clientWidth,
        size,
        count,
        overscan,
      )
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
  }, [ref, count, size, enabled, axis, overscan, full.from, full.to])
  return enabled ? (range ?? UNMEASURED) : full
}

export function useRowWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  return useScrollWindow(ref, count, rowHeight, enabled, 'row', overscan)
}

export function useColumnWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  pitch: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  return useScrollWindow(ref, count, pitch, enabled, 'column', overscan)
}

const noopMeasure = (): void => {}

export interface MeasuredWindow {
  from: number
  to: number
  topPad: number
  bottomPad: number
  measure: (key: string) => (el: HTMLElement | null) => void
  scrollToKey: (key: string) => void
}

const MEASURED_OVERSCAN_PX = 240
const MEASURED_WINDOW_SEED = 12
const MEASURED_WINDOW_MIN = 30

function heightOf(heights: ReadonlyMap<string, number>, estimate: (index: number) => number, key: string, index: number): number {
  return heights.get(key) ?? estimate(index)
}

export function useMeasuredWindow(
  ref: RefObject<HTMLElement | null>,
  keys: readonly string[],
  estimate: (index: number) => number,
  rowCount: number = keys.length,
): MeasuredWindow {
  const heights = useRef(new Map<string, number>())
  const callbacks = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const [range, setRange] = useState<RowRange | null>(null)
  const [measured, setMeasured] = useState(false)
  const [version, setVersion] = useState(0)

  const enabled = rowCount > MEASURED_WINDOW_MIN

  const offsets = useMemo(() => {
    const out = new Float64Array(keys.length + 1)
    for (let index = 0; index < keys.length; index++) {
      out[index + 1] = out[index] + heightOf(heights.current, estimate, keys[index], index)
    }
    return out
  }, [estimate, keys, version])

  const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys])

  const windowFor = useCallback((scrollTop: number, viewport: number): RowRange | null => {
    if (viewport <= 0 || keys.length === 0) return null
    const top = scrollTop - MEASURED_OVERSCAN_PX
    const bottom = scrollTop + viewport + MEASURED_OVERSCAN_PX
    let from = 0
    let lo = 0
    let hi = keys.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= top) { from = mid + 1; lo = mid + 1 } else hi = mid - 1
    }
    let to = from
    let low = from
    let high = keys.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (offsets[mid] < bottom) { to = mid; low = mid + 1 } else high = mid - 1
    }
    return { from: Math.min(from, keys.length - 1), to }
  }, [keys.length, offsets])

  useLayoutEffect(() => {
    if (!enabled) return undefined
    const el = ref.current
    setMeasured(true)
    if (el === null) {
      setRange(null)
      return
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const next = windowFor(el.scrollTop, el.clientHeight)
      setRange((current) => {
        if (current === null || next === null) return current === next ? current : next
        return current.from === next.from && current.to === next.to ? current : next
      })
    }
    const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(update) }
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
  }, [enabled, ref, windowFor])

  const observer = useRef<ResizeObserver | null>(null)
  const watched = useRef(new WeakMap<Element, string>())
  const elements = useRef(new Map<string, HTMLElement>())

  const ensureObserver = useCallback((): ResizeObserver | null => {
    /* v8 ignore next 1 */
    if (observer.current !== null || typeof ResizeObserver !== 'function') return observer.current
    observer.current = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = watched.current.get(entry.target)
        if (key === undefined) continue
        const height = entry.contentRect.height
        const previous = heights.current.get(key)
        if (previous !== undefined && Math.abs(previous - height) < 0.5) continue
        heights.current.set(key, height)
        changed = true
      }
      if (changed) setVersion(current => current + 1)
    })
    return observer.current
  }, [])

  useEffect(() => () => {
    observer.current?.disconnect()
    observer.current = null
    watched.current = new WeakMap()
    elements.current.clear()
    callbacks.current.clear()
  }, [])

  useEffect(() => {
    const live = new Set(keys)
    for (const key of heights.current.keys()) {
      if (live.has(key)) continue
      heights.current.delete(key)
      callbacks.current.delete(key)
    }
  }, [keys])

  const measure = useCallback((key: string): (el: HTMLElement | null) => void => {
    if (!enabled) return noopMeasure
    const known = callbacks.current.get(key)
    if (known !== undefined) return known
    const callback = (el: HTMLElement | null): void => {
      const instance = ensureObserver()
      if (el === null) {
        const previous = elements.current.get(key)
        /* v8 ignore next 1 */
        if (previous !== undefined) instance?.unobserve(previous)
        elements.current.delete(key)
        return
      }
      elements.current.set(key, el)
      watched.current.set(el, key)
      instance?.observe(el)
    }
    callbacks.current.set(key, callback)
    return callback
  }, [enabled, ensureObserver])

  const scrollToKey = useCallback((key: string): void => {
    const el = ref.current
    const index = indexOf.get(key)
    /* v8 ignore next 1 */
    if (el === null || index === undefined) return
    el.scrollTop = offsets[index]
  }, [indexOf, offsets, ref])

  const full: RowRange = { from: 0, to: Math.max(0, keys.length - 1) }
  const shown = !enabled
    ? full
    : (range ?? (!measured && keys.length > MEASURED_WINDOW_SEED
      ? { from: 0, to: MEASURED_WINDOW_SEED - 1 }
      : full))
  return {
    from: shown.from,
    to: shown.to,
    topPad: offsets[Math.min(shown.from, keys.length)],
    bottomPad: Math.max(0, offsets[keys.length] - offsets[Math.min(shown.to + 1, keys.length)]),
    measure,
    scrollToKey,
  }
}
