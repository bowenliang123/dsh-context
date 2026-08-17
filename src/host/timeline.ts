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
import type { ContextTimeline } from '../shared/types'
import { applyTimeline, buildTimelineView, createTimelineState } from './fold'
import type { TimelineState } from './fold'

/** Validate the wire payload before it leaves the host (strict: no drift). */
const surfaceNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'assistant', 'tool']),
  tokens: z.number().int().nonnegative(),
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

const contextTimelineSchema = z.object({
  ok: z.literal(true),
  model: z.string().optional(),
  provider: z.string().optional(),
  contextWindow: z.number().optional(),
  current: currentSchema,
  toolList: z.array(z.object({ name: z.string(), tokens: z.number().int().nonnegative() }).strict()),
  requests: z.array(requestRecordSchema),
  events: z.array(contextEventSchema),
  nodes: z.array(surfaceNodeSchema),
  droppedNodes: z.number().int().nonnegative(),
  archive: z.array(surfaceNodeSchema),
  surfaceFloor: z.number().int().nonnegative().optional(),
  archiveFloor: z.number().int().nonnegative().optional(),
}).strict() as unknown as z.ZodType<ContextTimeline>

/**
 * The context-timeline projection unit, created per plugin instance with its
 * config-resolved retention bounds (config.ts), and registered on
 * `ctx.sessionProjections`. Registry lifecycle notes (mirrored from the
 * harness contract): registration is an effect on the caller's fiber — an
 * unloaded Host half removes the key, and clients read it as capability
 * absence. `stateVersion` must be bumped whenever the persisted state shape
 * or fold semantics change (invalidation of cached rows); config-only
 * changes never require it (bounds tune retention, not state shape).
 */
export function createContextTimelineDefinition(config: Config): ProjectionDefinition<'contextTimeline', TimelineState> {
  const bounds = resolveBounds(config)
  return {
    key: 'contextTimeline',
    schema: contextTimelineSchema,
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: SessionEvent) => applyTimeline(state, event as Parameters<typeof applyTimeline>[1], bounds),
    view: (state: TimelineState) => buildTimelineView(state, bounds),
    // 2 since 0.11: the occupancy mirror (pressureTokens/sampledSurfaceTokens/
    // occupancyWindow) left the persisted state — the client now reads the
    // official token-meter `contextPressure` projection instead. Old cached
    // rows are discarded and refolded.
    // 3 since 0.12: the removed-node archive (`archived` + `archiveFloor`)
    // joined the persisted state for the Context browser's per-step
    // reconstruction — cached rows predate the shape and are refolded.
    stateVersion: 3,
  }
}
