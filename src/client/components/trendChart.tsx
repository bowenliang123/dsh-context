/**
 * TrendChart — the per-request history chart: fixed-width stacked bars with
 * a horizontal scroll (newest anchored right), a turn color strip below,
 * ✂ markers for boundary events, and edge fades. Includes the data
 * preparation helpers (aggregateByTurn, attachMarkers) used by ContextView.
 * JSX component; the chart chrome is bespoke data-viz (no shared primitive),
 * styled through the shared `--dsw-alias-*` tokens.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface TrendChartProps {
  requests: RequestRecord[]
  /** One boundary event (compaction/prune) per request index, if attached. */
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  /** The turn currently highlighted (from the turn strip or a hovered bar). */
  activeTurn: number | null
  /** Display granularity; a switch re-anchors the chart at the newest bars. */
  granularity: 'step' | 'turn'
  /** Display mode: cumulative totals ('total') or per-request incremental diff ('diff'). */
  mode: 'total' | 'diff'
  /** A strip-clicked turn pending scroll-centering; null once handled. */
  focusTurn: number | null
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  /** Strip click: jump to turn granularity focused on that turn. */
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
}

/**
 * Collapse a per-step request timeline into one bar per turn: each turn is
 * represented by its LAST step's record (the context state when the turn
 * finished), tagged with the number of steps the turn spans so the bar can
 * keep the turn's column width and the detail can label it. Requests of one
 * turn are consecutive in the log, so a run of equal turns is replaced by
 * its final record.
 */
