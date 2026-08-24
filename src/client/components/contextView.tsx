/**
 * Context tab root: renders the harness-pushed `contextTimeline` projection and composes stats, composition, history, events and messages;
 * never calls RPC and holds no cache — the harness owns the projection pipeline end to end.
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

// The context page scrolls inside the conversation's shared `[data-conversation-scroll]` container, which the chat bottom-anchors — mirror
// the chat's chatScroll pattern: a module-level per-session position ledger (survives tab remounts), restored once content renders; first
// visits start at the top.
const viewScroll = new Map<string, number>()

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

  // The body renders under the error boundary: a corrupt projection value (past the timelineOf shape guard) degrades to a styled error
  // card, not a white screen; the boundary itself has NO hooks, so the body's hook order and loading/data flow stay unchanged.
  function ContextViewBody(props: ContextViewProps): ReactNS.ReactElement {
    const sessionId = props.sessionId
    const data = typeof props.useProjection === 'function'
      ? timelineOf(props.useProjection('contextTimeline'))
      : null
    // Official token-meter `contextPressure` projection — the same key the chat's context ring reads; token-meter owns estimation, the Host
    // no longer mirrors it. Absent → derived fallback.
    const pressure = typeof props.useProjection === 'function'
      ? contextPressureOf(props.useProjection('contextPressure'))
      : null
    // Official token-meter `tokenUsage` projection — the same data the chat stats line below the input box reads for its '缓存命中' figure, so
    // the stats board's cache-hit cell reuses it verbatim; absent → the cell drops to a dash instead of estimating.
    const usage = typeof props.useProjection === 'function'
      ? tokenUsageOf(props.useProjection('tokenUsage'))
      : null
    // Official token-meter `contextBreakdown` projection — the exact rows the chat ring's click-open panel shows, so the overview legend
    // reads identically by construction; absent → the fold's own same-estimator sums inside headlineOf.
    const breakdown = typeof props.useProjection === 'function'
      ? contextBreakdownOf(props.useProjection('contextBreakdown'))
      : null
    // `contextHeaders` companion projection (full system prompt + tool schemas) for the Context browser; absent key = older Host half →
    // those sections degrade to tokens-only with a note.
    const headers = typeof props.useProjection === 'function'
      ? headersOf(props.useProjection('contextHeaders'))
      : null
    const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = React.useState<number | null>(null)
    // Mount-time default from the plugin settings card; in-chart toggling stays mount-local and never writes back.
    const [granularity, setGranularity] = React.useState<'step' | 'turn'>(() => settings.defaultGranularity())
    // 'total' plots each request's cumulative composition, 'delta' its incremental change vs the previous one;
    // like granularity, the default is read at mount and in-chart toggling never writes back.
    const [trendMode, setTrendMode] = React.useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    // Strip-clicked turn: chart switches to turn granularity and scroll-centers that turn's bar, then clears via onFocusTurnHandled.
    const [focusTurn, setFocusTurn] = React.useState<number | null>(null)
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    const [pickedKinds, setPickedKinds] = React.useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
        if (p.length === EVENT_KINDS.length) return [k]
        if (!p.includes(k)) return [...p, k]
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    const [toolFocus, setToolFocus] = React.useState<{ tool?: string } | null>(null)
    const clearToolFocus = React.useCallback(() => { setToolFocus(null) }, [])

    // Session-authorized durable-image loader for the browser's attachment cards, resolved through the harness conversation service — the
    // same `resolveImage` the chat history's images ride on; absent service/session degrades the cards to metadata-only, never an error.
    const loadImage = React.useMemo(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      const conversation = ctx.get('conversation') as ConversationFace | undefined
      if (conversation === undefined || typeof conversation.resolveImage !== 'function') return undefined
      return (attachment: ImageRefLike) => conversation.resolveImage(sessionId, attachment)
    }, [sessionId])

    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const scrollerRef = React.useRef<HTMLElement | null>(null)
    // The session whose position was already applied this mount — re-applying on re-renders would yank the reader's scroll.
    const restoredRef = React.useRef<string | null>(null)

    // Restore the saved position (or the top on first visit) in a layout effect, so the chat's bottom-anchored position never flashes in
    // first.
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

    // Save the position on unmount/session change — a layout-effect cleanup, so it fires before the incoming view's own layout effects
    // re-scroll the shared container.
    React.useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
      }
    }, [sessionId])

    // No locale subscription here: the harness slot outlet subscribes the
    // LocaleFace revision and re-renders every entry on a locale switch, and
    // the kit's bound `t` reads the active locale at call time.

    // Hooks stay unconditional (Rules of Hooks): the projection value can arrive AFTER a loading first render, and an early return above
    // these useMemos would grow the hook count between renders (React #310); fall back to empty collections and keep the loading return
    // below the last hook.
    const requests = data ? data.requests : []
    const events = data ? data.events : []
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    const nodes = data ? data.nodes : []
    // Per-step bars, or one per turn (each turn's LAST step's record); memoized so hover-driven re-renders keep bar props identity-stable —
    // the chart's memoized bars then skip reconciliation (turn-mode aggregation allocates).
    const displayRequests = React.useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    const markers = React.useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])

    if (!data) {
      return <div className="lc-root" ref={rootRef}><div className="lc-empty">{t('loading')}</div></div>
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      return i >= 0 ? markers[i] : undefined
    }

    let pinnedIdx = -1
    for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === selectedSeq) pinnedIdx = i
    const pinnedReq = pinnedIdx >= 0 ? displayRequests[pinnedIdx] : null
    let activeIdx = -1
    if (hoveredSeq !== null) {
      for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === hoveredSeq) { activeIdx = i; break }
    }
    if (activeIdx < 0) activeIdx = pinnedIdx
    if (activeIdx < 0 && displayRequests.length > 0) activeIdx = displayRequests.length - 1
    const activeReq = activeIdx >= 0 ? displayRequests[activeIdx] : null

    // Turn highlight is hover-only: the turn strip hover wins, then the hovered bar's turn — no fallback, so a pinned or default selection
    // never keeps a turn glowing.
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // Provider-anchored CURRENT occupancy (contextPressure.projectedTokens): the headline, because the fixed 4-chars/token heuristic
    // undercounts CJK by ~10–15% — proportions stay heuristic but are anchored to the real billed total. Shared with the /context popup
    // (headline.ts); composition rides the official `contextBreakdown` rows.
    const head = headlineOf(data, pressure, breakdown)

    // The cost cell prices in the active locale (zh → CNY, else USD), read at render time — the locale subscription above already
    // re-renders on a switch; older hosts without getLocale fall back to USD.
    const localeSvc = ctx.get('locale')
    const activeLocale = localeSvc !== undefined && typeof localeSvc.getLocale === 'function'
      ? localeSvc.getLocale().active
      : 'en'

    return (
      <div className="lc-root" ref={rootRef}>

        <div className="lc-cols lc-head">
          <StatsBoard requests={requests} events={events} usage={usage} toolCalls={data.toolCalls} images={data.images}
            cost={data.cost} locale={activeLocale} />
          <PluginInfo />
        </div>

        <div className="lc-cols">
          <div className="lc-col">
            <CurrentComposition
              head={head}
              subtitle={(data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '')}
              hoverKey={hoverCat}
              onHoverKey={setHoverCat}
              tools={data.toolList}
              onToolFocus={setToolFocus}
            />

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
                      className={'lc-gran-btn' + (trendMode === 'delta' ? ' lc-gran-on' : '')}
                      onClick={() => { setTrendMode('delta') }}
                    >{t('gran.delta')}</button>
                  </div>
                </div>
              </div>
              {displayRequests.length === 0
                ? <div className="lc-empty">{t('trend.empty')}</div>
                : (
                  <div>
                    <TrendChart
                      // Remount per session: switching sessions re-anchors the chart at the newest bars instead of inheriting stale scroll
                      // state.
                      key={sessionId}
                      // Render ALL retained requests (bounded by the host's maxKeptTurns/maxRequestSteps config) so earlier turns/steps
                      // stay reachable via horizontal scroll.
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
                    <RequestDetail
                      request={activeReq}
                      // Delta mode pairs the detail with the SAME previous record the chart diffs against (first bar: null).
                      prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1] : null) : undefined}
                      marker={activeReq !== null ? markerOf(activeReq) : undefined}
                    />
                  </div>
                )}
            </div>
          </div>

          {/* `lc-col-browser` stretches the browser card to the left column's height — Context tab only; the /context modal must stay
              content-sized.
              */}
          <div className="lc-col lc-col-browser">
            <ContextBrowser
              data={data}
              headers={headers}
              useSession={props.useSession}
              loadOlderHistory={props.loadOlderHistory}
              previewSeq={hoveredSeq}
              pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
              hoverKey={hoverCat}
              onHoverKey={setHoverCat}
              toolFocus={toolFocus}
              onToolFocusHandled={clearToolFocus}
              loadImage={loadImage}
            />
          </div>
        </div>

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
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}
