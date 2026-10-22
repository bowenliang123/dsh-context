import { briefNodes, briefOf } from '../client/brief'
import { CATS } from '../client/categories'
import { aggregateByTurn, attachMarkers } from '../client/records'
import type { ContextTimeline, DefaultGranularity } from '../shared/types'
import type { ColumnChartColumn } from './hostTypes'
import { nodeLabel } from './model'

export interface TrendColumn extends ColumnChartColumn {
  seq: number
  turn: number
  step: number
  stepCount: number
  total: number
  time: number
}

export function trendColumns(timeline: ContextTimeline, granularity: DefaultGranularity): TrendColumn[] {
  const records = granularity === 'turn' ? aggregateByTurn(timeline.requests) : timeline.requests
  const markers = attachMarkers(records, timeline.events)
  return records.map((req, i) => ({
    seq: req.seq,
    turn: req.turn ?? 0,
    step: req.step ?? 0,
    stepCount: req.stepCount ?? 1,
    total: req.total,
    time: req.time,
    segments: CATS.map((c, slot) => ({ value: req[c.key] ?? 0, color: slot })),
    ...(markers[i] !== undefined ? { marker: '✂', markerColor: 'warning' } : {}),
  }))
}

/** Columns as wide as the width allows (1–4 cells, a gap once they are 2+), one cell each when they outnumber it. */
export function trendGeometry(count: number, width: number): { columnWidth: number; gap: number; capacity: number } {
  const slot = Math.min(5, Math.max(1, Math.floor(width / Math.max(1, count))))
  const gap = slot >= 3 ? 1 : 0
  const columnWidth = slot - gap
  return { columnWidth, gap, capacity: Math.max(1, Math.floor((width + gap) / slot)) }
}

export function clampCursor(cursor: number, length: number): number {
  return Math.min(cursor, Math.max(0, length - 1))
}

/** The visible slice keeps `selected` in view: pinned to the newest end until the selection walks off it, then centered. */
export function visibleRange(count: number, selected: number, capacity: number): { start: number; end: number } {
  if (count <= capacity) return { start: 0, end: count }
  const start = Math.min(count - capacity, Math.max(0, selected - Math.floor(capacity / 2)))
  return { start, end: start + capacity }
}

export function cursorWindow(length: number, cursor: number, capacity: number): { cursor: number; start: number; end: number } {
  const at = clampCursor(cursor, length)
  return { cursor: at, ...visibleRange(length, at, capacity) }
}

export interface StepBrief {
  user?: string
  inputs: string[]
  response?: string
}

export function stepBrief(timeline: ContextTimeline, seq: number): StepBrief {
  const brief = briefOf(briefNodes(timeline), timeline.requests, timeline.requests.findIndex(r => r.seq === seq))
  if (brief === null) return { inputs: [] }
  const user = brief.opener?.text
  return {
    ...(user !== undefined ? { user } : {}),
    inputs: brief.inputs.map(nodeLabel),
    ...(brief.response !== undefined ? { response: nodeLabel(brief.response) } : {}),
  }
}
