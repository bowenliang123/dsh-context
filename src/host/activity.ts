/**
 * The `contextActivity` session projection unit — the per-day activity
 * ledger behind the Context Dashboard's heatmap and its last-7-days usage
 * chart.
 *
 * The timeline unit (fold.ts) is a "current snapshot" fold: it prices the
 * context as it stands NOW, which cannot draw a per-day chart. This unit
 * folds the same committed event stream into a ledger keyed by local
 * calendar day (shared/days.ts): successful assistant messages add completed
 * requests, while messages and failed attempts book provider usage. Samples
 * for the same attempt replace their predecessor until a retry boundary.
 * The day's billed-token figure grows by the disjoint buckets
 * (uncached input + cache read + cache write + output — the same semantics
 * the timeline's request records and the official token meter use). Each
 * metered settlement also books its buckets into the day's per-(provider,
 * model, period) pricing record — the same raw material the timeline's
 * session-cost totals carry (SessionCostUsage), so the client prices every
 * day off the SAME model-price book and estimator it prices the KPI band
 * with. Buckets attribute to the day the open STEP STARTED (the turn's
 * initiation, armed by `step/start` and cleared by `step/end` — the
 * timeline fold's own pending-slot protocol), falling back to the
 * settlement instant when no stamp is armed. The peak/off split uses the
 * settlement instant, matching the timeline's session-cost totals.
 *
 * One wire contract, one small state: a day entry is two integers plus the
 * optional pricing record, the route in force rides the state (last
 * `request/header` wins), and the retention cap keeps at most
 * {@link MAX_KEPT_DAYS} keys, so the value riding every session-list row
 * stays trivial next to the timeline head. Same projection contract as the
 * sibling units: pure init/apply/view, unknown or malformed events return
 * the state unchanged, and no `undefined`-valued property ever materializes
 * (the plain-JSON persisted-state precondition).
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import { isPeakUtc, billedUsageOf, type BilledUsage } from './fold'
import { isDeepSeekProvider } from '../shared/providers'
import { dayKeyOf } from '../shared/days'
import type { ContextActivity, CostModelUsage, SessionCostUsage } from '../shared/types'
import { usageOfSettlement } from './logShapes'
import { billedSampleSchema, billingSample, negateUsage, sameAttempt, type BilledSample } from './usage'

/**
 * Retention cap on ledger days. A little over a year of daily-active
 * sessions; the oldest keys drop first (key order IS chronological order).
 */
const MAX_KEPT_DAYS = 400

/** The persisted fold state (the registry's `stateSchema` contract). */
export interface ActivityState {
  lastUsage?: BilledSample
  days: Record<string, { tokens: number; requests: number; cost?: SessionCostUsage }>
  /** The route in force (last `request/header`'s config wins) — prices each settlement. */
  model?: string
  provider?: string
  /** The open step's start instant (armed by `step/start`, cleared by `step/end`). */
  stepStart?: number
}

const costBucketSchema = z.object({
  uncached: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
}).strict()

const costModelSchema = z.object({
  peak: costBucketSchema.optional(),
  off: costBucketSchema.optional(),
}).strict()

const costUsageSchema = z.record(z.string(), z.record(z.string(), costModelSchema))

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: costUsageSchema.optional(),
}).strict()

/** Validate the wire payload before it leaves the host (strict: no drift). */
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

/** The persisted fold-state schema — validated before a checkpoint row seeds a fold. */
const activityStateSchema = z.object({
  lastUsage: billedSampleSchema.optional(),
  days: z.record(z.string(), activityDaySchema),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
}) as unknown as z.ZodType<ActivityState>

/**
 * Add one settlement's billed buckets to a day's pricing record — the same
 * clone-along-the-mutated-path walk the timeline fold's accumulateCost
 * prices by, so the two folds' records share one shape and one semantics.
 * The pricing period follows the settlement instant; the day remains the
 * initiation day, so the chart and session totals use the same rate.
 */
function pricedDayOf(
  prev: SessionCostUsage | undefined,
  provider: string,
  model: string,
  period: 'peak' | 'off',
  usage: BilledUsage,
): SessionCostUsage {
  const models = prev?.[provider] ?? {}
  const periods: CostModelUsage = models[model] ?? {}
  const b = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  return {
    ...prev,
    [provider]: {
      ...models,
      [model]: {
        ...periods,
        [period]: {
          uncached: b.uncached + usage.input,
          cacheRead: b.cacheRead + usage.cacheRead,
          cacheWrite: b.cacheWrite + usage.cacheWrite,
          output: b.output + usage.output,
        },
      },
    },
  }
}

/**
 * Fold one committed event into the ledger.
 * `request/header` tracks the route in force (the timeline fold's rule —
 * last header wins), `step/start`/`step/end` maintain the initiation stamp,
 * and assistant messages/attempts book usage. Retry-started closes the
 * current usage replacement slot. Everything else returns the state reference
 * unchanged, as does a settlement with no attributable instant. The next
 * state is a copy along the mutated path only — the persisted previous
 * state is never mutated in place.
 */
