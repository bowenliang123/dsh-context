/**
 * Targeted full-content fetch for the Context browser — the fallback that
 * replaces blind tail paging. When a surface node's seq is outside the
 * conversation window, ONE seq-anchored history read returns the page
 * containing that event: the host cuts pages on whole append-origin message
 * boundaries, so the newest group on the page covers `seq` whenever the
 * durable log still holds it. The read rides whichever face the running
 * harness serves — the 0.1.2+ gateway remotes (`remote.session.page`, with
 * the inclusive cut `throughSeq` pinned to the target seq) or the pre-0.1.2
 * api client verb (`sessions.history({ beforeSeq })`) — and the raw events
 * map into the same conversation-node shapes the window join delivers (a
 * thin display subset of dsh's own fold). Fetched nodes cache per session —
 * history is immutable, so a seq never needs fetching twice.
 */

import type {
  ClientCtx, ConnectionFace, ContentFetcher, ConversationNodeLike, HistoryEntryLike,
  SessionPageFace,
} from './services'

/** Narrow one served row to a validated durable event envelope, or null. */
function eventOf(entry: unknown): { type: string; seq: number; data: Record<string, unknown> } | null {
  if (entry === null || typeof entry !== 'object') return null
  // Both eras wrap the envelope in an `event` field (0.1.1 history entries
  // `{event, view?}`, 0.1.2 records `{type:'event'|'chunks', event}`); a bare
  // envelope passes too, so shape drift across versions degrades instead of
  // breaking the page. Packed chunk-row records flow through as unknown types
  // and project to nothing downstream — only final events matter here.
  const inner = (entry as HistoryEntryLike).event ?? entry
  if (typeof inner !== 'object') return null
  const e = inner as { type?: unknown; seq?: unknown; data?: unknown }
  if (typeof e.type !== 'string' || typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return null
  const data = e.data !== null && typeof e.data === 'object' ? e.data as Record<string, unknown> : {}
  return { type: e.type, seq: e.seq, data }
}

/** All string texts of an event's message-content shape joined (compaction summaries). */
function textOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  for (const b of blocks) {
    const text = b !== null && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }).text : undefined
    if (typeof text === 'string') out += text
  }
  return out.trim() === '' ? null : out
}

/**
 * One assistant content block → the snapshot block vocabulary the browser
 * already renders (`kind`: text/reasoning/image/tool-call); unmappable
 * blocks pass through raw and degrade to the generic JSON section.
 */
function assistantBlockOf(block: unknown): Record<string, unknown> {
  const b = block !== null && typeof block === 'object' ? block as { type?: unknown; text?: unknown; attachment?: unknown; name?: unknown; arguments?: unknown } : null
  switch (b?.type) {
    case 'text': case 'reasoning':
      return { kind: b.type, ...(typeof b.text === 'string' ? { text: b.text } : {}) }
    case 'image':
      return { kind: 'image', ...(b.attachment !== undefined ? { attachment: b.attachment } : {}) }
    case 'tool-call':
      return {
        kind: 'tool-call',
        name: typeof b.name === 'string' ? b.name : '?',
        argsRaw: b.arguments,
      }
    default:
      return block !== null && typeof block === 'object' ? block as Record<string, unknown> : { value: block }
  }
}

/**
 * Map one history page into joined conversation nodes keyed by their event
 * seq — the display subset of the browser's join: user messages, assistant
 * blocks, tool results paired with their in-page call head, and compaction
 * checkpoints paired with their summary event. Everything else (headers,
 * boundaries, chunks, bare calls) projects to nothing.
 */
export function pageNodesOf(entries: readonly unknown[]): Map<number, ConversationNodeLike> {
  const nodes = new Map<number, ConversationNodeLike>()
  const calls = new Map<string, { name: string; argsRaw: string }>()
  const summaries = new Map<string, string>()
  for (const entry of entries) {
    const ev = eventOf(entry)
    if (ev === null) continue
    const { type, seq, data } = ev
    if (type === 'tool/call') {
      if (typeof data.callId === 'string') {
        calls.set(data.callId, {
          name: typeof data.name === 'string' ? data.name : '?',
          // The durable envelope stores arguments as a raw JSON string.
          argsRaw: typeof data.arguments === 'string' ? data.arguments : '',
        })
      }
      continue
    }
    if (type === 'compaction/summary') {
      if (typeof data.compactionId === 'string') {
        const summary = textOf(data.summary)
        if (summary !== null) summaries.set(data.compactionId, summary)
      }
      continue
    }
    if (type === 'user/message') {
      const source = data.source !== null && typeof data.source === 'object' ? data.source as Record<string, unknown> : null
      const compactionId = source !== null
        && source.kind === 'plugin' && typeof source.compactionId === 'string'
        ? source.compactionId
        : null
      if (compactionId !== null) {
        // A compaction checkpoint: the model-visible envelope never renders —
        // the marker shows its summary instead (null when the page cut left
        // the summary event outside).
        nodes.set(seq, { kind: 'compaction', seq, summary: summaries.get(compactionId) ?? null })
        continue
      }
      nodes.set(seq, {
        kind: 'user',
        seq,
        content: Array.isArray(data.content) ? data.content as readonly unknown[] : [],
      })
      continue
    }
    if (type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : null
      const content = message !== null && Array.isArray(message.content) ? message.content : []
      nodes.set(seq, {
        kind: 'assistant',
        seq,
        blocks: (content as unknown[]).map(assistantBlockOf),
      })
      continue
    }
    if (type === 'tool/result') {
      const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : null
      const source = message?.source !== null && typeof message?.source === 'object' ? message.source as Record<string, unknown> : null
      const first = Array.isArray(message?.content) ? (message.content as unknown[])[0] : undefined
      const block = first !== null && typeof first === 'object' ? first as Record<string, unknown> : null
      const callId = typeof source?.callId === 'string' ? source.callId
        : typeof block?.toolCallId === 'string' ? block.toolCallId
          : null
      const call = callId !== null ? calls.get(callId) ?? null : null
      nodes.set(seq, {
        kind: 'tool-result',
        seq,
        call,
        content: block !== null && Array.isArray(block.content) ? block.content as readonly unknown[] : [],
        isError: block?.isError === true || data.error === true,
      })
      continue
    }
  }
  return nodes
}

