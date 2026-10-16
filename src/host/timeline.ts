/**
 * The `contextTimeline` session projection unit — the plugin's data plane.
 *
 * This is the whole Host half after the v0.9 data-path migration: instead of
 * serving snapshots over a custom `/dsh-context` RPC channel, the plugin
 * registers one pure projection unit on the harness's
 * `ctx.sessionProjections` registry. The framework then:
 *   - drives the fold per committed `session/event` (eager, incremental),
 *   - persists the unit state through `ctx.sessionProjectionCache`
 *     (checkpointed rows, cold-read ladder, resume-safe),
 *   - delivers finished values to the browser as a `session/projection` push
 *     frame plus a tail-page baseline, where the Client reads them through
 *     the framework-standard `useProjection('contextTimeline')` seat.
 *
 * The unit is pure mathematics (init/apply/view) — it holds no subscriptions
 * and never touches the client. The wire value is the same Snapshot the UI
 * has always rendered (shared/types.ts), so the Client renders unchanged.
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config'
import { resolveBounds } from './config'
import type { ProjectionDefinition } from './compat'
import type { ContextTimeline } from '../shared/types'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import type { TimelineState } from './foldState'
import { buildTimelineHead, buildTimelineView } from './foldWire'

/** Validate the wire payload before it leaves the host (strict: no drift). */
const surfaceNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'skill', 'assistant', 'tool']),
  tokens: z.number().int().nonnegative(),
  imgs: z.number().int().nonnegative().optional(),
  gone: z.number().int().nonnegative().optional(),
  seat: z.number().int().nonnegative().optional(),
  form: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  err: z.boolean().optional(),
  skill: z.string().optional(),
  calls: z.array(z.string()).optional(),
}).strict()

/** One live system-prompt node (shared/types.ts SystemPromptNode). */
const systemPromptNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number(),
  tokens: z.number().int().nonnegative(),
}).strict()

const requestRecordSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  time: z.number(),
  seq: z.number(),
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
  /** Skill-machinery tokens (issue #66). The fold writes it on every record;
   * optional so rows folded before the category existed still parse. */
  skill: z.number().int().nonnegative().optional(),
  cacheRead: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  /** The request's step active milliseconds (see RequestRecord.activeMs).
   * Optional so a record whose step never closed (the live tail) still parses. */
  activeMs: z.number().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
}).strict()

const contextEventSchema = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.enum(['compaction', 'prune', 'inject', 'model', 'mode']),
  form: z.string().optional(),
  tokens: z.number().optional(),
  count: z.number().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromTurn: z.number().optional(),
  fromStep: z.number().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
}).strict()

/** The fold-derived file-operation record (shared/types.ts FileOpRecord). */
const fileOpSchema = z.object({
  seq: z.number().int().nonnegative(),
  path: z.string(),
  kind: z.enum(['read', 'write', 'search']),
  tool: z.string(),
  time: z.number().optional(),
  err: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  detail: z.string().optional(),
  hits: z.number().int().positive().optional(),
  read: z.union([
    z.object({ start: z.number().int().positive(), count: z.number().int().nonnegative() }).strict(),
    z.object({ count: z.number().int().positive(), est: z.literal(true) }).strict(),
  ]).optional(),
  parent: z.number().int().nonnegative().optional(),
  program: z.string().optional(),
  pattern: z.literal(true).optional(),
  gone: z.number().int().nonnegative().optional(),
}).strict()

/** One painted span of the timing strip (shared/types.ts TimingSpan). */
const timingSpanSchema = z.object({
  kind: z.enum(['ttft', 'reasoning', 'text', 'toolarg', 'tools', 'other']),
  start: z.number(),
  end: z.number(),
}).strict()

const currentSchema = z.object({
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  skill: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

const costBucketsSchema = z.object({
  uncached: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
}).strict()

const costModelSchema = z.object({
  peak: costBucketsSchema.optional(),
  off: costBucketsSchema.optional(),
}).strict()

const costModelsSchema = z.record(z.string(), costModelSchema)

/** The session-cost wire shape — shared by every projection that serves one (activity.ts imports it). */
export const costUsageSchema = z.record(z.string(), costModelsSchema)

const toolTimingSchema = z.object({
  calls: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
}).strict()

const timingTotalsSchema = z.object({
  wallMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  genMs: z.number().nonnegative(),
  // Additive-optional: rows cached before the generation split, the block counts, or the throughput seat existed must keep parsing.
  reasoningMs: z.number().nonnegative().optional(),
  reasoningBlocks: z.number().int().nonnegative().optional(),
  textMs: z.number().nonnegative().optional(),
  textBlocks: z.number().int().nonnegative().optional(),
  toolArgMs: z.number().nonnegative().optional(),
  toolArgBlocks: z.number().int().nonnegative().optional(),
  speedTokens: z.number().nonnegative().optional(),
  speedMs: z.number().nonnegative().optional(),
  calls: z.number().int().nonnegative(),
  toolsMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tools: z.record(z.string(), toolTimingSchema),
}).strict()

/** The baseline-gate record the fallback unit serves (see fallback.ts). */
const unsupportedSchema = z.object({
  current: z.string(),
  minimum: z.string(),
}).strict()

/** The stats board's precomputed count figures (the split head — see Snapshot.counts). */
const countsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  injects: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
  prunes: z.number().int().nonnegative(),
  // Additive-optional like every head field derived at view time: a cached row restores with its full event set.
  skills: z.number().int().nonnegative().optional(),
}).strict()

