import type { ReactNode } from 'react'
import { fmt } from '../client/format'
import { turnStepsOf } from '../client/records'
import type { ContextHeaders, ContextTimeline } from '../shared/types'
import { PREVIEW_INDENT, type BrowserRow, type BrowserView } from './browser'
import type { HostUsage } from './detect'
import type { Occupancy } from './model'
import type { SceneModel, SceneState } from './scene'
import { sessionRows, timingRows, tokenRows, type StatRow } from './stats'
import { cursorWindow, stepBrief, trendGeometry, visibleRange, type TrendColumn } from './trend'
import { eventLine, fileTable, line, occupancyBlock, type Draw } from './view'

export interface SceneEnv {
  state: SceneState
  model: SceneModel
  view: BrowserView
  data: { timeline: ContextTimeline; headers: ContextHeaders | null; partial: boolean }
  occupancy: Occupancy
  usage: HostUsage
  width: number
  height: number
}

const STAT_GAP = 2
const MIN_STAT_WIDTH = 28

/** As many stat sections per row as keep each at least MIN_STAT_WIDTH, sized so the row plus its gaps fits exactly. */
export function statGrid(count: number, width: number): { perRow: number; sectionWidth: number } {
  const perRow = Math.max(1, Math.min(count, Math.floor((width + STAT_GAP) / (MIN_STAT_WIDTH + STAT_GAP))))
  return { perRow, sectionWidth: Math.floor((width - STAT_GAP * (perRow - 1)) / perRow) }
}

function statSection(d: Draw, title: string, rows: StatRow[], width: number): ReactNode {
  let valueWidth = 0
  for (const row of rows) valueWidth = Math.max(valueWidth, d.kit.format.cells(row.value))
  return d.h(d.ui.Box, { key: title, flexDirection: 'column', width },
    line(d, title, { bold: true }),
    d.h(d.kit.Table, {
      columns: [{ key: 'label', grow: 1 }, { key: 'value', width: valueWidth, align: 'right' }],
      rows: rows.map(row => ({ label: row.label, value: row.value })),
      width,
      header: false,
    }))
}

function overviewBody(d: Draw, env: SceneEnv): ReactNode {
  const { width, occupancy: o, data } = env
  const body: ReactNode[] = occupancyBlock(d, o, width, 2)
  if (o.reserve !== undefined && o.window !== undefined) {
    body.push(d.h(d.ui.Box, { key: 'reserve' }, line(d, d.t('overview.reserveHeadroomTip', { p: Math.round(o.reserve.threshold / o.window * 100) }), { dimColor: true })))
  }
  if (data.partial) body.push(d.h(d.ui.Box, { key: 'partial' }, line(d, d.t('tui.partial'), { dimColor: true })))
  const sections = [
    { title: d.t('stats.session'), rows: sessionRows(data.timeline, d.t) },
    { title: d.t('tokens.title'), rows: tokenRows(data.timeline, env.usage, d.t) },
    { title: d.t('timing.title'), rows: timingRows(data.timeline, d.t) },
  ].filter(section => section.rows.length > 0)
  const { perRow, sectionWidth } = statGrid(sections.length, width)
  for (let i = 0; i < sections.length; i += perRow) {
    body.push(d.h(d.ui.Box, { key: `stats-${i}`, flexDirection: 'row', columnGap: STAT_GAP, marginTop: 1 },
      ...sections.slice(i, i + perRow).map(section => statSection(d, section.title, section.rows, sectionWidth))))
  }
  return d.h(d.ui.Box, { flexDirection: 'column', width }, ...body)
}

/** Tall enough to read the growth; the caption, the brief and the hints stay on screen below it. */
const MAX_PLOT_ROWS = 12

function columnCaption(d: Draw, column: TrendColumn, env: SceneEnv): string {
  const head = env.state.granularity === 'turn'
    ? d.t('detail.turn', { t: column.turn, n: column.stepCount })
    : d.t('detail.step', { t: column.turn, s: column.step, n: turnStepsOf(env.data.timeline.requests)(column.turn) })
  return `${head} · ${fmt(column.total)} · ${d.kit.format.relativeTime(column.time)}`
}

function trendBody(d: Draw, env: SceneEnv): ReactNode {
  const { model, state, width, height } = env
  const count = model.columns.length
  if (count === 0) return line(d, d.t('trend.empty'), { dimColor: true })
  const { columnWidth, gap, capacity } = trendGeometry(count, width)
  const selected = Math.min(state.column ?? count - 1, count - 1)
  const { start, end } = visibleRange(count, selected, capacity)
  let max = 1
  let marked = false
  for (const column of model.columns) {
    let sum = 0
    for (const segment of column.segments) sum += segment.value
    max = Math.max(max, sum)
    if (column.marker !== undefined) marked = true
  }
  const column = model.columns[selected]
  const brief = stepBrief(env.data.timeline, column.seq)
  const briefLines: string[] = []
  if (brief.user !== undefined) briefLines.push(`${d.t('tui.brief.user')}: ${brief.user}`)
  if (brief.inputs.length > 0) briefLines.push(`${d.t('tui.brief.in')}: ${brief.inputs.join(' · ')}`)
  if (brief.response !== undefined) briefLines.push(`${d.t('tui.brief.response')}: ${brief.response}`)
  const title = `${d.t('trend.title')} · ${d.t('gran.' + state.granularity)}${marked ? ` · ✂ ${d.t('kind.compaction')}/${d.t('kind.prune')}` : ''}`
  return d.h(d.ui.Box, { flexDirection: 'column', width },
    line(d, title, { dimColor: true }),
    d.h(d.kit.ColumnChart, {
      columns: model.columns.slice(start, end),
      height: Math.min(MAX_PLOT_ROWS, Math.max(3, height - 3 - briefLines.length)),
      columnWidth,
      gap,
      max,
      selected: selected - start,
    }),
    line(d, columnCaption(d, column, env), { bold: true }),
    ...briefLines.map(text => d.h(d.ui.Box, { key: text }, line(d, text))))
}

