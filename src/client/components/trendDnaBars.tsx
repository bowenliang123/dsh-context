import { memo, type CSSProperties, type ReactElement } from 'react'
import type { Category } from '../../shared/types'
import type { DeltaBand, TrendBand } from '../dna'

export const RISE_CLASS = ' animate-lc-bar-in motion-reduce:animate-none'

export const STAGGER_CAP = 20
const DNA_MAX_STOPS = 64

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



export const DNA_SNAP_PX = 2

export function snapDnaRuns(
  runs: { color: string; from: number; to: number }[],
  grid: number = DNA_SNAP_PX,
): { color: string; from: number; to: number }[] {
  if (runs.length === 0) return runs
  const out: { color: string; from: number; to: number }[] = []
  const end = runs[runs.length - 1].to
  let from = runs[0].from
  for (let i = 0; i < runs.length; i++) {
    const rawTo = runs[i].to
    const to = i === runs.length - 1 ? rawTo : Math.min(end, Math.round(rawTo / grid) * grid)
    if (to <= from) continue
    const prev = out.length > 0 ? out[out.length - 1] : null
    if (prev !== null && prev.color === runs[i].color) prev.to = to
    else out.push({ color: runs[i].color, from, to })
    from = to
  }
  return out
}

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
  const pxPerToken = props.chartHeight / props.maxTotal
  const runs: { color: string; from: number; to: number }[] = []
  for (const b of visible) {
    const from = Math.round(b.off * pxPerToken * 100) / 100
    const to = Math.round((b.off + b.tokens) * pxPerToken * 100) / 100
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last !== null && last.color === b.color && last.to === from) last.to = to
    else runs.push({ color: b.color, from, to })
  }
  const stops = snapDnaRuns(runs, DNA_SNAP_PX)
  const background = stops.length === 0
    ? visible[visible.length - 1].color
    : 'linear-gradient(to top, ' + stops.map(r => `${r.color} ${r.from}px, ${r.color} ${r.to}px`).join(', ') + ')'
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
        background,
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


interface DnaDeltaBarProps {
  bands: DeltaBand[]
  scale: number
  enterIndex: number
  rise: boolean
  seq: number
  onHit: (key: string | null) => void
  onPick?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
}

export const DnaDeltaBar = function DnaDeltaBar(props: DnaDeltaBarProps): ReactElement | null {
  let sum = 0
  for (const b of props.bands) sum += b.tokens
  if (sum === 0) return null
  const runs: { color: string; from: number; to: number }[] = []
  const pushRun = (color: string, mag: number, at: number): number => {
    const from = Math.round(at / sum * 10000) / 100
    const to = Math.round((at + mag) / sum * 10000) / 100
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last !== null && last.color === color && last.to === from) last.to = to
    else runs.push({ color, from, to })
    return at + mag
  }
  let acc = 0
  for (const b of props.bands) acc = pushRun(b.color, b.tokens, acc)
  const stops = capDnaRuns(runs, DNA_MAX_STOPS)
  const height = Math.max(1, Math.round(sum * props.scale))
  const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): { key: string; cat: Category | 'system' | 'tools' } => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = rect.height > 0 ? Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)) : 0
    const pos = frac * sum
    let hit = props.bands[0]
    for (const b of props.bands) {
      if (b.off > pos) break
      hit = b
    }
    return hit
  }
  return (
    <div
      className={'lc-bar-dna' + (props.rise ? RISE_CLASS : '')}
      style={{
        position: 'absolute',
        bottom: 0,
        height: `${height}px`,
        background: 'linear-gradient(to top, ' + stops.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
        '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
      } as CSSProperties}
      onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
      onMouseLeave={() => { props.onHit(null) }}
      onClick={(e) => { if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e)) }}
    />
  )
}


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

