import type { PartsPart } from '../client/categories'
import { makeEventText } from '../client/eventText'
import { absPathOf, activityOfOps, displayPathOf, fileComparators, type FileEntry } from '../client/fileActivity'
import { fmt } from '../client/format'
import { headlineOf, occupancyPercent } from '../client/headline'
import type { Translate } from '../client/i18n'
import type { ContextReserve } from '../client/reserve'
import type { ContextEventRecord, ContextTimeline, DefaultFileSort, SurfaceNode } from '../shared/types'
import type { HostUsage } from './detect'
import type { LegendItem, StackedBarSegment } from './hostTypes'

export interface Occupancy {
  tokens: number
  window?: number
  pct: number | null
  /** The seven categories in `CATS` order — a part's index is its palette slot. */
  parts: PartsPart[]
  reserve?: ContextReserve
}

/** The host's usage figure anchors the headline, so the panel and the host footer print the same occupancy. */
export function occupancyOf(timeline: ContextTimeline | null, usage: HostUsage): Occupancy | null {
  const occupancy = usage.occupancy
  if (timeline !== null) {
    const pressure = occupancy === undefined ? null : {
      projectedTokens: occupancy.usedTokens,
      ...(occupancy.contextWindow !== undefined ? { contextWindow: occupancy.contextWindow } : {}),
    }
    return headlineOf(timeline, pressure, usage.breakdown ?? null)
  }
  if (occupancy === undefined) return null
  const window = occupancy.contextWindow
  return {
    tokens: occupancy.usedTokens,
    pct: window === undefined ? null : occupancyPercent(occupancy.usedTokens, window),
    parts: [],
    ...(window !== undefined ? { window } : {}),
  }
}

export function headlineText(o: Occupancy, t: Translate): string {
  const used = o.window !== undefined ? `${fmt(o.tokens)}/${fmt(o.window)}` : fmt(o.tokens)
  return o.pct === null ? `${t('tui.title')} · ${used}` : `${t('tui.title')} ${o.pct.toFixed(1)}% · ${used}`
}

export interface BarSpec {
  width: number
  capacity?: number
  segments: StackedBarSegment[]
}

/** The window as one bar (one accent span before any composition is known), its compaction reserve hatched at the TRUE
 * tail: the masks tile `[window − output − headroom, window]`, so the used span draws against the masks' left edge and the
 * tail bar carries the masks (reserve.ts). */
export function occupancyBars(o: Occupancy, width: number): BarSpec[] {
  const parts: StackedBarSegment[] = o.parts.length > 0
    ? o.parts.map((p, slot) => ({ value: p.value, color: slot }))
    : [{ value: o.tokens, color: 'accent' }]
  const window = o.window
  if (window === undefined || window <= 0) return [{ width, segments: parts }]
  const reserve = o.reserve
  const start = reserve === undefined ? window : window - reserve.output - reserve.headroom
  const tail = Math.round(width * (window - start) / window)
  if (reserve === undefined || tail < 1 || tail >= width) return [{ width, capacity: window, segments: parts }]
  let used = 0
  for (const p of parts) used += p.value
  const fit = used > start ? start / used : 1
  const overflow = Math.min(Math.max(0, used - start), window - start)
  return [
    { width: width - tail, capacity: start, segments: parts.map(p => ({ ...p, value: p.value * fit })) },
    {
      width: tail,
      segments: [
        { value: overflow, color: 'warning' },
        { value: Math.max(0, reserve.headroom - overflow), color: 'warning', hatch: true },
        { value: Math.max(0, reserve.output - Math.max(0, overflow - reserve.headroom)), color: 'inactive', hatch: true },
      ],
    },
  ]
}

export function legendItems(o: Occupancy, t: Translate): LegendItem[] {
  const items: LegendItem[] = []
  o.parts.forEach((p, slot) => {
    const raw = p.raw ?? p.value
    if (raw > 0) items.push({ color: slot, label: t('cat.' + p.key), value: '≈' + fmt(raw) })
  })
  return items
}

const EVENT_GLYPHS: Record<ContextEventRecord['kind'], string> = { inject: '+', compaction: '✂', prune: '✂', model: '⇆', mode: '⇄' }

export interface EventRow {
  seq: number
  kind: ContextEventRecord['kind']
  glyph: string
  kindLabel: string
  label: string
  at: string | null
  tokens: string | null
  tone: 'success' | 'warning'
  time: number
}