function browserLine(d: Draw, row: BrowserRow, total: number, expanded: ReadonlySet<string>, selected: boolean): ReactNode {
  if (row.kind === 'line') {
    // A blank line between paragraphs still takes its row: an empty Text lays out zero rows high.
    return d.h(d.ui.Box, { key: row.id, paddingLeft: PREVIEW_INDENT }, line(d, row.text === '' ? ' ' : row.text, { inverse: selected }))
  }
  if (row.kind === 'category') {
    const c = row.category
    const share = total > 0 ? ` ${(c.tokens / total * 100).toFixed(1)}%` : ''
    const delta = c.delta === null || c.delta === 0 ? '' : ` ${d.t('tui.vsPrev', { n: (c.delta > 0 ? '+' : '−') + fmt(Math.abs(c.delta)) })}`
    return d.h(d.ui.Box, { key: row.id, flexDirection: 'row' },
      d.h(d.ui.Box, { flexGrow: 1, flexShrink: 1 },
        line(d, `${expanded.has(row.id) ? '▾' : '▸'} ${d.t('cat.' + c.key)} (${c.items.length})`, { color: d.kit.seriesColor(c.slot), inverse: selected })),
      d.h(d.ui.Box, { flexShrink: 0 }, line(d, ` ${fmt(c.tokens)}${share}${delta}`, { dimColor: true })))
  }
  const item = row.item
  const mark = item.content === undefined ? '  ' : expanded.has(item.id) ? '▾ ' : '▸ '
  return d.h(d.ui.Box, { key: row.id, flexDirection: 'row', paddingLeft: 2 },
    d.h(d.ui.Box, { flexGrow: 1, flexShrink: 1 },
      line(d, `${mark}${item.err === true ? '✗ ' : ''}${item.label}`, { inverse: selected, ...(item.err === true ? { color: 'error' } : {}) })),
    // The source chip gives way before the figure does.
    ...(item.source !== undefined
      ? [d.h(d.ui.Box, { key: 'source', flexShrink: 1 }, line(d, ` ${item.source}`, { color: d.kit.seriesColor(d.kit.hashSeries(item.source)) }))]
      : []),
    d.h(d.ui.Box, { key: 'tokens', flexShrink: 0 }, line(d, ` ${fmt(item.tokens)}`, { dimColor: true })))
}

function browserBody(d: Draw, env: SceneEnv): ReactNode {
  const { model, state, width, height, view } = env
  const step = view.seq === null ? undefined : env.data.timeline.requests.find(r => r.seq === view.seq)
  const where = step === undefined ? d.t('browser.liveNow') : d.t('browser.stepAt', { t: step.turn ?? 0, s: step.step ?? 0 })
  const notes: string[] = []
  if (view.missing > 0) notes.push(d.t('browser.missingLive', { n: view.missing }))
  if (view.approximate) notes.push(d.t('browser.approx'))
  let total = 0
  for (const c of view.categories) total += c.tokens
  const { cursor, start, end } = cursorWindow(model.rows.length, state.browserCursor, Math.max(1, height - 1 - notes.length))
  return d.h(d.ui.Box, { flexDirection: 'column', width },
    line(d, `${d.t('browser.title')} · ${where}`, { dimColor: true }),
    ...model.rows.slice(start, end).map((row, i) => browserLine(d, row, total, state.expanded, start + i === cursor)),
    ...notes.map(text => d.h(d.ui.Box, { key: text }, line(d, text, { dimColor: true }))))
}

function eventsBody(d: Draw, env: SceneEnv): ReactNode {
  const { model, state, width, height } = env
  const kind = state.eventKind === undefined ? d.t('files.kind.all') : d.t('kind.' + state.eventKind)
  const title = line(d, `${d.t('events.title')} · ${d.t('tui.filter', { kind })}`, { dimColor: true })
  if (model.events.length === 0) return d.h(d.ui.Box, { flexDirection: 'column', width }, title, line(d, d.t('events.empty')))
  const { cursor, start, end } = cursorWindow(model.events.length, state.eventCursor, Math.max(1, height - 1))
  return d.h(d.ui.Box, { flexDirection: 'column', width },
    title,
    ...model.events.slice(start, end).map((row, i) => eventLine(d, row, width, start + i === cursor)))
}

function filesBody(d: Draw, env: SceneEnv): ReactNode {
  const { model, state, width, height } = env
  const sort = d.t('tui.sort', { sort: d.t('files.sort.' + state.fileSort) })
  const title = line(d, `${d.t('files.title')} · ${d.t('files.files', { n: model.files.length })} · ${sort}`, { dimColor: true })
  if (model.files.length === 0) return d.h(d.ui.Box, { flexDirection: 'column', width }, title, line(d, d.t('files.empty')))
  const { cursor, start, end } = cursorWindow(model.files.length, state.fileCursor, Math.max(1, height - 2))
  return d.h(d.ui.Box, { flexDirection: 'column', width }, title, fileTable(d, model.files.slice(start, end), width, cursor - start, true))
}

export function sceneBody(d: Draw, env: SceneEnv): ReactNode {
  switch (env.state.tab) {
    case 'overview': return overviewBody(d, env)
    case 'trend': return trendBody(d, env)
    case 'browser': return browserBody(d, env)
    case 'events': return eventsBody(d, env)
    case 'files': return filesBody(d, env)
  }
}
