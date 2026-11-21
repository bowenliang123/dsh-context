import { type CSSProperties, type ReactElement, type ReactNode } from 'react'

const SEG_GAP = 0.5

export interface DonutSegment {
  key: string
  color: string
  value: number
}

export interface DonutProps {
  segments: DonutSegment[]
  centerTop: ReactNode
  centerSub?: ReactNode
  size?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function Donut(props: DonutProps): ReactElement {
  const size = props.size ?? 118
  let total = 0
  for (const s of props.segments) {
    if (Number.isFinite(s.value) && s.value > 0) total += s.value
  }
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
  if (arcs.length > 1) {
    for (const a of arcs) {
      const cut = Math.min(SEG_GAP / 2, a.len / 4)
      a.len -= cut * 2
      a.offset -= cut
    }
  }
  const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    && arcs.some(a => a.key === props.hoverKey)
  return (
    <div
      className={'lc-donut @max-[240px]/lc-card:mx-auto' + (hovering ? ' lc-donut-dim' : '')}
      style={{ width: size, height: size }}
      onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
    >
      <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
        {arcs.length === 0
          ? <circle className="lc-donut-track fill-none stroke-4" cx="21" cy="21" r="15.9155" />
          : arcs.map((a, i) => (
            <circle
              key={a.key}
              className={'lc-donut-seg fill-none stroke-4 animate-lc-donut-in motion-reduce:animate-none' + (props.hoverKey === a.key ? ' lc-donut-seg-on' : '')}
              cx="21"
              cy="21"
              r="15.9155"
              strokeDasharray={`${a.len} ${100 - a.len}`}
              strokeDashoffset={a.offset}
              style={{ '--lc-i': i, stroke: a.color } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(a.key) }}
            />
          ))}
      </svg>
      <div className="lc-donut-center">
        <b style={{ fontSize: Math.max(11, Math.round(size * 0.13)) }}>{props.centerTop}</b>
        {props.centerSub !== undefined
          ? <span style={{ fontSize: Math.max(10, Math.round(size * 0.105)) }}>{props.centerSub}</span>
          : null}
      </div>
    </div>
  )
}
