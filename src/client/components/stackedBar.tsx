/**
 * StackedBar + Legend — the composition bar (overview card) and its legend.
 * Hovering a segment or its legend chip lights the same segment and shows
 * the same tooltip; the free window space (blank track) is hoverable too.
 * JSX components; the shared hover-link tooltip is bespoke (no shared
 * primitive reproduces the cross-segment/legend linkage), so it stays custom
 * but styled through the shared `--dsw-alias-*` tokens.
 */

import type * as ReactNS from 'react'
import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

/**
 * DSH's automatic compaction trigger as a fraction of the routed context
 * window — the default `thresholdRatio` of `@deepseek-ai/dsh-compaction-basic`
 * (it compacts at step boundaries once `floor(contextWindow × ratio)` is
 * reached). DSH does not publish the configured ratio to plugins or clients,
 * so the UI mirrors the default here; deployments that tune `thresholdRatio`
 * / `modelPolicies` can adjust it if they want the reserve band to match.
 */
export const AUTO_COMPACT_RATIO = 0.8

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  /** Optional hover link: the active segment key, reported via onHoverKey. */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Render the hover tooltip (default true). A mirrored bar that only echoes
   * another card's hover turns it off, so the tooltip floats only over the
   * surface the pointer actually rests on. */
  tip?: boolean
  /**
   * Optional auto-compaction reserve band: the rightmost `(1 − ratio)` of the
   * window, drawn as striped "headroom" — the region the session normally
   * avoids filling because automatic compaction triggers past the threshold.
   * Only rendered when `max` (the window) is a positive number. `label` is the
   * translated hover explanation shown over the band.
   */
  reserve?: { ratio: number; label: string }
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactNS.ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactNS.ReactElement {
    // Hovering the reserve band shows its explanation (not a segment's); the
    // flag lives here so the single tooltip slot serves both.
    const [reserveOn, setReserveOn] = React.useState(false)
    // props.parts: [{key,color,value}]; optional props.max: when max exceeds
    // the parts' total, the remainder shows as an empty, hoverable track
    // ("free window" — the space left in the context window).
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    // Segment widths are laid out against the FULL window (scale), but their
    // legend/tooltip percentages are shares of the OCCUPIED total — so on
    // hover we frame the occupied region (width = used/scale) with a solid
    // box that makes that reference frame visible. Only when a free track
    // exists (otherwise width already equals the percentage).
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    const showBox = free > 0 && hovering

    // The reserve band is laid out in WINDOW units (`ratio × max` → `max`)
    // scaled onto whatever total the bar spans, so it stays the same physical
    // slice whether or not a free track exists (once used exceeds the window,
    // the stripes sit over the outermost segments).
    const reserve = props.reserve !== undefined && props.max !== undefined && props.max > 0
      // Carry the checked max into the object: the non-null reserve below
      // then proves max is present, no assertion needed.
      ? { ...props.reserve, max: props.max }
      : null
    // Round to one decimal: the ratios are float-y (0.8 × max / scale) and a
    // style % with a long decimal tail is noise (would render the same).
    const reserveLeft = reserve !== null ? Math.round(reserve.max * reserve.ratio / scale * 1000) / 10 : 0
    const reserveWidth = reserve !== null ? Math.round((1 - reserve.ratio) * reserve.max / scale * 1000) / 10 : 0

    // The tooltip is DERIVED from the shared hover key, so hovering either a
    // segment or its legend chip lights the same segment and shows the same
    // tooltip (centered on the segment; percentage positioning needs no
    // measuring). The wrapper keeps the tooltip outside the clipped stack.
    // Hovering the RESERVE band overrides the slot with its own explanation,
    // centered over the band's middle.
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
        for (const p of props.parts) {
          const pct = scale > 0 ? p.value / scale * 100 : 0
          if (p.key === props.hoverKey && p.value > 0) {
            tip = {
              // "(pct%)" is a share of the OCCUPIED total — the solid box
              // that appears on hover frames exactly this reference region.
              text: `${catLabel(p.key)} ≈${fmt(p.value)} (${Math.round(p.value / total * 100)}%) `
                + t('overview.ofUsed'),
              leftPct: Math.max(12, Math.min(acc + pct / 2, 88)),
            }
            break
          }
          acc += pct
        }
      }
    }

    return (
      <div className="lc-stacked-wrap">
        <div
          // Hover focus: dim everything except the hovered part and show the
          // occupied-region frame (`.lc-stacked-dim` + `.lc-occupied-box`).
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(false)
          }}
        >
          {total > 0
            ? props.parts.map((p) => {
              if (!p.value) return null
              const on = props.hoverKey !== undefined && props.hoverKey === p.key
              return (
                <div
                  key={p.key}
                  className={'lc-stacked-seg' + (on ? ' lc-stacked-seg-on' : '')}
                  style={{ width: `${p.value / scale * 100}%`, background: p.color }}
                  onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                />
              )
            })
            : null}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              style={{ width: `${free / scale * 100}%` }}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {/* Auto-compaction reserve band: the rightmost (1−ratio) of the
              window, striped like a warning plate to read as "headroom, not
              real usage". Painted above the track/segments so the stripes
              overlay them, owns the pointer so its own explanation shows
              (and the segment hover link is cleared while exploring it). */}
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
          {/* Hover reference frame: the occupied region (outside the free
              track) — the region the legend/tooltip percentages refer to.
              Painted last so its border stays above the segments. Always
              mounted (`.lc-occupied-box-on` toggles opacity) so the frame
              fades out on leave instead of unmounting instantly. */}
          <div
            className={'lc-occupied-box' + (showBox ? ' lc-occupied-box-on' : '')}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {/* The hover tooltip is always mounted too (opacity toggles via
            `.lc-bar-tip-on`) so it fades in AND out; hidden it holds no
            pointer events and no width of its own. */}
        {props.tip !== false
          ? (
            <div
              className={'lc-bar-tip' + (tip ? ' lc-bar-tip-on' : '')}
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
}) => ReactNS.ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactNS.ReactElement {
    let total = 0
    for (const p of props.parts) total += p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
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
                {'≈' + fmt(p.value)}
                {total > 0 ? <em>{`${Math.round(p.value / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
