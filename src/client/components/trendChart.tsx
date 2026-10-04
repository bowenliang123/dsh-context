/**
 * Bespoke per-request history chart — no shared data-viz primitive — styled through the shared `--dsw-alias-*` tokens; helpers
 * aggregateByTurn/attachMarkers are shared with ContextView. On mount each bar rises from its baseline,
 * staggered left to right with the cascade capped for long logs (trendChart.css, `--lc-i` slots below).
 */

import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type UIEvent } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import { deltaBandsOf, dnaBaseLabel } from '../dna'
import type { DnaDelta, TrendBand } from '../dna'
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
  /**
   * Duration overlay (the trend card's title-adjacent toggle): each bar's step active time (`activeMs`)
   * drawn as a curve over the bars, read off the quartile axis on the chart's right. The curve plots the
   * raw figure in every mode (total/delta/DNA) — duration is not a composition category — and follows the
   * same scale window as the bars (whole log, or the visible window when adaptive is on).
   */
  durationCurve?: boolean
  /**
   * DNA mode (the trend card's toggle): per bar, its assembled context decomposed into ONE band per item in
   * read order (dna.ts), aligned with `requests` by index. Non-null draws every bar as a single-gradient
   * fingerprint and implies TOTAL semantics — the parent disables the Total/Delta switch while DNA is on.
   */
  dna?: TrendBand[][] | null
  /** DNA mode: a band click reveals that item in the Context browser at the bar's step. */
  onPickBand?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
}

/**
 * Collapse per-step requests into one bar per turn — each turn is represented by its LAST step's record, tagged `stepCount` for the bar's
 * column width; the log keeps one turn's requests consecutive, so a run of equal turns collapses to its final record. The duration
 * overlay's `activeMs` is the run's steps SUMMED (the turn's total step active time), absent only when no step of the run carried one.
 */