/** Read a service off the client context without letting an absent/foreign
 * cordis service (a throwing `ctx.get`) escape: returns undefined instead. */
function serviceOf(ctx: ClientCtx, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** The rows array of a history/page response, under every served envelope. */
function rowsOf(response: unknown): readonly unknown[] {
  // Envelope unwrapping, both served shapes: the 0.1.2 remote resolves to
  // the ClientResult itself ({ok, value}); the 0.1.1 api client nests it
  // under `result` ({result: {ok, value}}). A bare {records}/{events}
  // payload passes too. Anything else rejects so the caller can offer a
  // retry instead of claiming absence.
  let payload: unknown = response
  if (payload !== null && typeof payload === 'object') {
    const nested = (payload as { result?: unknown }).result
    if (nested !== null && typeof nested === 'object') payload = nested
  }
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const r = payload as { ok?: unknown; value?: unknown }
    if (r.ok !== true || r.value === null || typeof r.value !== 'object') {
      throw new Error('history rpc failed')
    }
    payload = r.value
  }
  if (payload === null || typeof payload !== 'object') throw new Error('history rpc failed')
  const rows = (payload as { records?: unknown; events?: unknown }).records
    ?? (payload as { events?: unknown }).events
  if (!Array.isArray(rows)) throw new Error('history rpc failed')
  return rows
}

/**
 * Build the browser's per-session fetcher over whichever history face the
 * running harness serves — the 0.1.2+ gateway remotes (`remote.session.page`)
 * first, the pre-0.1.2 api client verb (`connection.api.sessions.history`)
 * beneath it. Both cut message-aligned pages, so `beforeSeq: seq + 1` (with
 * the inclusive cut pinned to `seq` on the newer face) covers the seq whenever
 * the durable log still holds it. Undefined when no face exists (older
 * hosts) — the caller keeps its static preview-plus-hint degradation. Found
 * nodes cache in the closure: one mount re-reading a row never re-fetches.
 */
export function makeContentFetcher(ctx: ClientCtx, sessionId: string): ContentFetcher | undefined {
  // The 0.1.2+ session namespace is a traced cordis service literally named
  // `remote.session` — read through `ctx.get`, whose reflect read needs no
  // inject declaration and yields undefined on harnesses that never mount
  // the namespace (0.1.1). The faces are bound up front: a method extracted
  // unbound loses `this`, and a transport relying on it would throw.
  const pageFace = serviceOf(ctx, 'remote.session') as SessionPageFace | undefined
  const page = pageFace !== undefined && typeof pageFace.page === 'function' ? pageFace.page.bind(pageFace) : undefined
  const historyFace = (serviceOf(ctx, 'connection') as ConnectionFace | undefined)?.api?.sessions
  const history = historyFace !== undefined && typeof historyFace.history === 'function' ? historyFace.history.bind(historyFace) : undefined
  if (page === undefined && history === undefined) return undefined
  // The 0.1.2 page request: the inclusive log cut pinned to the target seq,
  // the exclusive bound one past it — the newer face's exact-pinning of the
  // legacy `beforeSeq` page.
  const pageRequest = (seq: number) => ({
    address: { kind: 'session' as const, sessionId },
    throughSeq: seq,
    beforeSeq: seq + 1,
  })
  // The legacy reader, guarded by construction (only selected when the page
  // face is absent — the guard above leaves a face for either arm).
  const historyCall = (seq: number): Promise<unknown> =>
    (history as (request: { sessionId: string; beforeSeq: number }) => Promise<unknown>)({ sessionId, beforeSeq: seq + 1 })
  const cache = new Map<number, ConversationNodeLike>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    // The whole envelope is re-proven (no-white-screen guarantee): a failed or
    // malformed read rejects so the browser offers a retry instead of guessing.
    const response = page !== undefined ? await page(pageRequest(seq), new AbortController().signal) : await historyCall(seq)
    const node = pageNodesOf(rowsOf(response)).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}
