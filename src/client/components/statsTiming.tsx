/**
 * The Timing card: where the session's ACTIVE time went. The donut splits
 * whole-step wall time into the model-call slices — TTFT (step start → first
 * token, the wait) and LLM generation (first token → assistant message) —
 * and the tool-execution slice, with the residue as overhead; a call whose
 * stream recorded no token delta (legacy or aborted) stays unattributed and
 * lands in the residue. The slice rows lead with the true duration and
 * qualify it with the call count on the secondary line. The donut and the
 * rows sit side by side so the head row stays half-height. Parallel tool
 * calls each count, so the tools figure can overlap — the ring clamps it
 * into the post-model window while the row numbers stay true.
 */

import type * as ReactNS from 'react'
import type { TimingTotals } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

import { makeSliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps, DonutSegment } from './donut'

export function makeStatsTiming(kit: ViewKit, Donut: (props: DonutProps) => ReactNS.ReactElement): (props: {
  timing: TimingTotals | null
  locale: string
}) => ReactNS.ReactElement {
  const { t, fmt, fmtDuration, fmtShare } = kit
  const SliceList = makeSliceList(kit)
  return function StatsTiming(props: { timing: TimingTotals | null; locale: string }): ReactNS.ReactElement {
    const lang: 'zh' | 'en' = props.locale === 'zh' ? 'zh' : 'en'
    // The legend row ↔ donut segment hover link (shared key, set from either side).
    const [hoverKey, setHoverKey] = React.useState<string | null>(null)
    const timing = props.timing
    const wall = timing !== null && Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
    let segments: DonutSegment[] = []
    let rows: SliceRow[] = []
    if (timing !== null && (wall > 0 || timing.calls > 0 || timing.toolCalls > 0)) {
      // The model slices run from the step's start to its assistant message —
      // TTFT to the first token, generation from there; tools run after. The
      // ring clamps each (possibly parallel-overlapping) later slice into the
      // window its predecessors leave — the rows keep the real sums.
      const ttft = Math.min(timing.ttftMs, wall)
      const gen = Math.max(0, Math.min(timing.genMs, wall - ttft))
      const toolRing = Math.max(0, Math.min(timing.toolsMs, wall - ttft - gen))
      const other = Math.max(0, wall - ttft - gen - toolRing)
      // Segment shares over the wall total; every value is already clamped
      // into [0, wall], so the ratio needs no further bounding.
      const share = (ms: number): number => (wall > 0 ? ms / wall : 0)
      // The secondary line leads with the duration and qualifies it with the
      // call count; a zero-duration slice keeps just the count (its dash has
      // nothing to qualify).
      const countOf = (ms: number, times?: string): string => {
        const dur = fmtDuration(ms, lang)
        if (times === undefined) return dur
        return ms > 0 ? `${dur} · ${times}` : times
      }
      const callTimes = t('timing.callTimes', { n: fmt(timing.calls) })
      segments = [
        { key: 'ttft', color: '#3b82f6', value: share(ttft) },
        { key: 'gen', color: '#8b5cf6', value: share(gen) },
        { key: 'tools', color: '#14b8a6', value: share(toolRing) },
        { key: 'other', color: '#94a3b8', value: share(other) },
      ]
      rows = [
        {
          key: 'ttft', color: '#3b82f6', label: t('timing.ttft'), dim: timing.ttftMs === 0,
          pct: fmtShare(timing.ttftMs, wall),
          count: countOf(timing.ttftMs, callTimes),
        },
        {
          key: 'gen', color: '#8b5cf6', label: t('timing.gen'), dim: timing.genMs === 0,
          pct: fmtShare(timing.genMs, wall),
          count: countOf(timing.genMs, callTimes),
        },
        {
          key: 'tools', color: '#14b8a6', label: t('timing.tools'), dim: timing.toolsMs === 0,
          pct: fmtShare(timing.toolsMs, wall),
          count: countOf(timing.toolsMs, t('timing.toolTimes', { n: fmt(timing.toolCalls) })),
        },
        {
          key: 'other', color: '#94a3b8', label: t('timing.other'), dim: other === 0,
          pct: fmtShare(other, wall), count: countOf(other),
        },
      ]
    }
    return (
      <div className="lc-card lc-col-stats lc-col-donut">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('timing.title')}</span>
          <span className="lc-card-sub">{t('timing.hint')}</span>
        </div>
        {rows.length === 0
          ? <div className="lc-empty">{t('timing.empty')}</div>
          : (
            <div className="lc-donut-row">
              <Donut
                segments={segments}
                size={96}
                centerTop={wall > 0 ? fmtDuration(wall, lang) : '—'}
                centerSub={t('timing.total')}
                hoverKey={hoverKey}
                onHoverKey={setHoverKey}
              />
              <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
            </div>
          )}
      </div>
    )
  }
}
