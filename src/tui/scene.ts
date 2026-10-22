import type { ReactNode } from 'react'
import { asRecord } from '../client/services'
import type { ContextEventRecord, DefaultFileSort, DefaultGranularity } from '../shared/types'
import { PREVIEW_INDENT, browserRows, browserView, type BrowserRow, type BrowserView } from './browser'
import { kitOf, surfaceFactsOf } from './detect'
import type { SceneKey, SceneProps } from './hostTypes'
import { translatorOf } from './i18n'
import { EVENT_KINDS } from '../client/eventText'
import { FILE_SORTS } from '../client/fileActivity'
import { eventRows, fileRows, headlineText, occupancyOf, wrapCells, type EventRow, type FileRow } from './model'
import { sceneBody } from './sceneTabs'
import type { ContextSource } from './source'
import { clampCursor, trendColumns, type TrendColumn } from './trend'
import { line, notice, openFile, type Draw } from './view'

export const SCENE_TABS = ['overview', 'trend', 'browser', 'events', 'files'] as const

export type SceneTab = (typeof SCENE_TABS)[number]

export function sceneTabOf(value: unknown): SceneTab | undefined {
  const tab = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SCENE_TABS.find(name => name === tab)
}

export interface SceneState {
  tab: SceneTab
  granularity: DefaultGranularity
  /** The selected trend column; null follows the newest. */
  column: number | null
  /** The browser shows the live context instead of the selected step. */
  live: boolean
  browserCursor: number
  expanded: ReadonlySet<string>
  eventKind: ContextEventRecord['kind'] | undefined
  eventCursor: number
  fileSort: DefaultFileSort
  fileCursor: number
}

export interface SceneDefaults {
  granularity: DefaultGranularity
  fileSort: DefaultFileSort
}

/** The stored preferences, read when a scene opens; a value outside the vocabulary takes the schema default. */
export function sceneDefaultsOf(raw: { granularity?: unknown; fileSort?: unknown }): SceneDefaults {
  return {
    granularity: raw.granularity === 'turn' ? 'turn' : 'step',
    fileSort: FILE_SORTS.find(sort => sort === raw.fileSort) ?? 'count',
  }
}

export function initialSceneState(defaults: SceneDefaults, tab: SceneTab | undefined): SceneState {
  return {
    tab: tab ?? 'overview',
    granularity: defaults.granularity,
    column: null,
    live: true,
    browserCursor: 0,
    expanded: new Set(),
    eventKind: undefined,
    eventCursor: 0,
    fileSort: defaults.fileSort,
    fileCursor: 0,
  }
}

/** What the reducer needs to clamp against: the lengths the last render drew. */
export interface SceneCounts {
  columns: number
  rows: readonly BrowserRow[]
  events: number
  files: number
  /** Rows one PgUp/PgDn moves: the smallest list window, the Files table's under its title and column header. */
  page: number
}

export type SceneEffect = 'close' | { openFile: number }

/** A cursor past a list that shrank (a compaction, a narrower filter) moves from the last row, not from where it was. */
function step(cursor: number, key: SceneKey, length: number, page: number): number | undefined {
  const at = clampCursor(cursor, length)
  const by = key.downArrow === true ? 1 : key.upArrow === true ? -1 : key.pageDown === true ? page : key.pageUp === true ? -page : 0
  return by === 0 ? undefined : Math.min(Math.max(0, length - 1), Math.max(0, at + by))
}

function cycle<T>(list: readonly T[], value: T): T {
  return list[(list.indexOf(value) + 1) % list.length]
}

