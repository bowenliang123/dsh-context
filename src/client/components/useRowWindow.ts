import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'

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

export type WindowAlign = 'start' | 'center' | 'nearest'

export interface SurfaceWindowOptions {
  axis?: 'row' | 'column'
  count: number
  getKey: (index: number) => string
  estimateSize?: (index: number) => number
  enabled?: boolean
  minCount?: number
  initial?: 'start' | 'end'
  overscan?: number
  hysteresis?: number
  leading?: number
  leadingEl?: HTMLElement | null
  anchorKey?: string | null
  focusKey?: string | null
  onFocusKeyHandled?: () => void
  seed?: number
  scrollAlign?: WindowAlign
}

export interface SurfaceWindow {
  from: number
  to: number
  topPad: number
  bottomPad: number
  enabled: boolean
  measure: (key: string) => (el: HTMLElement | null) => void
  scrollToKey: (key: string, align?: WindowAlign) => void
  scrollToIndex: (index: number, align?: WindowAlign) => void
  activeKey: string | null
  setActiveKey: (key: string | null) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  tabIndexFor: (key: string) => number
}

const DEFAULT_ESTIMATE_SIZE = 32
const DEFAULT_MIN_COUNT = 30
const DEFAULT_OVERSCAN_PX = 240
const DEFAULT_SEED = 12

const noopMeasure = (): void => {}

const constantEstimate = (): number => DEFAULT_ESTIMATE_SIZE

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1
  if (index < 0) return 0
  return index > count - 1 ? count - 1 : index
}

function watchedKeyOf(watched: WeakMap<Element, string>, target: EventTarget | null): string | null {
  let node = target instanceof Element ? target : null
  while (node !== null) {
    const key = watched.get(node)
    if (key !== undefined) return key
    node = node.parentElement
  }
  return null
}

function focusTargetOf(row: HTMLElement): HTMLElement | null {
  if (row.matches(FOCUSABLE_SELECTOR)) return row
  return row.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
}

function entryHeightOf(entry: ResizeObserverEntry): number {
  const border = (entry as { borderBoxSize?: ReadonlyArray<ResizeObserverSize> }).borderBoxSize?.[0]
  if (border !== undefined) return border.blockSize
  return entry.contentRect.height
}

function heightOf(
  heights: ReadonlyMap<string, number>,
  estimate: (index: number) => number,
  key: string,
  index: number,
): number {
  const measured = heights.get(key)
  if (measured !== undefined && Number.isFinite(measured) && measured > 0) return measured
  const value = estimate(index)
  return Number.isFinite(value) && value > 0 ? value : 1
}

interface SurfaceWindowSnapshot {
  scrollTop: number
  viewport: number
  leading: number
  offsets: Float64Array
  keys: readonly string[]
  range: RowRange
}

