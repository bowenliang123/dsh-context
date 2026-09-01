/**
 * The `contextHeaders` session projection unit — the request-header EPOCH
 * METADATA behind the timeline's envelope figures.
 *
 * The hot `contextTimeline` unit carries only token prices of the system
 * prompt and tool schemas; this companion unit keeps the per-epoch METADATA
 * (epoch seq/time boundaries, per-tool token prices and plugin attribution)
 * so the Context browser can pick the header epoch in force at any step and
 * size its sections immediately. The epoch CONTENT (full system prompt text,
 * full tool JSON schemas) deliberately does NOT ride the projection VALUE:
 * session projections are served whole in every `session.list` row, control
 * baseline, push frame, and change notification, so carrying content here
 * multiplied it by sessions × epochs across every channel. The client
 * fetches one epoch's `request/header` event on demand — a seq-anchored
 * history read off the epoch's `seq`, the same targeted read the browser
 * already uses for message content — and caches it per session (history is
 * immutable).
 *
 * Read-compat over the persisted state (the pinned decision behind keeping
 * `stateVersion` at 1): the harness serves a cold session's projections from
 * its CACHED checkpoint rows and has no refresh channel for an idle session
 * — a version bump invalidates every row and orphans the key until the
 * session goes live again (the #37 regression). The state therefore still
 * ACCEPTS the v1 content-bearing record shape, current folds append
 * metadata-only records alongside any seeded legacy ones, and the view
 * normalizes BOTH to the metadata-only wire shape (pricing the legacy system
 * text at read time). Cached v1 rows keep working, new checkpoint writes
 * shrink as legacy epochs age out of the capped list, and the wire — the
 * part every delivery channel carries — is metadata-only from day one.
 *
 * Same projection contract as the timeline unit: pure init/apply/view,
 * `Object.is` reference stability for uninteresting events, plain-JSON
 * bounded state (epoch list capped — see HEADERS_MAX).
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateSystem, estimateToolSchema } from './pricing'

/** Retention cap on header epochs (metadata only; changes are rare; 50 is generous). */
const HEADERS_MAX = 50

/**
 * One stored tool: the v1 row shape carried the producer description and the
 * raw schema; folds since the #37 slim-down append metadata-only entries.
 */
export interface StoredHeaderTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** One stored epoch: v1 rows carried `system`; folds since carry `systemTokens`. */
export interface StoredHeaderRecord {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredHeaderTool[]
}

export interface HeadersState {
  headers: StoredHeaderRecord[]
}

/**
 * The persisted-state schema: the SUPERSET of both record generations, so a
 * cached v1 row (content-bearing) seeds the fold instead of being discarded.
 */
const storedToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  plugin: z.string().optional(),
  schema: z.unknown().optional(),
}).strict()

const storedEpochSchema = z.object({
  seq: z.number(),
  time: z.number(),
  system: z.string().optional(),
  systemTokens: z.number().int().nonnegative().optional(),
  tools: z.array(storedToolSchema),
}).strict()

const contextHeadersStateSchema = z.object({
  headers: z.array(storedEpochSchema),
}).strict() as unknown as z.ZodType<HeadersState>

/** The wire schema: strict metadata — the shape every delivery channel carries. */
const headerToolWireSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  plugin: z.string().optional(),
}).strict()

const contextHeadersSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    // Absent when the epoch logged no system prompt; the estimated tokens
    // ride the metadata so the browser can size the section pre-fetch.
    systemTokens: z.number().int().nonnegative().optional(),
    tools: z.array(headerToolWireSchema),
  }).strict()),
}).strict() as unknown as z.ZodType<ContextHeaders>

function recordOf(event: SessionEvent): StoredHeaderRecord | null {
  if (event.type !== 'request/header') return null
  const rawHeader = (event.data as { header?: unknown }).header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  const header = rawHeader as { system?: unknown; tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: StoredHeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): StoredHeaderTool => {
      // The log is untrusted input: a null or primitive entry degrades to an
      // unnamed, JSON-priced tool instead of throwing the fold.
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; plugin?: unknown }
      const entry: StoredHeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
      }
      // A harness/MCP-provided attribution rides the raw entry; kept verbatim
      // so the view-time resolver never overrides it. The epoch CONTENT
      // (descriptions, schemas, system text) stays in the durable log for the
      // client's on-demand fetch.
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  if (typeof header.system === 'string' && header.system.length > 0) {
    record.systemTokens = estimateSystem(header.system)
  }
  return record
}

/**
  * The context-headers projection unit; registered alongside the timeline unit (host/index.ts); clients read it through
  * `useProjection('contextHeaders')` and fetch an epoch's full content on demand via the session history (historyPage.ts).
  * Contract mirror with a REQUIRED `wire` block (see compat.ts).
  * @param resolve - best-effort tool-to-plugin attribution (see toolSources.ts); fills a missing `plugin` at view time so
  * epochs folded without attribution still render a tag when the source is known.
 */
export function createContextHeadersDefinition(
  resolve?: (name: string) => string | undefined,
): ProjectionDefinition<'contextHeaders', HeadersState> {
  // The view normalizes both stored generations to the metadata-only wire
  // shape: legacy v1 epochs are stripped of their content here (the system
  // text is priced once per read — the read side of a rarely-moving unit),
  // current epochs pass through.
  const view = (state: HeadersState): ContextHeaders => ({
    headers: state.headers.map((h): HeaderRecord => {
      const record: HeaderRecord = {
        seq: h.seq,
        time: h.time,
        tools: h.tools.map((t): HeaderTool => {
          const entry: HeaderTool = { name: t.name, tokens: t.tokens }
          const plugin = t.plugin ?? (resolve !== undefined ? resolve(t.name) : undefined)
          if (plugin !== undefined) entry.plugin = plugin
          return entry
        }),
      }
      const systemTokens = h.systemTokens
        ?? (typeof h.system === 'string' && h.system !== '' ? estimateSystem(h.system) : undefined)
      if (systemTokens !== undefined) record.systemTokens = systemTokens
      return record
    }),
  })
  const definition: ProjectionDefinition<'contextHeaders', HeadersState> = {
    key: 'contextHeaders',
    stateSchema: contextHeadersStateSchema,
    wire: { viewSchema: contextHeadersSchema, view },
    init: (): HeadersState => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const record = recordOf(event)
      if (record === null) return state
      // The agent loop already suppresses unchanged headers; a cheap guard
      // against the same epoch arriving twice in a row (e.g. resume replays).
      const last = state.headers.at(-1)
      if (last !== undefined && last.seq === record.seq) return state
      const headers = [...state.headers, record]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    // Pinned at 1 on purpose (see the read-compat note above): a bump would
    // invalidate every cached row and orphan the key for idle cold sessions,
    // which have no projection refresh channel until they go live.
    stateVersion: 1,
  }
  return definition
}
