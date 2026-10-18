/** Composition bar + legend; the shared hover-link tooltip is bespoke — no shared primitive reproduces the cross-segment/legend linkage —
 * styled through the shared `--dsw-alias-*` tokens. On mount the segments and the free track grow open
 * left to right (stackedBar.css, staggered by the capped per-piece `--lc-i` slots below, so a long DNA
 * band list settles fast); the reserve masks stay unanimated. */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { ContextReserve } from '../reserve'
import type { ViewKit } from '../viewkit'

/** Entrance stagger cap: the browser's DNA bands can list dozens of items, so the grow-in cascade stops
 * widening after this many slots and late bands simply join within the cap (stackedBar.css delays by
 * `--lc-i`); the composition bar's few category segments never reach it. */
const STAGGER_CAP = 8

interface ReserveMask {
  key: 'headroom' | 'output'
  label: string
  tokens: number
  left: number
  width: number
}

/** The tooltip's three rows: what the piece is, what it measures, and — only where the bar alone cannot
 *  say it — one line of explanation. `leftPct` is the piece's center, in shares of the bar's width. */
interface BarTip {
  head: string
  figure: string
  note?: string
  leftPct: number
}

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Segment click (the browser's DNA mode opens the band's accordion row): segments gain the pick cursor and report their key. */
  onPickKey?: (key: string) => void
  /** Minimum width each segment keeps, as a share of the OCCUPIED region (the browser's DNA bands: a tiny item must
   * stay a hoverable filament instead of rendering sub-pixel). Bands below the floor pin to it and the rest rescale
   * proportionally; the floor caps at the equal split (100/N), where the strip degrades to uniform bands. Tooltips
   * keep reporting TRUE shares — only widths are floored. */
  minBand?: number
  /** Render the hover tooltip (default true); a bar that only MIRRORS another card's hover turns it off, so the tooltip
   * floats only over the surface the pointer actually rests on. */
  tip?: boolean
  /** Optional auto-compaction reserve (reserve.ts derives the geometry): the two masks tiling the
   * window's tail — headroom, then the output reservation — plus the trigger's line when it detaches.
   * Laid out in WINDOW tokens and rendered only when `max` (the window) is positive. */
  reserve?: ContextReserve
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactElement {
    // The reserve-hover key lives here so the single tooltip slot serves segments, masks, and the trigger line.
    const [reserveOn, setReserveOn] = useState<ReserveMask['key'] | 'trigger' | null>(null)
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const tipRef = useRef<HTMLDivElement | null>(null)
    const [tipShift, setTipShift] = useState(0)
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    // Segment WIDTHS lay out against the full window (scale), but legend/tooltip percentages are shares of the OCCUPIED total — on hover a
    // solid box frames the occupied region (width = used/scale) to make that reference frame visible; only when a free track exists.
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    const showBox = free > 0 && hovering
    const pickKey = props.onPickKey
    const minBand = props.minBand !== undefined && props.minBand > 0 ? props.minBand : 0

    // The renderable segments (zero-value parts skip) with their BAR-unit widths, floored at `minBand` in occupied
    // units: pinned bands take the floor, the rest rescale into the remaining room so the strip still sums to the
    // occupied region exactly. At least one band always stays unpinned (the shares sum to 100, the floor ≤ 100/N),
    // so restRaw never divides by zero.
    const visible = total > 0 ? props.parts.filter(p => p.value > 0) : []
    const widths = ((): number[] => {
      if (minBand === 0 || visible.length < 2) return visible.map(p => p.value / scale * 100)
      const shares = visible.map(p => p.value / total * 100)
      const floor = Math.min(minBand, 100 / visible.length)
      let pinned = 0
      let pinnedRaw = 0
      for (const s of shares) {
        if (s < floor) { pinned += 1; pinnedRaw += s }
      }
      if (pinned === 0) return visible.map(p => p.value / scale * 100)
      const restRoom = 100 - pinned * floor
      const restRaw = 100 - pinnedRaw
      return shares.map(s => (s < floor ? floor : s * restRoom / restRaw) * total / scale)
    })()

    // The masks lay out in WINDOW units scaled onto whatever track the bar spans, so they keep the same
    // physical slice with or without a free track (once used exceeds the window, the stripes sit over the
    // outermost segments). They tile the window's tail at their true sizes — [window − output − headroom,
    // window] — and a mask nothing wide enough to hover is dropped rather than rendered sub-pixel.
    const win = props.max !== undefined && props.max > 0 ? props.max : undefined
    const reserve = win === undefined ? undefined : props.reserve
    const trackPct = (tokens: number): number => Math.round(Math.max(0, Math.min(100, tokens / scale * 100)) * 10) / 10
    // Read the trigger off the same projection the masks use — that one is clamped to the window,
    // so no impossible percent reaches the copy.
    const triggerPct = reserve === undefined ? 0 : trackPct(reserve.threshold)
    const masks: ReserveMask[] = []
    let triggerDetached = false
    if (reserve !== undefined && win !== undefined) {
      const maskStart = win - reserve.output - reserve.headroom
      const pieces = [
        { key: 'headroom' as const, label: t('overview.reserveHeadroom'), tokens: reserve.headroom, from: maskStart },
        { key: 'output' as const, label: t('overview.reserveOutput'), tokens: reserve.output, from: win - reserve.output },
      ]
      for (const piece of pieces) {
        const left = trackPct(piece.from)
        const width = trackPct(piece.from + piece.tokens) - left
        if (width > 0) masks.push({ key: piece.key, label: piece.label, tokens: piece.tokens, left, width })
      }
      triggerDetached = reserve.threshold < maskStart
    }

    // Every reserve piece — masks and the trigger line — shares the one hover key and pointer handling.
    const enterReserve = (key: ReserveMask['key'] | 'trigger') => (): void => {
      setReserveOn(key)
      if (props.onHoverKey !== undefined) props.onHoverKey(null)
    }
    const leaveReserve = (): void => { setReserveOn(null) }

    // The tooltip is DERIVED from the shared hover key, so a segment and its legend chip light the same segment with the same tooltip;
    // the wrapper keeps it outside the clipped stack; a hovered reserve piece (mask or trigger line) overrides the slot with its own
    // rows. Every figure NAMES its denominator — the segments share the USED total, the free track and the trigger line the WINDOW.
    let tip: BarTip | null = null
    const hoveredMask = reserveOn === null ? undefined : masks.find(m => m.key === reserveOn)
    if (reserveOn === 'trigger' && reserve !== undefined && triggerDetached) {
      tip = {
        head: t('overview.reserveTrigger'),
        figure: `${fmt(reserve.threshold)} · ${triggerPct}% ${t('overview.ofWindow')}`,
        note: t('overview.reserveTriggerTip'),
        leftPct: triggerPct,
      }
    } else if (hoveredMask !== undefined) {
      tip = {
        head: hoveredMask.label,
        figure: fmt(hoveredMask.tokens),
        note: hoveredMask.key === 'headroom'
          ? (triggerDetached ? t('overview.reserveHeadroomBuffer') : t('overview.reserveHeadroomTip', { p: triggerPct }))
          : t('overview.reserveOutputTip'),
        leftPct: hoveredMask.left + hoveredMask.width / 2,
      }
    } else if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          head: t('overview.free'),
          figure: `${fmt(free)} · ${Math.round(pct)}% ${t('overview.ofWindow')}`,
          leftPct: (total / scale * 100) + pct / 2,
        }
      } else {
        let acc = 0
        // Counts come from the part's heuristic `raw` figure (the ring
        // panel's rows); widths ride the floored `widths` so the tooltip centers on the RENDERED segment.
        let rawTotal = 0
        for (const p of props.parts) rawTotal += p.raw ?? p.value
        for (let i = 0; i < visible.length; i++) {
          const p = visible[i]
          if (p.key === props.hoverKey) {
            const count = p.raw ?? p.value
            tip = {
              head: p.label ?? catLabel(p.key),
              figure: `≈${fmt(count)} · ${rawTotal > 0 ? Math.round(count / rawTotal * 100) : 0}% ${t('overview.ofUsed')}`,
              leftPct: acc + widths[i] / 2,
            }
            break
          }
          acc += widths[i]
        }
      }
    }

    // The percentage anchor stays the source of truth; the px shift only fires when the rows would overhang the
    // bar, so a tip that fits is never displaced. No deps, so every render re-measures — the same-value bail-out
    // keeps that loopless. Rects, not clientWidth: the latter truncates to a whole pixel, and the residue lands
    // straight back on the overhang. A pane drag that changes no prop leaves the shift as last measured.
    useLayoutEffect(() => {
      // No visible tip → no measurement. Chart hover commits re-render this bar with no tip; reading layout
      // here would flush the whole page's layout for nothing.
      if (tip === null) {
        setTipShift(prev => (prev === 0 ? prev : 0))
        return
      }
      /* v8 ignore next -- unreachable: the wrap commits its ref before layout effects run. */
      const wrapW = wrapRef.current === null ? 0 : wrapRef.current.getBoundingClientRect().width
      const tipW = tipRef.current === null ? 0 : tipRef.current.getBoundingClientRect().width
      setTipShift((prev) => {
        if (wrapW <= 0 || tipW <= 0) return prev === 0 ? prev : 0
        const center = tip.leftPct / 100 * wrapW
        const leftOver = tipW / 2 - center
        const rightOver = center + tipW / 2 - wrapW
        const next = leftOver > 0 ? Math.ceil(leftOver) : rightOver > 0 ? Math.ceil(-rightOver) : 0
        return next === prev ? prev : next
      })
    })

    const shift = tipShift === 0
      ? null
      : { transform: `translateX(calc(-50% ${tipShift > 0 ? '+' : '-'} ${Math.abs(tipShift)}px))` }
    const tipStyle = tip === null ? { left: '50%' } : { left: `${tip.leftPct}%`, ...shift }

    return (
      <div className="lc-stacked-wrap" ref={wrapRef}>
        <div
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(null)
          }}
        >
          {visible.map((p, i) => {
            // Exact-key hover lights the one segment; a part's `group` answers a mirrored CATEGORY hover (DNA bands light per category).
            const on = props.hoverKey !== undefined
              && (props.hoverKey === p.key || (p.group !== undefined && props.hoverKey === p.group))
            return (
              <div
                key={p.key}
                className={'lc-stacked-seg animate-lc-stacked-in motion-reduce:animate-none' + (on ? ' lc-stacked-seg-on' : '') + (pickKey !== undefined ? ' lc-stacked-seg-pick' : '')}
                // Grow-in stagger slot (the animate-lc-stacked-in token's delay): each segment scaleX-opens
                // from the left edge in turn, capped so a long DNA band list settles fast.
                style={{ width: `${widths[i]}%`, backgroundColor: p.color, '--lc-i': Math.min(i, STAGGER_CAP) } as CSSProperties}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                onClick={pickKey !== undefined ? () => { pickKey(p.key) } : undefined}
              />
            )
          })}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free animate-lc-stacked-in motion-reduce:animate-none' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              // The free track opens right after the last occupied segment (past the stagger cap it joins
              // one slot after the capped segments).
              style={{ width: `${free / scale * 100}%`, '--lc-i': Math.min(visible.length, STAGGER_CAP + 1) } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {/* Painted above the track/segments so the stripes overlay them; each mask owns the pointer over its own slice so its
              explanation shows — and clears the segment hover link while exploring it.
              */}
          {masks.map(m => (
            <div
              key={m.key}
              className={`lc-reserve lc-reserve-${m.key}`}
              style={{ left: `${m.left}%`, width: `${m.width}%` }}
              onMouseEnter={enterReserve(m.key)}
              onMouseLeave={leaveReserve}
            />
          ))}
          {triggerDetached ? (
            <div
              className="lc-trigger"
              style={{ left: `${triggerPct}%` }}
              onMouseEnter={enterReserve('trigger')}
              onMouseLeave={leaveReserve}
            />
          ) : null}
          {/* The occupied-region frame: painted last so its border stays above the segments; always mounted (`.lc-occupied-box-on` toggles
              opacity) so it fades out on leave instead of unmounting instantly.
              */}
          <div
            className={'lc-occupied-box' + (showBox ? ' lc-occupied-box-on' : '')}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {/* The hover tooltip is always mounted too (opacity via `.lc-bar-tip-on`) so it fades in and out; hidden it holds no pointer events
            and no width of its own.
            */}
        {props.tip !== false
          ? (
            <div
              ref={tipRef}
              className={'lc-tip lc-bar-tip' + (tip ? ' lc-bar-tip-on' : '')}
              role={tip === null ? undefined : 'tooltip'}
              style={tipStyle}
            >
              {tip === null ? null : (
                <>
                  <b className="lc-bar-tip-head">{tip.head}</b>
                  <span className="lc-bar-tip-fig">{tip.figure}</span>
                  {tip.note !== undefined ? <span className="lc-bar-tip-note">{tip.note}</span> : null}
                </>
              )}
            </div>
          )
          : null}
      </div>
    )
  }
}

/** The category chips' interface, shared by the composition card's legend and the trend panel. */
export interface LegendProps {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Signed figures (the trend panel's Delta mode): the count prints with its sign and the sign's color,
   *  and the share drops out — a signed change has no share of the used total. */
  delta?: boolean
}

export function makeLegend(kit: ViewKit): (props: LegendProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: LegendProps): ReactElement {
    let total = 0
    for (const p of props.parts) total += p.raw ?? p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
          const count = p.raw ?? p.value
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          const sign = props.delta === true && count !== 0 ? ' lc-chip-nums-' + (count > 0 ? 'up' : 'down') : ''
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={props.delta === true ? undefined : t('overview.ofUsed')}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              <span className="lc-chip-label">{catLabel(p.key)}</span>
              <span className={'lc-chip-nums' + sign}>
                {props.delta === true ? (count > 0 ? '+' : '') + fmt(count) : '≈' + fmt(count)}
                {props.delta !== true && total > 0 ? <em>{`${Math.round(count / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