export function useSurfaceWindow(
  ref: RefObject<HTMLElement | null>,
  options: SurfaceWindowOptions,
): SurfaceWindow {
  const axis = options.axis ?? 'row'
  const count = Math.max(0, Math.floor(options.count))
  const getKey = options.getKey
  const estimateSize = options.estimateSize ?? constantEstimate
  const overscan = Math.max(0, options.overscan ?? DEFAULT_OVERSCAN_PX)
  const hysteresis = Math.min(Math.max(0, options.hysteresis ?? Math.floor(overscan / 2)), overscan)
  const minCount = Math.max(0, Math.floor(options.minCount ?? DEFAULT_MIN_COUNT))
  const enabledOption = options.enabled !== false
  const enabled = enabledOption && count > minCount
  const initial = options.initial ?? 'start'
  const scrollAlign = options.scrollAlign ?? 'nearest'
  const focusKey = options.focusKey ?? null
  const anchorKey = options.anchorKey ?? null
  const leadingEl = options.leadingEl ?? null
  const staticLeading = Math.max(0, options.leading ?? 0)
  const seed = Math.max(0, Math.floor(options.seed ?? DEFAULT_SEED))
  const onFocusKeyHandled = options.onFocusKeyHandled

  const keys = useMemo(
    () => Array.from({ length: count }, (_, index) => getKey(index)),
    [count, getKey],
  )
  const indexOf = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys])

  const heights = useRef(new Map<string, number>())
  const callbacks = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const elements = useRef(new Map<string, HTMLElement>())
  const watched = useRef(new WeakMap<Element, string>())
  const rowObserver = useRef<ResizeObserver | null>(null)
  const last = useRef<SurfaceWindowSnapshot | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const focusFrame = useRef(0)
  const handledFocusKey = useRef<string | null>(null)
  const inited = useRef(false)
  const [version, setVersion] = useState(0)
  const [range, setRange] = useState<RowRange | null>(null)
  const appliedRange = useRef<RowRange | null>(null)
  const [activeKey, setActiveKeyState] = useState<string | null>(null)

  const offsets = useMemo(() => {
    const out = new Float64Array(keys.length + 1)
    for (let index = 0; index < keys.length; index++) {
      out[index + 1] = out[index] + heightOf(heights.current, estimateSize, keys[index], index)
    }
    return out
  }, [estimateSize, keys, version])

  const readScroll = useCallback((el: HTMLElement): number => (
    axis === 'row' ? el.scrollTop : el.scrollLeft
  ), [axis])

  const readViewport = useCallback((el: HTMLElement): number => (
    axis === 'row' ? el.clientHeight : el.clientWidth
  ), [axis])

  const writeScroll = useCallback((el: HTMLElement, value: number): void => {
    if (axis === 'row') el.scrollTop = value
    else el.scrollLeft = value
  }, [axis])

  const measureLeading = useCallback((el: HTMLElement): number => {
    if (leadingEl === null) return staticLeading
    const boxRect = el.getBoundingClientRect()
    /* v8 ignore next 1 */
    if (!(boxRect.width > 0) && !(boxRect.height > 0)) return staticLeading
    const listRect = leadingEl.getBoundingClientRect()
    const raw = axis === 'row' ? listRect.top - boxRect.top : listRect.left - boxRect.left
    const value = raw + readScroll(el)
    return Number.isFinite(value) && value > 0 ? value : 0
  }, [axis, leadingEl, readScroll, staticLeading])

  const apply = useCallback((force: boolean): void => {
    const el = ref.current
    if (el === null) {
      last.current = null
      if (appliedRange.current !== null) {
        appliedRange.current = null
        setRange(null)
      }
      return
    }
    let viewport = readViewport(el)
    let scrollTop = readScroll(el)
    if (!Number.isFinite(viewport) || viewport < 0) viewport = 0
    if (!Number.isFinite(scrollTop)) scrollTop = 0
    const leading = measureLeading(el)
    const totalContent = leading + offsets[count]
    const previous = last.current
    if (!force && previous !== null && Math.abs(scrollTop - previous.scrollTop) < hysteresis && viewport === previous.viewport) {
      return
    }
    if (previous !== null && previous.keys === keys) {
      const anchorIndex = anchorKey !== null && indexOf.has(anchorKey)
        ? indexOf.get(anchorKey) as number
        : clampIndex(previous.range.from, count)
      const nextTop = offsets[anchorIndex] + leading
      const previousTop = previous.offsets[anchorIndex] + previous.leading
      const delta = nextTop - previousTop
      if (Math.abs(delta) >= 0.5) {
        const shifted = scrollTop + delta
        scrollTop = shifted < 0 ? 0 : shifted
        writeScroll(el, scrollTop)
      }
    }
    if (!inited.current) {
      if (initial === 'start') {
        inited.current = true
      } else if (viewport > 0) {
        const maxTop = Math.max(0, totalContent - viewport)
        scrollTop = maxTop
        writeScroll(el, maxTop)
        inited.current = true
      }
    }
    const top = scrollTop - overscan - leading
    const bottom = viewport > 0
      ? scrollTop + viewport + overscan - leading
      : top + overscan * 2
    let from = 0
    let low = 0
    let high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (offsets[mid + 1] <= top) { from = mid + 1; low = mid + 1 } else high = mid - 1
    }
    from = clampIndex(from, count)
    let to = from
    low = from
    high = count - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (offsets[mid] <= bottom) { to = mid; low = mid + 1 } else high = mid - 1
    }
    to = clampIndex(Math.max(from, to), count)
    const next: RowRange = { from, to: Math.max(from, to) }
    last.current = { scrollTop, viewport, leading, offsets, keys, range: next }
    const applied = appliedRange.current
    if (applied !== null && applied.from === next.from && applied.to === next.to) return
    appliedRange.current = next
    setRange(next)
  }, [
    anchorKey, count, enabled, hysteresis, indexOf, initial, keys, measureLeading,
    offsets, overscan, readScroll, readViewport, ref, writeScroll,
  ])

  useLayoutEffect(() => {
    if (!enabled) {
      if (appliedRange.current === null) return undefined
      appliedRange.current = null
      setRange(null)
      return undefined
    }
    const el = ref.current
    if (el === null) {
      apply(true)
      return undefined
    }
    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        apply(false)
      })
    }
    const onFocusIn = (event: FocusEvent): void => {
      const key = watchedKeyOf(watched.current, event.target)
      if (key === null) return
      setActiveKeyState(current => (current === key ? current : key))
    }
    el.addEventListener('scroll', schedule, { passive: true })
    el.addEventListener('focusin', onFocusIn)
    /* v8 ignore start */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(el)
    /* v8 ignore stop */
    apply(true)
    return () => {
      el.removeEventListener('scroll', schedule)
      el.removeEventListener('focusin', onFocusIn)
      if (frame !== 0) cancelAnimationFrame(frame)
      /* v8 ignore next 1 */
      observer?.disconnect()
    }
  }, [apply, enabled, ref])

  const ensureObserver = useCallback((): ResizeObserver | null => {
    if (rowObserver.current !== null) return rowObserver.current
    /* v8 ignore next 1 */
    if (typeof ResizeObserver !== 'function') return null
    rowObserver.current = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = watched.current.get(entry.target)
        if (key === undefined) continue
        const height = entryHeightOf(entry)
        const previous = heights.current.get(key)
        if (previous !== undefined && Math.abs(previous - height) < 0.5) continue
        heights.current.set(key, height)
        changed = true
      }
      if (changed) setVersion(current => current + 1)
    })
    return rowObserver.current
  }, [])

  useEffect(() => () => {
    rowObserver.current?.disconnect()
    rowObserver.current = null
    watched.current = new WeakMap()
    elements.current.clear()
    callbacks.current.clear()
    heights.current.clear()
    last.current = null
    appliedRange.current = null
    pendingFocus.current = null
    inited.current = false
    if (focusFrame.current !== 0) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = 0
  }, [])

  useEffect(() => {
    const live = new Set(keys)
    for (const key of heights.current.keys()) {
      if (live.has(key)) continue
      heights.current.delete(key)
      callbacks.current.delete(key)
      elements.current.delete(key)
    }
    if (activeKey !== null && !live.has(activeKey)) setActiveKeyState(null)
  }, [activeKey, keys])

  const measure = useCallback((key: string): (el: HTMLElement | null) => void => {
    if (!enabled) return noopMeasure
    const known = callbacks.current.get(key)
    if (known !== undefined) return known
    const callback = (el: HTMLElement | null): void => {
      const observer = ensureObserver()
      if (el === null) {
        const previous = elements.current.get(key)
        /* v8 ignore next 1 */
        if (previous !== undefined) observer?.unobserve(previous)
        elements.current.delete(key)
        return
      }
      elements.current.set(key, el)
      watched.current.set(el, key)
      observer?.observe(el)
    }
    callbacks.current.set(key, callback)
    return callback
  }, [enabled, ensureObserver])

  const scrollToIndex = useCallback((index: number, align: WindowAlign = scrollAlign): void => {
    const el = ref.current
    const target = clampIndex(index, count)
    if (el === null || target < 0) return
    const viewport = readViewport(el)
    const leading = measureLeading(el)
    const top = leading + offsets[target]
    const size = offsets[target + 1] - offsets[target]
    const current = readScroll(el)
    const total = leading + offsets[count]
    let next = current
    if (align === 'start') {
      next = top
    } else if (align === 'center') {
      next = top + size / 2 - viewport / 2
    } else if (viewport > 0 && (top < current || top + size > current + viewport)) {
      next = top + size > current + viewport ? top + size - viewport : top
    }
    const maxTop = Math.max(0, total - viewport)
    next = next < 0 ? 0 : next > maxTop ? maxTop : next
    if (next !== current) writeScroll(el, next)
    apply(true)
  }, [apply, count, measureLeading, offsets, readScroll, readViewport, ref, scrollAlign, writeScroll])

  const scheduleFocus = useCallback((key: string): void => {
    pendingFocus.current = key
    if (focusFrame.current !== 0) cancelAnimationFrame(focusFrame.current)
    let attempts = 4
    const attempt = (): void => {
      focusFrame.current = 0
      const pending = pendingFocus.current
      /* v8 ignore next 1 */
      if (pending === null) return
      const row = elements.current.get(pending)
      const node = row === undefined ? null : focusTargetOf(row)
      if (node !== null) {
        pendingFocus.current = null
        node.focus()
        return
      }
      attempts -= 1
      if (attempts <= 0) {
        pendingFocus.current = null
        return
      }
      focusFrame.current = requestAnimationFrame(attempt)
    }
    focusFrame.current = requestAnimationFrame(attempt)
  }, [])

  useLayoutEffect(() => {
    if (!enabled || focusKey === null) {
      if (focusKey === null) handledFocusKey.current = null
      return
    }
    if (handledFocusKey.current === focusKey) return
    handledFocusKey.current = focusKey
    const index = indexOf.get(focusKey)
    setActiveKeyState(current => (current === focusKey ? current : focusKey))
    if (index !== undefined) {
      scrollToIndex(index, scrollAlign)
      scheduleFocus(focusKey)
    }
    if (onFocusKeyHandled !== undefined) onFocusKeyHandled()
  }, [enabled, focusKey, indexOf, onFocusKeyHandled, scheduleFocus, scrollAlign, scrollToIndex])

  const scrollToKey = useCallback((key: string, align: WindowAlign = scrollAlign): void => {
    const index = indexOf.get(key)
    if (index === undefined) return
    scrollToIndex(index, align)
  }, [indexOf, scrollAlign, scrollToIndex])

  const setActiveKey = useCallback((key: string | null): void => {
    setActiveKeyState(current => (current === key ? current : key))
  }, [])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!enabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
    const el = ref.current
    if (el === null) return
    const key = watchedKeyOf(watched.current, target)
    const known = key !== null ? indexOf.get(key) : undefined
    /* v8 ignore next 1 */
    const current = known !== undefined ? known : clampIndex(range !== null ? range.from : 0, count)
    const page = nextPageRows(readViewport(el), offsets, count, overscan)
    let next = current
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = current + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = current - 1
    else if (event.key === 'PageDown') next = current + page
    else if (event.key === 'PageUp') next = current - page
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    const nextIndex = clampIndex(next, count)
    const nextKey = getKey(nextIndex)
    setActiveKeyState(cur => (cur === nextKey ? cur : nextKey))
    scrollToIndex(nextIndex, 'nearest')
    scheduleFocus(nextKey)
  }, [count, enabled, getKey, indexOf, offsets, overscan, range, readViewport, ref, scheduleFocus, scrollToIndex])

  const tabIndexFor = useCallback((key: string): number => {
    if (!enabled) return 0
    const index = indexOf.get(key)
    if (index === undefined) return -1
    const windowed = range
    if (windowed === null) return index === 0 ? 0 : -1
    if (activeKey !== null) {
      const active = indexOf.get(activeKey)
      if (active !== undefined && active >= windowed.from && active <= windowed.to) return index === active ? 0 : -1
    }
    return index === windowed.from ? 0 : -1
  }, [activeKey, count, enabled, indexOf, range])

  const fullRange: RowRange = { from: 0, to: Math.max(0, count - 1) }
  const seeded: RowRange = { from: 0, to: Math.max(0, Math.min(seed, count) - 1) }
  const shown = !enabled ? fullRange : range ?? (count > seed ? seeded : fullRange)
  return {
    from: shown.from,
    to: shown.to,
    topPad: offsets[Math.min(shown.from, count)],
    bottomPad: Math.max(0, offsets[count] - offsets[Math.min(shown.to + 1, count)]),
    enabled,
    measure,
    scrollToKey,
    scrollToIndex,
    activeKey,
    setActiveKey,
    onKeyDown,
    tabIndexFor,
  }
}

