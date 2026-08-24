/**
 * Bespoke per-request history chart — no shared data-viz primitive — styled through the shared `--dsw-alias-*` tokens; helpers
 * aggregateByTurn/attachMarkers are shared with ContextView.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface TrendChartProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'diff'
  focusTurn: number | null
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
}

/**
 * Collapse per-step requests into one bar per turn — each turn is represented by its LAST step's record, tagged `stepCount` for the bar's
 * column width; the log keeps one turn's requests consecutive, so a run of equal turns collapses to its final record.
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
 * Attach each boundary event (compaction/prune) to the first request logged after it — one entry per index, for the ✂ marker and the detail
 * chip; shared with the detail panel so both show the SAME event.
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

  const CHART_H = 112
  // Constant bar width: sparse histories don't stretch bars, dense ones scroll instead of compressing; the turn strip below mirrors the
  // same column grid.
  const BAR_W = 14
  const BAR_GAP = 2
  // Neutral zebra, deliberately DISJOINT from the category palette — the strip must read as a partition layer, not a bottom segment of the
  // composition bars.
  const TURN_FILLS = ['rgba(128,128,128,0.12)', 'rgba(128,128,128,0.26)']

  // Anchor bar HEIGHT to the provider-reported prompt when the request carried usage: categories keep their heuristic ratios but the height
  // tracks the real billed tokens (matching the overview card and official chat ring), not the underpriced estimate.
  const anchorOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 && req.total > 0 ? req.prompt / req.total : 1
  const barTotalOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 ? req.prompt : req.total

  /**
   * Diff mode: each category becomes |current − previous|, `total` the summed magnitude, `net` the signed change for the tooltip; the first
   * request diffs from zero so the scale is change-driven, and per-request provider prompt/output are dropped (they are not diffs).
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
    marker: ContextEventRecord | undefined
    selected: boolean
    hovered: boolean
    inTurn: boolean
    maxTotal: number
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  // Memoized so a hover/selection change re-renders only the bars whose flags flipped — the retained log renders in full (thousands of
  // nodes on long sessions); `req`/`marker` keep stable identities because the parent memoizes its aggregation, so the default shallow
  // compare suffices.
  const ChartBar = React.memo(function ChartBar(props: ChartBarProps): ReactNS.ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    return (
      <div
        className={'lc-bar'
          + (props.selected ? ' lc-bar-selected' : '')
          + (props.hovered ? ' lc-bar-hovered' : '')
          + (props.inTurn ? ' lc-bar-in-turn' : '')}
        data-seq={req.seq}
        style={{ width: `${BAR_W}px` }}
        onClick={() => { props.onSelect(props.selected ? null : req.seq) }}
        onMouseEnter={() => { props.onHover(req.seq) }}
      >
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
            // px (not %) heights: the stack is content-driven, so percentage heights would collapse against an indefinite base.
            return <div key={c.key} style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
          })}
        </div>
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const diff = props.mode === 'diff'
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

    // Consecutive same-turn requests collapse into one labeled range; `span` counts the STEP columns the group covers (step records count
    // one each), so strip blocks align with the bars in both granularities.
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

    // Strip offsets/widths are computed in content px so the scroll handler can re-center labels analytically and measures only the handful
    // of labels on screen.
    const turnOffsets: number[] = []
    const turnWidths: number[] = []
    {
      let x = 0
      for (const grp of groups) {
        const w = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
        turnOffsets.push(x)
        turnWidths.push(w)
        x += w + BAR_GAP
      }
    }

    // Default anchor: newest bars at the RIGHT edge; the first layout after mount scrolls unconditionally, a GRANULARITY SWITCH re-anchors
    // the same way (step mode must not inherit the turn chart's stale left edge), otherwise stick to the end only while already near it;
    // useLayoutEffect avoids a first-paint flash and edge fades stay in sync.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const scrolledOnce = React.useRef(false)
    const lastGranRef = React.useRef(props.granularity)
    const [edges, setEdges] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false })
    // Mirror of the last computed fades: the layout effect runs after EVERY render (no deps), so it must dispatch setState only on true
    // change — a same-value dispatch during a granularity switch's pending lanes disables React's eager bailout and the queue grows
    // unbounded (React error #185).
    const edgesRef = React.useRef(edges)
    const updateEdges = (el: HTMLDivElement): void => {
      const left = el.scrollLeft > 4
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      const prev = edgesRef.current
      if (prev.left === left && prev.right === right) return
      edgesRef.current = { left, right }
      setEdges({ left, right })
    }
    /**
     * Keep each turn label centered within its block's VISIBLE slice so it never scrolls out while any part of the block is on screen
     * (narrower-than-label blocks stay put); reads (offsetWidth) batch before writes (transform) to avoid layout thrash — out-of-view
     * blocks need no measurement.
     */
    const updateTurnLabels = (el: HTMLDivElement): void => {
      const labels = el.querySelectorAll<HTMLElement>('.lc-turn-label')
      const n = Math.min(labels.length, turnOffsets.length)
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      const writes: [HTMLElement, string][] = []
      for (let i = 0; i < n; i++) {
        const off = turnOffsets[i]
        const w = turnWidths[i]
        const visL = Math.max(off, sl)
        const visR = Math.min(off + w, vr)
        let dx = 0
        if (visR > visL) {
          const lw = labels[i].offsetWidth
          if (lw < w) {
            const center = (visL + visR) / 2 - off
            dx = Math.min(Math.max(center, lw / 2), w - lw / 2) - w / 2
          }
        }
        const next = dx !== 0 ? `translateX(${dx}px)` : ''
        if (labels[i].style.transform !== next) writes.push([labels[i], next])
      }
      for (const [label, next] of writes) label.style.transform = next
    }
    React.useLayoutEffect(() => {
      const el = scrollRef.current
      if (el === null) return
      if (props.granularity !== lastGranRef.current) {
        lastGranRef.current = props.granularity
        scrolledOnce.current = false
      }
      // A strip-clicked focus turn centers its bar instead of the newest anchor, consumed once via onFocusTurnHandled — also when
      // granularity was already 'turn' (no re-anchor happens that render).
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
      updateTurnLabels(el)
    })

    // Compact single-line hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed): position, time,
    // estimated total, provider prompt when available; the per-category breakdown lives in the detail panel below.
    const tipOf = (req: RequestRecord): string => {
      const head = req.stepCount !== undefined && req.stepCount > 1
        ? t('tip.turn', { t: req.turn ?? 0, n: req.stepCount })
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 })
      if (diff) {
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
          className={'lc-chart-scroll' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
          ref={scrollRef}
          onScroll={(e: ReactNS.UIEvent<HTMLDivElement>) => {
            updateEdges(e.currentTarget)
            updateTurnLabels(e.currentTarget)
          }}
        >
          {edges.left ? <div className="lc-chart-fade lc-chart-fade-l" /> : null}
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
          {/* The tip lives inside the scrolling content so it stays glued to its bar's column while the chart scrolls. */}
          {hoveredReq !== null ? (
            <div
              className="lc-chart-tip"
              style={{ left: `${hoveredIdx * (BAR_W + BAR_GAP) + BAR_W / 2}px` }}
            >{tipOf(hoveredReq)}</div>
          ) : null}
          {/* Turn strip: one COLOR BLOCK per turn spanning exactly its bars' columns, so the partition reads at a glance and lines up with
              the steps; hovering a block highlights that turn's bars and vice versa — one shared hover-only state.
              */}
          <div className="lc-turns" onMouseLeave={() => { props.onHoverTurn(null) }}>
            {groups.map((grp, gi) => {
              const on = props.activeTurn === grp.turn
              return (
                <span
                  key={`turn-${gi}`}
                  className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                  style={{
                    width: `${turnWidths[gi]}px`,
                    background: TURN_FILLS[gi % TURN_FILLS.length],
                  }}
                  title={`T${grp.turn}`}
                  onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                  onClick={() => { props.onPickTurn(grp.turn) }}
                ><span className="lc-turn-label">{`T${grp.turn}`}</span></span>
              )
            })}
          </div>
        </div>
        {edges.right ? <div className="lc-chart-fade lc-chart-fade-r" /> : null}
      </div>
    )
  }
}
