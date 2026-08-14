/**
 * StackedBar + Legend — the composition bar (overview card) and its legend.
 * Hovering a segment or its legend chip lights the same segment and shows
 * the same tooltip; the free window space (blank track) is hoverable too.
 */

import type * as ReactNS from 'react'
import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'

const React: typeof ReactNS = require('react')
const h = React.createElement

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  /** Optional hover link: the active segment key, reported via onHoverKey. */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactNS.ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactNS.ReactElement {
    // props.parts: [{key,color,value}]; optional props.max: when max exceeds
    // the parts' total, the remainder shows as an empty, hoverable track
    // ("free window" — the space left in the context window).
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0

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
              text: catLabel(p.key) + ' ' + fmt(p.value) + ' (' + Math.round(p.value / total * 100) + '%)',
              leftPct: Math.max(12, Math.min(acc + pct / 2, 88)),
            }
            break
          }
          acc += pct
        }
      }
    }

    return h('div', { className: 'lc-stacked-wrap' },
      h('div', {
        className: 'lc-stacked',
        style: { height: (props.height || 14) + 'px' },
        onMouseLeave: () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) },
      },
        total > 0
          ? props.parts.map(p => {
            if (!p.value) return null
            const on = props.hoverKey !== undefined && props.hoverKey === p.key
            return h('div', {
              key: p.key,
              className: 'lc-stacked-seg' + (on ? ' lc-stacked-seg-on' : ''),
              style: { width: (p.value / scale * 100) + '%', background: p.color },
              onMouseEnter: () => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) },
            })
          })
          : null,
        free > 0 ? h('div', {
          key: 'free',
          className: 'lc-stacked-free' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : ''),
          style: { width: (free / scale * 100) + '%' },
          onMouseEnter: () => { if (props.onHoverKey !== undefined) props.onHoverKey('free') },
        }) : null),
      tip ? h('div', { className: 'lc-bar-tip', style: { left: tip.leftPct + '%' } }, tip.text) : null)
  }
}

export function makeLegend(kit: ViewKit): (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactNS.ReactElement {
  const { fmt, catLabel } = kit
  return function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactNS.ReactElement {
    let total = 0
    for (const p of props.parts) total += p.value
    return h('div', { className: 'lc-legend' },
      props.parts.map(p => {
        const on = props.hoverKey !== undefined && props.hoverKey === p.key
        return h('span', {
          key: p.key,
          className: 'lc-chip' + (on ? ' lc-chip-on' : ''),
          onMouseEnter: () => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) },
          onMouseLeave: () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) },
        },
          h('i', { style: { background: p.color } }),
          catLabel(p.key) + ' ' + fmt(p.value),
          total > 0 ? h('em', null, Math.round(p.value / total * 100) + '%') : null)
      }))
  }
}
