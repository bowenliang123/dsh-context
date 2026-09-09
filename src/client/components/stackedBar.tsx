/**
 * Composition bar + legend; the shared hover-link tooltip is bespoke — no shared primitive reproduces the cross-segment/legend linkage —
 * styled through the shared `--dsw-alias-*` tokens.
 */

import { useState, type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'

/**
 * Mirror of dsh-compaction-basic's default `thresholdRatio` (0.8): it compacts at step boundaries once `floor(contextWindow × ratio)` is
 * reached; DSH does not publish the configured ratio to plugins/clients, so the reserve band mirrors the default — deployments tuning
 * `thresholdRatio`/`modelPolicies` should adjust it to match.
 */
export const AUTO_COMPACT_RATIO = 0.8

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Segment click (the browser's DNA mode opens the band's accordion row): segments gain the pick cursor and report their key. */
  onPickKey?: (key: string) => void
  /**
   * Minimum width each segment keeps, as a share of the OCCUPIED region (the browser's DNA bands: a tiny item must
   * stay a hoverable filament instead of rendering sub-pixel). Bands below the floor pin to it and the rest rescale
   * proportionally; the floor caps at the equal split (100/N), where the strip degrades to uniform bands. Tooltips
   * keep reporting TRUE shares — only widths are floored.
   */
  minBand?: number
  /**
   * Render the hover tooltip (default true); a bar that only MIRRORS another card's hover turns it off, so the tooltip floats only over the
   * surface the pointer actually rests on.
   */
  tip?: boolean
  /**
   * Optional auto-compaction reserve band: the rightmost (1−ratio) of the window, striped 'headroom' — the region the session normally
   * avoids filling because automatic compaction triggers past the threshold; rendered only when `max` (the window) is positive.
   */
  reserve?: { ratio: number; label: string }
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactElement {
    // The reserve-hover flag lives here so the single tooltip slot serves both the segments and the band.
    const [reserveOn, setReserveOn] = useState(false)
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

    // The band lays out in WINDOW units (`ratio × max` → `max`) scaled onto whatever total the bar spans, so it stays the same physical
    // slice with or without a free track (once used exceeds the window, the stripes sit over the outermost segments).
    const reserve = props.reserve !== undefined && props.max !== undefined && props.max > 0
      ? { ...props.reserve, max: props.max }
      : null
    const reserveLeft = reserve !== null ? Math.round(reserve.max * reserve.ratio / scale * 1000) / 10 : 0
    const reserveWidth = reserve !== null ? Math.round((1 - reserve.ratio) * reserve.max / scale * 1000) / 10 : 0

    // The tooltip is DERIVED from the shared hover key, so a segment and its legend chip light the same segment with the same tooltip
    // (centered by %, no measuring); the wrapper keeps it outside the clipped stack; the reserve band overrides the slot with its own
    // label.
    let tip: { text: string; leftPct: number } | null = null
    if (reserveOn && reserve !== null) {
      tip = {
        text: reserve.label,
        leftPct: Math.max(12, Math.min(reserveLeft + reserveWidth / 2, 88)),
      }
    } else if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          text: `${t('overview.free')} ${fmt(free)} (${Math.round(pct)}%)`,
          leftPct: Math.max(12, Math.min((total / scale * 100) + pct / 2, 88)),
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
              text: `${p.label ?? catLabel(p.key)} ≈${fmt(count)} (${rawTotal > 0 ? Math.round(count / rawTotal * 100) : 0}%) `
                + t('overview.ofUsed'),
              leftPct: Math.max(12, Math.min(acc + widths[i] / 2, 88)),
            }
            break
          }
          acc += widths[i]
        }
      }
    }

    return (
      <div className="lc-stacked-wrap">
        <div
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(false)
          }}
        >
          {visible.map((p, i) => {
            // Exact-key hover lights the one segment; a part's `group` answers a mirrored CATEGORY hover (DNA bands light per category).
            const on = props.hoverKey !== undefined
              && (props.hoverKey === p.key || (p.group !== undefined && props.hoverKey === p.group))
            return (
              <div
                key={p.key}
                className={'lc-stacked-seg' + (on ? ' lc-stacked-seg-on' : '') + (pickKey !== undefined ? ' lc-stacked-seg-pick' : '')}
                style={{ width: `${widths[i]}%`, backgroundColor: p.color }}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                onClick={pickKey !== undefined ? () => { pickKey(p.key) } : undefined}
              />
            )
          })}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              style={{ width: `${free / scale * 100}%` }}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {/* Painted above the track/segments so the stripes overlay them; owns the pointer so its own explanation shows — and clears the
              segment hover link while exploring it.
              */}
          {reserve !== null ? (
            <div
              className="lc-reserve"
              style={{ left: `${reserveLeft}%`, width: `${reserveWidth}%` }}
              onMouseEnter={() => {
                setReserveOn(true)
                if (props.onHoverKey !== undefined) props.onHoverKey(null)
              }}
              onMouseLeave={() => { setReserveOn(false) }}
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
              className={'lc-tip lc-bar-tip' + (tip ? ' lc-bar-tip-on' : '')}
              style={{ left: tip ? `${tip.leftPct}%` : '50%' }}
            >{tip ? tip.text : ''}</div>
          )
          : null}
      </div>
    )
  }
}

export function makeLegend(kit: ViewKit): (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactElement {
    let total = 0
    for (const p of props.parts) total += p.raw ?? p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
          const count = p.raw ?? p.value
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={t('overview.ofUsed')}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              <span className="lc-chip-label">{catLabel(p.key)}</span>
              <span className="lc-chip-nums">
                {'≈' + fmt(count)}
                {total > 0 ? <em>{`${Math.round(count / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
