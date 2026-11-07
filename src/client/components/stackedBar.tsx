import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { ContextReserve } from '../reserve'
import type { ViewKit } from '../viewkit'
import { TipBubble, tipShiftStyle, useTipShift } from './tip'

const STAGGER_CAP = 8

export const SEGMENT_ANIMATION_MAX = 256

interface ReserveMask {
  key: 'headroom' | 'output'
  label: string
  tokens: number
  left: number
  width: number
}

interface BarTip {
  head: string
  figure: string
  note?: string
  leftPct: number
}

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onPickKey?: (key: string) => void
  minBand?: number
  tip?: boolean
  reserve?: ContextReserve
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactElement {
    const [reserveOn, setReserveOn] = useState<ReserveMask['key'] | 'trigger' | null>(null)
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const tipRef = useRef<HTMLDivElement | null>(null)
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    const showBox = free > 0 && hovering
    const pickKey = props.onPickKey
    const minBand = props.minBand !== undefined && props.minBand > 0 ? props.minBand : 0

    const visible = total > 0 ? props.parts.filter(p => p.value > 0) : []
    const animate = visible.length <= SEGMENT_ANIMATION_MAX
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

    const win = props.max !== undefined && props.max > 0 ? props.max : undefined
    const reserve = win === undefined ? undefined : props.reserve
    const trackPct = (tokens: number): number => Math.round(Math.max(0, Math.min(100, tokens / scale * 100)) * 10) / 10
    const triggerPct = reserve === undefined ? 0 : trackPct(reserve.threshold)
    const masks: ReserveMask[] = []
    let triggerDetached = false
    if (reserve !== undefined && win !== undefined) {
      const maskStart = win - reserve.output - reserve.headroom
      const pieces = [
        { key: 'headroom' as const, label: t('overview.reserveHeadroom'), tokens: reserve.headroom, from: maskStart },
        { key: 'output' as const, label: t('overview.reserveOutput'), tokens: reserve.output, from: win - reserve.output },
      ]
      for (const piece of pieces) {
        const left = trackPct(piece.from)
        const width = trackPct(piece.from + piece.tokens) - left
        if (width > 0) masks.push({ key: piece.key, label: piece.label, tokens: piece.tokens, left, width })
      }
      triggerDetached = reserve.threshold < maskStart
    }

    const enterReserve = (key: ReserveMask['key'] | 'trigger') => (): void => {
      setReserveOn(key)
      if (props.onHoverKey !== undefined) props.onHoverKey(null)
    }
    const leaveReserve = (): void => { setReserveOn(null) }

    let tip: BarTip | null = null
    const hoveredMask = reserveOn === null ? undefined : masks.find(m => m.key === reserveOn)
    if (reserveOn === 'trigger' && reserve !== undefined && triggerDetached) {
      tip = {
        head: t('overview.reserveTrigger'),
        figure: `${fmt(reserve.threshold)} · ${triggerPct}% ${t('overview.ofWindow')}`,
        note: t('overview.reserveTriggerTip'),
        leftPct: triggerPct,
      }
    } else if (hoveredMask !== undefined) {
      tip = {
        head: hoveredMask.label,
        figure: fmt(hoveredMask.tokens),
        note: hoveredMask.key === 'headroom'
          ? (triggerDetached ? t('overview.reserveHeadroomBuffer') : t('overview.reserveHeadroomTip', { p: triggerPct }))
          : t('overview.reserveOutputTip'),
        leftPct: hoveredMask.left + hoveredMask.width / 2,
      }
    } else if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          head: t('overview.free'),
          figure: `${fmt(free)} · ${Math.round(pct)}% ${t('overview.ofWindow')}`,
          leftPct: (total / scale * 100) + pct / 2,
        }
      } else {
        let acc = 0
        let rawTotal = 0
        for (const p of props.parts) rawTotal += p.raw ?? p.value
        for (let i = 0; i < visible.length; i++) {
          const p = visible[i]
          if (p.key === props.hoverKey) {
            const count = p.raw ?? p.value
            tip = {
              head: p.label ?? catLabel(p.key),
              figure: `≈${fmt(count)} · ${rawTotal > 0 ? Math.round(count / rawTotal * 100) : 0}% ${t('overview.ofUsed')}`,
              leftPct: acc + widths[i] / 2,
            }
            break
          }
          acc += widths[i]
        }
      }
    }

    const tipShift = useTipShift(wrapRef, tipRef, tip === null ? null : { unit: 'pct', value: tip.leftPct })
    const tipStyle = tip === null ? { left: '50%' } : { left: `${tip.leftPct}%`, ...tipShiftStyle(tipShift) }

    return (
      <div className="lc-stacked-wrap" ref={wrapRef}>
        <div
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(null)
          }}
        >
          {visible.map((p, i) => {
            const on = props.hoverKey !== undefined
              && (props.hoverKey === p.key || (p.group !== undefined && props.hoverKey === p.group))
            return (
              <div
                key={p.key}
                className={'lc-stacked-seg' + (animate ? ' animate-lc-stacked-in motion-reduce:animate-none' : '') + (on ? ' lc-stacked-seg-on' : '') + (pickKey !== undefined ? ' lc-stacked-seg-pick' : '')}
                style={{ width: `${widths[i]}%`, backgroundColor: p.color, ...(animate ? { '--lc-i': Math.min(i, STAGGER_CAP) } : {}) }}
                {...(pickKey !== undefined
                  ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': `${p.label ?? catLabel(p.key)} ${fmt(p.raw ?? p.value)}`,
                    onKeyDown: (ev: { key: string; preventDefault: () => void }) => {
                      if (ev.key !== 'Enter' && ev.key !== ' ') return
                      ev.preventDefault()
                      pickKey(p.key)
                    },
                  }
                  : {})}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                onClick={pickKey !== undefined ? () => { pickKey(p.key) } : undefined}
              />
            )
          })}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free animate-lc-stacked-in motion-reduce:animate-none' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              style={{ width: `${free / scale * 100}%`, '--lc-i': Math.min(visible.length, STAGGER_CAP + 1) } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {masks.map(m => (
            <div
              key={m.key}
              className={`lc-reserve lc-reserve-${m.key}`}
              style={{ left: `${m.left}%`, width: `${m.width}%` }}
              onMouseEnter={enterReserve(m.key)}
              onMouseLeave={leaveReserve}
            />
          ))}
          {triggerDetached ? (
            <div
              className="lc-trigger"
              style={{ left: `${triggerPct}%` }}
              onMouseEnter={enterReserve('trigger')}
              onMouseLeave={leaveReserve}
            />
          ) : null}
          <div
            className={'lc-occupied-box' + (showBox ? ' lc-occupied-box-on' : '')}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {props.tip !== false
          ? (
            <TipBubble
              tipRef={tipRef}
              className="lc-tip lc-bar-tip"
              onClass="lc-bar-tip-on"
              shown={tip !== null}
              style={tipStyle}
              head={tip?.head}
              figure={tip?.figure}
              note={tip?.note}
            />
          )
          : null}
      </div>
    )
  }
}

export interface LegendProps {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  delta?: boolean
}

export function makeLegend(kit: ViewKit): (props: LegendProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: LegendProps): ReactElement {
    let total = 0
    for (const p of props.parts) total += p.raw ?? p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
          const count = p.raw ?? p.value
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          const sign = props.delta === true && count !== 0 ? ' lc-chip-nums-' + (count > 0 ? 'up' : 'down') : ''
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={props.delta === true ? undefined : t('overview.ofUsed')}
              {...(props.onHoverKey !== undefined
                ? {
                  tabIndex: 0,
                  'aria-label': `${catLabel(p.key)} ${fmt(count)}`,
                  onFocus: () => { props.onHoverKey?.(p.key) },
                  onBlur: () => { props.onHoverKey?.(null) },
                }
                : {})}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              <span className="lc-chip-label">{catLabel(p.key)}</span>
              <span className={'lc-chip-nums' + sign}>
                {props.delta === true ? (count > 0 ? '+' : '') + fmt(count) : '≈' + fmt(count)}
                {props.delta !== true && total > 0 ? <em>{`${Math.round(count / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
