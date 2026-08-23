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
import type { SessionStandardProps } from '../services'
import { contextBreakdownOf, contextPressureOf, headersOf, timelineOf, tokenUsageOf } from '../services'
import type { ClientCtx, ConversationFace, ImageRefLike } from '../services'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeEventList } from './events'
import { makeNodeList } from './nodes'
import { makePluginInfo } from './pluginInfo'
import { makeRequestDetail } from './requestDetail'
import { makeStatsBoard } from './statsBoard'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, makeTrendChart } from './trendChart'

import { React, h } from '../react'
import { makeErrorBoundary } from './errorBoundary'

// The context page scrolls inside the conversation's shared page scroller
// (`[data-conversation-scroll]`) — the same container the chat auto-scrolls
// to the bottom on every visit. Without a position ledger of its own, a
// context mount inherits wherever the chat left that container, so the tab
// opens at the bottom and stays locked there (each chat visit re-scrolls it).
// Mirror the chat's chatScroll pattern: remember where the reader left each
// session's context page (module-level, so it survives tab remounts) and
// restore it once the content renders — first visits start at the top.
const viewScroll = new Map<string, number>()

// The event kinds, in display order (toggles + filter share the list).
const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

export type ContextViewProps = SessionStandardProps

export function makeContextView(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextViewProps) => ReactNS.ReactElement {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  const NodeList = makeNodeList(kit)
  const StatsBoard = makeStatsBoard(kit)
  const PluginInfo = makePluginInfo(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar)
  const ErrorBoundary = makeErrorBoundary(t)

  // The data-driven body lives inside the error boundary: any render error
  // (a corrupt projection value that slips past the timelineOf shape guard,
  // a framework surprise) degrades to a styled error card inside the tab
  // instead of white-screening the whole conversation view. The boundary is
  // a separate component with NO hooks of its own, so the body's hook order
  // and the loading/data control flow stay exactly as they were.
  function ContextViewBody(props: ContextViewProps): ReactNS.ReactElement {
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
    // Heuristic composition counts come from the OFFICIAL token-meter
    // `contextBreakdown` projection — the exact system/tools/messages rows
    // the chat ring's click-open panel shows, so the overview legend reads
    // identically by construction. Absent key degrades to the fold's own
    // sums (same fixed estimator) inside headlineOf.
    const breakdown = typeof props.useProjection === 'function'
      ? contextBreakdownOf(props.useProjection('contextBreakdown'))
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
    // The per-user default (Settings → Plugins → dsh-context card) decides the
    // granularity a freshly mounted view opens with; in-chart toggling stays
    // mount-local and never writes back.
    const [granularity, setGranularity] = React.useState<'step' | 'turn'>(() => settings.defaultGranularity())
    // Trend display mode: 'total' plots each request's cumulative
    // composition, 'diff' plots its incremental change vs the previous one.
    const [trendMode, setTrendMode] = React.useState<'total' | 'diff'>('total')
    // Turn strip click target: the chart switches to turn granularity and
    // scroll-centers this turn's bar, then clears it via onFocusTurnHandled.
    const [focusTurn, setFocusTurn] = React.useState<number | null>(null)
    // Shared hover link between the composition bar and its legend below.
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    // Kind picker for the events column, every kind picked by default (all
    // shown). Clicking an unpicked kind adds it (A -> A+B -> ...); clicking
    // the only remaining picked kind resets to all; clicking a picked kind
    // among several removes it.
    const [pickedKinds, setPickedKinds] = React.useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
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

    // Session-authorized durable-image loader for the Context browser's
    // attachment cards, resolved through the harness conversation service —
    // the same `resolveImage` the chat history's message images ride on.
    // Absent service (or a missing session id) degrades the cards to
    // metadata-only, never an error.
    const loadImage = React.useMemo(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      const conversation = ctx.get('conversation') as ConversationFace | undefined
      if (conversation === undefined || typeof conversation.resolveImage !== 'function') return undefined
      return (attachment: ImageRefLike) => conversation.resolveImage(sessionId, attachment)
    }, [sessionId])

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
      const localeSvc = ctx.get('locale')
      if (!localeSvc) return undefined
      return localeSvc.subscribe(() => { setTick(x => x + 1) })
    }, [])

    void tick

    // Hooks stay unconditional (Rules of Hooks): the projection value can
    // arrive AFTER a loading first render, and an early return above these
    // useMemos would grow the hook count between renders — React #310
    // (issue #12). Fall back to empty collections while data is absent; the
    // loading return sits below the last hook instead.
    const requests = data ? data.requests : []
    const events = data ? data.events : []
    // The events column filters to the picked kinds (all picked = all shown);
    // the stats board keeps the full log regardless.
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    const nodes = data ? data.nodes : []
    // Display granularity: one bar per step (default) or one bar per turn
    // (each turn shown by its LAST step's record). Memoized so hover-driven
    // re-renders keep the bar props identity-stable (the chart's memoized
    // bars then skip reconciliation; turn-mode aggregation allocates).
    const displayRequests = React.useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    // Boundary events attach to the first request after them; the same
    // attachment drives the ✂ marker above the bar and the detail chip.
    const markers = React.useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])

    if (!data) {
      return <div className="lc-root" ref={rootRef}><div className="lc-empty">{t('loading')}</div></div>
    }

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
    // Shared with the /context popup (headline.ts). The composition counts
    // ride the official `contextBreakdown` rows (the chat ring panel).
    const head = headlineOf(data, pressure, breakdown)

    // The cost cell prices in the locale's currency (zh -> CNY, else USD);
    // read the active locale at render time — the locale subscription above
    // already re-renders on a switch. Older hosts without getLocale fall
    // back to USD.
    const localeSvc = ctx.get('locale')
    const activeLocale = localeSvc !== undefined && typeof localeSvc.getLocale === 'function'
      ? localeSvc.getLocale().active
      : 'en'

    return (
      <div className="lc-root" ref={rootRef}>

        {/* ---- session context stats + plugin info, side by side (7 : 3) ---- */}
        <div className="lc-cols lc-head">
          <StatsBoard requests={requests} events={events} usage={usage} toolCalls={data.toolCalls} images={data.images}
            cost={data.cost} locale={activeLocale} />
          <PluginInfo />
        </div>

        {/* ---- main split: overview + trend stacked in the left column,
               the context browser in the right column (shared lc-cols flex,
               wraps to one column on narrow widths) ---- */}
        <div className="lc-cols">
          <div className="lc-col">
            {/* ---- overview (shared CurrentComposition card) ---- */}
            <CurrentComposition
              head={head}
              subtitle={(data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '')}
              hoverKey={hoverCat}
              onHoverKey={setHoverCat}
              tools={data.toolList}
              onToolFocus={setToolFocus}
            />

            {/* ---- trend ---- */}
            <div className="lc-card">
              <div className="lc-card-title">
                <span className="lc-card-title-text">{t('trend.title')}</span>
                <span className="lc-card-sub">{t('trend.hint')}</span>
                <div className="lc-trend-ctl">
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
                  <div className="lc-gran" title={t('gran.modeHint')}>
                    <button
                      className={'lc-gran-btn' + (trendMode === 'total' ? ' lc-gran-on' : '')}
                      onClick={() => { setTrendMode('total') }}
                    >{t('gran.total')}</button>
                    <button
                      className={'lc-gran-btn' + (trendMode === 'diff' ? ' lc-gran-on' : '')}
                      onClick={() => { setTrendMode('diff') }}
                    >{t('gran.diff')}</button>
                  </div>
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
                      // Render ALL retained requests (bounded by the host's
                      // maxKeptTurns/maxRequestSteps config) so earlier
                      // turns/steps stay reachable via horizontal scroll.
                      requests={displayRequests}
                      markers={markers}
                      selectedSeq={pinnedReq ? pinnedReq.seq : null}
                      hoveredSeq={hoveredSeq}
                      activeTurn={activeTurn}
                      granularity={granularity}
                      mode={trendMode}
                      focusTurn={focusTurn}
                      onSelect={setSelectedSeq}
                      onHover={setHoveredSeq}
                      onHoverTurn={setHoverTurn}
                      onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                      onFocusTurnHandled={() => { setFocusTurn(null) }}
                    />
                    <RequestDetail request={activeReq} marker={activeReq !== null ? markerOf(activeReq) : undefined} />
                  </div>
                )}
            </div>
          </div>

          {/* ---- context browser: the assembled content of the live surface
                 or a picked step; follows the trend chart's hovered bar.
                 `lc-col-browser` stretches the card to the left column's
                 height (Context tab only — the /context modal stays
                 content-sized) ---- */}
          <div className="lc-col lc-col-browser">
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
              loadImage={loadImage}
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

  return function ContextView(props: ContextViewProps): ReactNS.ReactElement {
    // The whole body — hooks, projection reads, derivation, and all child
    // cards — renders under the boundary (see ContextViewBody above).
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}