function nextPageRows(viewport: number, offsets: Float64Array, count: number, overscan: number): number {
  const pitch = Math.max(1, offsets[count] / count)
  const span = viewport > 0 ? viewport : overscan
  return Math.max(1, Math.floor(span / pitch))
}

export function useRowWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  const getKey = useCallback((index: number): string => String(index), [])
  const estimateSize = useCallback((): number => (rowHeight > 0 ? rowHeight : 1), [rowHeight])
  const scope = useSurfaceWindow(ref, {
    axis: 'row',
    count,
    getKey,
    estimateSize,
    enabled,
    minCount: 0,
    overscan: Math.max(1, overscan) * Math.max(1, rowHeight),
    hysteresis: 0,
    seed: Math.min(count, ROW_WINDOW_OVERSCAN),
  })
  return { from: scope.from, to: scope.to }
}

export function useColumnWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  pitch: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  const getKey = useCallback((index: number): string => String(index), [])
  const estimateSize = useCallback((): number => (pitch > 0 ? pitch : 1), [pitch])
  const scope = useSurfaceWindow(ref, {
    axis: 'column',
    count,
    getKey,
    estimateSize,
    enabled,
    minCount: 0,
    overscan: Math.max(1, overscan) * Math.max(1, pitch),
    hysteresis: 0,
    seed: Math.min(count, ROW_WINDOW_OVERSCAN),
  })
  return { from: scope.from, to: scope.to }
}

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

