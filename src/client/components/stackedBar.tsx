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

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  /** Optional hover link: the active segment key, reported via onHoverKey. */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactNS.ReactElement {
  const { t, tr, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactNS.ReactElement {
    // props.parts: [{key,color,value}]; optional props.max: when max exceeds
    // the parts' total, the remainder shows as an empty, hoverable track
    // ("free window" — the space left in the context window).
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    // Segment widths are laid out against the FULL window (scale), but their
    // legend/tooltip percentages are shares of the OCCUPIED total — so on
    // hover we frame the occupied region (width = used/scale) with a dashed
    // box that makes that reference frame visible. Only when a free track
    // exists (otherwise width already equals the percentage).
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const showBox = free > 0 && props.hoverKey !== null && props.hoverKey !== undefined

    // The tooltip is DERIVED from the shared hover key, so hovering either a
    // segment or its legend chip lights the same segment and shows the same
    // tooltip (centered on the segment; percentage positioning needs no
    // measuring). The wrapper keeps the tooltip outside the clipped stack.
    let tip: { text: string; leftPct: number } | null = null
    if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          text: t('overview.free') + ' ' + fmt(free) + ' (' + Math.round(pct) + '%)',
          leftPct: Math.max(12, Math.min((total / scale * 100) + pct / 2, 88)),
        }
      } else {
        let acc = 0
        for (const p of props.parts) {
          const pct = scale > 0 ? p.value / scale * 100 : 0
          if (p.key === props.hoverKey && p.value > 0) {
            tip = {
              // "(pct%)" is a share of the OCCUPIED total — the dashed box
              // that appears on hover frames exactly this reference region.
              text: catLabel(p.key) + ' ≈' + fmt(p.value) + ' (' + Math.round(p.value / total * 100) + '%) '
                + tr('overview.ofUsed'),
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
          className="lc-stacked"
          style={{ height: (props.height || 14) + 'px' }}
          onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
        >
          {total > 0
            ? props.parts.map(p => {
              if (!p.value) return null
              const on = props.hoverKey !== undefined && props.hoverKey === p.key
              return (
                <div
                  key={p.key}
                  className={'lc-stacked-seg' + (on ? ' lc-stacked-seg-on' : '')}
                  style={{ width: (p.value / scale * 100) + '%', background: p.color }}
                  onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                />
              )
            })
            : null}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              style={{ width: (free / scale * 100) + '%' }}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {/* Hover reference frame: the occupied region (outside the free
              track) — the region the legend/tooltip percentages refer to.
              Painted last so its border stays above the segments. */}
          {showBox ? (
            <div className="lc-occupied-box" style={{ width: usedPct + '%' }} />
          ) : null}
        </div>
        {tip ? <div className="lc-bar-tip" style={{ left: tip.leftPct + '%' }}>{tip.text}</div> : null}
      </div>
    )
  }
}

export function makeLegend(kit: ViewKit): (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactNS.ReactElement {
  const { tr, fmt, catLabel } = kit
  return function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactNS.ReactElement {
    let total = 0
    for (const p of props.parts) total += p.value
    return (
      <div className="lc-legend">
        {props.parts.map(p => {
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={tr('overview.ofUsed')}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              {catLabel(p.key) + ' ≈' + fmt(p.value)}
              {total > 0 ? <em>{Math.round(p.value / total * 100) + '%'}</em> : null}
            </span>
          )
        })}
      </div>
    )
  }
}
