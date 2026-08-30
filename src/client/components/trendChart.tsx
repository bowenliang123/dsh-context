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
  mode: 'total' | 'delta'
  focusTurn: number | null
  /** Mirrored category hover (shared with the overview and the browser): lights that category's segment in every bar. */
  hoverCat: string | null
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
  /** seq → one-line reply preview (see brief.ts replyTipsOf); appended to the hover tooltip when present. */
  replyTips?: Map<number, string>
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

export function makeTrendChart(kit: ViewKit): (props: TrendChartProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit

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

  // Anchor bar HEIGHT to the provider-reported prompt when the request carried usage: categories keep their heuristic ratios but the height
  // tracks the real billed tokens (matching the overview card and official chat ring), not the underpriced estimate.
  const anchorOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 && req.total > 0 ? req.prompt / req.total : 1
  const barTotalOf = (req: RequestRecord): number =>
    typeof req.prompt === 'number' && req.prompt > 0 ? req.prompt : req.total

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
  const ChartBar = React.memo(function ChartBar(props: ChartBarProps): ReactNS.ReactElement {
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
              const v = (req[c.key] || 0) * anchorOf(req)
              if (!v) return null
              // px (not %) heights: the stack is content-driven, so percentage heights would collapse against an indefinite base.
              return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
            })}
          </div>
        )}
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactNS.ReactElement {
    const delta = props.mode === 'delta'
    const requests = React.useMemo(
      () => (delta ? props.requests.map((req, i) => deltaOf(req, i > 0 ? props.requests[i - 1] : null)) : props.requests),
      [props.requests, delta],
    )
    const markers = props.markers
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
        const bt = barTotalOf(req)
        if (bt > maxTotal) maxTotal = bt
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

    // Default anchor: newest bars at the RIGHT edge; the first layout after mount scrolls unconditionally, a GRANULARITY SWITCH re-anchors
    // the same way (step mode must not inherit the turn chart's stale left edge), otherwise stick to the end only while already near it;
    // useLayoutEffect avoids a first-paint flash.
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const scrolledOnce = React.useRef(false)
    const lastGranRef = React.useRef(props.granularity)
    // The newest bar's seq (or 0 when the log is empty): the layout effect only re-runs when the right edge genuinely
    // moves (new bar appended, granularity switched, focus turn set) — hover/select changes keep their scroll position
    // so the chart does not flash with every keystroke.
    const lastSeqRef = React.useRef(0)
    // The scrollWidth measured during the PREVIOUS effect pass. The "was the reader near the right edge?" check
    // has to compare against the width as it was BEFORE the new bar landed — by the time the layout effect runs,
    // `el.scrollWidth` is already the new (wider) value, so a near-edge check against it would miss the auto-follow.
    const prevScrollWidthRef = React.useRef(0)
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
    }, [props.granularity, props.focusTurn, requests])

    // Compact single-line hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed).
    const tipOf = (req: RequestRecord): string => {
      const head = req.stepCount !== undefined && req.stepCount > 1
        ? t('tip.turn', { t: req.turn ?? 0, n: req.stepCount })
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0 })
      const reply = props.replyTips?.get(req.seq)
      // The reply preview anchors the bar's identity at a glance; kept short so the tip stays one line.
      const tail = reply !== undefined
        ? ' · “' + (reply.length > 48 ? reply.slice(0, 48) + '…' : reply) + '”'
        : ''
      if (delta) {
        /* v8 ignore next 1 -- delta mode only receives records from
           deltaOf, which always assigns net; the fallback is defensive. */
        const n = req.net ?? 0
        return head + ' · ' + fmtTime(req.time) + ' · ' + t('tip.delta', { n: (n > 0 ? '+' : '') + fmt(n) }) + tail
      }
      return head + ' · ' + fmtTime(req.time) + ' · ' + t('tip.total', { n: fmt(req.total) })
        + (req.prompt !== undefined ? ' · ' + t('tip.actual', { n: fmt(req.prompt) }) : '') + tail
    }
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null

    // Column center (content px) of the currently hovered bar, for syncTip reads outside the render pass.
    const tipColRef = React.useRef(0)

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
    React.useLayoutEffect(() => {
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
            onScroll={(e: ReactNS.UIEvent<HTMLDivElement>) => {
              updateTurnLabels(e.currentTarget)
              syncTip(e.currentTarget)
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
          {/* Compact single-line hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed):
              position, time, estimated total, provider prompt when available; the per-category breakdown lives in the detail
              panel below. Positioned imperatively over its bar's visible slice (syncTip) so scrolling keeps it glued without
              ever widening the scrollable area. */}
          {hoveredReq !== null ? (
            <div className="lc-chart-tip">{tipOf(hoveredReq)}</div>
          ) : null}
        </div>
      </div>
    )
  }
}
