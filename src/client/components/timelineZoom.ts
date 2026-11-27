import { wheelDeltaPx } from '../wheel'

export const ZOOM_FIT = 1
export const ZOOM_CAP_FLOOR = 2
export const ZOOM_MAX = 40
export const ZOOM_PITCH_PX = 24
export const ZOOM_WHEEL_RATE = 0.0015

export interface ZoomAnchor {
  frac: number
  vx: number
}

export function wheelZoomFactor(deltaY: number, deltaMode: number, pagePx: number): number {
  return Math.exp(-wheelDeltaPx(deltaY, deltaMode, pagePx) * ZOOM_WHEEL_RATE)
}

export function maxZoomOf(paneWidth: number, indexSpan: number): number {
  if (paneWidth <= 0 || indexSpan <= 0) return ZOOM_MAX
  return Math.min(ZOOM_MAX, Math.max(ZOOM_CAP_FLOOR, ZOOM_PITCH_PX * indexSpan / paneWidth))
}

export function clampZoom(zoom: number, maxZoom: number): number {
  return Math.min(Math.max(zoom, ZOOM_FIT), Math.max(ZOOM_FIT, maxZoom))
}

export function zoomAnchorOf(scrollLeft: number, vx: number, contentWidth: number): ZoomAnchor {
  return { frac: Math.min(1, Math.max(0, (scrollLeft + vx) / Math.max(1, contentWidth))), vx }
}

export function anchoredScrollLeft(anchor: ZoomAnchor, contentWidth: number, paneWidth: number): number {
  const max = Math.max(0, contentWidth - paneWidth)
  return Math.min(max, Math.max(0, anchor.frac * contentWidth - anchor.vx))
}

export function zoomLabelOf(zoom: number): string {
  return '×' + String(Math.round(zoom * 10) / 10)
}
