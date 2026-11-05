import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS, CAT_COLOR } from '../categories'
import { RISE_CLASS, TURN_FILLS, preprocessTrend, trendMaxima, turnStepsOf, trendTipRows } from './trendChart'
import type { ViewKit } from '../viewkit'

export interface TrendOverviewProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  hoverCat: string | null
  focusCat?: string | null
  durationCurve?: boolean
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onPickCat?: (cat: Category | 'system' | 'tools', seq: number) => void
}

const FLAG_FRACS: readonly number[] = [0.25, 0.5, 0.75, 1]

const CHART_H = 112

const PLOT_TOP = 18

const yOf = (cum: number, scale: number, baseline: number, dir: 1 | -1): number =>
  Math.round((baseline - dir * cum * scale) * 100) / 100

interface RibbonBand {
  cat: Category | 'system' | 'tools'
  upper: number[]
  lower: number[]
  dir: 1 | -1
  points: string
}

interface RibbonGeometry {
  maxTotal: number
  maxUp: number
  maxDown: number
  upPx: number
  span: number
  maxActiveMs: number
  baseline: number
  scale: number
  bands: RibbonBand[]
  durationRuns: string[]
  durationDots: [number, number][]
}

function ribbonGeometry(requests: RequestRecord[], delta: boolean, durationOn: boolean): RibbonGeometry {
  const n = requests.length
  const geo: RibbonGeometry = {
    maxTotal: 1,
    maxUp: 0,
    maxDown: 0,
    upPx: 0,
    span: 1,
    maxActiveMs: 0,
    baseline: 0,
    scale: 1,
    bands: [],
    durationRuns: [],
    durationDots: [],
  }
  if (n === 0) return geo
  ;({ maxTotal: geo.maxTotal, maxUp: geo.maxUp, maxDown: geo.maxDown } = trendMaxima(requests, delta))
  const span = Math.max(1, geo.maxUp + geo.maxDown)
  const deltaScale = CHART_H / span
  geo.span = span
  geo.upPx = Math.round(geo.maxUp * deltaScale)
  const u = n > 1 ? n - 1 : 1
  const xs: number[] = n === 1 ? [0, u] : Array.from({ length: n }, (_, i) => i)
  const cumAt = (v: number[], x: number): number => v[n === 1 ? 0 : x]
  const ribbon = (cat: RibbonBand['cat'], upper: number[], lower: number[], dir: 1 | -1): void => {
    let width = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(upper[i] - lower[i])
      if (d > width) width = d
    }
    if (width <= 0) return
    const pts: string[] = []
    for (const x of xs) pts.push(`${x},${yOf(cumAt(upper, x), geo.scale, geo.baseline, dir)}`)
    for (let k = xs.length - 1; k >= 0; k--) pts.push(`${xs[k]},${yOf(cumAt(lower, xs[k]), geo.scale, geo.baseline, dir)}`)
    geo.bands.push({ cat, upper: [...upper], lower: [...lower], dir, points: pts.join(' ') })
  }
  if (delta) {
    geo.baseline = geo.upPx
    geo.scale = deltaScale
    const up = new Array<number>(n).fill(0)
    const down = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const upPrev = up.slice()
      const downPrev = down.slice()
      for (let i = 0; i < n; i++) {
        const d = requests[i][c.key] || 0
        up[i] += Math.max(0, d)
        down[i] += Math.max(0, -d)
      }
      ribbon(c.key, up, upPrev, 1)
      ribbon(c.key, downPrev, down, -1)
    }
  } else {
    geo.baseline = CHART_H
    geo.scale = CHART_H / geo.maxTotal
    const acc = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const prev = acc.slice()
      for (let i = 0; i < n; i++) acc[i] += requests[i][c.key] || 0
      ribbon(c.key, acc, prev, 1)
    }
  }
  if (durationOn) {
    let maxActiveMs = 0
    for (const req of requests) {
      const m = req.activeMs ?? 0
      if (m > maxActiveMs) maxActiveMs = m
    }
    geo.maxActiveMs = maxActiveMs
    const scale = CHART_H / Math.max(1, maxActiveMs)
    let run: [number, number][] = []
    const flushRun = (): void => {
      if (run.length >= 2) geo.durationRuns.push(run.map(p => `${p[0]},${p[1]}`).join(' '))
      else if (run.length === 1) geo.durationDots.push(run[0])
      run = []
    }
    for (let i = 0; i < n; i++) {
      const m = requests[i].activeMs
      if (m === undefined) {
        flushRun()
        continue
      }
      run.push([i, yOf(m, scale, CHART_H, 1)])
    }
    flushRun()
  }
  return geo
}

