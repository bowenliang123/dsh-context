/**
 * TrendChart — the per-request history chart: fixed-width stacked bars with
 * a horizontal scroll (newest anchored right), a turn color strip below,
 * ✂ markers for boundary events, and edge fades. Includes the data
 * preparation helpers (aggregateByTurn, attachMarkers) used by ContextView.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React, h } from '../react'

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
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
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
  const markers: (ContextEventRecord | undefined)[] = new Array(requests.length)
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
  const { t, tr, fmt, fmtTime, catLabel, eventLabel, eventAt } = kit

  // Plot height in px (the marker lane above it is 18px).
  const CHART_H = 112
  // Fixed column geometry: constant bar width keeps sparse histories from
  // stretching bars, and dense histories scroll horizontally instead of
  // compressing. The turn strip below mirrors the same column grid.
  const BAR_W = 14
  const BAR_GAP = 2
  // Turn strip palette: one color per turn, cycling for long histories.
  const TURN_COLORS = ['#6366f1', '#f59e0b', '#22c55e', '#a855f7', '#3b82f6', '#14b8a6', '#ef4444', '#ec4899']

  return function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const requests = props.requests
    const markers = props.markers
    let maxTotal = 1
    for (const req of requests) if (req.total > maxTotal) maxTotal = req.total

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
      if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 24) {
        el.scrollLeft = el.scrollWidth
      }
      updateEdges(el)
    })

    return h('div', { className: 'lc-chartrow' },
      h('div', { className: 'lc-axis' },
        h('span', { className: 'lc-axis-top' }, fmt(maxTotal)),
        h('span', { className: 'lc-axis-mid' }, fmt(Math.round(maxTotal / 2))),
        h('span', { className: 'lc-axis-bot' }, '0')),
      h('div', {
        className: 'lc-chart-scroll',
        ref: scrollRef,
        onScroll: (e: ReactNS.UIEvent<HTMLDivElement>) => { updateEdges(e.currentTarget) },
      },
        // Edge fades: visible whenever more history sits beyond the viewport,
        // so the horizontal scroll affordance is obvious.
        edges.left ? h('div', { className: 'lc-chart-fade lc-chart-fade-l' }) : null,
        // Hovering a bar previews it in the detail below; leaving the plot
        // clears the preview (a pinned selection, if any, takes over again).
        h('div', { className: 'lc-chart', onMouseLeave: () => { props.onHover(null) } },
          h('div', { className: 'lc-grid lc-grid-top' }),
          h('div', { className: 'lc-grid lc-grid-mid' }),
          requests.map((req, i) => {
            const marker = markers[i]
            const markerAt = marker !== undefined ? eventAt(marker) : null
            const selected = props.selectedSeq === req.seq
            const hovered = props.hoveredSeq === req.seq
            const inTurn = props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn
            const tip = (req.stepCount !== undefined && req.stepCount > 1
              ? tr('tip.turn', { t: req.turn ?? 0, n: req.stepCount })
              : tr('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 }))
              + ' · ' + fmtTime(req.time) + '\n'
              + tr('tip.total', { n: fmt(req.total) })
              + (req.prompt !== undefined ? tr('tip.actual', { n: fmt(req.prompt) }) : '') + '\n'
              + CATS.map(c => catLabel(c.key) + ' ' + fmt(req[c.key] || 0)).join(' / ')
            return h('div', {
              key: req.seq,
              // Uniform column width in BOTH granularities: turn aggregates
              // keep the same fixed width as step bars.
              className: 'lc-bar'
                + (selected ? ' lc-bar-selected' : '')
                + (hovered ? ' lc-bar-hovered' : '')
                + (inTurn ? ' lc-bar-in-turn' : ''),
              style: { width: BAR_W + 'px' },
              title: tip,
              onClick: () => { props.onSelect(selected ? null : req.seq) },
              onMouseEnter: () => { props.onHover(req.seq) },
            },
              // The ✂ tooltip names the event AND where it happened: the
              // gap between the request before and the request after.
              marker !== undefined ? h('span', {
                className: 'lc-bar-marker',
                title: '✂ ' + (markerAt !== null ? markerAt + ' — ' : '') + eventLabel(marker),
              }, '✂') : null,
              h('div', { className: 'lc-bar-stack' },
                CATS.map(c => {
                  const v = req[c.key] || 0
                  if (!v) return null
                  // px heights: the stack's height is content-driven, so
                  // percentage heights would collapse against an indefinite base.
                  return h('div', { key: c.key, style: { height: Math.max(1, Math.round(v / maxTotal * CHART_H)) + 'px', background: c.color } })
                })))
          })),
        // Turn strip: one COLOR BLOCK per turn, spanning exactly its bars'
        // columns, so the partition reads at a glance and lines up with the
        // steps above. Hovering a block highlights that turn's bars in the
        // chart (and hovering a bar highlights its block — the active turn
        // is shared hover-only state).
        h('div', { className: 'lc-turns', onMouseLeave: () => { props.onHoverTurn(null) } },
          groups.map((grp, gi) => {
            // Turn mode: uniform blocks under uniform bars (1:1). Step mode:
            // blocks span their steps' columns. The flex gap between blocks
            // mirrors the bar gap, so blocks always line up with the bars.
            const on = props.activeTurn === grp.turn
            const blockW = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
            return h('span', {
              key: 'turn-' + gi,
              className: 'lc-turn' + (on ? ' lc-turn-on' : ''),
              style: {
                width: blockW + 'px',
                background: TURN_COLORS[gi % TURN_COLORS.length],
              },
              title: 'T' + grp.turn,
              onMouseEnter: () => { props.onHoverTurn(grp.turn) },
            }, 'T' + grp.turn)
          }))),
      edges.right ? h('div', { className: 'lc-chart-fade lc-chart-fade-r' }) : null)
  }
}