function tabKey(state: SceneState, input: string, key: SceneKey, counts: SceneCounts): SceneState | SceneEffect | undefined {
  if (state.tab === 'trend') {
    const last = counts.columns - 1
    const at = state.column ?? last
    if (key.leftArrow === true) return { ...state, column: Math.max(0, at - 1), live: false }
    if (key.rightArrow === true) return { ...state, column: at >= last ? null : at + 1, live: false }
    if (key.home === true) return { ...state, column: 0, live: false }
    if (key.end === true) return { ...state, column: null }
    if (input === 't') return { ...state, granularity: state.granularity === 'step' ? 'turn' : 'step', column: null }
    return undefined
  }
  if (state.tab === 'browser') {
    const moved = step(state.browserCursor, key, counts.rows.length, counts.page)
    if (moved !== undefined) return { ...state, browserCursor: moved }
    if (input === 'l') return { ...state, live: !state.live, browserCursor: 0 }
    const row = counts.rows.at(clampCursor(state.browserCursor, counts.rows.length))
    if (key.return === true && row !== undefined) {
      const id = row.kind === 'line' ? row.itemId : row.id
      const expanded = new Set(state.expanded)
      if (!expanded.delete(id)) expanded.add(id)
      const browserCursor = row.kind === 'line' ? counts.rows.findIndex(r => r.id === id) : state.browserCursor
      return { ...state, expanded, browserCursor }
    }
    return undefined
  }
  if (state.tab === 'events') {
    const moved = step(state.eventCursor, key, counts.events, counts.page)
    if (moved !== undefined) return { ...state, eventCursor: moved }
    if (input === 'f') {
      const kinds: (ContextEventRecord['kind'] | undefined)[] = [undefined, ...EVENT_KINDS]
      return { ...state, eventKind: cycle(kinds, state.eventKind), eventCursor: 0 }
    }
    return undefined
  }
  if (state.tab === 'files') {
    const moved = step(state.fileCursor, key, counts.files, counts.page)
    if (moved !== undefined) return { ...state, fileCursor: moved }
    if (input === 's') return { ...state, fileSort: cycle(FILE_SORTS, state.fileSort), fileCursor: 0 }
    if (key.return === true && counts.files > 0) return { openFile: clampCursor(state.fileCursor, counts.files) }
  }
  return undefined
}

export function sceneKey(state: SceneState, input: string, key: SceneKey, counts: SceneCounts): SceneState | SceneEffect | undefined {
  if (key.escape === true || input === 'q') return 'close'
  const index = SCENE_TABS.indexOf(state.tab)
  if (key.tab === true) {
    const next = (index + (key.shift === true ? SCENE_TABS.length - 1 : 1)) % SCENE_TABS.length
    return { ...state, tab: SCENE_TABS[next] }
  }
  const digit = Number.parseInt(input, 10)
  if (input.length === 1 && digit >= 1 && digit <= SCENE_TABS.length) return { ...state, tab: SCENE_TABS[digit - 1] }
  return tabKey(state, input, key, counts)
}

export interface SceneModel {
  columns: TrendColumn[]
  /** The step the browser and the brief read; null = live. */
  seq: number | null
  view: BrowserView | null
  rows: BrowserRow[]
  events: EventRow[]
  files: FileRow[]
}

export interface SceneDeps {
  source: ContextSource
  /** The stored preferences, read at each opening so an edit in /settings applies to the next one. */
  defaults: () => { granularity?: unknown; fileSort?: unknown }
  /** The latest opening: the tab it asked for, and a serial telling a fresh opening from a host remount (a closed file preview). */
  opening: () => { tab?: SceneTab; serial: number }
}

