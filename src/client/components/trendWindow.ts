/** One bar column: 14px bar + 2px gap. The turn strip and the windowing math share this grid. */
export const BAR_W = 14
export const BAR_GAP = 2
/** Under this many columns every bar renders; above it the chart renders only the visible window + overscan. */
export const TREND_WINDOW_MIN = 240
export const WINDOW_OVERSCAN_BARS = 36
export const WINDOW_HYSTERESIS_BARS = 8

export interface BarWindow {
  from: number
  to: number
}

/** A large history mounts anchored to its newest bars (the layout effect then scrolls there). */
export function initialBarWindow(n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  return n <= TREND_WINDOW_MIN ? { from: 0, to: Math.max(0, n - 1) } : { from: Math.max(0, n - 1 - 4 * overscan), to: n - 1 }
}

/** The range that must exist for the current scroll position, expressed in bar indices. */
export function windowRangeFor(scrollLeft: number, clientWidth: number, n: number, overscan: number = WINDOW_OVERSCAN_BARS): BarWindow {
  if (n <= TREND_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  const pitch = BAR_W + BAR_GAP
  const from = Math.min(n - 1, Math.max(0, Math.floor(scrollLeft / pitch) - overscan))
  const to = Math.min(n - 1, Math.ceil((scrollLeft + clientWidth) / pitch) + overscan)
  return { from, to: Math.max(from, to) }
}

/** Keep the rendered range until the scroll position leaves its overscan; then re-fill around the new position. */
export function nextBarWindow(prev: BarWindow, desired: BarWindow, n: number, hysteresis: number = WINDOW_HYSTERESIS_BARS): BarWindow {
  if (n <= TREND_WINDOW_MIN) return { from: 0, to: Math.max(0, n - 1) }
  if (desired.from >= prev.from && desired.to <= prev.to) return prev
  return {
    from: Math.max(0, desired.from - hysteresis),
    to: Math.min(n - 1, desired.to + hysteresis),
  }
}

/** Flex-row padding that reproduces the skipped columns exactly (one 2px gap joins each side to the rendered bars). */
export function windowPads(from: number, to: number, n: number): { left: number; right: number } {
  const pitch = BAR_W + BAR_GAP
  return {
    left: from > 0 ? from * pitch - BAR_GAP : 0,
    right: to < n - 1 ? (n - 1 - to) * pitch - BAR_GAP : 0,
  }
}
