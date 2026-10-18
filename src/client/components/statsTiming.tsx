/** The Timing card: where the session's ACTIVE time went. The donut splits
 * whole-step wall time into the model-call slices — TTFT (step start → first
 * token, the wait) and LLM generation (first token → assistant message) —
 * and the tool-execution slice, with the residue as overhead; a call whose
 * stream recorded no token delta (legacy or aborted) stays unattributed and
 * lands in the residue. When the host folded the generation split (see
 * TimingTotals), the generation slice expands into what was being decoded:
 * thinking, answer text, and tool-call arguments. The slice rows lead with
 * the true duration and qualify it with a tally on the secondary line — the
 * model calls (TTFT), the tool runs, and the decode slices' own BLOCK counts
 * (zero to many per call, so a call count would be a false tally there). A
 * slice that never happened (zero time) is omitted entirely — the ring already skips
 * its arc, and a zero row would otherwise borrow the session's call count and
 * read as "no time, many calls". The donut and the rows sit side by side so
 * the head row stays half-height. Parallel tool calls each count, so the tools
 * figure can overlap — the ring clamps it into the post-model window while the
 * row numbers stay true. Below them the session-time strip packs every
 * completed step's slices gapless in occurrence order (the DNA idiom applied
 * to time consumed — each band's width is its share of the cumulative active
 * time, idle time takes no track), joining the same hover link by KIND. */

import { useState, type ReactElement } from 'react'
import type { TimingSpan, TimingTotals } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import { makeTimingStrip, TIMING_COLOR } from './timingStrip'
import type { DonutProps, DonutSegment } from './donut'

/** One ring/legend entry before the shares are computed. */
interface Slice {
  key: string
  color: string
  label: string
  /** The TRUE duration (the row prints this; the ring clamps it into its window). */
  ms: number
  /** The secondary-line qualifier (a call/run/block tally), absent when there is none. */
  times?: string
}

/** The card's slice palette (timingStrip.tsx owns it — the strip paints the same kinds). */
const COLOR = TIMING_COLOR

/** The decode-throughput figure, formatted exactly as the harness's own
 * session-stats seat formats it: whole tokens from ten up, one decimal below. */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