export function useMeasuredWindow(
  ref: RefObject<HTMLElement | null>,
  keys: readonly string[],
  estimate: (index: number) => number,
  rowCount: number = keys.length,
): MeasuredWindow {
  const getKey = useCallback((index: number): string => keys[index], [keys])
  const scope = useSurfaceWindow(ref, {
    count: keys.length,
    getKey,
    estimateSize: estimate,
    enabled: rowCount > MEASURED_WINDOW_MIN,
    minCount: 0,
    overscan: MEASURED_OVERSCAN_PX,
    hysteresis: 0,
    seed: MEASURED_WINDOW_SEED,
    scrollAlign: 'start',
  })
  return {
    from: scope.from,
    to: scope.to,
    topPad: scope.topPad,
    bottomPad: scope.bottomPad,
    measure: scope.measure,
    scrollToKey: scope.scrollToKey,
  }
}

export interface RowGeometry {
  pitch: number
  gap: number
}

export function rowGeometryOf(items: readonly HTMLElement[]): RowGeometry | null {
  if (items.length < 2) return null
  const rects = items.map(item => item.getBoundingClientRect())
  const height = Math.round(rects[0].height)
  if (!(height > 4)) return null
  const pitch = Math.round(rects[1].top - rects[0].top)
  if (!(pitch > height)) return null
  for (let i = 0; i < rects.length; i++) {
    if (Math.abs(Math.round(rects[i].height) - height) > 1) return null
    if (i > 0 && Math.abs(Math.round(rects[i].top - rects[i - 1].top) - pitch) > 1) return null
  }
  return { pitch, gap: Math.max(0, pitch - height) }
}