export function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  let runActiveMs = 0
  let runHasActiveMs = false
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      if (req.activeMs !== undefined) { runActiveMs += req.activeMs; runHasActiveMs = true }
      out[out.length - 1] = { ...req, stepCount: runSteps, ...(runHasActiveMs ? { activeMs: runActiveMs } : {}) }
    } else {
      runSteps = 1
      runActiveMs = req.activeMs ?? 0
      runHasActiveMs = req.activeMs !== undefined
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

/**
 * The per-turn step tallies the step-granularity labels lean on ("第 s 步 (共 n 步)") — the same count a
 * turn-mode bar's `stepCount` carries. Records without a turn stamp pool under 0, the key the labels'
 * `turn ?? 0` fallback reads; the getter answers 1 for a turn outside the list so a caller can never miss.
 */
export function turnStepsOf(requests: RequestRecord[]): (turn: number | undefined) => number {
  const counts = new Map<number, number>()
  for (const req of requests) {
    const turn = req.turn ?? 0
    counts.set(turn, (counts.get(turn) ?? 0) + 1)
  }
  return turn => counts.get(turn ?? 0) ?? 1
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
  const { t, fmt, fmtDuration, eventLabel, eventAt, catLabel } = kit

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
  // Entrance stagger cap: long logs render thousands of bars, so the grow-in cascade stops widening after
  // this many columns and late bars simply join within the cap (trendChart.css delays by `--lc-i`).
  const STAGGER_CAP = 20
  // Step flags: every 5th step bar plants one at its left edge, labeled with its cumulative step number
  // (5, 10, 15, …) — the chart's only position landmark in step granularity (the turn strip numbers turns).
  const STEP_FLAG_EVERY = 5
  // Neutral zebra, deliberately DISJOINT from the category palette — the strip must read as a partition layer, not a bottom segment of the
  // composition bars.
  const TURN_FILLS = [
    'color-mix(in srgb, var(--color-neutral-500) 12%, transparent)',
    'color-mix(in srgb, var(--color-neutral-500) 26%, transparent)',
  ]
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

  /** The visible window's own maxima (adaptive scale): the total-mode peak, the delta arms' up/down sums, the duration overlay's peak. */
  interface VisibleMax {
    total: number
    up: number
    down: number
    activeMs: number
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
    /** Bar index in the render order: the entrance grow-in stagger slot (capped inside, so a long log's cascade stays snappy). */
    enterIndex: number
    /** The step flag's label (the bar's cumulative step number), or null to plant none. */
    flag: number | null
    /** DNA mode: this bar's per-item bands (read order), or null in the stacked modes. */
    dna: TrendBand[] | null
    /** DNA+delta mode: this bar's signed band deltas (a stable memo element); null elsewhere. */
    dnaDelta: DnaDelta | null
    /** DNA+delta mode: the uniform px-per-token scale and the zero line's offset from the floor. */
    dnaScale: number | undefined
    zeroBottom: number | undefined
    /** DNA mode: reports the band under the pointer (null when the pointer leaves it or rests on no band). */
    onDnaHit: (key: string | null) => void
    /** DNA mode: a band click asks the owner to reveal the item in the Context browser. */
    onPickBand?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  /**
   * DNA mode's bar interior: ONE gradient div paints the whole fingerprint — consecutive same-color
   * bands coalesce into a single run (long same-category message runs would otherwise bloat the
   * style string), zero-token bands occupy no height and skip. Gradient stops are each band's
   * cumulative share of the bar (percent of the div's own height, which is proportional to the
   * bar's total), so the strip reads bottom-up in the model's read order.
   */
  interface DnaBarProps {
    bands: TrendBand[]
    total: number
    maxTotal: number
    enterIndex: number
    /** The bar's request seq: a band pick reveals the item at THIS step in the Context browser. */
    seq: number
    onHit: (key: string | null) => void
    /** A band click's reveal request, lifted to the chart's owner (undefined = picking disabled). */
    onPick?: (seq: number, band: TrendBand) => void
  }

  const DnaBar = function DnaBar(props: DnaBarProps): ReactElement | null {
    // Zero-token bands occupy no height: they keep their read-order slot (the hit-test below
    // walks the full list) but drop out of the gradient's runs entirely.
    const visible: TrendBand[] = []
    for (const b of props.bands) if (b.tokens > 0) visible.push(b)
    if (visible.length === 0) return null
    const runs: { color: string; from: number; to: number }[] = []
    for (const b of visible) {
      const from = Math.round(b.off / props.total * 10000) / 100
      const to = Math.round((b.off + b.tokens) / props.total * 10000) / 100
      const last = runs.length > 0 ? runs[runs.length - 1] : null
      if (last !== null && last.color === b.color && last.to === from) last.to = to
      else runs.push({ color: b.color, from, to })
    }
    // Pointer → band: the fraction measured from the div's bottom maps linearly onto [0, total]
    // tokens; the hit is the LAST band whose start is at or below the position (zero-token bands
    // are invisible and skip), so the top edge still resolves to the last band. A hit always
    // exists — the first visible band starts at off 0 (leading zero-token bands advance nothing)
    // and the fraction clamps into [0, 1] — so the type carries no null.
    const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): TrendBand => {
      const rect = e.currentTarget.getBoundingClientRect()
      const frac = rect.height > 0 ? Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)) : 0
      const pos = frac * props.total
      let hit = visible[0]
      for (const b of props.bands) {
        if (b.off > pos) break
        if (b.tokens > 0) hit = b
      }
      return hit
    }
    return (
      <div
        className="lc-bar-dna animate-lc-bar-in motion-reduce:animate-none"
        style={{
          height: `${Math.max(1, Math.round(props.total / props.maxTotal * CHART_H))}px`,
          background: 'linear-gradient(to top, ' + runs.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
          '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
        } as CSSProperties}
        onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
        onMouseLeave={() => { props.onHit(null) }}
        onClick={(e) => {
          // A band click reveals the item in the Context browser (and the bar's own click
          // bubbles up to pin this step — the two land on the same seq).
          if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e))
        }}
      />
    )
  }

  /**
   * DNA + DELTA mode's bar interior: ONE gradient div spans BOTH arms around the zero line —
   * from the div's bottom, the down arm's bands in REVERSE read order (the first removed item
   * hugs the zero line from below), then the up arm in read order. Like the segmented delta
   * arms the div is absolutely positioned off the zero line and scaleY-opens FROM it
   * (transform-origin at the zero line's share of the div's own height). A hit always exists:
   * every position maps into one of the arms' read-order walks.
   */
  interface DnaDeltaBarProps {
    d: DnaDelta
    /** Uniform px-per-token scale (identical above and below the zero line). */
    scale: number
    /** The zero line's offset from the bar's floor (px). */
    zeroBottom: number
    enterIndex: number
    seq: number
    onHit: (key: string | null) => void
    onPick?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
  }

  const DnaDeltaBar = function DnaDeltaBar(props: DnaDeltaBarProps): ReactElement | null {
    let upSum = 0
    for (const b of props.d.up) upSum += b.tokens
    let downSum = 0
    for (const b of props.d.down) downSum -= b.tokens
    const gradSpan = upSum + downSum
    if (gradSpan === 0) return null
    // Gradient runs: bottom-up = down arm reversed, then up arm; consecutive same-color bands
    // coalesce exactly like the total-mode strip.
    const runs: { color: string; from: number; to: number }[] = []
    const pushRun = (color: string, mag: number, at: number): number => {
      const from = Math.round(at / gradSpan * 10000) / 100
      const to = Math.round((at + mag) / gradSpan * 10000) / 100
      const last = runs.length > 0 ? runs[runs.length - 1] : null
      if (last !== null && last.color === color && last.to === from) last.to = to
      else runs.push({ color, from, to })
      return at + mag
    }
    let acc = 0
    for (let i = props.d.down.length - 1; i >= 0; i--) acc = pushRun(props.d.down[i].color, -props.d.down[i].tokens, acc)
    for (const b of props.d.up) acc = pushRun(b.color, b.tokens, acc)
    const height = Math.max(1, Math.round(gradSpan * props.scale))
    const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): { key: string; cat: Category | 'system' | 'tools' } => {
      // Fraction from the div's bottom maps onto [-downSum, upSum] around the zero line; each arm
      // then walks its read order for the last band whose start is at or below |position|.
      const rect = e.currentTarget.getBoundingClientRect()
      const frac = rect.height > 0 ? Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)) : 0
      const pos = frac * gradSpan - downSum
      const useUp = pos >= 0 && props.d.up.length > 0
      const arm = useUp ? props.d.up : props.d.down
      const p = useUp ? pos : -pos
      let hit = arm[0]
      for (const b of arm) {
        if (b.off > p) break
        hit = b
      }
      return hit
    }
    return (
      <div
        className="lc-bar-dna animate-lc-bar-in motion-reduce:animate-none"
        style={{
          position: 'absolute',
          bottom: `${Math.round(props.zeroBottom - downSum * props.scale)}px`,
          height: `${height}px`,
          background: 'linear-gradient(to top, ' + runs.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
          // The entrance rise grows from the zero line, not an arm's end.
          transformOrigin: `50% ${Math.round(downSum / gradSpan * 10000) / 100}%`,
          '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
        } as CSSProperties}
        onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
        onMouseLeave={() => { props.onHit(null) }}
        onClick={(e) => { if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e)) }}
      />
    )
  }

  /**
   * DNA mode's cross-bar lifetime highlight: a flex row mirroring the bar grid (same 14px columns,
   * 2px gap, 18px top band — no per-bar x math), painting ONE translucent slice per bar that still
   * holds the hovered item — its whole life in the context at a glance. The chart resolves every
   * slice's geometry (both DNA flavors) so this layer stays a dumb painter; memoized so a hover
   * change reconciles only this thin layer, never the memoized bars beneath. Null while no item
   * is hovered.
   */
  interface DnaHighlightsProps {
    /** Per bar, the hovered item's slice in chart geometry — null entries paint nothing. */
    slices: ({ bottom: number; height: number } | null)[] | null
  }

  const DnaHighlights = memo(function DnaHighlights(props: DnaHighlightsProps): ReactElement | null {
    if (props.slices === null) return null
    return (
      <div className="lc-dna-hl">
        {props.slices.map((s, i) => (
          <span key={i} className="lc-dna-cell">
            {s !== null ? (
              <span className="lc-dna-slice" style={{ bottom: `${s.bottom}px`, height: `${s.height}px` }} />
            ) : null}
          </span>
        ))}
      </div>
    )
  })

  // Memoized so a hover/selection change re-renders only the bars whose flags flipped — the retained log renders in full (thousands of
  // nodes on long sessions); `req`/`marker` keep stable identities because the parent memoizes its aggregation, so the default shallow
  // compare suffices.
  const ChartBar = memo(function ChartBar(props: ChartBarProps): ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    // Delta mode: diverging stacks — positive category deltas pile UP from the zero line, negative ones
    // hang DOWN from it, both in category colors (direction carries the sign, color the category).
    const diverge = props.upPx !== undefined && props.downPx !== undefined && props.deltaScale !== undefined
    // Rise stagger slot, shared by the total stack and both delta arms (trendChart.css scaleY-opens them).
    const enterStyle = { '--lc-i': Math.min(props.enterIndex, STAGGER_CAP) } as CSSProperties
    return (
      <div
        className={'lc-bar hover:bg-(--dsw-alias-bg-layer-2)'
          + (props.selected ? ' lc-bar-selected' : '')
          + (props.hovered ? ' lc-bar-hovered' : '')
          + (props.inTurn ? ' lc-bar-in-turn' : '')}
        data-seq={req.seq}
        style={{ width: `${BAR_W}px` }}
        onClick={() => { props.onSelect(props.selected ? null : req.seq) }}
        onMouseEnter={() => { props.onHover(req.seq) }}
      >
        {props.flag !== null ? (
          // Painted UNDER the ✂ marker (it follows in DOM order): on a rare same-bar collision the event
          // glyph keeps precedence over the landmark.
          <span className="lc-step-flag" aria-hidden="true"><span className="lc-step-flag-label">{props.flag}</span></span>
        ) : null}
        {marker !== undefined ? (
          <span
            className="lc-bar-marker"
            title={'✂ ' + (markerAt !== null ? markerAt + ' — ' : '') + eventLabel(marker)}
          >{'✂'}</span>
        ) : null}
        {props.dna !== null ? (
          props.dnaDelta !== null && props.dnaScale !== undefined && props.zeroBottom !== undefined ? (
            <DnaDeltaBar
              d={props.dnaDelta}
              scale={props.dnaScale}
              zeroBottom={props.zeroBottom}
              enterIndex={props.enterIndex}
              seq={req.seq}
              onHit={props.onDnaHit}
              onPick={props.onPickBand}
            />
          ) : (
            <DnaBar
              bands={props.dna}
              total={req.total}
              maxTotal={props.maxTotal}
              enterIndex={props.enterIndex}
              seq={req.seq}
              onHit={props.onDnaHit}
              onPick={props.onPickBand}
            />
          )
        ) : diverge ? (
          <>
            <div className="lc-bar-up animate-lc-bar-in motion-reduce:animate-none" style={{ bottom: `${props.downPx}px`, ...enterStyle }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d <= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
            <div className="lc-bar-down animate-lc-bar-in motion-reduce:animate-none" style={{ top: `${props.upPx}px`, ...enterStyle }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d >= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(-d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
          </>
        ) : (
          <div className="lc-bar-stack animate-lc-bar-in motion-reduce:animate-none" style={enterStyle}>
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
    const dnaBands = props.dna ?? null
    // DNA mode: the bars become per-item fingerprints of each request's context. It ignores the
    // category focus (the bands ARE the full composition already); the Total/Delta switch stays
    // LIVE — delta diffs the bands against the previous bar instead of the categories.
    const dnaOn = dnaBands !== null
    const delta = props.mode === 'delta'
    const dnaDeltaOn = dnaOn && delta
    // The duration overlay (durationCurve): each bar's step active time as a curve over the bars,
    // read off the right-hand quartile axis.
    const durationOn = props.durationCurve === true
    // An unrecognized focus key degrades to the unfocused chart instead of plotting an empty axis.
    const focus = !dnaOn && props.focusCat !== null && props.focusCat !== undefined && CATS.some(c => c.key === props.focusCat)
      ? props.focusCat
      : null
    // The item (band key) under the pointer in DNA mode: drives the cross-bar lifetime highlight
    // and the tooltip's item row. Mount-local; cleared with the chart hover.
    const [dnaHit, setDnaHit] = useState<string | null>(null)
    // DNA+delta: each bar's bands paired against the previous bar's by key (dna.ts) — new/grown
    // items ride the up arm, removed/shrunk ones the down arm. Aligned with `requests` by index;
    // the first bar has no baseline and carries no change, mirroring the record delta.
    const dnaDeltas = useMemo(
      () => (dnaDeltaOn ? dnaBands.map((bands, i) => deltaBandsOf(bands, i > 0 ? dnaBands[i - 1] : null)) : null),
      [dnaDeltaOn, dnaBands],
    )
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
      let activeMs = 0
      // The column holding the left edge through the one holding the right edge; the per-column test then drops
      // the neighbour whose column falls in the 2px gap just outside the viewport.
      const from = Math.max(0, Math.floor(sl / pitch))
      const to = Math.min(n - 1, Math.max(from, Math.floor((vr - 1) / pitch)))
      for (let i = from; i <= to; i++) {
        const col = i * pitch
        if (col >= vr || col + BAR_W <= sl) continue
        const req = requests[i]
        // The duration overlay's window maximum rides the same pass, so the right axis
        // follows the scroll exactly like the bars' axis (measured whether or not the
        // overlay is currently on — a toggle-on then never re-measures).
        const m = req.activeMs ?? 0
        if (m > activeMs) activeMs = m
        if (dnaDeltaOn && dnaDeltas !== null) {
          // DNA+delta: the band arms' own sums — the same figures the whole-log loop takes.
          let bu = 0
          let bd = 0
          for (const b of dnaDeltas[i].up) bu += b.tokens
          for (const b of dnaDeltas[i].down) bd -= b.tokens
          if (bu > up) up = bu
          if (bd > down) down = bd
        } else if (delta) {
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
      setVisMax(prev => prev !== null && prev.total === total && prev.up === up && prev.down === down && prev.activeMs === activeMs
        ? prev
        : { total, up, down, activeMs })
    }
    // Whole-log maxima: the axis when adaptive is off, and the fallback for a delta window with no change at all
    // (it carries no scale of its own).
    let maxTotal = 1
    let maxUp = 0
    let maxDown = 0
    if (dnaDeltaOn && dnaDeltas !== null) {
      for (const d of dnaDeltas) {
        let up = 0
        let down = 0
        for (const b of d.up) up += b.tokens
        for (const b of d.down) down -= b.tokens
        if (up > maxUp) maxUp = up
        if (down > maxDown) maxDown = down
      }
    } else if (delta) {
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
    // The duration overlay's scale (the right-hand axis): mode-independent — the curve always plots the
    // bar's raw active time, whether the bars read totals, deltas, or DNA bands. Whole-log by default; the
    // visible window's own maximum when adaptive is on (measured on every scroll, durationCurve or not).
    let maxActiveMs = 0
    if (durationOn) {
      for (const req of requests) {
        const m = req.activeMs ?? 0
        if (m > maxActiveMs) maxActiveMs = m
      }
      if (adaptive && visMax !== null) maxActiveMs = visMax.activeMs
    }
    // The overlay geometry: ONE polyline per contiguous run of bars carrying a duration (a bar without
    // `activeMs` breaks the line instead of faking a value) and a dot for an isolated single point, which a
    // one-point polyline would render invisible. X centers on each bar's column, y rides the right axis's
    // floor-anchored scale; the svg rides the scrolling content, so scrolling needs no re-computation.
    const durationRuns: string[] = []
    const durationDots: [number, number][] = []
    if (durationOn) {
      const scale = CHART_H / Math.max(1, maxActiveMs)
      let run: [number, number][] = []
      const flushRun = (): void => {
        if (run.length >= 2) durationRuns.push(run.map(p => `${p[0]},${p[1]}`).join(' '))
        else if (run.length === 1) durationDots.push(run[0])
        run = []
      }
      for (let i = 0; i < requests.length; i++) {
        const m = requests[i].activeMs
        if (m === undefined) {
          flushRun()
          continue
        }
        run.push([i * (BAR_W + BAR_GAP) + BAR_W / 2, Math.round((CHART_H - m * scale) * 100) / 100])
      }
      flushRun()
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
      // A DNA↔stacked or total↔delta switch changes what the window maximum means (band arms vs
      // category arms vs totals) — re-measure so an adaptive axis never rides a stale scale.
    }, [props.granularity, props.focusTurn, requests, adaptive, dnaDeltaOn])

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

    // Compact hover tooltip, shown instantly by the custom `.lc-chart-tip` (the native title is delayed):
    // identity and the bar's total — the SAME value the bar height and axis are scaled against (the fold's
    // heuristic figure, matching every other card). Identity phrasing follows the granularity —
    // turn bars always speak TURN (the aggregate's step count, singular for a 1-step turn; a record missing
    // stepCount degrades to that too), step bars carry the step index plus the turn's step total. Delta swaps
    // the metric row for the net, and the duration overlay appends a third row while it is on.
    const stepsOf = useMemo(() => turnStepsOf(props.requests), [props.requests])
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null
    // DNA mode: the band under the pointer in the hovered bar — in total mode an absolute band of the
    // hovered bar; in delta mode the signed band (either arm) of the hovered bar's delta. Nothing while
    // the pointer rests on the bar's top padding, above the strip.
    const hoveredBands = dnaOn && !dnaDeltaOn && hoveredIdx >= 0 ? dnaBands[hoveredIdx] : null
    const hitBand = hoveredBands !== null && dnaHit !== null
      ? hoveredBands.find(b => b.key === dnaHit && b.tokens > 0) ?? null
      : null
    const hoveredDelta = dnaDeltaOn && hoveredIdx >= 0 && dnaDeltas !== null
      ? dnaDeltas[hoveredIdx].up.find(b => b.key === dnaHit) ?? dnaDeltas[hoveredIdx].down.find(b => b.key === dnaHit) ?? null
      : null
    // The hovered item's slice in EVERY bar, resolved to chart geometry: total mode anchors slices at the
    // floor on the total scale; delta mode anchors them at the zero line on the delta scale (an item that
    // left arms hangs below it, one that joined rises above). Feeds the dumb highlight layer.
    const dnaSlices = useMemo(() => {
      if (!dnaOn || dnaHit === null) return null
      const slices: ({ bottom: number; height: number } | null)[] = []
      if (dnaDeltaOn && dnaDeltas !== null) {
        for (const d of dnaDeltas) {
          const hit = d.up.find(b => b.key === dnaHit) ?? d.down.find(b => b.key === dnaHit) ?? null
          if (hit === null) { slices.push(null); continue }
          // Up-arm slice rises from the zero line, down-arm slice hangs below it (`off` is the
          // cumulative magnitude from the line, `mag` the band's own).
          const mag = Math.abs(hit.tokens)
          const edge = hit.tokens > 0
            ? downPx + hit.off * deltaScale
            : downPx - (hit.off + mag) * deltaScale
          slices.push({ bottom: Math.round(edge), height: Math.max(1, Math.round(mag * deltaScale)) })
        }
      } else {
        for (const bands of dnaBands) {
          const hit = bands.find(b => b.key === dnaHit && b.tokens > 0) ?? null
          slices.push(hit === null ? null : {
            bottom: Math.round(hit.off / maxTotal * CHART_H),
            height: Math.max(1, Math.round(hit.tokens / maxTotal * CHART_H)),
          })
        }
      }
      return slices
    }, [dnaOn, dnaHit, dnaDeltaOn, dnaDeltas, dnaBands, downPx, deltaScale, maxTotal])
    const tipRowsOf = (req: RequestRecord): string[] => {
      const n = req.stepCount ?? 1
      const head = props.granularity === 'turn'
        ? (n > 1 ? t('tip.turn', { t: req.turn ?? 0, n }) : t('tip.turn1', { t: req.turn ?? 0 }))
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0, n: stepsOf(req.turn) })
      // DNA mode: the metric row names the hovered item the way the browser's DNA bands name it —
      // its absolute tokens in total mode, its SIGNED change in delta mode. Both lookups are null
      // unless a band sits under the pointer (a hover on the bar's padding above the strip falls
      // through to the mode's own row: the delta's net, else the total).
      const band = hitBand ?? hoveredDelta
      let metric: string
      if (band !== null) {
        metric = t('trend.dnaItem', { label: dnaBaseLabel(band, t, catLabel), n: dnaDeltaOn ? fmtSigned(band.tokens) : fmt(band.tokens) })
      } else if (delta) {
        /* v8 ignore next 1 -- delta mode only receives records from
           deltaOf, which always assigns net; the fallback is defensive. */
        metric = t('tip.delta', { n: fmtSigned(req.net ?? 0) })
      } else {
        // Focused: the metric row IS the focused category's figure, so the tip names it instead of claiming a total.
        metric = focus !== null
          ? t('tip.cat', { cat: catLabel(focus), n: fmt(req.total) })
          : t('tip.total', { n: fmt(req.total) })
      }
      const rows = [head, metric]
      // The overlay's own reading: the bar's step active time, only while the curve is on.
      if (durationOn && req.activeMs !== undefined) rows.push(t('tip.duration', { n: fmtDuration(req.activeMs) }))
      return rows
    }

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
              onMouseLeave={() => { props.onHover(null); setDnaHit(null) }}
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
                  // Granularity belongs in the key: a turn aggregate IS its last step's record (the same
                  // seq), so a step ↔ turn switch would otherwise REUSE that bar's DOM node and its finished
                  // entrance rise would not replay — every turn's last step bar would pop in unanimated.
                  key={`${req.seq}:${props.granularity}`}
                  req={req}
                  marker={markers[i]}
                  selected={props.selectedSeq === req.seq}
                  hovered={props.hoveredSeq === req.seq}
                  inTurn={props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn}
                  // Turn bars skip the flag: the turn strip below already numbers that grid.
                  flag={props.granularity === 'step' && (i + 1) % STEP_FLAG_EVERY === 0 ? i + 1 : null}
                  maxTotal={maxTotal}
                  upPx={delta ? upPx : undefined}
                  downPx={delta ? downPx : undefined}
                  deltaScale={delta ? deltaScale : undefined}
                  enterIndex={i}
                  dna={dnaOn ? dnaBands[i] : null}
                  dnaDelta={dnaDeltaOn && dnaDeltas !== null ? dnaDeltas[i] : null}
                  dnaScale={dnaDeltaOn ? deltaScale : undefined}
                  zeroBottom={dnaDeltaOn ? downPx : undefined}
                  onDnaHit={setDnaHit}
                  onPickBand={props.onPickBand}
                  onSelect={props.onSelect}
                  onHover={props.onHover}
                />
              ))}
              {dnaOn ? <DnaHighlights slices={dnaSlices} /> : null}
              {/* The duration overlay: one svg riding the scrolling content (top 18px padding band excluded),
                  so it scrolls with the bars and needs no scroll handler. z-index parity with the DNA
                  highlight but later in DOM order, so the curve reads above the translucent slices; a bar
                  without `activeMs` breaks the line instead of faking a point. */}
              {durationOn && (durationRuns.length > 0 || durationDots.length > 0) ? (
                <svg
                  className="lc-duration"
                  width={requests.length * (BAR_W + BAR_GAP) - BAR_GAP}
                  height={CHART_H}
                  aria-hidden="true"
                >
                  {durationRuns.map((pts, i) => <polyline key={i} points={pts} />)}
                  {durationDots.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.5} />)}
                </svg>
              ) : null}
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
          {/* Compact hover tooltip (identity / bar total), shown instantly by the custom `.lc-chart-tip`
              (the native title is delayed); the per-category breakdown lives in the detail panel below. It floats
              ABOVE the plot (CSS bottom anchoring) so it never covers the bars, is capped at the wrapper's width
              and wrapped, and is positioned imperatively over its bar's visible slice (syncTip) so scrolling keeps
              it glued without ever widening the scrollable area. */}
          {hoveredReq !== null ? (
            <div className="lc-chart-tip">{tipRowsOf(hoveredReq).map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
        {/* The duration overlay's own quartile axis rides the chart's RIGHT edge (the bars' token axis
            keeps the left): the same five fixed marks, formatted as durations, floor-anchored in every
            mode — the curve plots raw active time even while the bars read deltas. Only while the overlay
            is on. */}
        {durationOn ? (
          <div className="lc-axis lc-axis-r">
            <span className="lc-axis-top">{fmtDuration(maxActiveMs)}</span>
            <span className="lc-axis-q3">{fmtDuration(Math.round(maxActiveMs * 3 / 4))}</span>
            <span className="lc-axis-mid">{fmtDuration(Math.round(maxActiveMs / 2))}</span>
            <span className="lc-axis-q1">{fmtDuration(Math.round(maxActiveMs / 4))}</span>
            <span className="lc-axis-bot">{'0'}</span>
          </div>
        ) : null}
      </div>
    )
  }
}
