/**
 * ContextView — the root component of the Context tab: owns the snapshot
 * fetch/poll state and composes the stats board, composition bar, history
 * chart + detail, events and message columns.
 *
 * First-screen notes (all behavior-preserving):
 * - The initial data state is seeded from the per-session cache, so
 *   re-opening a session renders instantly and the poll refreshes behind it.
 * - Polling pauses while the tab is hidden and resumes (with an immediate
 *   fetch) on becoming visible again.
 * - A failed poll only surfaces the error screen when there is no data to
 *   show yet; already-visible data is never blanked by a transient error.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord, Snapshot } from '../../shared/types'
import { cacheGet, cachePut } from '../cache'
import { partsOf } from '../categories'
import type { LocaleService } from '../services'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import { makeEventList } from './events'
import { makeNodeList } from './nodes'
import { makeRequestDetail } from './requestDetail'
import { makeStatsBoard } from './statsBoard'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, makeTrendChart } from './trendChart'

const React: typeof ReactNS = require('react')
const h = React.createElement

export interface ContextViewProps { sessionId?: string }

export function makeContextView(ctx: ClientCtx, kit: ViewKit): (props: ContextViewProps) => ReactNS.ReactElement {
  const { t, tr, fmt, fmtTime, catLabel } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  const NodeList = makeNodeList(kit)
  const StatsBoard = makeStatsBoard(kit)

  return function ContextView(props: ContextViewProps): ReactNS.ReactElement {
    const sessionId = props.sessionId
    const initial = typeof sessionId === 'string' && sessionId !== '' ? cacheGet(sessionId) ?? null : null
    const [data, setData] = React.useState<Snapshot | null>(initial)
    const [error, setError] = React.useState<string | null>(null)
    const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = React.useState<number | null>(null)
    const [tick, setTick] = React.useState(0)
    const [granularity, setGranularity] = React.useState<'step' | 'turn'>('step')
    // Shared hover link between the composition bar and its legend below.
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    // Latest data for the fetch effect's error branch (a ref, so the
    // [sessionId]-only effect sees fresh state without re-subscribing).
    const dataRef = React.useRef<Snapshot | null>(initial)
    React.useEffect(() => { dataRef.current = data }, [data])

    React.useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      let alive = true
      const load = () => {
        // Generic Connection RPC channel served by the Host half.
        ctx.connection.rpc.call('/dsh-context', 'snapshot', { sessionId }).then(res => {
          if (!alive) return
          if (res && res.ok) {
            const snap = res.value as Snapshot
            cachePut(sessionId, snap)
            setData(snap)
            setError(null)
          } else if (dataRef.current === null) {
            // Only surface fetch failures when there is nothing to show yet —
            // a transient poll error must not blank already-visible data.
            setError(res && res.error ? String(res.error.message || res.error.code) : 'failed')
          }
        }, (err: unknown) => {
          if (alive && dataRef.current === null) {
            setError(String(err instanceof Error ? err.message : err))
          }
        })
      }
      load()
      // The data only serves the visible UI: pause polling while the tab is
      // hidden and refresh immediately when it becomes visible again.
      const timerId = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
      }, 2000)
      const onVisible = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') load()
      }
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
      return () => {
        alive = false
        clearInterval(timerId)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      }
    }, [sessionId])

    // Re-render on locale switch.
    React.useEffect(() => {
      const localeSvc = ctx.get('locale') as LocaleService | undefined
      if (!localeSvc) return undefined
      return localeSvc.subscribe(() => setTick(x => x + 1))
    }, [])

    void tick

    if (error) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('error') + error))
    }
    if (!data) {
      return h('div', { className: 'lc-root' }, h('div', { className: 'lc-empty' }, t('loading')))
    }

    const current = data.current
    const requests = data.requests || []
    const events = data.events || []
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

    const windowPct = data.contextWindow ? Math.min(100, Math.round(current.total / data.contextWindow * 100)) : null

    return h('div', { className: 'lc-root' },

      // ---- session context stats (over the retained window) ----
      h(StatsBoard, { requests, events }),

      // ---- overview ----
      h('div', { className: 'lc-card' },
        h('div', { className: 'lc-card-title' },
          t('overview.title'),
          h('span', { className: 'lc-card-sub' },
            (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : ''))),
        h('div', { className: 'lc-overview-num' },
          h('b', null, fmt(current.total)),
          h('span', null, data.contextWindow
            ? ' / ' + fmt(data.contextWindow) + ' ' + tr('overview.ofWindow', { p: windowPct ?? 0 })
            : ' ' + t('overview.estimate')),
          // The provider-reported prompt of the last request is the best
          // ground truth for what the model actually received; the fixed
          // density heuristic can undercount CJK-heavy content, so show the
          // real number alongside the estimate.
          displayRequests.length > 0 && displayRequests[displayRequests.length - 1].prompt !== undefined
            ? h('span', { className: 'lc-actual' },
              tr('overview.actual', { n: fmt(displayRequests[displayRequests.length - 1].prompt ?? 0) }))
            : null),
        h(StackedBar, { parts: partsOf(current), height: 16, max: data.contextWindow, hoverKey: hoverCat, onHoverKey: setHoverCat }),
        h(Legend, { parts: partsOf(current), hoverKey: hoverCat, onHoverKey: setHoverCat }),
        (data.toolList && data.toolList.length > 0) ? h('div', { className: 'lc-tools' },
          t('tools.top'),
          data.toolList.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(tool => {
            return h('span', { key: tool.name, className: 'lc-tool-chip' }, tool.name + ' ' + fmt(tool.tokens))
          }),
          data.toolList.length > 5 ? h('span', { className: 'lc-card-sub' }, ' ' + tr('tools.more', { n: data.toolList.length })) : null) : null),

      // ---- trend ----
      h('div', { className: 'lc-card' },
        h('div', { className: 'lc-card-title' },
          t('trend.title'),
          h('span', { className: 'lc-card-sub' }, t('trend.hint')),
          h('div', { className: 'lc-gran' },
            h('button', {
              className: 'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : ''),
              onClick: () => { setGranularity('step') },
            }, t('gran.step')),
            h('button', {
              className: 'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : ''),
              onClick: () => { setGranularity('turn') },
            }, t('gran.turn')))),
        displayRequests.length === 0
          ? h('div', { className: 'lc-empty' }, t('trend.empty'))
          : h('div', null,
            h(TrendChart, {
              // Remount per session: switching sessions re-anchors the chart
              // at the newest bars instead of inheriting stale scroll state.
              key: sessionId,
              // The host caps the log at 160 requests; render them ALL so
              // earlier turns/steps stay reachable via horizontal scroll.
              requests: displayRequests,
              markers,
              selectedSeq: pinnedReq ? pinnedReq.seq : null,
              hoveredSeq,
              activeTurn,
              granularity,
              onSelect: setSelectedSeq,
              onHover: setHoveredSeq,
              onHoverTurn: setHoverTurn,
            }),
            h(RequestDetail, { request: activeReq, marker: activeReq !== null ? markerOf(activeReq) : undefined }))),

      // ---- events + messages ----
      h('div', { className: 'lc-cols' },
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' }, t('events.title')),
          h(EventList, { events })),
        h('div', { className: 'lc-card lc-col' },
          h('div', { className: 'lc-card-title' },
            t('nodes.title'),
            h('span', { className: 'lc-card-sub' }, t('nodes.hint'))),
          h(NodeList, { nodes, dropped: data.droppedNodes || 0 }))),

      h('div', { className: 'lc-foot' }, t('footer')))
  }
}
