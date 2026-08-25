/**
 * Targeted full-content fetch for the Context browser — the fallback that
 * replaces blind tail paging. When a surface node's seq is outside the
 * conversation window, ONE seq-anchored history RPC
 * (`sessions.history({ beforeSeq: seq + 1 })`) returns the page containing
 * that event: the host cuts pages on whole append-origin message boundaries,
 * so the newest group on the page covers `seq` whenever the durable log
 * still holds it. The raw events map into the same conversation-node shapes
 * the window join delivers (a thin display subset of dsh's own fold), and
 * fetched nodes cache per session — history is immutable, so a seq never
 * needs fetching twice.
 */

import type { ClientCtx, ConnectionFace, ContentFetcher, ConversationNodeLike, HistoryEntryLike } from './services'

/** Narrow one served row to a validated durable event envelope, or null. */
function eventOf(entry: unknown): { type: string; seq: number; data: Record<string, unknown> } | null {
  if (entry === null || typeof entry !== 'object') return null
  const row = entry as HistoryEntryLike
  const ev = row.event
  if (ev === null || typeof ev !== 'object') return null
  const e = ev as { type?: unknown; seq?: unknown; data?: unknown }
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

/**
 * Build the browser's per-session fetcher over the shared api client.
 * Undefined when the connection face or the history verb is absent (older
 * hosts) — the caller keeps its static preview-plus-hint degradation. Found
 * nodes cache in the closure: one mount re-reading a row never re-fetches.
 */
export function makeContentFetcher(ctx: ClientCtx, sessionId: string): ContentFetcher | undefined {
  const sessions = (ctx.get('connection') as ConnectionFace | undefined)?.api?.sessions
  if (typeof sessions?.history !== 'function') return undefined
  const cache = new Map<number, ConversationNodeLike>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const response = await sessions.history({ sessionId, beforeSeq: seq + 1 })
    const result = response.result
    // The whole envelope is re-proven (no-white-screen guarantee): a failed or
    // malformed read rejects so the browser offers a retry instead of guessing.
    if (result === null || typeof result !== 'object' || result.ok !== true || result.value === null || typeof result.value !== 'object') {
      throw new Error('history rpc failed')
    }
    const events = result.value.events
    const node = pageNodesOf(Array.isArray(events) ? events : []).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}