export function useRowGeometry(
  ref: RefObject<HTMLElement | null>,
  count: number,
  selector: string,
  signature: string,
  enabled = true,
): RowGeometry | null {
  const [measured, setMeasured] = useState<{ signature: string; geometry: RowGeometry | null } | null>(null)
  useLayoutEffect(() => {
    if (!enabled || count < 2) return
    const el = ref.current
    /* v8 ignore next 1 */
    if (el === null) return
    const items = [...el.querySelectorAll<HTMLElement>(selector)]
    /* v8 ignore next 1 */
    if (items.length !== count) return
    setMeasured({ signature, geometry: rowGeometryOf(items) })
  }, [count, enabled, ref, selector, signature])
  return measured !== null && measured.signature === signature ? measured.geometry : null
}

export interface WindowedRows {
  from: number
  to: number
  topPad: number
  bottomPad: number
  pitch: number
}

export function useWindowedRows(
  ref: RefObject<HTMLElement | null>,
  count: number,
  geometry: RowGeometry | null,
  enabled: boolean,
): WindowedRows {
  const pitch = geometry === null ? 1 : geometry.pitch
  const gap = geometry === null ? 0 : geometry.gap
  const range = useRowWindow(ref, count, pitch, enabled)
  const last = Math.max(0, count - 1)
  const from = Math.min(range.from, last)
  const to = Math.min(range.to, last)
  return {
    from,
    to,
    topPad: from > 0 ? Math.max(0, from * pitch - gap) : 0,
    bottomPad: to < last ? Math.max(0, (last - to) * pitch - gap) : 0,
    pitch,
  }
}