export function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      out[out.length - 1] = { ...req, stepCount: runSteps }
    } else {
      runSteps = 1
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

/**
 * Attach each boundary event (compaction/prune) to the first request
 * logged after it — one entry per request index, for the ✂ marker above
 * the bar and the range chip in the detail header. Shared by TrendChart
 * and the detail panel so both show the SAME event for a request.
 */
export function attachMarkers(requests: RequestRecord[], events: ContextEventRecord[]): (ContextEventRecord | undefined)[] {
  const markers: (ContextEventRecord | undefined)[] = new Array<ContextEventRecord | undefined>(requests.length)
  for (const ev of events) {
    if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
    for (let r = 0; r < requests.length; r++) {
      if (requests[r].seq >= ev.seq) {
        if (markers[r] === undefined) markers[r] = ev
        break
      }
    }
  }
  return markers
}

export function makeTrendChart(kit: ViewKit): (props: TrendChartProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit

  // Plot height in px (the marker lane above it is 18px).
  const CHART_H = 112
  // Fixed column geometry: constant bar width keeps sparse histories from
  // stretching bars, and dense histories scroll horizontally instead of
  // compressing. The turn strip below mirrors the same column grid.
  const BAR_W = 14
  const BAR_GAP = 2
  // Turn strip fills: a neutral zebra, deliberately DISJOINT from the
  // category palette — the strip sits directly under the bars, and the old
  // per-turn palette (identical to the six category colors) made it read as
  // a detached, misaligned bottom segment of the composition bars.
  const TURN_FILLS = ['rgba(128,128,128,0.12)', 'rgba(128,128,128,0.26)']

  // Anchor each bar to the provider-reported prompt size when the request
  // carried usage: the heuristic categories keep their ratios but the bar
  // HEIGHT tracks the real billed tokens (matching the overview card and
  // the official chat ring) instead of the underpriced raw estimate.
  const anchorOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 && req.total > 0 ? req.prompt / req.total : 1
  const barTotalOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 ? req.prompt : req.total

  /**
   * Transform one request into its per-request incremental diff for the
   * diff mode. Each category becomes |current − previous| (the magnitude of
   * change, stacked like the cumulative bars), `total` becomes the summed
   * magnitude, and `net` keeps the signed change for the tooltip. The first
   * request (no previous) diff from empty is zero, so the diff mode's scale
   * is driven purely by inter-request changes rather than the initial
   * cumulative baseline. Provider prompt/output are dropped: they are
   * per-request values, not diffs.
   */
  const diffOf = (req: RequestRecord, prev: RequestRecord | null): RequestRecord => {
    const out = { ...req }
    let churn = 0
    let net = 0
    for (const c of CATS) {
      const d = prev !== null ? (req[c.key] || 0) - (prev[c.key] || 0) : 0
      out[c.key] = Math.abs(d)
      churn += Math.abs(d)
      net += d
    }
    out.total = churn
    out.net = net
    delete out.prompt
    delete out.output
    return out
  }

  interface ChartBarProps {
    req: RequestRecord
    /** The boundary event attached to this bar, if any. */
    marker: ContextEventRecord | undefined
    selected: boolean
    hovered: boolean
    inTurn: boolean
    maxTotal: number
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  // Memoized so a hover/selection change re-renders only the bars whose
  // flags flipped: the retained log renders in full (no windowing), so a
  // long session's chart is thousands of nodes and the pointer path is hot.
  // `req`/`marker` keep stable identities between projection pushes (the
  // parent memoizes its turn-aggregation), so the default shallow compare
  // suffices.
  const ChartBar = React.memo(function ChartBar(props: ChartBarProps): ReactNS.ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    return (
      <div
        // Uniform column width in BOTH granularities: turn aggregates
        // keep the same fixed width as step bars.
        className={'lc-bar'
          + (props.selected ? ' lc-bar-selected' : '')
          + (props.hovered ? ' lc-bar-hovered' : '')
          + (props.inTurn ? ' lc-bar-in-turn' : '')}
        data-seq={req.seq}
        style={{ width: `${BAR_W}px` }}
        onClick={() => { props.onSelect(props.selected ? null : req.seq) }}
        onMouseEnter={() => { props.onHover(req.seq) }}
      >
        {/* The ✂ tooltip names the event AND where it happened: the
            gap between the request before and the request after. */}
        {marker !== undefined ? (
          <span
            className="lc-bar-marker"
            title={'✂ ' + (markerAt !== null ? markerAt + ' — ' : '') + eventLabel(marker)}
          >{'✂'}</span>
        ) : null}
        <div className="lc-bar-stack">
          {CATS.map((c) => {
            const v = (req[c.key] || 0) * anchorOf(req)
            if (!v) return null
            // px heights: the stack's height is content-driven, so
            // percentage heights would collapse against an indefinite base.
            return <div key={c.key} style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
          })}
        </div>
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const diff = props.mode === 'diff'
    // Diff mode swaps the cumulative records for per-request diffs. Memoized
    // so hover-driven re-renders keep the bar props identity-stable (same
    // reason the parent memoizes its turn aggregation).
    const requests = React.useMemo(
      () => (diff ? props.requests.map((req, i) => diffOf(req, i > 0 ? props.requests[i - 1] : null)) : props.requests),
      [props.requests, diff],
    )
    const markers = props.markers
    let maxTotal = 1
    for (const req of requests) {
      const bt = barTotalOf(req)
      if (bt > maxTotal) maxTotal = bt
    }

    // Consecutive requests of the same turn collapse into one labeled range.
    // `span` is the number of STEP columns the group covers (step records
    // count one each). In turn granularity the bars are uniform width, so
    // the strip blocks are uniform too; in step granularity they span their
    // steps' columns. Either way bars and blocks stay aligned.
    const groups: { turn: number; count: number; span: number; agg: boolean }[] = []
    for (const req of requests) {
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, span: 0, agg: req.stepCount !== undefined }
        groups.push(grp)
      }
      grp.count++
      grp.span += req.stepCount ?? 1
    }

    // Default anchor: the newest bars at the RIGHT edge. The first layout
    // after mount scrolls unconditionally; a GRANULARITY SWITCH re-anchors
    // the same way (returning to step mode must show the newest bars, not
    // the stale left edge from the narrow turn chart); otherwise the chart
    // only sticks to the end while the user is already near it (scrolling
    // away is respected). useLayoutEffect avoids a first-paint flash at the
    // left. Edge fades stay in sync with the scroll position.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const scrolledOnce = React.useRef(false)
    const lastGranRef = React.useRef(props.granularity)
    const [edges, setEdges] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false })
    // Mirror of the last computed fades. The layout effect below runs after
    // EVERY render (no deps), so it must not dispatch a setState unless the
    // values truly changed: on a granularity switch the first dispatch
    // schedules a sync re-render whose fiber still has pending lanes, which
    // disables React's same-value eager bailout — every subsequent commit
    // then enqueues yet another update and the queue grows without bound
    // (React error #185, maximum update depth — the tab whites out).
    const edgesRef = React.useRef(edges)
    const updateEdges = (el: HTMLDivElement): void => {
      const left = el.scrollLeft > 4
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      const prev = edgesRef.current
      if (prev.left === left && prev.right === right) return
      edgesRef.current = { left, right }
      setEdges({ left, right })
    }
    React.useLayoutEffect(() => {
      const el = scrollRef.current
      if (el === null) return
      if (props.granularity !== lastGranRef.current) {
        lastGranRef.current = props.granularity
        scrolledOnce.current = false // re-anchor on every granularity switch
      }
      // A strip click carries a focus turn: center its bar instead of the
      // default newest-anchor. Consumed once — also when the granularity
      // was already 'turn' (no re-anchor happens on that render).
      if (props.focusTurn !== null) {
        const gi = groups.findIndex(g => g.turn === props.focusTurn)
        if (gi >= 0) {
          scrolledOnce.current = true
          el.scrollLeft = Math.max(0, gi * (BAR_W + BAR_GAP) + BAR_W / 2 - el.clientWidth / 2)
        }
        props.onFocusTurnHandled()
      }
      if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 24) {
        el.scrollLeft = el.scrollWidth
      }
      updateEdges(el)
    })

    // Compact single-line hover tooltip (shown instantly by the custom
    // `.lc-chart-tip`, replacing the delayed native title): position, time,
    // estimated total, and the provider-reported prompt when available. The
    // per-category breakdown lives in the detail panel below.
    const tipOf = (req: RequestRecord): string => {
      const head = req.stepCount !== undefined && req.stepCount > 1
        ? t('tip.turn', { t: req.turn ?? 0, n: req.stepCount })
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 })
      if (diff) {
        // Diff mode: the bar height is the summed magnitude, but the hover
        // tip reports the SIGNED net change so growth vs shrink is explicit.
        const n = req.net ?? 0
        return head + ' · ' + fmtTime(req.time) + ' · ' + t('tip.diff', { n: (n > 0 ? '+' : '') + fmt(n) })
      }
      return head + ' · ' + fmtTime(req.time) + ' · ' + t('tip.total', { n: fmt(req.total) })
        + (req.prompt !== undefined ? ' · ' + t('tip.actual', { n: fmt(req.prompt) }) : '')
    }
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null

    return (
      <div className="lc-chartrow">
        <div className="lc-axis">
          <span className="lc-axis-top">{fmt(maxTotal)}</span>
          <span className="lc-axis-mid">{fmt(Math.round(maxTotal / 2))}</span>
          <span className="lc-axis-bot">{'0'}</span>
        </div>
        <div
          // Turn-aware dim scope: while a turn is focused (bar or strip hover),
          // bars and strip blocks OUTSIDE the active turn fade to 35%.
          className={'lc-chart-scroll' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
          ref={scrollRef}
          onScroll={(e: ReactNS.UIEvent<HTMLDivElement>) => { updateEdges(e.currentTarget) }}
        >
          {/* Edge fades: visible whenever more history sits beyond the viewport,
              so the horizontal scroll affordance is obvious. */}
          {edges.left ? <div className="lc-chart-fade lc-chart-fade-l" /> : null}
          {/* Hovering a bar previews it in the detail below; leaving the plot
              clears the preview (a pinned selection, if any, takes over again). */}
          <div
            className="lc-chart"
            onMouseLeave={() => { props.onHover(null) }}
          >
            <div className="lc-grid lc-grid-top" />
            <div className="lc-grid lc-grid-mid" />
            {requests.map((req, i) => (
              <ChartBar
                key={req.seq}
                req={req}
                marker={markers[i]}
                selected={props.selectedSeq === req.seq}
                hovered={props.hoveredSeq === req.seq}
                inTurn={props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn}
                maxTotal={maxTotal}
                onSelect={props.onSelect}
                onHover={props.onHover}
              />
            ))}
          </div>
          {/* Instant hover tooltip, glued to its bar's column (it lives in the
              scrolling content, so it follows the bar while the chart scrolls). */}
          {hoveredReq !== null ? (
            <div
              className="lc-chart-tip"
              style={{ left: `${hoveredIdx * (BAR_W + BAR_GAP) + BAR_W / 2}px` }}
            >{tipOf(hoveredReq)}</div>
          ) : null}
          {/* Turn strip: one COLOR BLOCK per turn, spanning exactly its bars'
              columns, so the partition reads at a glance and lines up with the
              steps above. Hovering a block highlights that turn's bars in the
              chart (and hovering a bar highlights its block — the active turn
              is shared hover-only state). */}
          <div className="lc-turns" onMouseLeave={() => { props.onHoverTurn(null) }}>
            {groups.map((grp, gi) => {
              // Turn mode: uniform blocks under uniform bars (1:1). Step mode:
              // blocks span their steps' columns. The flex gap between blocks
              // mirrors the bar gap, so blocks always line up with the bars.
              const on = props.activeTurn === grp.turn
              const blockW = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
              return (
                <span
                  key={`turn-${gi}`}
                  className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                  style={{
                    width: `${blockW}px`,
                    background: TURN_FILLS[gi % TURN_FILLS.length],
                  }}
                  title={`T${grp.turn}`}
                  onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                  onClick={() => { props.onPickTurn(grp.turn) }}
                >{`T${grp.turn}`}</span>
              )
            })}
          </div>
        </div>
        {edges.right ? <div className="lc-chart-fade lc-chart-fade-r" /> : null}
      </div>
    )
  }
}
