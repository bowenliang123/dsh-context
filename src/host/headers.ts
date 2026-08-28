/**
 * The `contextHeaders` session projection unit — the request-header CONTENT
 * epochs behind the timeline's envelope figures.
 *
 * The hot `contextTimeline` unit carries only token prices of the system
 * prompt and tool schemas; this companion unit keeps the CONTENT (full
 * system prompt text, full tool JSON schemas) so the Context browser card
 * can show what a picked step's request was actually assembled from. It is
 * a separate unit on purpose: the agent loop logs `request/header` only
 * when the header changes, so this state (and its pushes to the browser)
 * moves rarely — carrying full content costs nothing on the per-event hot
 * path.
 *
 * Same projection contract as the timeline unit: pure init/apply/view,
 * `Object.is` reference stability for uninteresting events, plain-JSON
 * bounded state (epoch list capped — see HEADERS_MAX).
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CompatProjectionDefinition } from './compat'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateToolSchema } from './pricing'

/** Retention cap on header epochs (changes are rare; 50 is generous). */
const HEADERS_MAX = 50

export interface HeadersState {
  headers: HeaderRecord[]
}

const headerToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  plugin: z.string().optional(),
  schema: z.unknown().optional(),
}).strict()

const contextHeadersSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    system: z.string().optional(),
    tools: z.array(headerToolSchema),
  }).strict()),
}).strict() as unknown as z.ZodType<ContextHeaders>

/**
  * State and wire are the same shape (the view only shallow-copies each record), so one schema validates both under the dsh 0.1.1-rc.1+
  * `stateSchema`/`wire` contract.
 */
const contextHeadersStateSchema = contextHeadersSchema

function recordOf(event: SessionEvent): HeaderRecord | null {
  if (event.type !== 'request/header') return null
  const rawHeader = (event.data as { header?: unknown }).header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  const header = rawHeader as { system?: unknown; tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: HeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): HeaderTool => {
      // The log is untrusted input: a null or primitive entry degrades to an
      // unnamed, JSON-priced tool instead of throwing the fold.
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; description?: unknown; plugin?: unknown }
      const entry: HeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
        schema: t,
      }
      if (typeof tool.description === 'string' && tool.description !== '') {
        entry.description = tool.description
      }
      // A harness/MCP-provided attribution rides the raw entry; kept verbatim
      // so the view-time resolver never overrides it.
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  if (typeof header.system === 'string' && header.system.length > 0) {
    record.system = header.system
  }
  return record
}

/**
  * The context-headers projection unit; registered alongside the timeline unit (host/index.ts); clients read it through
  * `useProjection('contextHeaders')` and degrade to tokens-only header sections when the key is absent. Dual-contract definition (see
  * compat.ts).
  * @param resolve - best-effort tool-to-plugin attribution (see toolSources.ts); fills a missing `plugin` at view time so
  * epochs folded without attribution still render a tag when the source is known.
 */
export function createContextHeadersDefinition(
  resolve?: (name: string) => string | undefined,
): CompatProjectionDefinition<'contextHeaders', HeadersState> {
  const view = (state: HeadersState): ContextHeaders => ({
    headers: state.headers.map(h => ({
      ...h,
      tools: h.tools.map((t) => {
        if (resolve === undefined || t.plugin !== undefined) return { ...t }
        const plugin = resolve(t.name)
        return plugin === undefined ? { ...t } : { ...t, plugin }
      }),
    })),
  })
  const definition: CompatProjectionDefinition<'contextHeaders', HeadersState> = {
    key: 'contextHeaders',
    schema: contextHeadersSchema,
    view,
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
    stateVersion: 1,
  }
  return definition
}