/** Newest first, like the web list; `kind` narrows to one event kind. */
export function eventRows(events: readonly ContextEventRecord[], t: Translate, kind?: ContextEventRecord['kind']): EventRow[] {
  const { eventLabel, eventAt } = makeEventText(t)
  const rows: EventRow[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (kind !== undefined && ev.kind !== kind) continue
    const inflow = ev.kind === 'inject'
    rows.push({
      seq: ev.seq,
      kind: ev.kind,
      glyph: EVENT_GLYPHS[ev.kind],
      kindLabel: t('kind.' + ev.kind),
      label: eventLabel(ev),
      at: eventAt(ev),
      tokens: ev.tokens ? (inflow ? '+' : '−') + fmt(ev.tokens) : null,
      tone: inflow ? 'success' : 'warning',
      time: ev.time,
    })
  }
  return rows
}

export interface FileRow {
  path: string
  display: string
  /** Absent for a search pattern or a relative path with no workspace to anchor it. */
  abs?: string
  /** The newest op's exact read window start, the line `openFile` lands on. */
  line?: number
  reads: number
  writes: number
  searches: number
  added: number
  removed: number
  time?: number
}

/** The op-log generation only: an older host serves no `fileOps`, and the legacy join needs conversation content. */
export function fileRows(timeline: ContextTimeline | null, cwd: string | undefined, sort: DefaultFileSort): FileRow[] {
  if (timeline?.fileOps === undefined) return []
  const displayOf = (e: FileEntry): string => (e.pattern === true ? e.path : displayPathOf(e.path, cwd))
  const entries = activityOfOps(timeline.fileOps, timeline.archive, null).entries
  return entries.sort(fileComparators(e => e.ops.length, displayOf)[sort]).map((entry): FileRow => {
    const newest = entry.ops[0]
    const abs = entry.pattern === true ? undefined : absPathOf(entry.path, cwd)
    const read = newest.read
    return {
      path: entry.path,
      display: displayOf(entry),
      ...(abs !== undefined ? { abs } : {}),
      ...(read !== undefined && 'start' in read ? { line: read.start } : {}),
      reads: entry.reads,
      writes: entry.writes,
      searches: entry.searches,
      added: entry.added,
      removed: entry.removed,
      ...(newest.time !== undefined ? { time: newest.time } : {}),
    }
  })
}

export function truncateStart(text: string, cells: number, measure: (text: string) => number): string {
  if (cells <= 0) return ''
  if (measure(text) <= cells) return text
  const chars = Array.from(text)
  let out = ''
  let used = 1
  for (let i = chars.length - 1; i >= 0; i--) {
    const width = measure(chars[i])
    if (used + width > cells) break
    out = chars[i] + out
    used += width
  }
  return '…' + out
}

export function nodeLabel(n: SurfaceNode): string {
  const text = n.text ?? ''
  if (n.cat === 'tool' && n.tool !== undefined) return text === '' ? n.tool : `${n.tool}: ${text}`
  const skill = n.cat === 'skill' ? n.skill ?? n.name : undefined
  if (skill !== undefined) return skill
  if (n.cat === 'inject' && n.name !== undefined) return text === '' ? n.name : `${n.name}: ${text}`
  if (text === '' && n.calls !== undefined && n.calls.length > 0) return '→ ' + n.calls.join(', ')
  return text === '' ? `#${n.seq}` : text
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Wrap to `width` display cells, breaking after the last space when a line has one; `\n` starts a new paragraph. A tab
 * becomes a space and other control characters drop: the measure counts them as no cells, the terminal does not. */
export function wrapCells(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\t/g, ' ').replace(/[\0-\x09\x0b-\x1f\x7f-\x9f]/g, '').split('\n')) {
    let line = ''
    let used = 0
    for (const { segment } of graphemes.segment(paragraph)) {
      const cells = measure(segment)
      if (used + cells > width && line !== '' && segment === ' ') {
        lines.push(line)
        line = ''
        used = 0
        continue
      }
      if (used + cells > width && line !== '') {
        const space = line.lastIndexOf(' ')
        lines.push(space > 0 ? line.slice(0, space) : line)
        line = space > 0 ? line.slice(space + 1) : ''
        used = measure(line)
      }
      line += segment
      used += cells
    }
    lines.push(line)
  }
  return lines
}

export interface PanelLayout {
  legendRows: number
  events: number
  files: number
}

/** Rows for each panel section; the headline and the bar always draw, sections drop from the bottom as height shrinks. */
export function panelLayout(height: number, eventCount: number, fileCount: number): PanelLayout {
  let left = height - 2
  const legendRows = left >= 10 ? 2 : left >= 3 ? 1 : 0
  left -= legendRows
  const events = eventCount > 0 && left >= 2 ? Math.min(5, eventCount, left - 1) : 0
  if (events > 0) left -= events + 1
  const files = fileCount > 0 && left >= 2 ? Math.min(fileCount, left - 1) : 0
  return { legendRows, events, files }
}