/** The newest retained request's billing summary (the split head's headline anchor). */
const lastSchema = z.object({
  seq: z.number(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
}).strict()

/** One wire contract for both generations: the SPLIT head (envelope scalars +
 * counts/last/detailRev; the heavy collections stay absent — they ride the
 * on-demand detail channel, host/detail.ts) and the INLINE value
 * (channel-less hosts and the fallback unit carry the collections in place).
 * The collections are therefore optional on the schema; the split marker is `detailRev` (present ⟺ split). */
export const contextTimelineSchema = z.object({
  ok: z.literal(true),
  unsupported: unsupportedSchema.optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().positive().optional(),
  current: currentSchema,
  images: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  // Additive-optional like humanInputs: rows folded before the field existed read without it, and clients degrade to zero.
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  counts: countsSchema.optional(),
  last: lastSchema.optional(),
  detailRev: z.number().int().nonnegative().optional(),
  requests: z.array(requestRecordSchema).optional(),
  events: z.array(contextEventSchema).optional(),
  cost: costUsageSchema.optional(),
  timing: timingTotalsSchema.optional(),
  systems: z.array(systemPromptNodeSchema).optional(),
  nodes: z.array(surfaceNodeSchema).optional(),
  droppedNodes: z.number().int().nonnegative().optional(),
  archive: z.array(surfaceNodeSchema).optional(),
  surfaceFloor: z.number().int().nonnegative().optional(),
  archiveFloor: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema).optional(),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  spans: z.array(timingSpanSchema).optional(),
}).strict() as unknown as z.ZodType<ContextTimeline>

/** The persisted fold-state schema (the registry's `stateSchema`
 * contract). Validates the plain-JSON `TimelineState` before a checkpoint
 * row seeds a fold — the same shape guarantee the projection cache's plain-JSON precondition already enforces at write time. */
const timelineStateSchema = z.object({
  surface: z.array(surfaceNodeSchema),
  sums: z.object({
    user: z.number().int().nonnegative(),
    inject: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    tool: z.number().int().nonnegative(),
  }).strict(),
  systemTokens: z.number().int().nonnegative(),
  systems: z.array(systemPromptNodeSchema).optional(),
  toolsTokens: z.number().int().nonnegative(),
  model: z.string().optional(),
  provider: z.string().optional(),
  lastModel: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().positive().optional(),
  requests: z.array(requestRecordSchema),
  turnRuns: z.number().int().nonnegative().optional(),
  events: z.array(contextEventSchema),
  archived: z.array(surfaceNodeSchema),
  cost: costUsageSchema.optional(),
  archiveFloor: z.number().optional(),
  timing: timingTotalsSchema.optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  stepStart: z.object({
    time: z.number(),
    firstToken: z.number().optional(),
  }).strict().optional(),
  stepWaits: z.array(z.object({ start: z.number(), end: z.number() }).strict()).optional(),
  stepApprovals: z.record(z.string(), z.number()).optional(),
  stepRequestSeq: z.number().optional(),
  callNames: z.record(z.string(), z.object({ name: z.string(), start: z.number(), argsRaw: z.string().optional() }).strict()),
  pendingShadowedSeqs: z.array(z.number()).optional(),
  pendingShadowEventSeq: z.number().optional(),
  detailRev: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  spans: z.array(timingSpanSchema),
  stepSpans: z.array(timingSpanSchema).optional(),
  pendingCodeOps: z.record(z.string(), z.array(fileOpSchema)).optional(),
}) as unknown as z.ZodType<TimelineState>

/**
 * The `contextTimeline` projection unit, created per plugin instance with its config-resolved retention bounds.
 *
 * The registry serves the value only when the unit carries a `wire` block; a unit without one is host-only and the
 * Context tab would wait on its loading screen forever.
 *
 * `slim` picks the wire generation PER SERVE, as a liveness probe rather than a fixed flag: while the on-demand
 * detail channel is live the value is the slim head, and before it arms (or on a deployment whose connection
 * services never compose) the inline value keeps the tab working end to end. Both generations validate against the
 * same schema and fold the same state, so the split is view-only.
 */
export function createContextTimelineDefinition(config: Config, slim: () => boolean): ProjectionDefinition<'contextTimeline', TimelineState> {
  const bounds = resolveBounds(config)
  const view = (state: TimelineState): ContextTimeline =>
    slim() ? buildTimelineHead(state) : buildTimelineView(state, bounds)
  const definition: ProjectionDefinition<'contextTimeline', TimelineState> = {
    key: 'contextTimeline',
    stateSchema: timelineStateSchema,
    wire: { viewSchema: contextTimelineSchema, view },
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: SessionEvent) => applyTimeline(state, event as Parameters<typeof applyTimeline>[1], bounds),
    // Bump on any change to the persisted state shape or the fold's semantics, which invalidates cached rows and
    // makes them refold from the durable log. A field the log can still backfill, or one the view derives at serve
    // time, must NOT bump: invalidating every in-generation row orphans the key for idle sessions, which have no
    // refresh channel until they go live again.
    stateVersion: 29,
  }
  return definition
}
