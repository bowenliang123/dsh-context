import { memo, type CSSProperties, type ReactElement } from 'react'
import type { Category } from '../../shared/types'
import type { DnaDelta, TrendBand } from '../dna'

export const RISE_CLASS = ' animate-lc-bar-in motion-reduce:animate-none'

export const STAGGER_CAP = 20
const DNA_MAX_STOPS = 64

/** A 14px-wide DNA bar cannot show one stop per band, and thousands of stops bloat every inline style. Sample the
 *  runs down to a small fixed set: visually indistinguishable at this width, and the tooltip still reads the full model. */
export function capDnaRuns(
  runs: { color: string; from: number; to: number }[],
  maxStops: number,
): { color: string; from: number; to: number }[] {
  if (runs.length <= maxStops) return runs
  const end = runs[runs.length - 1].to
  const out: { color: string; from: number; to: number }[] = []
  let j = 0
  for (let k = 0; k < maxStops; k++) {
    const from = end * k / maxStops
    const to = end * (k + 1) / maxStops
    const mid = (from + to) / 2
    while (j < runs.length - 1 && runs[j].to <= mid) j++
    const color = runs[j].color
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && last.color === color) last.to = to
    else out.push({ color, from, to })
  }
  return out
}



/** DNA bar interior: ONE gradient div, same-color bands coalesced (long runs would bloat the style string) and
 * zero-token bands skipped. */
interface DnaBarProps {
  bands: TrendBand[]
  total: number
  maxTotal: number
  chartHeight: number
  enterIndex: number
  rise: boolean
  seq: number
  onHit: (key: string | null) => void
  onPick?: (seq: number, band: TrendBand) => void
}

export const DnaBar = function DnaBar(props: DnaBarProps): ReactElement | null {
  const visible: TrendBand[] = []
  for (const b of props.bands) if (b.tokens > 0) visible.push(b)
  if (visible.length === 0) return null
  // Shared per-token pixel scale (chartHeight/maxTotal), not per-bar percentages: the same band's stops are
  // identical numbers in every bar, so the browser rasterizes common strands identically (per-bar %
  // stops quantized against each bar's own total and made sub-pixel strands flip visible/merged).
  const pxPerToken = props.chartHeight / props.maxTotal
  const runs: { color: string; from: number; to: number }[] = []
  for (const b of visible) {
    const from = Math.round(b.off * pxPerToken * 100) / 100
    const to = Math.round((b.off + b.tokens) * pxPerToken * 100) / 100
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last !== null && last.color === b.color && last.to === from) last.to = to
    else runs.push({ color: b.color, from, to })
  }
  const stops = capDnaRuns(runs, DNA_MAX_STOPS)
  // A hit always exists (the first visible band starts at off 0; the fraction clamps), so the type carries no null.
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
      className={'lc-bar-dna' + (props.rise ? RISE_CLASS : '')}
      style={{
        height: `${Math.max(1, Math.round(props.total * pxPerToken))}px`,
        background: 'linear-gradient(to top, ' + stops.map(r => `${r.color} ${r.from}px, ${r.color} ${r.to}px`).join(', ') + ')',
        '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
      } as CSSProperties}
      onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
      onMouseLeave={() => { props.onHit(null) }}
      onClick={(e) => {
        if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e))
      }}
    />
  )
}


/** DNA+delta bar interior: ONE gradient div spans both arms — the down arm's bands in REVERSE read order, then the up arm. */
interface DnaDeltaBarProps {
  d: DnaDelta
  scale: number
  zeroBottom: number
  enterIndex: number
  rise: boolean
  seq: number
  onHit: (key: string | null) => void
  onPick?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
}

export const DnaDeltaBar = function DnaDeltaBar(props: DnaDeltaBarProps): ReactElement | null {
  let upSum = 0
  for (const b of props.d.up) upSum += b.tokens
  let downSum = 0
  for (const b of props.d.down) downSum -= b.tokens
  const gradSpan = upSum + downSum
  if (gradSpan === 0) return null
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
  const stops = capDnaRuns(runs, DNA_MAX_STOPS)
  const height = Math.max(1, Math.round(gradSpan * props.scale))
  const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): { key: string; cat: Category | 'system' | 'tools' } => {
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
      className={'lc-bar-dna' + (props.rise ? RISE_CLASS : '')}
      style={{
        position: 'absolute',
        bottom: `${Math.round(props.zeroBottom - downSum * props.scale)}px`,
        height: `${height}px`,
        background: 'linear-gradient(to top, ' + stops.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
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


/** Cross-bar lifetime highlight: a flex row mirroring the bar grid, one slice per bar still holding the hovered item; memoized. */
interface DnaHighlightsProps {
  slices: ({ bottom: number; height: number } | null)[] | null
  from: number
  to: number
  pads: { left: number; right: number }
}

export const DnaHighlights = memo(function DnaHighlights(props: DnaHighlightsProps): ReactElement | null {
  if (props.slices === null) return null
  return (
    <div className="lc-dna-hl">
      {props.pads.left > 0 ? <span className="lc-dna-cell" style={{ width: `${props.pads.left}px` }} aria-hidden="true" /> : null}
      {props.slices.slice(props.from, props.to + 1).map((s, k) => (
        <span key={props.from + k} className="lc-dna-cell">
          {s !== null ? (
            <span className="lc-dna-slice" style={{ bottom: `${s.bottom}px`, height: `${s.height}px` }} />
          ) : null}
        </span>
      ))}
      {props.pads.right > 0 ? <span className="lc-dna-cell" style={{ width: `${props.pads.right}px` }} aria-hidden="true" /> : null}
    </div>
  )
})

