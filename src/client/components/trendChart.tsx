/**
 * Bespoke per-request history chart — no shared data-viz primitive — styled through the shared `--dsw-alias-*` tokens; helpers
 * aggregateByTurn/attachMarkers are shared with ContextView.
 */

import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type UIEvent } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import { containHorizontalOverscroll } from '../overscroll'
import type { ViewKit } from '../viewkit'

export interface TrendChartProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  focusTurn: number | null
  /** Mirrored category hover (shared with the overview and the browser): lights that category's segment in every bar. */
  hoverCat: string | null
  /**
   * The browser's open category: every bar plots only that category's fold figure, with the axis rescaled
   * to its own max. Null plots every category; an unrecognized key (a stale or hostile state) degrades to the
   * unfocused chart.
   */
  focusCat?: string | null
  /**
   * Adaptive scale (the trend card's title-adjacent toggle): the axis is recomputed from the bars currently
   * VISIBLE in the scroller and follows the scroll, so a spike far outside the window cannot flatten the bars
   * on screen. Off = the whole retained log scales the axis, the historical behavior.
   */
  adaptive?: boolean
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

/**
 * The chat→Context jump's target: the turn bar whose closing reply the user clicked — the relayed seq is a turn's LAST step, exactly the
 * aggregate's record — or, when that turn has aged out of the host's retained window, the oldest retained bar. Resolved against turn
 * aggregates, since the jump pins in turn granularity. Null only on an empty history.
 */
export function jumpTargetOf(requests: RequestRecord[], seq: number): RequestRecord | null {
  for (const req of requests) if (req.seq === seq) return req
  return requests.length > 0 ? requests[0] : null
}

