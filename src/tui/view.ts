/** Element builders the panel and the scene share; every element goes through the host's injected React. */

import type { ReactNode } from 'react'
import { fmt } from '../client/format'
import type { Translate } from '../client/i18n'
import type { ChartKit, HostReact, SurfaceHost, SurfaceUi, TableColumn, TableProps } from './hostTypes'
import { legendItems, occupancyBars, truncateStart, type EventRow, type FileRow, type Occupancy } from './model'

export interface Draw {
  h: HostReact['createElement']
  ui: SurfaceUi
  kit: ChartKit
  t: Translate
}

export function notice(h: HostReact['createElement'], ui: SurfaceUi, text: string): ReactNode {
  return h(ui.Box, { flexDirection: 'column', paddingX: 1 }, h(ui.Text, { dimColor: true, wrap: 'wrap' }, text))
}

type LineProps = { color?: string; bold?: boolean; dimColor?: boolean; inverse?: boolean }

export function line(d: Draw, text: string, props: LineProps = {}): ReactNode {
  return d.h(d.ui.Text, { ...props, wrap: 'truncate-end' }, text)
}

export function occupancyBlock(d: Draw, o: Occupancy, width: number, legendRows: number): ReactNode[] {
  const bars = occupancyBars(o, width).map((bar, i) => d.h(d.kit.StackedBar, { key: String(i), ...bar, emptyColor: 'subtle' }))
  const out: ReactNode[] = [d.h(d.ui.Box, { key: 'bar', flexDirection: 'row', width }, ...bars)]
  const items = legendItems(o, d.t)
  if (legendRows > 0 && items.length > 0) out.push(d.h(d.kit.Legend, { key: 'legend', items, width, maxRows: legendRows }))
  return out
}

/** Narrowest label an event row keeps before it gives up a figure. */
const MIN_EVENT_LABEL = 12

/** The meta strip of one event row: the time goes first, then the turn, while the label would fall under its minimum. */
export function eventMeta(row: EventRow, width: number, time: string, measure: (text: string) => number): string {
  const parts = [row.tokens, row.at, time].filter((m): m is string => m !== null && m !== '')
  const room = (): number => width - measure(row.glyph) - 1 - (parts.length > 0 ? measure(parts.join(' ')) + 1 : 0)
  while (room() < MIN_EVENT_LABEL && parts.length > 1) parts.pop()
  return parts.join(' ')
}

/** One event per line, every part at its exact width so nothing wraps: the label is cut, never the figures. */
export function eventLine(d: Draw, row: EventRow, width: number, selected: boolean): ReactNode {
  const { cells, truncate, relativeTime } = d.kit.format
  const meta = eventMeta(row, width, relativeTime(row.time), cells)
  const room = Math.max(0, width - cells(row.glyph) - 1 - (meta === '' ? 0 : cells(meta) + 1))
  const label = truncate(`${row.kindLabel} · ${row.label}`, room)
  return d.h(d.ui.Box, { key: String(row.seq), flexDirection: 'row', width },
    d.h(d.ui.Text, { color: row.tone, inverse: selected }, row.glyph + ' '),
    d.h(d.ui.Text, { inverse: selected, wrap: 'truncate-end' }, label + ' '.repeat(Math.max(0, room - cells(label)))),
    ...(meta === '' ? [] : [d.h(d.ui.Text, { key: 'meta', dimColor: true }, ' ' + meta)]))
}

function count(n: number): string | number {
  return n > 0 ? n : '·'
}

/** The file table; narrow widths drop the search and line-delta columns before the path loses its name. */
export function fileTable(d: Draw, rows: readonly FileRow[], width: number, selected: number | undefined, timed = false): ReactNode {
  const wide = width >= 40
  const fixed: (TableColumn & { width: number })[] = [
    { key: 'r', title: 'R', width: 3, align: 'right' },
    { key: 'w', title: 'W', width: 3, align: 'right' },
    ...(wide ? [{ key: 's', title: 'S', width: 3, align: 'right' as const }, { key: 'd', title: '+/−', width: 11, align: 'right' as const }] : []),
    ...(timed && wide ? [{ key: 't', title: '', width: 4, align: 'right' as const }] : []),
  ]
  let used = fixed.length
  for (const c of fixed) used += c.width
  const pathWidth = Math.max(4, width - used)
  const props: TableProps = {
    columns: [{ key: 'path', title: d.t('files.title'), width: pathWidth }, ...fixed],
    rows: rows.map(row => ({
      path: truncateStart(row.display, pathWidth, d.kit.format.cells),
      r: count(row.reads),
      w: count(row.writes),
      s: count(row.searches),
      d: row.added + row.removed > 0 ? `+${fmt(row.added)} −${fmt(row.removed)}` : '·',
      t: row.time !== undefined ? d.kit.format.relativeTime(row.time) : '',
    })),
    width,
    ...(selected !== undefined ? { selected } : {}),
  }
  return d.h(d.kit.Table, { key: 'files', ...props })
}

export function openFile(host: SurfaceHost | undefined, file: FileRow, t: Translate): void {
  const at = file.line !== undefined ? { line: file.line } : undefined
  const opened = file.abs !== undefined && host?.openFile?.(file.abs, at) === true
  if (!opened) host?.toast?.(t('tui.openFailed', { path: file.display }))
}
