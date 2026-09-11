/**
 * The stats cards' ring chart: proportional SVG segments (stroke-dasharray
 * over a 100-unit circumference, the same trick as the agent graph's rings)
 * around an HTML center label. Neighbouring segments part on a hairline of the
 * card's own background (each arc gives up a half gap at both ends); segments
 * with no value are skipped; an all-zero ring renders as one neutral track so
 * the card never draws a misleading "100% of nothing" pie. The center type
 * scales with the ring's size, so the label always fits inside the hole the
 * thin stroke leaves. On mount the slices sweep in one after another, growing
 * their dasharcs clockwise from 12 o'clock (stats.css, staggered by the
 * per-slice `--lc-i` slot below).
 */

import { type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ViewKit } from '../viewkit'

/**
 * The hairline divider between two slices, in dasharray units (1 unit ≈ 1% of
 * the circumference ≈ 2.3px on the 96px card ring, so this reads as ~1px).
 */
const SEG_GAP = 0.5

export interface DonutSegment {
  key: string
  color: string
  value: number
}

export interface DonutProps {
  segments: DonutSegment[]
  /** The big center figure (a duration, a token count, a percentage). */
  centerTop: ReactNode
  /** The small caption under the center figure. */
  centerSub?: ReactNode
  /** Outer size in px (default 118). */
  size?: number
  /** The hovered slice key — the legend row ↔ segment hover link. */
  hoverKey?: string | null
  /** Hover relay; absent renders the ring inert. */
  onHoverKey?: (key: string | null) => void
}

export function makeDonut(kit: ViewKit): (props: DonutProps) => ReactElement {
  void kit
  return function Donut(props: DonutProps): ReactElement {
    const size = props.size ?? 118
    let total = 0
    for (const s of props.segments) {
      if (Number.isFinite(s.value) && s.value > 0) total += s.value
    }
    // One dasharray unit = 1% of the circumference (r = 15.9155 → C ≈ 100);
    // each segment starts where the previous one ends, the +25 offset pins
    // the first segment to 12 o'clock.
    const arcs: { key: string; color: string; len: number; offset: number }[] = []
    let acc = 0
    if (total > 0) {
      for (const s of props.segments) {
        const v = Number.isFinite(s.value) && s.value > 0 ? s.value : 0
        if (v === 0) continue
        const pct = v / total * 100
        arcs.push({ key: s.key, color: s.color, len: pct, offset: 100 - acc + 25 })
        acc += pct
      }
    }
    // The divider: with a neighbour on each side a slice gives up half a gap at
    // BOTH ends, so the card's own background parts the colours. A lone painted
    // slice keeps its full ring (a gap there reads as a nick), and the cut never
    // takes more than half a sliver — the 0.2% overhead wedge would otherwise
    // vanish whole.
    if (arcs.length > 1) {
      for (const a of arcs) {
        const cut = Math.min(SEG_GAP / 2, a.len / 4)
        a.len -= cut * 2
        a.offset -= cut
      }
    }
    // The ring dims only for a hover that lands on a painted arc — a legend
    // row without a segment (a zero slice) leaves the ring at rest.
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
      && arcs.some(a => a.key === props.hoverKey)
    return (
      <div
        className={'lc-donut' + (hovering ? ' lc-donut-dim' : '')}
        style={{ width: size, height: size }}
        onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
      >
        <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
          {arcs.length === 0
            ? <circle className="lc-donut-track" cx="21" cy="21" r="15.9155" fill="none" strokeWidth="4" />
            : arcs.map((a, i) => (
              <circle
                key={a.key}
                className={'lc-donut-seg' + (props.hoverKey === a.key ? ' lc-donut-seg-on' : '')}
                cx="21"
                cy="21"
                r="15.9155"
                fill="none"
                stroke={a.color}
                strokeWidth="4"
                strokeDasharray={`${a.len} ${100 - a.len}`}
                strokeDashoffset={a.offset}
                // Sweep-in stagger slot (stats.css animates stroke-dasharray from 0 100 up to these attribute
                // values, so the slices build clockwise from 12 o'clock, one after another).
                style={{ '--lc-i': i } as CSSProperties}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(a.key) }}
              />
            ))}
        </svg>
        <div className="lc-donut-center">
          <b style={{ fontSize: Math.max(11, Math.round(size * 0.13)) }}>{props.centerTop}</b>
          {props.centerSub !== undefined
            ? <span style={{ fontSize: Math.max(9, Math.round(size * 0.105)) }}>{props.centerSub}</span>
            : null}
        </div>
      </div>
    )
  }
}
