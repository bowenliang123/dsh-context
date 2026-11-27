import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS, CAT_COLOR } from '../categories'
import { containHorizontalOverscroll, panByWheel } from '../overscroll'
import { RISE_CLASS } from './timelineDnaBars'
import { TimelineMilestoneBand } from './timelineMilestoneBand'
import { fitBandItemsOf, milestoneJumpSeq, milestonesOf, type MilestoneBandItem } from './timelineMilestones'
import { milestoneLabel, milestoneTipRows } from './timelineMilestoneText'
import { preprocessTimeline, riseKeyOf, TURN_FILLS, timelineMaxima, turnStepsOf, timelineTipRows } from './timelineModel'
import { placeTip } from './tip'
import { useElementSize } from './useElementMetrics'
import { ZOOM_FIT, anchoredScrollLeft, clampZoom, maxZoomOf, wheelZoomFactor, zoomAnchorOf, zoomLabelOf, type ZoomAnchor } from './timelineZoom'
import { isVerticalWheel } from '../wheel'
import type { ViewKit } from '../viewkit'

export interface TimelineOverviewProps {
  requests: RequestRecord[]
  events: ContextEventRecord[]
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
  onPickMilestone?: (seq: number) => void
}

const FLAG_FRACS: readonly number[] = [0.25, 0.5, 0.75, 1]

const TURN_LABEL_CHAR_PX = 6

const TURN_LABEL_PAD_PX = 6

const CHART_H = 112

const PLOT_TOP = 36

const yOf = (cum: number, scale: number, baseline: number): number =>
  Math.round((baseline - cum * scale) * 100) / 100

interface RibbonBand {
  cat: Category | 'system' | 'tools'
  upper: number[]
  lower: number[]
  points: string
}

