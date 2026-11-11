import { useState, type ReactElement } from 'react'
import type { TimingSpan, TimingTotals } from '../../shared/types'
import type { ViewKit } from '../viewkit'
import { activeMsOf } from '../services'
import { IconClock } from '../primitives'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import { makeTimingStrip, TIMING_COLOR } from './timingStrip'
import type { DonutProps, DonutSegment } from './donut'

interface Slice {
  key: string
  color: string
  label: string
  ms: number
  times?: string
}

interface TimingSlice {
  slice: Slice
  ring: number
  tip?: string
}

const COLOR = TIMING_COLOR

const ZERO_TIMING: TimingTotals = {
  wallMs: 0,
  ttftMs: 0,
  genMs: 0,
  calls: 0,
  toolsMs: 0,
  toolCalls: 0,
  tools: {},
}

function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

export interface StatsTimingProps {
  timing: TimingTotals | null
  spans?: TimingSpan[]
  locale?: string
  reserve?: boolean
  note?: string
}

export function makeStatsTiming(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: StatsTimingProps) => ReactElement {
  const { t, fmt, fmtDuration, fmtShare } = kit
  const TimingStrip = makeTimingStrip(kit)
  return function StatsTiming(props: StatsTimingProps): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const hasTiming = props.timing !== null
    const timing = props.timing ?? ZERO_TIMING
    const wall = Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
    const active = activeMsOf(timing)
    const tps = typeof timing.speedMs === 'number' && Number.isFinite(timing.speedMs) && timing.speedMs > 0
      && typeof timing.speedTokens === 'number' && Number.isFinite(timing.speedTokens) && timing.speedTokens >= 0
      ? formatTokensPerSecond(timing.speedTokens / (timing.speedMs / 1_000))
      : null
    let segments: DonutSegment[] = []
    let rows: SliceRow[] = []
    const callTimes = t('timing.callTimes', { n: fmt(timing.calls) })
    const modelSlices: Slice[] = [
      { key: 'ttft', color: COLOR.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: callTimes },
    ]
    const blockTimes = (blocks?: number): string | undefined =>
      blocks !== undefined && blocks > 0 ? t('timing.blockTimes', { n: fmt(blocks) }) : undefined
    const buckets: [key: string, color: string, label: string, ms: number, times?: string][] = [
      ['reasoning', COLOR.reasoning, t('timing.reasoning'), timing.reasoningMs ?? 0, blockTimes(timing.reasoningBlocks)],
      ['text', COLOR.text, t('timing.text'), timing.textMs ?? 0, blockTimes(timing.textBlocks)],
      ['toolarg', COLOR.toolarg, t('timing.toolArgs'), timing.toolArgMs ?? 0, blockTimes(timing.toolArgBlocks)],
    ]
    const split = buckets.some(([, , , ms]) => ms > 0)
    if (split) {
      for (const [key, color, label, ms, times] of buckets) {
        modelSlices.push({ key, color, label, ms, ...(times !== undefined ? { times } : {}) })
      }
    } else {
      modelSlices.push({ key: 'gen', color: COLOR.reasoning, label: t('timing.gen'), ms: timing.genMs })
    }
    const ttftRing = Math.min(timing.ttftMs, active)
    const genRing = Math.max(0, Math.min(timing.genMs, active - ttftRing))
    const modelRings: number[] = [ttftRing]
    let used = ttftRing
    const genEnd = ttftRing + genRing
    for (const slice of modelSlices.slice(1)) {
      const take = Math.max(0, Math.min(slice.ms, genEnd - used))
      modelRings.push(take)
      used += take
    }
    const toolMs = timing.toolBusyMs ?? timing.toolsMs
    const toolRing = Math.max(0, Math.min(toolMs, active - ttftRing - genRing))
    const other = Math.max(0, active - used - toolRing)
    const share = (ms: number): number => (active > 0 ? ms / active : 0)
    const countOf = (ms: number, times?: string): string => {
      const dur = fmtDuration(ms)
      if (times === undefined) return dur
      return ms > 0 ? `${dur} · ${times}` : times
    }
    const toolDisplayMs = wall > 0 ? toolRing : toolMs
    const toolSlice: Slice = {
      key: 'tools',
      color: COLOR.tools,
      label: t('timing.tools'),
      ms: toolDisplayMs,
      times: t('timing.toolTimes', { n: fmt(timing.toolCalls) }),
    }
    const toolTip = timing.toolsMs > toolDisplayMs
      ? t('timing.toolsBusyTip', { total: fmtDuration(timing.toolsMs) })
      : undefined
    const otherSlice: Slice = { key: 'other', color: COLOR.other, label: t('timing.other'), ms: other }
    const slices: TimingSlice[] = [
      ...modelSlices.map((slice, index) => ({ slice, ring: modelRings[index] })),
      { slice: toolSlice, ring: toolRing, ...(toolTip !== undefined ? { tip: toolTip } : {}) },
      { slice: otherSlice, ring: other },
    ]
    segments = slices.map(({ slice, ring }) => ({ key: slice.key, color: slice.color, value: share(ring) }))
    rows = slices.map(({ slice, ring, tip }) => ({
      key: slice.key,
      color: slice.color,
      label: slice.label,
      dim: slice.ms === 0,
      pct: fmtShare(ring, active),
      count: hasTiming ? countOf(slice.ms, slice.times) : '—',
      ...(tip !== undefined ? { tip } : {}),
    }))
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconClock size={14} />
            {t('timing.title')}
          </span>
          {props.note !== undefined && <span className="lc-card-sub">{props.note}</span>}
          {tps !== null && (
            <span className="lc-card-rate" title={t('timing.tpsTip')}>{t('timing.tps', { tps })}</span>
          )}
        </div>
        <div
          className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap"
        >
          <Donut
            segments={segments}
            size={96}
            centerTop={wall > 0 ? fmtDuration(active) : '—'}
            centerSub={t('timing.total')}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
          <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
        </div>
        {props.spans !== undefined && props.spans.length > 0
          ? <TimingStrip spans={props.spans} hoverKey={hoverKey} onHoverKey={setHoverKey} locale={props.locale} />
          : props.reserve === true
            ? (
              <div className="lc-tstrip" aria-hidden="true">
                <div className="lc-tstrip-wrap"><div className="lc-tstrip-bar" /></div>
                <div className="lc-tstrip-axis" />
              </div>
            )
            : null}
      </div>
    )
  }
}
