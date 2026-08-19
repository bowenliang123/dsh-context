/**
 * ContextView — the root component of the Context tab: renders the
 * `contextTimeline` session projection delivered by the framework (finished
 * value, pushed by the Host half) and composes the stats board, composition
 * bar, history chart + detail, events and message columns.
 *
 * JSX functional component. All data comes through the framework standard
 * kit (`useProjection`); the component never calls any RPC and holds no
 * cache — the harness owns the projection pipeline end to end.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { headlineOf } from '../headline'
import type { LocaleService, SessionStandardProps } from '../services'
import { contextPressureOf, headersOf, timelineOf, tokenUsageOf } from '../services'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeEventList } from './events'
import { makeNodeList } from './nodes'
import { makePluginInfo } from './pluginInfo'
import { makeRequestDetail } from './requestDetail'
import { makeStatsBoard } from './statsBoard'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, makeTrendChart } from './trendChart'

import { React } from '../react'

// The context page scrolls inside the conversation's shared page scroller
// (`[data-conversation-scroll]`) — the same container the chat auto-scrolls
// to the bottom on every visit. Without a position ledger of its own, a
// context mount inherits wherever the chat left that container, so the tab
// opens at the bottom and stays locked there (each chat visit re-scrolls it).
// Mirror the chat's chatScroll pattern: remember where the reader left each
// session's context page (module-level, so it survives tab remounts) and
// restore it once the content renders — first visits start at the top.
const viewScroll = new Map<string, number>()

// The four event kinds, in display order (toggles + filter share the list).
const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model'] as const

export type ContextViewProps = SessionStandardProps

export function makeContextView(ctx: ClientCtx, kit: ViewKit): (props: ContextViewProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, catLabel } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  const NodeList = makeNodeList(kit)
  const StatsBoard = makeStatsBoard(kit)
  const PluginInfo = makePluginInfo(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar)

  return function ContextView(props: ContextViewProps): ReactNS.ReactElement {
    const sessionId = props.sessionId
    // The finished value the harness pushes for this session: the
    // `contextTimeline` projection key (capability-absent until a value
    // arrives -> loading screen, mirroring the old first-poll wait).
    const data = typeof props.useProjection === 'function'
      ? timelineOf(props.useProjection('contextTimeline'))
      : null
    // Provider-anchored occupancy comes from the OFFICIAL token-meter
    // `contextPressure` projection (the same key the chat's context ring
    // reads) — token-meter owns estimation and replay, the Host no longer
    // mirrors it. Absent key/value degrades to the derived fallback.
    const pressure = typeof props.useProjection === 'function'
      ? contextPressureOf(props.useProjection('contextPressure'))
      : null
    // Durable provider-reported usage comes from the OFFICIAL token-meter
    // `tokenUsage` projection — the exact same data the chat stats line below
    // the input box reads for its "缓存命中" figure, so the stats board's
    // cache-hit cell reuses it verbatim. Absent key/value drops the cell to a
    // dash instead of estimating.
    const usage = typeof props.useProjection === 'function'
      ? tokenUsageOf(props.useProjection('tokenUsage'))
      : null
    // The header-content companion projection (full system prompt + tool
    // schemas) for the Context browser card; absent key = older Host half,
    // the card degrades those sections to tokens-only with a note.
    const headers = typeof props.useProjection === 'function'
      ? headersOf(props.useProjection('contextHeaders'))
      : null
    const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = React.useState<number | null>(null)
    const [tick, setTick] = React.useState(0)
    const [granularity, setGranularity] = React.useState<'step' | 'turn'>('step')
    // Shared hover link between the composition bar and its legend below.
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    // Kind picker for the events column, every kind picked by default (all
    // shown). Clicking an unpicked kind adds it (A -> A+B -> ...); clicking
    // the only remaining picked kind resets to all; clicking a picked kind
    // among several removes it.
    const [pickedKinds, setPickedKinds] = React.useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds(p => {
        // All picked -> narrow to this kind only (that's the "点击后只显示该分类" entry).
        if (p.length === EVENT_KINDS.length) return [k]
        // Unpicked -> add it (A -> A+B -> ...).
        if (!p.includes(k)) return [...p, k]
        // Picked -> remove it; removing the last one resets to all.
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    // Tool-link bridge to the Context browser: clicking the overview's
    // "工具定义 Top" label (category focus) or one of its chips (specific
    // tool focus) asks the browser to reveal the corresponding section.
    // One-shot — the browser applies it and clears it back through
    // `onToolFocusHandled`, so clicking the same chip again re-triggers.
    const [toolFocus, setToolFocus] = React.useState<{ tool?: string } | null>(null)
    const clearToolFocus = React.useCallback(() => { setToolFocus(null) }, [])

    // ---- page-scroller ownership (see `viewScroll` above) ----
    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const scrollerRef = React.useRef<HTMLElement | null>(null)
    // The session whose position was already applied this mount: re-renders
    // must never re-apply, or they would yank the reader's scroll.
    const restoredRef = React.useRef<string | null>(null)

    // Restore this session's saved position (or the top on a first visit) as
    // soon as the content renders — a layout effect, so the reader never sees
    // the chat's bottom-anchored position flash in first.
    React.useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '' || data === null) return
      if (restoredRef.current === sessionId) return
      restoredRef.current = sessionId
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller === null) return
      scrollerRef.current = scroller as HTMLElement
      scroller.scrollTop = viewScroll.get(sessionId) ?? 0
    }, [sessionId, data])

    // Save where the reader left this session's context page. Runs on unmount
    // (tab switch) and on session change — a layout-effect cleanup, so it
    // fires before the incoming view's own layout effects re-scroll the
    // shared container.
    React.useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
      }
    }, [sessionId])

    // Re-render on locale switch.
    React.useEffect(() => {
      const localeSvc = ctx.get('locale') as LocaleService | undefined
      if (!localeSvc) return undefined
      return localeSvc.subscribe(() => setTick(x => x + 1))
    }, [])

    void tick

    if (!data) {
      return <div className="lc-root" ref={rootRef}><div className="lc-empty">{t('loading')}</div></div>
    }

    const requests = data.requests || []
    const events = data.events || []
    // The events column filters to the picked kinds (all picked = all shown);
    // the stats board keeps the full log regardless.
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    const nodes = data.nodes || []
    // Display granularity: one bar per step (default) or one bar per turn
    // (each turn shown by its LAST step's record).
    const displayRequests = granularity === 'turn' ? aggregateByTurn(requests) : requests
    // Boundary events attach to the first request after them; the same
    // attachment drives the ✂ marker above the bar and the detail chip.
    const markers = attachMarkers(displayRequests, events)
    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      return i >= 0 ? markers[i] : undefined
    }

    // The detail below follows the pointer: hover previews a bar, a pinned
    // click takes over when the pointer leaves, and both fall back to the
    // newest request. The active turn (for strip/bar highlighting) follows
    // the turn strip hover, or the hovered bar's turn.
    let pinnedReq: RequestRecord | null = null
    for (const req of displayRequests) if (req.seq === selectedSeq) pinnedReq = req
    let activeReq: RequestRecord | null = null
    if (hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) activeReq = req
    }
    if (activeReq === null) activeReq = pinnedReq
    if (activeReq === null && displayRequests.length > 0) activeReq = displayRequests[displayRequests.length - 1]

    // The turn highlight is hover-only: the turn strip hover wins, then the
    // hovered bar's turn (no fallback — a pinned or default selection must
    // not keep a turn glowing).
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // Provider-anchored CURRENT occupancy from the official chat ring
    // (contextPressure.projectedTokens): the newest usage sample (input +
    // cache) carried forward by the heuristic surface movement since it was
    // taken. The provider's tokenizer counts the real billed tokens, which
    // the fixed 4-chars/token heuristic can undercount by ~10-15% on
    // CJK-heavy sessions — so this is the headline, and the heuristic
    // composition below is anchored to it (proportions stay heuristic).
    // Shared with the /context popup (headline.ts).
    const head = headlineOf(data, pressure)

    return (
      <div className="lc-root" ref={rootRef}>

        {/* ---- session context stats + plugin info, side by side (7 : 3) ---- */}
        <div className="lc-cols lc-head">
          <StatsBoard requests={requests} events={events} usage={usage} />
          <PluginInfo />
        </div>

        {/* ---- main split: overview + trend stacked in the left column,
               the context browser in the right column (shared lc-cols flex,
               wraps to one column on narrow widths) ---- */}
        <div className="lc-cols">
          <div className="lc-col">
            {/* ---- overview ---- */}
            <div className="lc-card">
              <div className="lc-card-title">
                <span className="lc-card-title-text">{t('overview.title')}</span>
                <span className="lc-card-sub">
                  {(data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '')}
                </span>
              </div>
              <div className="lc-overview-num">
                <b>{fmt(head.tokens)}</b>
                <span>
                  {head.window
                    ? ' / ' + fmt(head.window) + ' tokens'
                    : ' ' + t('overview.estimate')}
                </span>
                {head.pct !== null ? (
                  <span className="lc-overview-pct">
                    <b>{head.pct + '%'}</b>
                    {t('overview.used')}
                  </span>
                ) : null}
              </div>
              <StackedBar parts={head.parts} height={16} max={head.window} hoverKey={hoverCat} onHoverKey={setHoverCat} />
              <Legend parts={head.parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />
              {(data.toolList && data.toolList.length > 0) ? (
                <div className="lc-tools">
                  <button
                    type="button"
                    className="lc-tools-label"
                    onClick={() => { setToolFocus({}) }}
                  >{t('tools.top')}</button>
                  {data.toolList.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(tool => {
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        className="lc-tool-chip"
                        onClick={() => { setToolFocus({ tool: tool.name }) }}
                      >{tool.name + ' ' + fmt(tool.tokens)}</button>
                    )
                  })}
                  {data.toolList.length > 5
                    ? (
                      <button
                        type="button"
                        className="lc-tools-more"
                        onClick={() => { setToolFocus({}) }}
                      >{t('tools.more', { n: data.toolList.length })}</button>
                    )
                    : null}
                </div>
              ) : null}
            </div>

            {/* ---- trend ---- */}
            <div className="lc-card">
              <div className="lc-card-title">
                <span className="lc-card-title-text">{t('trend.title')}</span>
                <span className="lc-card-sub">{t('trend.hint')}</span>
                <div className="lc-gran">
                  <button
                    className={'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : '')}
                    onClick={() => { setGranularity('step') }}
                  >{t('gran.step')}</button>
                  <button
                    className={'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : '')}
                    onClick={() => { setGranularity('turn') }}
                  >{t('gran.turn')}</button>
                </div>
              </div>
              {displayRequests.length === 0
                ? <div className="lc-empty">{t('trend.empty')}</div>
                : (
                  <div>
                    <TrendChart
                      // Remount per session: switching sessions re-anchors the chart
                      // at the newest bars instead of inheriting stale scroll state.
                      key={sessionId}
                      // The host caps the log at 160 requests; render them ALL so
                      // earlier turns/steps stay reachable via horizontal scroll.
                      requests={displayRequests}
                      markers={markers}
                      selectedSeq={pinnedReq ? pinnedReq.seq : null}
                      hoveredSeq={hoveredSeq}
                      activeTurn={activeTurn}
                      granularity={granularity}
                      onSelect={setSelectedSeq}
                      onHover={setHoveredSeq}
                      onHoverTurn={setHoverTurn}
                    />
                    <RequestDetail request={activeReq} marker={activeReq !== null ? markerOf(activeReq) : undefined} />
                  </div>
                )}
            </div>
          </div>

          {/* ---- context browser: the assembled content of the live surface
                 or a picked step; follows the trend chart's hovered bar ---- */}
          <div className="lc-col">
            <ContextBrowser
              data={data}
              headers={headers}
              useSession={props.useSession}
              loadOlderHistory={props.loadOlderHistory}
              previewSeq={hoveredSeq}
              // History-chart pin linkage: a clicked (locked) bar pins the
              // browser on that step; unpinning returns it to live.
              pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
              // Shared current-composition hover link (bar + legend + browser
              // category rows); the browser joins only while it shows the
              // live step, gated inside the browser itself.
              hoverKey={hoverCat}
              onHoverKey={setHoverCat}
              // Tool-link bridge from the overview ("工具定义 Top" chips).
              toolFocus={toolFocus}
              onToolFocusHandled={clearToolFocus}
            />
          </div>
        </div>

        {/* ---- events + messages ---- */}
        <div className="lc-cols">
          <div className="lc-card lc-col">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('events.title')}</span>
              <div className="lc-kinds">
                {EVENT_KINDS.map(k => (
                  <button
                    key={k}
                    className={'lc-gran-btn' + (pickedKinds.includes(k) ? ' lc-gran-on lc-kind-' + k : '')}
                    onClick={() => { toggleKind(k) }}
                  >{t('kind.' + k)}</button>
                ))}
              </div>
            </div>
            <EventList events={shownEvents} />
          </div>
          <div className="lc-card lc-col">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('nodes.title')}</span>
              <span className="lc-card-sub">{t('nodes.hint')}</span>
            </div>
            <NodeList nodes={nodes} dropped={data.droppedNodes || 0} />
          </div>
        </div>

        <div className="lc-foot">{t('footer')}</div>
      </div>
    )
  }
}
