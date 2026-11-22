export const BAR_W = 14
export const BAR_GAP = 2
export const TIMELINE_WINDOW_MIN = 240
export const WINDOW_OVERSCAN_BARS = 36
export const WINDOW_HYSTERESIS_BARS = 8

export interface BarWindow {
  from: number
  to: number
}

export function initialBarWindow(n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  return n <= TIMELINE_WINDOW_MIN ? { from: 0, to: Math.max(0, n - 1) } : { from: Math.max(0, n - 1 - 4 * overscan), to: n - 1 }
}

export function windowRangeFor(scrollLeft: number, clientWidth: number, n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  if (n <= TIMELINE_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  const pitch = BAR_W + BAR_GAP
  const from = Math.min(n - 1, Math.max(0, Math.floor(scrollLeft / pitch) - overscan))
  const to = Math.min(n - 1, Math.ceil((scrollLeft + clientWidth) / pitch) + overscan)
  return { from, to: Math.max(from, to) }
}

export function nextBarWindow(prev: BarWindow, desired: BarWindow, n: number, hysteresis: number = WINDOW_HYSTERESIS_BARS): BarWindow {
  if (n <= TIMELINE_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  if (desired.from >= prev.from && desired.to <= prev.to) return prev
  return {
    from: Math.max(0, desired.from - hysteresis),
    to: Math.min(n - 1, desired.to + hysteresis),
  }
}

export function windowPads(from: number, to: number, n: number): { left: number; right: number } {
  const pitch = BAR_W + BAR_GAP
  return {
    left: from > 0 ? from * pitch - BAR_GAP : 0,
    right: to < n - 1 ? (n - 1 - to) * pitch - BAR_GAP : 0,
  }
}
