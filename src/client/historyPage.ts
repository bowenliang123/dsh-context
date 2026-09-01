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
  ClientCtx, ConnectionFace, ContentFetcher, ConversationNodeLike, HeaderFetcher,
  HistoryEntryLike, SessionPageFace,
} from './services'
import type { HeaderEpochContent } from '../shared/types'

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
 * The session's history readers over whichever face the running harness
 * serves — the 0.1.2+ gateway remotes (`remote.session.page`) first, the
 * pre-0.1.2 api client verb (`connection.api.sessions.history`) beneath it.
 * Both cut message-aligned pages, so the returned read covers `seq` whenever
 * the durable log still holds it: the newer face pins the inclusive cut to
 * the seq itself, the legacy reader uses the exclusive bound one past it.
 * Undefined when no face exists (older hosts) — callers keep their static
 * degradation.
 */
function pageReadersOf(ctx: ClientCtx, sessionId: string): ((seq: number) => Promise<unknown>) | undefined {
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
  return (seq) => {
    if (page !== undefined) {
      // The inclusive log cut pinned to the target seq, the exclusive bound
      // one past it — the newer face's exact-pinning of the legacy page.
      return page({
        address: { kind: 'session' as const, sessionId },
        throughSeq: seq,
        beforeSeq: seq + 1,
      }, new AbortController().signal)
    }
    return (history as (request: { sessionId: string; beforeSeq: number }) => Promise<unknown>)({ sessionId, beforeSeq: seq + 1 })
  }
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
  const read = pageReadersOf(ctx, sessionId)
  if (read === undefined) return undefined
  // Fetched nodes cache in the closure: history is immutable, so one mount
  // re-reading a row never re-fetches.
  const cache = new Map<number, ConversationNodeLike>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    // The whole envelope is re-proven (no-white-screen guarantee): a failed or
    // malformed read rejects so the browser offers a retry instead of guessing.
    const node = pageNodesOf(rowsOf(await read(seq))).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}

/**
 * Map one raw `request/header` event into the epoch content the browser
 * renders — the full system prompt text plus each tool's producer
 * description and raw schema, mirroring the host fold's per-entry guards
 * (a null or primitive tool entry degrades to an unnamed row instead of
 * throwing the read). Null when the envelope carries no usable header.
 */
function headerContentOf(data: Record<string, unknown>): HeaderEpochContent | null {
  const rawHeader = data.header !== null && typeof data.header === 'object'
    ? data.header as Record<string, unknown>
    : null
  if (rawHeader === null) return null
  const toolsRaw = Array.isArray(rawHeader.tools) ? rawHeader.tools : []
  const tools: HeaderEpochContent['tools'] = []
  for (const t of toolsRaw) {
    const tool = t !== null && typeof t === 'object' ? t as Record<string, unknown> : null
    tools.push({
      name: tool !== null && typeof tool.name === 'string' ? tool.name : '?',
      ...(tool !== null && typeof tool.description === 'string' && tool.description !== ''
        ? { description: tool.description }
        : {}),
      schema: t,
    })
  }
  return {
    ...(typeof rawHeader.system === 'string' && rawHeader.system !== '' ? { system: rawHeader.system } : {}),
    tools,
  }
}

/**
 * The on-demand CONTENT fetch for `contextHeaders` epochs — the lazy
 * counterpart of the node fetcher above. One seq-anchored history read off
 * the epoch's `seq` returns the page holding that epoch's `request/header`
 * event (non-message events ride the page verbatim); the raw header is
 * mapped client-side into the renderable content. Epochs cache per session
 * (history is immutable), and OLDER epochs sharing the page cache for free —
 * stepping back through epochs walks the same pages. Undefined when no
 * history face exists (older hosts) — the browser keeps a metadata-only
 * degradation instead.
 */
export function makeHeaderFetcher(ctx: ClientCtx, sessionId: string): HeaderFetcher | undefined {
  const read = pageReadersOf(ctx, sessionId)
  if (read === undefined) return undefined
  const cache = new Map<number, HeaderEpochContent>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    // Same re-prove contract as the node fetcher: a failed or malformed read
    // rejects so the browser offers a retry instead of guessing.
    const rows = rowsOf(await read(seq))
    let picked: HeaderEpochContent | null = null
    for (const entry of rows) {
      const ev = eventOf(entry)
      if (ev === null || ev.type !== 'request/header') continue
      const content = headerContentOf(ev.data)
      if (content === null) continue
      // The page's exclusive bound is seq + 1, so every header event on it
      // is the picked epoch or an OLDER one — cache them all.
      cache.set(ev.seq, content)
      if (ev.seq === seq) picked = content
    }
    return picked
  }
}