interface RibbonGeometry {
  maxTotal: number
  maxUp: number
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
    maxActiveMs: 0,
    baseline: CHART_H,
    scale: 1,
    bands: [],
    durationRuns: [],
    durationDots: [],
  }
  if (n === 0) return geo
  ;({ maxTotal: geo.maxTotal, maxUp: geo.maxUp } = timelineMaxima(requests, delta))
  const span = Math.max(1, geo.maxUp)
  const deltaScale = CHART_H / span
  const u = n > 1 ? n - 1 : 1
  const xs: number[] = n === 1 ? [0, u] : Array.from({ length: n }, (_, i) => i)
  const cumAt = (v: number[], x: number): number => v[n === 1 ? 0 : x]
  const ribbon = (cat: RibbonBand['cat'], upper: number[], lower: number[]): void => {
    let width = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(upper[i] - lower[i])
      if (d > width) width = d
    }
    if (width <= 0) return
    const pts: string[] = []
    for (const x of xs) pts.push(`${x},${yOf(cumAt(upper, x), geo.scale, geo.baseline)}`)
    for (let k = xs.length - 1; k >= 0; k--) pts.push(`${xs[k]},${yOf(cumAt(lower, xs[k]), geo.scale, geo.baseline)}`)
    geo.bands.push({ cat, upper: [...upper], lower: [...lower], points: pts.join(' ') })
  }
  if (delta) {
    geo.scale = deltaScale
    const up = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const upPrev = up.slice()
      for (let i = 0; i < n; i++) up[i] += Math.max(0, requests[i][c.key] || 0)
      ribbon(c.key, up, upPrev)
    }
  } else {
    geo.scale = CHART_H / geo.maxTotal
    const acc = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const prev = acc.slice()
      for (let i = 0; i < n; i++) acc[i] += requests[i][c.key] || 0
      ribbon(c.key, acc, prev)
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
      run.push([i, yOf(m, scale, CHART_H)])
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
    const a = yOf(at(band.upper), geo.scale, geo.baseline)
    const b = yOf(at(band.lower), geo.scale, geo.baseline)
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

export function makeTimelineOverview(kit: ViewKit): (props: TimelineOverviewProps) => ReactElement | null {
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + kit.fmt(v)

  return function TimelineOverview(props: TimelineOverviewProps): ReactElement | null {
    const delta = props.mode === 'delta'
    const durationOn = props.durationCurve === true
    const { requests, focus } = useMemo(
      () => preprocessTimeline(props.requests, delta, props.focusCat),
      [props.requests, delta, props.focusCat],
    )
    const n = requests.length
    const geo = useMemo(() => ribbonGeometry(requests, delta, durationOn), [requests, delta, durationOn])
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const rowRef = useRef<HTMLDivElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const paneWidth = useElementSize(scrollRef).width
    const [zoom, setZoom] = useState(ZOOM_FIT)
    const zoomRef = useRef(ZOOM_FIT)
    const anchorRef = useRef<ZoomAnchor | null>(null)
    const tipXRef = useRef(0)
    const syncTip = useCallback((): void => {
      const wrap = wrapRef.current
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (wrap === null || scroller === null) return
      placeTip(wrap, tipXRef.current, scroller.scrollLeft, paneWidth)
    }, [paneWidth])
    const resetZoom = useCallback((): void => {
      anchorRef.current = null
      zoomRef.current = ZOOM_FIT
      setZoom(ZOOM_FIT)
    }, [])
    const lastIdxRef = useRef<number | null>(null)
    const lastCatRef = useRef<RibbonBand['cat'] | null>(null)
    const [localHover, setLocalHover] = useState<number | null>(null)
    const [localCat, setLocalCat] = useState<RibbonBand['cat'] | null>(null)
    const [keyCursor, setKeyCursor] = useState<number | null>(null)
    const [msHoverKey, setMsHoverKey] = useState<string | null>(null)
    const hoverSeq = localHover ?? props.hoveredSeq
    const handleHover = useCallback((seq: number | null): void => {
      setLocalHover(seq)
      props.onHover(seq)
    }, [props.onHover])
    const handleMilestoneHover = useCallback((item: MilestoneBandItem): void => {
      setMsHoverKey(item.key)
      handleHover(item.group.targetSeq)
    }, [handleHover])
    const handleMilestoneLeave = useCallback((): void => {
      setMsHoverKey(null)
      handleHover(null)
    }, [handleHover])
    const handleMilestonePick = useCallback((item: MilestoneBandItem): void => {
      if (props.onPickMilestone !== undefined) props.onPickMilestone(milestoneJumpSeq(item.group))
      else props.onSelect(item.group.targetSeq)
    }, [props.onPickMilestone, props.onSelect])
    const u = n > 1 ? n - 1 : 1
    const zoomed = zoom > ZOOM_FIT
    const zoomStyle = zoomed ? { width: `${Math.round(zoom * 1000) / 10}%` } : undefined
    const contentWidth = zoom * paneWidth
    const maxZoom = maxZoomOf(paneWidth, u)
    const viewRef = useRef({ u, w: paneWidth })
    const resetPendingRef = useRef(false)
    useLayoutEffect(() => {
      resetPendingRef.current = zoomRef.current > ZOOM_FIT
      anchorRef.current = null
      zoomRef.current = ZOOM_FIT
      setZoom(prev => (prev === ZOOM_FIT ? prev : ZOOM_FIT))
    }, [props.granularity, props.mode, props.focusCat])
    useLayoutEffect(() => {
      if (resetPendingRef.current) {
        resetPendingRef.current = false
        return
      }
      if (zoom <= maxZoom) return
      setZoom(maxZoom)
    }, [maxZoom, zoom])
    useLayoutEffect(() => {
      const prev = viewRef.current
      viewRef.current = { u, w: paneWidth }
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (scroller === null) return
      if (prev.u === u && prev.w === paneWidth) return
      if (zoomRef.current <= ZOOM_FIT) return
      const zoomNow = Math.min(zoomRef.current, maxZoom)
      const max = Math.max(0, zoomNow * paneWidth - paneWidth)
      const atEnd = scroller.scrollLeft >= Math.max(0, zoomRef.current * prev.w - prev.w) - 2
      scroller.scrollLeft = atEnd
        ? max
        : Math.min(max, scroller.scrollLeft * (prev.u / u) * (zoomNow / zoomRef.current) * (paneWidth / Math.max(1, prev.w)))
    }, [u, paneWidth, maxZoom])
    useLayoutEffect(() => {
      zoomRef.current = zoom
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (scroller === null) return
      const anchor = anchorRef.current
      anchorRef.current = null
      scroller.scrollLeft = anchor !== null
        ? anchoredScrollLeft(anchor, contentWidth, paneWidth)
        : Math.min(scroller.scrollLeft, Math.max(0, contentWidth - paneWidth))
    }, [zoom, contentWidth, paneWidth])
    useLayoutEffect(() => {
      const row = rowRef.current
      /* v8 ignore next 1 */
      if (row === null) return
      const onWheel = (e: WheelEvent): void => {
        if (!isVerticalWheel(e)) return
        const scroller = scrollRef.current
        /* v8 ignore next 1 */
        if (scroller === null) return
        e.preventDefault()
        if (e.shiftKey) {
          panByWheel(scroller, e, contentWidth - paneWidth)
          syncTip()
          return
        }
        const base = zoomRef.current
        const nextZoom = clampZoom(base * wheelZoomFactor(e.deltaY, e.deltaMode, paneWidth), maxZoom)
        if (nextZoom === base) return
        if (paneWidth > 0) {
          const vx = Math.min(Math.max(e.clientX - scroller.getBoundingClientRect().left, 0), paneWidth)
          anchorRef.current = zoomAnchorOf(scroller.scrollLeft, vx, contentWidth)
        }
        zoomRef.current = nextZoom
        setZoom(nextZoom)
      }
      row.addEventListener('wheel', onWheel, { passive: false })
      return () => { row.removeEventListener('wheel', onWheel) }
    }, [contentWidth, maxZoom, paneWidth, syncTip])
    useLayoutEffect(() => {
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (scroller === null) return
      return containHorizontalOverscroll(scroller)
    }, [])
    const milestoneGroups = useMemo(
      () => milestonesOf(props.requests, props.events, props.granularity),
      [props.requests, props.events, props.granularity],
    )
    const bandItems = useMemo(
      () => fitBandItemsOf(milestoneGroups, contentWidth, u),
      [milestoneGroups, contentWidth, u],
    )
    const msItem = msHoverKey !== null ? bandItems.find(item => item.key === msHoverKey) ?? null : null
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
    const turnLabelFits = (gi: number): boolean => {
      if (flagGroups.includes(gi)) return true
      if (!zoomed) return false
      const grp = groups[gi]
      return grp.count / n * contentWidth >= String(grp.turn).length * TURN_LABEL_CHAR_PX + TURN_LABEL_PAD_PX
    }
    const q3Value = Math.round(geo.maxUp * 3 / 4)
    const q1Value = Math.round(geo.maxUp / 4)
    const midValue = Math.round(geo.maxUp / 2)

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
      if (msHoverKey !== null) setMsHoverKey(null)
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
      setMsHoverKey(null)
      handleHover(null)
    }
    const onClick = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
      if (msHoverKey !== null) setMsHoverKey(null)
      const rect = e.currentTarget.getBoundingClientRect()
      const x = xAt(rect, e.clientX)
      const seq = requests[idxOf(x)].seq
      const cat = bandAt(geo, x, n, e.clientY - rect.top - PLOT_TOP)
      if (cat !== null && props.onPickCat !== undefined) props.onPickCat(cat, seq)
      props.onSelect(props.selectedSeq === seq ? null : seq)
    }

    const hoveredIdx = hoverSeq !== null ? requests.findIndex(r => r.seq === hoverSeq) : -1
    const selectedIdx = props.selectedSeq !== null ? requests.findIndex(r => r.seq === props.selectedSeq) : -1
    const keyboardIdx = (): number => keyCursor ?? (hoveredIdx >= 0 ? hoveredIdx : selectedIdx >= 0 ? selectedIdx : 0)
    const revealCursor = (index: number): void => {
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (scroller === null) return
      if (zoomRef.current <= ZOOM_FIT) return
      const content = zoomRef.current * paneWidth
      const x = index / u * content
      if (x < scroller.scrollLeft + 8 || x > scroller.scrollLeft + paneWidth - 8) {
        scroller.scrollLeft = Math.max(0, Math.min(x - paneWidth / 2, content - paneWidth))
      }
    }
    const moveCursor = (index: number, reveal = true): void => {
      const clamped = Math.min(n - 1, Math.max(0, index))
      setKeyCursor(clamped)
      handleHover(requests[clamped].seq)
      if (reveal) revealCursor(clamped)
    }
    const zoomByStep = (factor: number): void => {
      const scroller = scrollRef.current
      /* v8 ignore next 1 */
      if (scroller === null) return
      const next = clampZoom(zoomRef.current * factor, maxZoom)
      if (next === zoomRef.current) return
      anchorRef.current = zoomAnchorOf(scroller.scrollLeft, paneWidth / 2, contentWidth)
      zoomRef.current = next
      setZoom(next)
    }
    const onKeyDown = (ev: ReactKeyboardEvent): void => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); moveCursor(keyboardIdx() - 1) }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); moveCursor(keyboardIdx() + 1) }
      else if (ev.key === 'Home') { ev.preventDefault(); moveCursor(0) }
      else if (ev.key === 'End') { ev.preventDefault(); moveCursor(n - 1) }
      else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomByStep(1.25) }
      else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomByStep(1 / 1.25) }
      else if (ev.key === '0') { ev.preventDefault(); resetZoom() }
      else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        const seq = requests[keyboardIdx()].seq
        props.onSelect(props.selectedSeq === seq ? null : seq)
      }
    }
    const stepsOf = useMemo(() => turnStepsOf(props.requests), [props.requests])
    const msTextOptions = { granularity: props.granularity, stepsOf }
    const msReq = msItem !== null ? requests[msItem.group.targetIdx] : null
    const milestoneLabelOf = (item: MilestoneBandItem): string =>
      milestoneLabel(kit, msTextOptions, item.group, requests[item.group.targetIdx])
    useLayoutEffect(() => {
      tipXRef.current = msItem !== null
        ? msItem.x
        : hoveredIdx >= 0 ? hoveredIdx / u * contentWidth : 0
      syncTip()
    })
    if (n === 0) return null

    const tipRows = msHoverKey !== null
      ? (msItem !== null && msReq !== null ? milestoneTipRows(kit, msTextOptions, msItem.group, msReq) : null)
      : hoveredIdx >= 0
        ? timelineTipRows(kit, { granularity: props.granularity, stepsOf, delta, focus, durationOn }, requests[hoveredIdx])
        : null

    return (
      <div className="lc-chartrow" ref={rowRef}>
        {zoomed ? (
          <button
            type="button"
            className="lc-zoom-chip"
            title={kit.t('timeline.zoomReset')}
            aria-label={`${zoomLabelOf(zoom)} · ${kit.t('timeline.zoomReset')}`}
            onClick={resetZoom}
          >{zoomLabelOf(zoom)}</button>
        ) : null}
        <div className="lc-axis lc-axis-milestones">
          {delta ? (
            <>
              <span className="lc-axis-top">{fmtSigned(geo.maxUp)}</span>
              <span className="lc-axis-q3">{fmtSigned(q3Value)}</span>
              <span className="lc-axis-mid">{fmtSigned(midValue)}</span>
              <span className="lc-axis-q1">{fmtSigned(q1Value)}</span>
              <span className="lc-axis-bot">{'0'}</span>
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
          <div
            className={'lc-chart-scroll lc-chart-fit' + (zoomed ? ' lc-chart-zoom' : '') + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
            ref={scrollRef}
            onScroll={syncTip}
          >
            <div
              className="lc-chart lc-chart-milestones"
              style={zoomStyle}
              data-catdim={localCat ?? props.hoverCat ?? undefined}
              role="button"
              tabIndex={0}
              aria-label={kit.t('timeline.title')}
              onKeyDown={onKeyDown}
              onFocus={() => { setMsHoverKey(null); moveCursor(keyboardIdx(), false) }}
              onBlur={() => { setKeyCursor(null); handleHover(null) }}
              onMouseMove={onMove}
              onMouseLeave={onLeave}
              onClick={onClick}
            >
              <div className="lc-grid lc-grid-top" />
              <div className="lc-grid lc-grid-q3" />
              <div className="lc-grid lc-grid-q1" />
              <div className="lc-grid lc-grid-mid" />
              <div className="lc-grid lc-grid-zero" />
              {geo.bands.length > 0 || geo.durationRuns.length > 0 || geo.durationDots.length > 0 ? (
                <svg
                  key={riseKeyOf(props.granularity, props.mode, focus)}
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
                {flagRecords.map(idx => (
                  <span
                    key={`flag-${idx}`}
                    className="lc-timeline-flag"
                    style={{ left: idx === n - 1 ? 'calc(100% - 1px)' : `${idx / u * 100}%` }}
                    aria-hidden="true"
                  >
                    <span className="lc-timeline-flag-label">{flagLabel(idx)}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="lc-turns" style={zoomStyle} onMouseLeave={() => { props.onHoverTurn(null) }}>
              {groups.map((grp, gi) => {
                const on = props.activeTurn === grp.turn
                return (
                  <span
                    key={`turn-${gi}`}
                    className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                    style={{ flexGrow: grp.count, flexBasis: 0, background: TURN_FILLS[gi % TURN_FILLS.length] }}
                    title={`T${grp.turn}`}
                    role="button"
                    tabIndex={0}
                    aria-label={kit.t('tip.turn1', { t: grp.turn })}
                    aria-pressed={on}
                    onKeyDown={(ev) => {
                      if (ev.key !== 'Enter' && ev.key !== ' ') return
                      ev.preventDefault()
                      props.onPickTurn(grp.turn)
                    }}
                    onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                    onClick={() => { props.onPickTurn(grp.turn) }}
                  >{turnLabelFits(gi) ? <span className="lc-turn-label">{`${grp.turn}`}</span> : null}</span>
                )
              })}
            </div>
            <div className="lc-band" style={zoomStyle}>
              <TimelineMilestoneBand
                items={bandItems}
                activeKey={msItem !== null ? msItem.key : null}
                selectedSeq={props.selectedSeq}
                activeTurn={props.activeTurn}
                bandLabel={kit.t('timeline.ms.band')}
                labelOf={milestoneLabelOf}
                onHoverItem={handleMilestoneHover}
                onLeaveItem={handleMilestoneLeave}
                onPickItem={handleMilestonePick}
              />
            </div>
          </div>
          {tipRows !== null ? (
            <div className="lc-chart-tip">{tipRows.map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
        {durationOn ? (
          <div className="lc-axis lc-axis-r lc-axis-milestones">
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