export function makeTrendChart(kit: ViewKit): (props: TrendChartProps) => ReactElement {
  const { t, fmt, eventLabel, eventAt, catLabel } = kit

  const CHART_H = 112
  // Quarter-mark label tops for the axis (mirrored to .lc-axis-q1/.lc-axis-q3 in trendChart.css): chart top 18
  // plus a quarter/three-quarters of the 112px bar area, minus half the 11px label box (font-size 11, line-height 1).
  const Q3_TOP = 41
  const Q1_TOP = 97
  // Delta axis ticks are signed: '+' only on positives — fmt already carries the minus for negatives.
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + fmt(v)
  // Constant bar width: sparse histories don't stretch bars, dense ones scroll instead of compressing; the turn strip below mirrors the
  // same column grid.
  const BAR_W = 14
  const BAR_GAP = 2
  // Neutral zebra, deliberately DISJOINT from the category palette — the strip must read as a partition layer, not a bottom segment of the
  // composition bars.
  const TURN_FILLS = ['rgba(128,128,128,0.12)', 'rgba(128,128,128,0.26)']
  // Turn labels render at natural width (a 2-digit "12" is wider than a 14px turn bar) and overflow their block.
  // Every label must stay on the single line, so the strip shrinks ALL labels to one font size — the largest at
  // which the tightest adjacent pair still clears the gap (analytic widths below, no measurement) — and the
  // measured chain in updateTurnLabels stays only as the last-resort guard past the floor. OVERHANG bounds how
  // far a label can reach beyond its block (a generous read of "9999" at 10px) for the viewport-participation
  // test; GAP is the breathing room between adjacent labels' boxes.
  const LABEL_OVERHANG = 48
  const LABEL_GAP = 2
  // Label font sizing (the 10px base mirrors .lc-turn in trendChart.css): conservative upper-bound glyph width
  // at the base size (6.5px per digit at 10px semibold), floored at 6px.
  const LABEL_FONT = 10
  const LABEL_FONT_MIN = 6
  const estTurnLabel = (turn: number): number => 6.5 * String(turn).length

  /**
   * Focus a bar on one category (the browser's open category): the kept bucket carries its fold figure, the other
   * buckets zero, and `total` IS the plotted figure — the downstream stack/tooltip math reads the derived record
   * unchanged. The raw fold figures are plotted as-is: a per-request rescale against the provider prompt would drift
   * with the heuristic's ratio error and fake growth into constant categories (a never-changing system prompt must
   * plot flat).
   */
  const focusOf = (req: RequestRecord, cat: string): RequestRecord => {
    const key = cat as Category | 'system' | 'tools'
    const out: RequestRecord = { ...req }
    const v = req[key] || 0
    out.total = v
    for (const c of CATS) out[c.key] = c.key === key ? v : 0
    return out
  }

  /**
   * Delta mode: each category keeps the SIGNED change vs the previous record so bars can diverge
   * above/below the zero line; `total` is the churn (summed magnitude), `net` the signed change
   * for the tooltip; the first request starts from zero so the scale is change-driven, and per-request
   * provider prompt/output are dropped (they are not deltas).
   */
  const deltaOf = (req: RequestRecord, prev: RequestRecord | null): RequestRecord => {
    const { prompt: _prompt, output: _output, ...out } = req
    let churn = 0
    let net = 0
    for (const c of CATS) {
      const d = prev !== null ? (req[c.key] || 0) - (prev[c.key] || 0) : 0
      out[c.key] = d
      churn += Math.abs(d)
      net += d
    }
    out.total = churn
    out.net = net
    return out
  }

  /** The visible window's own maxima (adaptive scale): the total-mode peak, and the delta arms' up/down sums. */
  interface VisibleMax {
    total: number
    up: number
    down: number
  }

  interface ChartBarProps {
    req: RequestRecord
    marker: ContextEventRecord | undefined
    selected: boolean
    hovered: boolean
    inTurn: boolean
    maxTotal: number
    /**
     * Delta mode geometry: zero-line offsets in px (up from the top / down from the bottom of the bar area)
     * and the uniform px-per-token scale — identical above and below the zero line, so a +n segment and a
     * −n segment always draw the same height. All three absent in total mode; passed as PRIMITIVES so the
     * memoized bar keeps its shallow-compare bailout.
     */
    upPx?: number
    downPx?: number
    deltaScale?: number
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  // Memoized so a hover/selection change re-renders only the bars whose flags flipped — the retained log renders in full (thousands of
  // nodes on long sessions); `req`/`marker` keep stable identities because the parent memoizes its aggregation, so the default shallow
  // compare suffices.
  const ChartBar = memo(function ChartBar(props: ChartBarProps): ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    // Delta mode: diverging stacks — positive category deltas pile UP from the zero line, negative ones
    // hang DOWN from it, both in category colors (direction carries the sign, color the category).
    const diverge = props.upPx !== undefined && props.downPx !== undefined && props.deltaScale !== undefined
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
        {diverge ? (
          <>
            <div className="lc-bar-up" style={{ bottom: `${props.downPx}px` }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d <= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
            <div className="lc-bar-down" style={{ top: `${props.upPx}px` }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d >= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(-d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
          </>
        ) : (
          <div className="lc-bar-stack">
            {CATS.map((c) => {
              const v = req[c.key] || 0
              if (!v) return null
              // px (not %) heights: the stack is content-driven, so percentage heights would collapse against an indefinite base.
              return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
            })}
          </div>
        )}
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactElement {
    const delta = props.mode === 'delta'
    // An unrecognized focus key degrades to the unfocused chart instead of plotting an empty axis.
    const focus = props.focusCat !== null && props.focusCat !== undefined && CATS.some(c => c.key === props.focusCat)
      ? props.focusCat
      : null
    const requests = useMemo(
      () => {
        const base = focus !== null ? props.requests.map(req => focusOf(req, focus)) : props.requests
        return delta ? base.map((req, i) => deltaOf(req, i > 0 ? base[i - 1] : null)) : base
      },
      [props.requests, delta, focus],
    )
    const markers = props.markers
    // Adaptive scale: the maxima over the bars currently on screen. Null until the first measure, which falls
    // back to the whole-log scale, so the first paint never draws an empty axis; the field-wise comparison means
    // scrolling inside a window whose maxima do not move re-renders nothing.
    const adaptive = props.adaptive === true
    const [visMax, setVisMax] = useState<VisibleMax | null>(null)
    const measureVisible = (el: HTMLDivElement): void => {
      if (!adaptive) return
      const n = requests.length
      // Nothing measurable: an empty history, or a zero-width viewport (a hidden pane, an unlaid-out test DOM).
      // Keeping the previous scale degrades the chart to the whole-log axis instead of flattening every bar.
      if (n === 0 || el.clientWidth <= 0) return
      const pitch = BAR_W + BAR_GAP
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      let total = 0
      let up = 0
      let down = 0
      // The column holding the left edge through the one holding the right edge; the per-column test then drops
      // the neighbour whose column falls in the 2px gap just outside the viewport.
      const from = Math.max(0, Math.floor(sl / pitch))
      const to = Math.min(n - 1, Math.max(from, Math.floor((vr - 1) / pitch)))
      for (let i = from; i <= to; i++) {
        const col = i * pitch
        if (col >= vr || col + BAR_W <= sl) continue
        const req = requests[i]
        if (delta) {
          // Per-bar arms, then the window maximum — the same figures the whole-log loop takes.
          let bu = 0
          let bd = 0
          for (const c of CATS) {
            const d = req[c.key] || 0
            if (d > 0) bu += d
            else bd -= d
          }
          if (bu > up) up = bu
          if (bd > down) down = bd
        } else if (req.total > total) {
          total = req.total
        }
      }
      setVisMax(prev => prev !== null && prev.total === total && prev.up === up && prev.down === down
        ? prev
        : { total, up, down })
    }
    // Whole-log maxima: the axis when adaptive is off, and the fallback for a delta window with no change at all
    // (it carries no scale of its own).
    let maxTotal = 1
    let maxUp = 0
    let maxDown = 0
    if (delta) {
      for (const req of requests) {
        let up = 0
        let down = 0
        for (const c of CATS) {
          const d = req[c.key] || 0
          if (d > 0) up += d
          else down -= d
        }
        if (up > maxUp) maxUp = up
        if (down > maxDown) maxDown = down
      }
    } else {
      for (const req of requests) {
        if (req.total > maxTotal) maxTotal = req.total
      }
    }
    if (adaptive && visMax !== null) {
      if (delta) {
        if (visMax.up + visMax.down > 0) {
          maxUp = visMax.up
          maxDown = visMax.down
        }
      } else {
        maxTotal = Math.max(1, visMax.total)
      }
    }
    // The zero line splits the bar area PROPORTIONALLY to the larger side, so the px-per-token scale
    // is identical above and below it — a compaction's downward bar reads honestly against a growth bar.
    const span = Math.max(1, maxUp + maxDown)
    const deltaScale = CHART_H / span
    const upPx = Math.round(maxUp * deltaScale)
    const downPx = CHART_H - upPx
    // A delta quarter mark (axis label + its dashed guide) yields ENTIRELY when its 11px label box would
    // overlap the zero label (top 13+upPx) — the zero line is the reading reference. Total-mode marks never
    // collide and always render.
    const q3Clear = Math.abs(Q3_TOP - 13 - upPx) >= 11
    const q1Clear = Math.abs(Q1_TOP - 13 - upPx) >= 11

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

    // One font size for the whole strip: the largest at which the TIGHTEST adjacent pair of labels still clears
    // the gap between their block centers (center distance = half each block + the gap between blocks), so every
    // turn label stays shown on the single line instead of thinning out. Uniform (not per-label) so sizes never
    // mix, and computed from the groups alone so it is stable while scrolling.
    let labelFont = ''
    {
      let scale = 1
      for (let i = 0; i + 1 < groups.length; i++) {
        const avail = (turnWidths[i] + turnWidths[i + 1]) / 2 + BAR_GAP
        const need = (estTurnLabel(groups[i].turn) + estTurnLabel(groups[i + 1].turn)) / 2 + LABEL_GAP
        if (need > avail) scale = Math.min(scale, avail / need)
      }
      if (scale < 1) labelFont = `${Math.max(LABEL_FONT_MIN, Math.floor(LABEL_FONT * scale))}px`
    }

    // Default anchor: newest bars at the RIGHT edge; the first layout after mount scrolls unconditionally, a GRANULARITY SWITCH re-anchors
    // the same way (step mode must not inherit the turn chart's stale left edge), otherwise stick to the end only while already near it;
    // useLayoutEffect avoids a first-paint flash.
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const scrolledOnce = useRef(false)
    const lastGranRef = useRef(props.granularity)
    // The newest bar's seq (or 0 when the log is empty): the layout effect only re-runs when the right edge genuinely
    // moves (new bar appended, granularity switched, focus turn set) — hover/select changes keep their scroll position
    // so the chart does not flash with every keystroke.
    const lastSeqRef = useRef(0)
    // The scrollWidth measured during the PREVIOUS effect pass. The "was the reader near the right edge?" check
    // has to compare against the width as it was BEFORE the new bar landed — by the time the layout effect runs,
    // `el.scrollWidth` is already the new (wider) value, so a near-edge check against it would miss the auto-follow.
    const prevScrollWidthRef = useRef(0)
    /**
     * Keep each turn label centered within its block's VISIBLE slice, then thin colliding labels: a label wider
     * than its block overflows it, so consecutive narrow turns would smear into each other — walking left→right
     * in content coordinates, a label whose box reaches the previous KEPT one drops to visibility:hidden. The
     * render-time font shrink (labelFont) already sizes every label to clear its tightest neighbour, so this
     * chain only fires past the 6px floor or on viewport-edge shifts. Blocks that cannot reach the viewport even
     * overhung by a label skip their reads/writes entirely (their transform/visibility just reset); reads
     * (offsetWidth) batch before the writes to avoid layout thrash, and unchanged styles write nothing.
     */
    const updateTurnLabels = (el: HTMLDivElement): void => {
      const labels = el.querySelectorAll<HTMLElement>('.lc-turn-label')
      const n = Math.min(labels.length, turnOffsets.length)
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      const writes: [HTMLElement, string, string][] = []
      // Right edge (content px) of the last kept label's box plus the gap; -Infinity opens the chain.
      let chainR = -Infinity
      for (let i = 0; i < n; i++) {
        const off = turnOffsets[i]
        const w = turnWidths[i]
        let dx = 0
        let vis = ''
        if (off + w + LABEL_OVERHANG > sl && off - LABEL_OVERHANG < vr) {
          const lw = labels[i].offsetWidth
          const visL = Math.max(off, sl)
          const visR = Math.min(off + w, vr)
          if (visR > visL && lw < w) {
            const center = (visL + visR) / 2 - off
            dx = Math.min(Math.max(center, lw / 2), w - lw / 2) - w / 2
          }
          const left = off + w / 2 + dx - lw / 2
          if (left < chainR) vis = 'hidden'
          else chainR = left + lw + LABEL_GAP
        }
        const next = dx !== 0 ? `translateX(${dx}px)` : ''
        if (labels[i].style.transform !== next || labels[i].style.visibility !== vis) writes.push([labels[i], next, vis])
      }
      for (const [label, next, vis] of writes) {
        label.style.transform = next
        label.style.visibility = vis
      }
    }
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React
         attaches refs before layout effects run; el is never null here. */
      if (el === null) return
      const newestSeq = requests.length === 0 ? 0 : requests[requests.length - 1].seq
      const grew = newestSeq !== lastSeqRef.current
      const widthBeforeAppend = prevScrollWidthRef.current
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
      } else if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (grew && el.scrollLeft + el.clientWidth >= widthBeforeAppend - 24) {
        // Only follow the latest bar when the right edge actually moved AND the reader was already near it
        // BEFORE the new bar landed — comparing against the new scrollWidth would silently drop the stick for a
        // mid-chart reader whose viewport just slid past the near-end threshold.
        el.scrollLeft = el.scrollWidth
      }
      lastSeqRef.current = newestSeq
      prevScrollWidthRef.current = el.scrollWidth
      updateTurnLabels(el)
      syncTip(el)
      measureVisible(el)
    }, [props.granularity, props.focusTurn, requests, adaptive])

    // The observer callback needs the LATEST measure closure (it captures `requests`/`delta`); a ref keeps it fresh
    // without tearing the observer down on every commit.
    const measureRef = useRef(measureVisible)
    useLayoutEffect(() => { measureRef.current = measureVisible })
    // A pane resize (sidebar collapse/drag, window resize) changes the visible window without any render, so the
    // observer re-measures. jsdom exposes no ResizeObserver — the commit/scroll measures cover those paths.
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React
         attaches refs before layout effects run; el is never null here. */
      if (el === null) return
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { measureRef.current(el) })
      observer.observe(el)
      return () => { observer.disconnect() }
    }, [])
    // A horizontal swipe running off the chart's edge must not chain into the browser's history navigation
    // (overscroll.ts): the sheet's overscroll-behavior-x covers Chromium/Firefox, this covers WebKit.
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React
         attaches refs before layout effects run; el is never null here. */
      if (el === null) return
      return containHorizontalOverscroll(el)
    }, [])

    // Compact 2-row hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed):
    // identity and the bar's total — the SAME value the bar height and axis are scaled against (the fold's
    // heuristic figure, matching every other card). Identity phrasing follows the granularity —
    // turn bars always speak TURN (the aggregate's step count, singular for a 1-step turn; a record missing
    // stepCount degrades to that too), step bars carry the step index. Delta swaps the metric row for the net.
    const tipRowsOf = (req: RequestRecord): [string, string] => {
      const n = req.stepCount ?? 1
      const head = props.granularity === 'turn'
        ? (n > 1 ? t('tip.turn', { t: req.turn ?? 0, n }) : t('tip.turn1', { t: req.turn ?? 0 }))
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 })
      if (delta) {
        /* v8 ignore next 1 -- delta mode only receives records from
           deltaOf, which always assigns net; the fallback is defensive. */
        const n = req.net ?? 0
        return [head, t('tip.delta', { n: (n > 0 ? '+' : '') + fmt(n) })]
      }
      // Focused: the metric row IS the focused category's figure, so the tip names it instead of claiming a total.
      return [head, focus !== null
        ? t('tip.cat', { cat: catLabel(focus), n: fmt(req.total) })
        : t('tip.total', { n: fmt(req.total) })]
    }
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null

    // Column center (content px) of the currently hovered bar, for syncTip reads outside the render pass.
    const tipColRef = useRef(0)

    /**
     * Glue the hover tip to its bar's VISIBLE slice. The tip deliberately does NOT live inside the scrolling
     * content: an absolutely-positioned child of a scroller contributes to its scrollable overflow, so a wide
     * reply preview on a right-edge bar used to inflate scrollWidth on every hover and flap the horizontal
     * scrollbar open/closed — jumping the whole card. Reads (offsetWidth/clientWidth) batch before the single
     * style write; unchanged transforms write nothing.
     */
    const syncTip = (el: HTMLDivElement): void => {
      /* v8 ignore next 1 -- the scroll div renders unconditionally while mounted, so its parent exists. */
      const tip = (el.parentElement ?? document.body).querySelector<HTMLElement>('.lc-chart-tip')
      // No hover, nothing to place.
      if (tip === null) return
      const lw = tip.offsetWidth
      const cw = el.clientWidth
      // Center over the bar's visible slice, clamped so the tip never hangs past either edge nor gets cut off; a tip
      // wider than the viewport centers over it instead of picking a bogus side on an inverted clamp window.
      const half = Math.min(lw / 2, cw / 2)
      const cx = Math.min(Math.max(tipColRef.current - el.scrollLeft, half), cw - half)
      const next = `translate(${Math.round(cx - lw / 2)}px, 0)`
      if (tip.style.transform !== next) tip.style.transform = next
    }

    // Position (and re-position after EVERY commit — the tip mounts on hover changes, which touch no other
    // effect dependency here) from the committed hovered column before paint.
    useLayoutEffect(() => {
      /* v8 ignore next 1 -- the scroll div renders unconditionally and React attaches refs before
         layout effects run; el is never null here. */
      if (scrollRef.current === null) return
      tipColRef.current = hoveredIdx >= 0 ? hoveredIdx * (BAR_W + BAR_GAP) + BAR_W / 2 : 0
      syncTip(scrollRef.current)
    })

    return (
      <div className="lc-chartrow">
        <div className="lc-axis">
          {delta ? (
            <>
              <span className="lc-axis-top">{fmtSigned(maxUp)}</span>
              {/* Axis quartile marks on the uniform px-per-token scale (the value at each fixed height); a mark
                  whose 11px label box would overlap the zero label drops itself — the zero line is the reading
                  reference and keeps its place. */}
              {q3Clear
                ? <span className="lc-axis-q3">{fmtSigned(Math.round(maxUp - span / 4))}</span>
                : null}
              {/* The 0 label rides the zero line (chart top padding 18px, half the 11px line-height up). */}
              <span className="lc-axis-mid" style={{ top: `${13 + upPx}px` }}>{'0'}</span>
              {q1Clear
                ? <span className="lc-axis-q1">{fmtSigned(Math.round(maxUp - 3 * span / 4))}</span>
                : null}
              <span className="lc-axis-bot">{fmtSigned(-maxDown)}</span>
            </>
          ) : (
            <>
              <span className="lc-axis-top">{fmt(maxTotal)}</span>
              <span className="lc-axis-q3">{fmt(Math.round(maxTotal * 3 / 4))}</span>
              <span className="lc-axis-mid">{fmt(Math.round(maxTotal / 2))}</span>
              <span className="lc-axis-q1">{fmt(Math.round(maxTotal / 4))}</span>
              <span className="lc-axis-bot">{'0'}</span>
            </>
          )}
        </div>
        {/* Only the scrolling CONTENT lives under .lc-chart-scroll; the hover tip sits beside it inside the
            positioned wrapper instead of inside the scroller — absolutely-positioned children of a scroller
            contribute to its scrollable overflow AND translate away with the content on scroll. */}
        <div className="lc-chart-wrap">
          <div
            className={'lc-chart-scroll' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
            ref={scrollRef}
            onScroll={(e: UIEvent<HTMLDivElement>) => {
              updateTurnLabels(e.currentTarget)
              syncTip(e.currentTarget)
              measureVisible(e.currentTarget)
            }}
          >
            <div
              className="lc-chart"
              // The shared category hover rides a plain attribute: the CSS lights that key's segment in EVERY bar
              // and recedes the rest, so the memoized bars never re-render on a cross-card hover change.
              data-catdim={props.hoverCat ?? undefined}
              onMouseLeave={() => { props.onHover(null) }}
            >
              <div className="lc-grid lc-grid-top" />
              {/* Dashed guides aligning the bars with the axis quarter marks (fixed heights, both modes); a delta
                  mark that yielded to the zero label drops its guide too, and a coinciding guide sits under the
                  solid zero line painted after it. */}
              {(!delta || q3Clear) ? <div className="lc-grid lc-grid-q3" /> : null}
              {(!delta || q1Clear) ? <div className="lc-grid lc-grid-q1" /> : null}
              {!delta ? <div className="lc-grid lc-grid-mid" /> : null}
              {/* The SOLID zero baseline — the reading reference in both modes: inline-positioned off the up-arm
                  in delta mode, the chart floor (CSS default) under the '0' label in total mode. */}
              <div className="lc-grid lc-grid-zero" style={delta ? { top: `${18 + upPx}px` } : undefined} />
              {requests.map((req, i) => (
                <ChartBar
                  key={req.seq}
                  req={req}
                  marker={markers[i]}
                  selected={props.selectedSeq === req.seq}
                  hovered={props.hoveredSeq === req.seq}
                  inTurn={props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn}
                  maxTotal={maxTotal}
                  upPx={delta ? upPx : undefined}
                  downPx={delta ? downPx : undefined}
                  deltaScale={delta ? deltaScale : undefined}
                  onSelect={props.onSelect}
                  onHover={props.onHover}
                />
              ))}
            </div>
            {/* Turn strip: one COLOR BLOCK per turn spanning exactly its bars' columns, so the partition reads at a glance and lines
                up with the steps; hovering a block highlights that turn's bars and vice versa — one shared hover-only state.
                */}
            <div className="lc-turns" style={labelFont !== '' ? { fontSize: labelFont } : undefined} onMouseLeave={() => { props.onHoverTurn(null) }}>
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
                  ><span className="lc-turn-label">{`${grp.turn}`}</span></span>
                )
              })}
            </div>
          </div>
          {/* Compact 2-row hover tooltip (identity / bar total), shown instantly by the custom `.lc-chart-tip`
              (the native title is delayed); the per-category breakdown lives in the detail panel below. It floats
              ABOVE the plot (CSS bottom anchoring) so it never covers the bars, is capped at the wrapper's width
              and wrapped, and is positioned imperatively over its bar's visible slice (syncTip) so scrolling keeps
              it glued without ever widening the scrollable area. */}
          {hoveredReq !== null ? (
            <div className="lc-chart-tip">{tipRowsOf(hoveredReq).map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
      </div>
    )
  }
}
