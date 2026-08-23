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
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config'
import { resolveBounds } from './config'
import type { CompatProjectionDefinition } from './compat'
import type { ContextTimeline } from '../shared/types'
import { applyTimeline, buildTimelineView, createTimelineState } from './fold'
import type { TimelineState } from './fold'

/** Validate the wire payload before it leaves the host (strict: no drift). */
const surfaceNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'assistant', 'tool']),
  tokens: z.number().int().nonnegative(),
  imgs: z.number().int().nonnegative().optional(),
  gone: z.number().int().nonnegative().optional(),
  form: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  err: z.boolean().optional(),
  skill: z.string().optional(),
  calls: z.array(z.string()).optional(),
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
  output: z.number().int().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
}).strict()

const contextEventSchema = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.enum(['compaction', 'prune', 'inject', 'model']),
  form: z.string().optional(),
  tokens: z.number().optional(),
  count: z.number().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromTurn: z.number().optional(),
  fromStep: z.number().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
}).strict()

const currentSchema = z.object({
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
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

const costFamilySchema = z.object({
  peak: costBucketsSchema.optional(),
  off: costBucketsSchema.optional(),
}).strict()

const contextTimelineSchema = z.object({
  ok: z.literal(true),
  model: z.string().optional(),
  provider: z.string().optional(),
  contextWindow: z.number().optional(),
  current: currentSchema,
  toolList: z.array(z.object({ name: z.string(), tokens: z.number().int().nonnegative() }).strict()),
  images: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  requests: z.array(requestRecordSchema),
  events: z.array(contextEventSchema),
  cost: z.object({ flash: costFamilySchema.optional(), pro: costFamilySchema.optional() }).strict().optional(),
  nodes: z.array(surfaceNodeSchema),
  droppedNodes: z.number().int().nonnegative(),
  archive: z.array(surfaceNodeSchema),
  surfaceFloor: z.number().int().nonnegative().optional(),
  archiveFloor: z.number().int().nonnegative().optional(),
}).strict() as unknown as z.ZodType<ContextTimeline>

/**
 * The persisted fold-state schema (the dsh 0.1.1-rc.1+ `stateSchema`
 * contract). Validates the plain-JSON `TimelineState` before a checkpoint
 * row seeds a fold — the same shape guarantee the projection cache's
 * plain-JSON precondition already enforces at write time.
 */
const timelineStateSchema = z.object({
  surface: z.array(surfaceNodeSchema),
  sums: z.object({
    user: z.number().int().nonnegative(),
    inject: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    tool: z.number().int().nonnegative(),
  }).strict(),
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  toolList: z.array(z.object({ name: z.string(), tokens: z.number().int().nonnegative() }).strict()),
  model: z.string().optional(),
  provider: z.string().optional(),
  lastModel: z.string().optional(),
  contextWindow: z.number().optional(),
  requests: z.array(requestRecordSchema),
  events: z.array(contextEventSchema),
  archived: z.array(surfaceNodeSchema),
  cost: z.object({ flash: costFamilySchema.optional(), pro: costFamilySchema.optional() }).strict().optional(),
  archiveFloor: z.number().optional(),
  callNames: z.record(z.string(), z.string()),
  pendingShadowedSeqs: z.array(z.number()).optional(),
}) as unknown as z.ZodType<TimelineState>

/**
 * The context-timeline projection unit, created per plugin instance with its
 * config-resolved retention bounds (config.ts), and registered on
 * `ctx.sessionProjections`. Registry lifecycle notes (mirrored from the
 * harness contract): registration is an effect on the caller's fiber — an
 * unloaded Host half removes the key, and clients read it as capability
 * absence. `stateVersion` must be bumped whenever the persisted state shape
 * or fold semantics change (invalidation of cached rows); config-only
 * changes never require it (bounds tune retention, not state shape).
 *
 * The definition carries BOTH session-projection contracts (see compat.ts):
 * `schema`/`view` for dsh <= 0.1.0-rc.8, `stateSchema`/`wire` for
 * dsh >= 0.1.1-rc.1 — each registry reads its own fields off the same unit.
 * Without the `wire` block the 0.1.1-rc.1+ registry treats the unit as
 * host-only and never delivers `contextTimeline` to the browser (the Context
 * tab would stay on its loading screen forever).
 */
export function createContextTimelineDefinition(config: Config): ProjectionDefinition<'contextTimeline', TimelineState> {
  const bounds = resolveBounds(config)
  const view = (state: TimelineState): ContextTimeline => buildTimelineView(state, bounds)
  const definition: CompatProjectionDefinition<'contextTimeline', TimelineState> = {
    key: 'contextTimeline',
    // dsh <= 0.1.0-rc.8 contract: one schema validates the wire payload, `view` is top-level.
    schema: contextTimelineSchema,
    view,
    // dsh >= 0.1.1-rc.1 contract: `stateSchema` validates persisted state, the client view lives in `wire`.
    stateSchema: timelineStateSchema,
    wire: { viewSchema: contextTimelineSchema, view },
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: SessionEvent) => applyTimeline(state, event as Parameters<typeof applyTimeline>[1], bounds),
    // 2 since 0.11: the occupancy mirror (pressureTokens/sampledSurfaceTokens/
    // occupancyWindow) left the persisted state — the client now reads the
    // official token-meter `contextPressure` projection instead. Old cached
    // rows are discarded and refolded.
    // 3 since 0.12: the removed-node archive (`archived` + `archiveFloor`)
    // joined the persisted state for the Context browser's per-step
    // reconstruction — cached rows predate the shape and are refolded.
    // 4 since 0.18: the persisted state no longer carries `undefined`-valued
    // properties (model/provider/lastModel/contextWindow are absent until
    // known; pendingShadowedSeqs is deleted when consumed). The previous
    // shape violated the plain-JSON persisted-state precondition and failed
    // EVERY session-projection-cache write (TypeError: projection checkpoint
    // is not losslessly JSON-serializable) — which also starved the `title`
    // projection row and broke the session list after a restart. The bump
    // discards old cached rows and refolds them clean.
    // 5: the session-cost totals (`cost` — per-family/per-period billed
    // tokens) joined the persisted state; cached rows predate the shape and
    // are refolded.
    // 6: image blocks price through the official DeepSeek docs calculator
    // (real vision billing by pixel dimensions) instead of the token-meter's
    // generic JSON branch — cached rows carry the old underpriced image
    // nodes and are refolded.
    // 7: the whole-session image-block count (`images`) joined the persisted
    // state; cached rows predate the shape and are refolded.
    // 8: the image count moved OFF the persisted counter onto per-node `imgs`
    // (the stats cell now sums the LIVE surface — current context only, like
    // the tool-call cell); cached rows predate the shape and are refolded.
    stateVersion: 8,
  }
  return definition
}
