import type { ReactNode } from 'react'
import { kitOf, surfaceFactsOf } from './detect'
import type { CompactProps, PanelKeyEvent, PanelProps } from './hostTypes'
import { translatorOf } from './i18n'
import { eventRows, fileRows, headlineText, occupancyBars, occupancyOf, panelLayout } from './model'
import type { SceneTab } from './scene'
import type { ContextSource } from './source'
import { eventLine, fileTable, line, notice, occupancyBlock, openFile, type Draw } from './view'

export interface PanelDeps {
  source: ContextSource
  /** Opens the full scene on a tab; false when no scene is registered. */
  openScene: (tab?: SceneTab) => boolean
}

export function createContextPanel(deps: PanelDeps): (props: PanelProps) => ReactNode {
  return function ContextPanel(props: PanelProps): ReactNode {
    const { React, ui, host, width, height } = props
    const h = React.createElement
    const data = React.useSyncExternalStore(deps.source.subscribe, deps.source.read)
    const facts = surfaceFactsOf(host)
    const t = translatorOf(facts.lang)
    const events = React.useMemo(() => eventRows(data.timeline?.events ?? [], t), [data, t])
    const files = React.useMemo(() => fileRows(data.timeline, facts.cwd, 'latest'), [data, facts.cwd])
    const layout = panelLayout(height, events.length, files.length)
    const [cursor, setCursor] = React.useState(-1)
    const selectable = layout.events + layout.files
    const selected = Math.min(cursor, selectable - 1)
    const latest = React.useRef({ selected, selectable, layout, files, t })
    latest.current = { selected, selectable, layout, files, t }

    React.useEffect(() => host.onKey?.((event: PanelKeyEvent) => {
      const now = latest.current
      if (event.key.downArrow === true) setCursor(Math.min(now.selectable - 1, now.selected + 1))
      else if (event.key.upArrow === true) setCursor(Math.max(-1, now.selected - 1))
      else if (event.key.return_ === true) {
        deps.openScene(now.selected < 0 ? undefined : now.selected < now.layout.events ? 'events' : 'files')
      } else if (event.input === 'o' && now.selected >= now.layout.events) {
        openFile(host, now.files[now.selected - now.layout.events], now.t)
      } else return
      event.preventDefault()
    }), [host])

    const kit = kitOf(ui)
    if (kit === undefined) return notice(h, ui, t('tui.needsKit'))
    const unsupported = data.timeline?.unsupported
    if (unsupported !== undefined) return notice(h, ui, t('tui.unsupported', unsupported))
    const o = occupancyOf(data.timeline, facts.usage)
    if (o === null) return notice(h, ui, t('tui.waiting'))
    const d: Draw = { h, ui, kit, t }
    const body: ReactNode[] = [
      h(ui.Box, { key: 'head' }, line(d, headlineText(o, t), { bold: true })),
      ...occupancyBlock(d, o, width, layout.legendRows),
    ]
    if (data.partial) body.push(h(ui.Box, { key: 'partial' }, line(d, t('tui.partial'), { dimColor: true })))
    if (layout.events > 0) {
      body.push(h(ui.Box, { key: 'events-title' }, line(d, t('events.title'), { dimColor: true })))
      for (let i = 0; i < layout.events; i++) body.push(eventLine(d, events[i], width, selected === i))
    }
    if (layout.files > 0) {
      const fileIndex = selected - layout.events
      body.push(fileTable(d, files.slice(0, layout.files), width, fileIndex >= 0 ? fileIndex : undefined))
    }
    return h(ui.Box, { flexDirection: 'column', width }, ...body)
  }
}

export function createContextCompact(source: ContextSource): (props: CompactProps) => ReactNode {
  return function ContextCompact(props: CompactProps): ReactNode {
    const { React, ui, width } = props
    const h = React.createElement
    const data = React.useSyncExternalStore(source.subscribe, source.read)
    const o = occupancyOf(data.timeline, surfaceFactsOf(props).usage)
    const label = typeof o?.pct === 'number' ? `ctx ${Math.round(o.pct)}% ` : 'ctx — '
    const cells = width - label.length
    const head = h(ui.Text, { dimColor: true }, label)
    const StackedBar = ui.StackedBar
    if (StackedBar === undefined || o === null || cells <= 0) return h(ui.Box, { flexDirection: 'row', width }, head)
    const bars = occupancyBars(o, cells).map((bar, i) => h(StackedBar, { key: String(i), ...bar, emptyColor: 'subtle' }))
    return h(ui.Box, { flexDirection: 'row', width }, head, ...bars)
  }
}
