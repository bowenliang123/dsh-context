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
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateToolSchema } from './pricing'

/** Retention cap on header epochs (changes are rare; 50 is generous). */
const HEADERS_MAX = 50

/** The unit's persisted state (plain JSON, bounded). */
export interface HeadersState {
  headers: HeaderRecord[]
}

const headerToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
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

/** Fold one `request/header` payload into an epoch record (display-priced). */
function recordOf(event: SessionEvent): HeaderRecord | null {
  if (event.type !== 'request/header') return null
  const header = (event.data as { header?: unknown }).header as {
    system?: unknown
    tools?: unknown[]
  } | undefined
  if (header === null || typeof header !== 'object') return null
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: HeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): HeaderTool => {
      const tool = t as { name?: unknown; description?: unknown }
      const entry: HeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
        schema: t,
      }
      if (typeof tool.description === 'string' && tool.description !== '') {
        entry.description = tool.description
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
 * The context-headers projection unit. Registered alongside the timeline
 * unit (host/index.ts); clients read it through `useProjection('contextHeaders')`
 * and degrade to tokens-only header sections when the key is absent.
 */
export function createContextHeadersDefinition(): ProjectionDefinition<'contextHeaders', HeadersState> {
  return {
    key: 'contextHeaders',
    schema: contextHeadersSchema,
    init: (): HeadersState => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const record = recordOf(event)
      if (record === null) return state
      // The agent loop already suppresses unchanged headers; a cheap guard
      // against the same epoch arriving twice in a row (e.g. resume replays).
      const last = state.headers[state.headers.length - 1]
      if (last !== undefined && last.seq === record.seq) return state
      const headers = [...state.headers, record]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    view: (state: HeadersState): ContextHeaders => ({
      headers: state.headers.map(h => ({ ...h, tools: h.tools.map(t => ({ ...t })) })),
    }),
    stateVersion: 1,
  }
}