export function createContextScene(deps: SceneDeps): (props: SceneProps) => ReactNode {
  let saved: { serial: number; state: SceneState } | undefined
  return function ContextScene(props: SceneProps): ReactNode {
    const { React, ui, close, host } = props
    const h = React.createElement
    const params = host?.useParams?.()
    const data = React.useSyncExternalStore(deps.source.subscribe, deps.source.read)
    const { columns: width, rows: height } = ui.useTerminalSize()
    const facts = surfaceFactsOf(host)
    const t = translatorOf(facts.lang)
    const [mounted] = React.useState(() => {
      const opening = deps.opening()
      if (saved?.serial === opening.serial) return saved
      const defaults = sceneDefaultsOf(deps.defaults())
      return { serial: opening.serial, state: initialSceneState(defaults, sceneTabOf(asRecord(params)?.tab) ?? opening.tab) }
    })
    const stateRef = React.useRef(mounted.state)
    const state = stateRef.current
    const [, setVersion] = React.useState(0)

    const timeline = data.timeline
    const columns = React.useMemo(() => (timeline === null ? [] : trendColumns(timeline, state.granularity)), [timeline, state.granularity])
    const selectedColumn = state.column === null ? columns.at(-1) : columns.at(state.column)
    const seq = state.live ? null : selectedColumn?.seq ?? null
    const headers = data.headers
    const view = React.useMemo(() => (timeline === null ? null : browserView(timeline, headers, seq, t)), [timeline, headers, seq, t])
    const kit = kitOf(ui)
    const measure = kit?.format.cells
    const rows = React.useMemo(() => {
      if (view === null || measure === undefined) return []
      return browserRows(view, state.expanded, text => wrapCells(text, Math.max(1, width - PREVIEW_INDENT), measure))
    }, [view, state.expanded, width, measure])
    const events = React.useMemo(() => eventRows(timeline?.events ?? [], t, state.eventKind), [timeline, t, state.eventKind])
    const files = React.useMemo(() => fileRows(timeline, facts.cwd, state.fileSort), [timeline, facts.cwd, state.fileSort])
    const model: SceneModel = { columns, seq, view, rows, events, files }
    const latest = React.useRef(model)
    latest.current = model

    const bodyHeight = Math.max(1, height - 2)
    ui.useInput((input, key) => {
      const now = latest.current
      const page = Math.max(1, bodyHeight - 2)
      const counts = { columns: now.columns.length, rows: now.rows, events: now.events.length, files: now.files.length, page }
      const result = sceneKey(stateRef.current, input, key, counts)
      if (result === undefined) return
      if (result === 'close') {
        close()
        return
      }
      if ('openFile' in result) {
        openFile(host, now.files[result.openFile], t)
        return
      }
      stateRef.current = result
      saved = { serial: mounted.serial, state: result }
      setVersion(v => v + 1)
    })

    if (kit === undefined) return notice(h, ui, t('tui.needsKit'))
    const d: Draw = { h, ui, kit, t }
    const o = occupancyOf(timeline, facts.usage)
    const tabs = SCENE_TABS.map((tab, i) => h(ui.Text, {
      key: tab,
      ...(tab === state.tab ? { bold: true, inverse: true } : { dimColor: true }),
    }, tab === state.tab || width >= 64 ? ` ${i + 1} ${t('tui.tab.' + tab)} ` : ` ${i + 1} `))
    const header = h(ui.Box, { key: 'header', flexDirection: 'row', width, justifyContent: 'space-between' },
      h(ui.Box, { flexDirection: 'row', flexShrink: 0 }, ...tabs),
      h(ui.Box, { flexShrink: 1, paddingLeft: 1 }, line(d, o === null ? t('tui.title') : headlineText(o, t), { bold: true })))
    const unsupported = timeline?.unsupported
    const body = unsupported !== undefined ? notice(h, ui, t('tui.unsupported', unsupported))
      : timeline === null || o === null || view === null ? notice(h, ui, t('tui.waiting'))
        : sceneBody(d, { state, model, view, data: { ...data, timeline }, occupancy: o, usage: facts.usage, width, height: bodyHeight })
    const footer = h(ui.Box, { key: 'footer' }, line(d, `${t('tui.hint.' + state.tab)} · ${t('tui.hint.scene')}`, { dimColor: true }))
    return h(ui.Box, { flexDirection: 'column', width, height },
      header,
      h(ui.Box, { key: 'body', flexDirection: 'column', height: bodyHeight, overflow: 'hidden' }, body),
      footer)
  }
}
