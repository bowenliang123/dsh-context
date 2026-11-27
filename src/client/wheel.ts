export const WHEEL_LINE_PX = 16

export function wheelDeltaPx(deltaY: number, deltaMode: number, pagePx: number): number {
  return deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * pagePx : deltaY
}

export function isVerticalWheel(e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaX' | 'deltaY'>): boolean {
  return !e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)
}