function bandAt(geo: RibbonGeometry, f: number, n: number, y: number): RibbonBand['cat'] | null {
  const i0 = Math.min(n - 1, Math.floor(f))
  const i1 = Math.min(n - 1, i0 + 1)
  const t = f - i0
  const at = (v: number[]): number => v[i0] + (v[i1] - v[i0]) * t
  for (const band of geo.bands) {
    const a = yOf(at(band.upper), geo.scale, geo.baseline, band.dir)
    const b = yOf(at(band.lower), geo.scale, geo.baseline, band.dir)
    if (y >= Math.min(a, b) && y <= Math.max(a, b)) return band.cat
  }
  return null
}

function wideQuartiles(groups: { count: number }[]): number[] {
  const total = groups.reduce((s, g) => s + g.count, 0)
  const picks: number[] = []
  for (const q of FLAG_FRACS) {
    let acc = 0
    let pick = groups.length - 1
    for (let g = 0; g + 1 < groups.length; g++) {
      acc += groups[g].count
      if (acc > q * total) {
        pick = g
        break
      }
    }
    if (!picks.includes(pick)) picks.push(pick)
  }
  return picks
}

export function makeTrendOverview(kit: ViewKit): (props: TrendOverviewProps) => ReactElement | null {
  const { eventLabel, eventAt } = kit

  const Q3_TOP = 41
  const Q1_TOP = 97
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + kit.fmt(v)

  return function TrendOverview(props: TrendOverviewProps): ReactElement | null {
    const delta = props.mode === 'delta'
    const durationOn = props.durationCurve === true
    const { requests, focus } = useMemo(
      () => preprocessTrend(props.requests, delta, props.focusCat),
      [props.requests, delta, props.focusCat],
    )
    const n = requests.length
    const geo = useMemo(() => ribbonGeometry(requests, delta, durationOn), [requests, delta, durationOn])
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const lastIdxRef = useRef<number | null>(null)
    const lastCatRef = useRef<RibbonBand['cat'] | null>(null)
    const [localHover, setLocalHover] = useState<number | null>(null)
    const [localCat, setLocalCat] = useState<RibbonBand['cat'] | null>(null)
    const hoverSeq = localHover ?? props.hoveredSeq
    const handleHover = useCallback((seq: number | null): void => {
      setLocalHover(seq)
      props.onHover(seq)
    }, [props.onHover])
    const u = n > 1 ? n - 1 : 1
    const groups: { turn: number; count: number; first: number }[] = []
    for (let i = 0; i < n; i++) {
      const req = requests[i]
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, first: i }
        groups.push(grp)
      }
      grp.count++
    }
    const flagRecords = [...new Set(FLAG_FRACS.map(q => Math.round(q * (n - 1))))].filter(idx => idx > 0)
    const flagLabel = (idx: number): number => (props.granularity === 'step' ? idx + 1 : requests[idx].turn ?? 0)
    const flagGroups = wideQuartiles(groups)
    const q3Clear = Math.abs(Q3_TOP - 13 - geo.upPx) >= 11
    const q1Clear = Math.abs(Q1_TOP - 13 - geo.upPx) >= 11

    let wash: { left: string; right: string } | null = null
    if (props.activeTurn !== null) {
      const wi = groups.findIndex(g => g.turn === props.activeTurn)
      if (wi >= 0) {
        const end = groups[wi].first + groups[wi].count - 1
        const left = groups[wi].first === 0 ? 0 : (groups[wi].first - 0.5) / u * 100
        const right = end === n - 1 ? 100 : (end + 0.5) / u * 100
        wash = { left: `${left}%`, right: `${100 - right}%` }
      }
    }

    const xAt = (rect: { width: number; left: number }, clientX: number): number => {
      if (rect.width <= 0) return 0
      const fx = (clientX - rect.left) / rect.width
      return Math.min(u, Math.max(0, fx * u))
    }
    const idxOf = (x: number): number => Math.min(n - 1, Math.round(x))
    const onMove = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = xAt(rect, e.clientX)
      const idx = idxOf(x)
      if (lastIdxRef.current !== idx) {
        lastIdxRef.current = idx
        handleHover(requests[idx].seq)
      }
      const cat = bandAt(geo, x, n, e.clientY - rect.top - PLOT_TOP)
      if (lastCatRef.current !== cat) {
        lastCatRef.current = cat
        setLocalCat(cat)
      }
    }
    const onLeave = (): void => {
      lastIdxRef.current = null
      lastCatRef.current = null
      setLocalCat(null)
      handleHover(null)
    }
    const onClick = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = xAt(rect, e.clientX)
      const seq = requests[idxOf(x)].seq
      const cat = bandAt(geo, x, n, e.clientY - rect.top - PLOT_TOP)
      if (cat !== null && props.onPickCat !== undefined) props.onPickCat(cat, seq)
      props.onSelect(props.selectedSeq === seq ? null : seq)
    }

    const hoveredIdx = hoverSeq !== null ? requests.findIndex(r => r.seq === hoverSeq) : -1
    const selectedIdx = props.selectedSeq !== null ? requests.findIndex(r => r.seq === props.selectedSeq) : -1
    const stepsOf = useMemo(() => turnStepsOf(props.requests), [props.requests])
    useLayoutEffect(() => {
      const el = surfaceRef.current
      /* v8 ignore next 1 */
      if (el === null) return
      const cw = el.clientWidth
      /* v8 ignore next 1 */
      const tip = (wrapRef.current ?? document.body).querySelector<HTMLElement>('.lc-chart-tip')
      if (tip === null) return
      const lw = tip.offsetWidth
      const half = Math.min(lw / 2, cw / 2)
      /* v8 ignore next 1 */
      const cx = hoveredIdx >= 0 ? Math.min(Math.max(hoveredIdx / u * cw, half), cw - half) : 0
      const next = `translate(${Math.round(cx - lw / 2)}px, 0)`
      if (tip.style.transform !== next) tip.style.transform = next
    })
    if (n === 0) return null

    const tipRows = hoveredIdx >= 0
      ? trendTipRows(kit, { granularity: props.granularity, stepsOf, delta, focus, durationOn }, requests[hoveredIdx])
      : null

    return (
      <div className="lc-chartrow">
        <div className="lc-axis">
          {delta ? (
            <>
              <span className="lc-axis-top">{fmtSigned(geo.maxUp)}</span>
              {q3Clear
                ? <span className="lc-axis-q3">{fmtSigned(Math.round(geo.maxUp - geo.span / 4))}</span>
                : null}
              <span className="lc-axis-mid" style={{ top: `${13 + geo.upPx}px` }}>{'0'}</span>
              {q1Clear
                ? <span className="lc-axis-q1">{fmtSigned(Math.round(geo.maxUp - 3 * geo.span / 4))}</span>
                : null}
              <span className="lc-axis-bot">{fmtSigned(-geo.maxDown)}</span>
            </>
          ) : (
            <>
              <span className="lc-axis-top">{kit.fmt(geo.maxTotal)}</span>
              <span className="lc-axis-q3">{kit.fmt(Math.round(geo.maxTotal * 3 / 4))}</span>
              <span className="lc-axis-mid">{kit.fmt(Math.round(geo.maxTotal / 2))}</span>
              <span className="lc-axis-q1">{kit.fmt(Math.round(geo.maxTotal / 4))}</span>
              <span className="lc-axis-bot">{'0'}</span>
            </>
          )}
        </div>
        <div className="lc-chart-wrap" ref={wrapRef}>
          <div className={'lc-chart-scroll lc-chart-fit' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}>
            <div
              className="lc-chart"
              ref={surfaceRef}
              data-catdim={localCat ?? props.hoverCat ?? undefined}
              onMouseMove={onMove}
              onMouseLeave={onLeave}
              onClick={onClick}
            >
              <div className="lc-grid lc-grid-top" />
              {(!delta || q3Clear) ? <div className="lc-grid lc-grid-q3" /> : null}
              {(!delta || q1Clear) ? <div className="lc-grid lc-grid-q1" /> : null}
              {!delta ? <div className="lc-grid lc-grid-mid" /> : null}
              <div className="lc-grid lc-grid-zero" style={delta ? { top: `${PLOT_TOP + geo.upPx}px` } : undefined} />
              {geo.bands.length > 0 || geo.durationRuns.length > 0 || geo.durationDots.length > 0 ? (
                <svg
                  className={'lc-duration lc-fit-svg' + RISE_CLASS}
                  viewBox={`0 0 ${u} ${CHART_H}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {geo.bands.map((b, i) => (
                    <polygon
                      key={i}
                      data-cat={b.cat}
                      className="lc-cat-seg"
                      style={{ fill: CAT_COLOR[b.cat], stroke: CAT_COLOR[b.cat] }}
                      points={b.points}
                    />
                  ))}
                  {geo.durationRuns.map((pts, i) => (
                    <Fragment key={i}>
                      <polyline className="lc-dur-halo" points={pts} />
                      <polyline points={pts} />
                    </Fragment>
                  ))}
                  {geo.durationDots.map((p, i) => (
                    <Fragment key={i}>
                      <circle className="lc-dur-halo" cx={p[0]} cy={p[1]} r={2} />
                      <circle cx={p[0]} cy={p[1]} r={1.2} />
                    </Fragment>
                  ))}
                </svg>
              ) : null}
              {wash !== null && localCat === null ? (
                <>
                  <div className="lc-fit-wash" style={{ left: 0, width: wash.left, right: 'auto' }} />
                  <div className="lc-fit-wash" style={{ left: 'auto', width: wash.right, right: 0 }} />
                </>
              ) : null}
              {hoveredIdx >= 0 ? <div className="lc-fit-cursor" style={{ left: `${hoveredIdx / u * 100}%` }} /> : null}
              {selectedIdx >= 0 ? <div className="lc-fit-cursor lc-fit-pin" style={{ left: `${selectedIdx / u * 100}%` }} /> : null}
              <div className="lc-fit-layer">
                {props.markers.map((ev, i) => {
                  if (ev === undefined) return null
                  const at = eventAt(ev)
                  return (
                    <span
                      key={`marker-${i}`}
                      className="lc-bar-marker"
                      style={{ left: `${i / u * 100}%` }}
                      title={'✂ ' + (at !== null ? at + ' — ' : '') + eventLabel(ev)}
                    >{'✂'}</span>
                  )
                })}
                {flagRecords.map(idx => (
                  <span
                    key={`flag-${idx}`}
                    className="lc-trend-flag"
                    style={{ left: idx === n - 1 ? 'calc(100% - 1px)' : `${idx / u * 100}%` }}
                    aria-hidden="true"
                  >
                    <span className="lc-trend-flag-label">{flagLabel(idx)}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="lc-turns" onMouseLeave={() => { props.onHoverTurn(null) }}>
              {groups.map((grp, gi) => {
                const on = props.activeTurn === grp.turn
                return (
                  <span
                    key={`turn-${gi}`}
                    className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                    style={{ flexGrow: grp.count, flexBasis: 0, background: TURN_FILLS[gi % TURN_FILLS.length] }}
                    title={`T${grp.turn}`}
                    onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                    onClick={() => { props.onPickTurn(grp.turn) }}
                  >{flagGroups.includes(gi) ? <span className="lc-turn-label">{`${grp.turn}`}</span> : null}</span>
                )
              })}
            </div>
          </div>
          {tipRows !== null ? (
            <div className="lc-chart-tip">{tipRows.map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
        {durationOn ? (
          <div className="lc-axis lc-axis-r">
            <span className="lc-axis-top">{kit.fmtDuration(geo.maxActiveMs)}</span>
            <span className="lc-axis-q3">{kit.fmtDuration(Math.round(geo.maxActiveMs * 3 / 4))}</span>
            <span className="lc-axis-mid">{kit.fmtDuration(Math.round(geo.maxActiveMs / 2))}</span>
            <span className="lc-axis-q1">{kit.fmtDuration(Math.round(geo.maxActiveMs / 4))}</span>
            <span className="lc-axis-bot">{'0'}</span>
          </div>
        ) : null}
      </div>
    )
  }
}