export function applyActivity(state: ActivityState, event: { type: string; time: number; data?: unknown }): ActivityState {
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } | null } | null } | undefined
    const config = data?.header?.config
    if (config === null || typeof config !== 'object') return state
    const model = typeof config.model === 'string' ? config.model : undefined
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    const nextModel = model !== undefined ? model : state.model
    const nextProvider = provider !== undefined ? provider : state.provider
    if (nextModel === state.model && nextProvider === state.provider) return state
    return {
      ...state,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    }
  }
  if (event.type === 'step/start') {
    if (!Number.isFinite(event.time)) return state
    return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
  }
  if (event.type === 'step/end') {
    if (state.stepStart === undefined) return state
    // DELETE the field — assigning `undefined` would break the plain-JSON
    // persisted-state precondition (see TimelineState.stepStart).
    const next = { ...state }
    delete next.stepStart
    return next
  }
  if (event.type === 'session/end-seed') {
    // The tagged fork/seed boundary (the cost-semantics decision in
    // fold.ts): settlements before it are the inherited parent-log prefix —
    // spend the session it forked from already booked — so the ledger
    // resets and a seeded session's days count post-seed activity only
    // (issue #94). The untagged resume marker returns the state unchanged.
    // `stepStart` dies with the cut: a slot armed by the inherited tail
    // must not attribute the child's first settlement to a parent-day.
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited !== true) return state
    return { days: {} }
  }
  const data = event.data as Record<string, unknown> | undefined
  if (event.type === 'llm/retry-started') {
    if (!sameAttempt(state.lastUsage, data)) return state
    const next = { ...state }
    delete next.lastUsage
    return next
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  // Attribute the settlement to the open step's initiation instant, falling
  // back to the settlement's own instant (the pending slot stays armed — the
  // timeline fold's protocol — so a second settlement of the same step still
  // reads it; `step/end` clears it).
  const initiated = state.stepStart !== undefined ? state.stepStart : event.time
  const key = dayKeyOf(initiated)
  if (key === null) return state
  const buckets = billedUsageOf(usageOfSettlement(event.type, data))
  if (event.type === 'assistant/attempt' && buckets === null) return state
  let ledger = state.days
  const previous = state.lastUsage
  if (buckets !== null && previous !== undefined && sameAttempt(previous, data) && previous.day !== undefined) {
    const previousDays: Record<string, ActivityState['days'][string] | undefined> = ledger
    const old = previousDays[previous.day]
    if (old !== undefined) {
      const minus = negateUsage(previous.buckets)
      const oldCost = previous.model !== undefined && old.cost !== undefined
        ? pricedDayOf(old.cost, previous.provider, previous.model, isDeepSeekProvider(previous.provider) && !isPeakUtc(previous.time) ? 'off' : 'peak', minus)
        : old.cost
      ledger = { ...ledger,
        [previous.day]: {
          ...old,
          tokens: Math.max(0, old.tokens + minus.input + minus.cacheRead + minus.cacheWrite + minus.output),
          ...(oldCost !== undefined ? { cost: oldCost } : {}),
        } }
    }
  }
  // A Record index read CAN miss at runtime (no noUncheckedIndexedAccess
  // here), so the value type is widened honestly before the read.
  const byKey: Record<string, { tokens: number; requests: number; cost?: SessionCostUsage } | undefined> = ledger
  const prev = byKey[key]
  // A settlement prices only when a model is in force (the accumulateCost
  // rule): a model-less or unmetered settlement still counts its tokens and
  // request, never a fabricated fee.
  let cost = prev?.cost
  if (buckets !== null && state.model !== undefined) {
    const provider = state.provider ?? ''
    const period = isDeepSeekProvider(provider) && !isPeakUtc(Number.isFinite(event.time) ? event.time : initiated) ? 'off' : 'peak'
    cost = pricedDayOf(cost, provider, state.model, period, buckets)
  }
  const entry = {
    tokens: (prev === undefined ? 0 : prev.tokens)
      + (buckets === null ? 0 : buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output),
    requests: (prev === undefined ? 0 : prev.requests) + (event.type === 'assistant/message' ? 1 : 0),
    ...(cost !== undefined ? { cost } : {}),
  }
  let days = { ...ledger, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    // Rebuild over the kept suffix (key order IS chronological) — a dynamic
    // `delete` per evicted key would deopt the record into dictionary mode.
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  const next = { ...state, days }
  if (buckets !== null) {
    const sample = billingSample(data, event.time, buckets, state.provider ?? '', state.model, key)
    if (sample !== undefined) next.lastUsage = sample
    else delete next.lastUsage
  }
  return next
}

/**
 * The daily-activity projection unit, registered alongside the timeline and
 * headers units (host/index.ts); the overview reads it through the session
 * list's projection column. `stateVersion` 4 rebuilds historical pricing
 * periods at settlement time, matching the timeline cost totals while
 * retaining initiation-day attribution and the seed-boundary reset. It also
 * rebuilds stream-only and failed-attempt usage under the Harness retry rule.
 */
export function createContextActivityDefinition(): ProjectionDefinition<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event),
    // The view copies the ledger (entries included) so the registry, the
    // cache writer, and the wire can never share — and mutate — the fold's
    // own record. The nested pricing records ride the entry copy by
    // reference: every mutation above clones along its path, so a shared
    // record can never diverge (the same immutability the timeline fold's
    // shared request/event records rely on).
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, { ...v }])),
      }),
    },
    stateVersion: 4,
  }
}