export function makeStatsTiming(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  timing: TimingTotals | null
  /** The timing strip's painted spans (the detail channel's per-step time
   * slices). Absent on the overview's cross-session aggregate card and on
   * rows folded before the collection existed — the card then shows no strip. */
  spans?: TimingSpan[]
  locale?: string
}) => ReactElement {
  const { t, fmt, fmtDuration, fmtShare } = kit
  const TimingStrip = makeTimingStrip(kit)
  return function StatsTiming(props: { timing: TimingTotals | null; spans?: TimingSpan[]; locale?: string }): ReactElement {
    // The legend row ↔ donut segment hover link (shared key, set from either side).
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const timing = props.timing
    const wall = timing !== null && Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
    // The throughput figure: the host paired provider output tokens with
    // decode windows exactly as the harness session-stats fold does, so the
    // two figures can never disagree. An unreadable or absent pairing (an older cached row) renders no figure.
    const tps = timing !== null
      && typeof timing.speedMs === 'number' && Number.isFinite(timing.speedMs) && timing.speedMs > 0
      && typeof timing.speedTokens === 'number' && Number.isFinite(timing.speedTokens) && timing.speedTokens >= 0
      ? formatTokensPerSecond(timing.speedTokens / (timing.speedMs / 1_000))
      : null
    let segments: DonutSegment[] = []
    let rows: SliceRow[] = []
    if (timing !== null && (wall > 0 || timing.calls > 0 || timing.toolCalls > 0)) {
      // The MODEL slices run from the step's start to its assistant message —
      // TTFT to the first token, generation from there; tools run after.
      const callTimes = t('timing.callTimes', { n: fmt(timing.calls) })
      const modelSlices: Slice[] = [
        { key: 'ttft', color: COLOR.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: callTimes },
      ]
      // The generation window either expands into its decode buckets or stays
      // one slice. The split is shown only when the buckets actually carry
      // time: a host that folded no split (an older cached row) serves `genMs`
      // alone, and a log whose stream carried token deltas but no block markers
      // (all-zero buckets) keeps the un-split shape instead of three dead rows.
      // An absent bucket reads as 0 (the host omits a zero span).
      // These slices qualify with their own BLOCK tally, never the call
      // count: one model call emits zero to many decode blocks (a single call
      // routinely requests several tools, and most calls emit no reasoning at
      // all), so the call count would read as a per-slice tally that is simply
      // untrue. TTFT and tools keep theirs — those happen exactly once per
      // call/run. A host that folded no counts (an older cached row) serves the duration alone.
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
      // Ring windows: TTFT, then the generation window, then tools with what
      // is left; the residue is overhead. Every window is clamped into the
      // space its predecessors leave, so a hostile over-long slice (parallel
      // tool overlap) can never push the ring past the wall — the ROWS keep
      // the true sums. The decode buckets share the generation window in card
      // order; the un-split shape gives that window to `gen` alone.
      const ttftRing = Math.min(timing.ttftMs, wall)
      const genRing = Math.max(0, Math.min(timing.genMs, wall - ttftRing))
      const modelRings: number[] = [ttftRing]
      let used = ttftRing
      const genEnd = ttftRing + genRing
      for (const slice of modelSlices.slice(1)) {
        const take = Math.max(0, Math.min(slice.ms, genEnd - used))
        modelRings.push(take)
        used += take
      }
      const toolRing = Math.max(0, Math.min(timing.toolsMs, wall - ttftRing - genRing))
      const other = Math.max(0, wall - ttftRing - genRing - toolRing)
      // Segment shares over the wall total; every value is already clamped
      // into [0, wall], so the ratio needs no further bounding.
      const share = (ms: number): number => (wall > 0 ? ms / wall : 0)
      // The secondary line leads with the duration and qualifies it with the
      // call count; a zero-duration slice keeps just the count (its dash has nothing to qualify).
      const countOf = (ms: number, times?: string): string => {
        const dur = fmtDuration(ms)
        if (times === undefined) return dur
        return ms > 0 ? `${dur} · ${times}` : times
      }
      const modelSegments = modelSlices.map((slice, index) => ({
        key: slice.key, color: slice.color, value: share(modelRings[index]),
      }))
      const toolSlice: Slice = {
        key: 'tools',
        color: COLOR.tools,
        label: t('timing.tools'),
        ms: timing.toolsMs,
        times: t('timing.toolTimes', { n: fmt(timing.toolCalls) }),
      }
      const otherSlice: Slice = { key: 'other', color: COLOR.other, label: t('timing.other'), ms: other }
      segments = [
        ...modelSegments,
        { key: 'tools', color: COLOR.tools, value: share(toolRing) },
        { key: 'other', color: COLOR.other, value: share(other) },
      ]
      const toRow = (slice: Slice): SliceRow => ({
        key: slice.key,
        color: slice.color,
        label: slice.label,
        dim: slice.ms === 0,
        pct: fmtShare(slice.ms, wall),
        count: countOf(slice.ms, slice.times),
      })
      // A slice that never happened is HIDDEN rather than shown as a zero row:
      // a "0.0%" row still carrying a count ("— · 323 calls") reads as "this
      // ran 323 times in no time" when in truth nothing ever ran or decoded
      // there. The ring already skips zero arcs, so the legend now matches it.
      // Every slice is a share of the wall total, so dropping rows never distorts the remaining percentages.
      rows = [
        ...modelSlices.map(toRow),
        toRow(toolSlice),
        toRow(otherSlice),
      ].filter(row => !row.dim)
    }
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('timing.title')}</span>
          {tps !== null && (
            <span className="lc-card-rate" title={t('timing.tpsTip')}>{t('timing.tps', { tps })}</span>
          )}
        </div>
        {rows.length === 0
          ? <div className="lc-empty">{t('timing.empty')}</div>
          : (
            <>
              <div
                className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap"
              >
                {/* donut + legend row: the gap folds at a 320px card, below 240px the row wraps
                    and the ring centers over the full-width legend (keyed to the lc-card container). */}
                <Donut
                  segments={segments}
                  size={96}
                  centerTop={wall > 0 ? fmtDuration(wall) : '—'}
                  centerSub={t('timing.total')}
                  hoverKey={hoverKey}
                  onHoverKey={setHoverKey}
                />
                <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
              </div>
              {/* The session-time strip joins the hover link: a span hover lights
                  every span of its KIND plus the donut arc and the legend row,
                  and a legend/donut hover lights the strip's matching spans. */}
              {props.spans !== undefined && props.spans.length > 0
                ? <TimingStrip spans={props.spans} hoverKey={hoverKey} onHoverKey={setHoverKey} locale={props.locale} />
                : null}
            </>
          )}
      </div>
    )
  }
}
