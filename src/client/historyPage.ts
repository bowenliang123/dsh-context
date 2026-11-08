import { useSyncExternalStore } from 'react'
import { makeRetentionCache } from './retention'
import type {
  ClientCtx, ContentFetcher, ConversationNodeLike, HeaderFetcher,
  HistoryEntryLike, SessionAddressLike, SessionPageFace,
} from './services'
import type { HeaderEpochContent } from '../shared/types'

function eventOf(entry: unknown): { type: string; seq: number; data: Record<string, unknown> } | null {
  if (entry === null || typeof entry !== 'object') return null
  const inner = (entry as HistoryEntryLike).event ?? entry
  if (typeof inner !== 'object') return null
  const e = inner as { type?: unknown; seq?: unknown; data?: unknown }
  if (typeof e.type !== 'string' || typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return null
  const data = e.data !== null && typeof e.data === 'object' ? e.data as Record<string, unknown> : {}
  return { type: e.type, seq: e.seq, data }
}

function textOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  for (const b of blocks) {
    const text = b !== null && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }).text : undefined
    if (typeof text === 'string') out += text
  }
  return out.trim() === '' ? null : out
}

function systemTextOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  let seen = false
  for (const b of blocks) {
    const text = b !== null && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }).text : undefined
    if (typeof text === 'string') {
      out += text
      seen = true
    }
  }
  return seen ? out : null
}

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
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId
        : typeof source?.callId === 'string' ? source.callId
          : null
      const call = callId !== null ? calls.get(callId) ?? null : null
      nodes.set(seq, {
        kind: 'tool-result',
        seq,
        call,
        content: Array.isArray(message?.content) ? message.content as readonly unknown[] : [],
        isError: message?.isError === true,
      })
      continue
    }
  }
  return nodes
}

function readPageOf(face: unknown): SessionPageFace['page'] | undefined {
  if (face === null || typeof face !== 'object') return undefined
  try {
    const fn = (face as Record<string, unknown>).page
    return typeof fn === 'function' ? (fn as SessionPageFace['page']).bind(face) : undefined
  } catch {
    return undefined
  }
}

let declaredPage: SessionPageFace['page'] | undefined

const faceListeners = new Set<() => void>()

function setPageFace(page: SessionPageFace['page'] | undefined): void {
  declaredPage = page
  for (const listener of [...faceListeners]) listener()
}

export function historyFace(): SessionPageFace['page'] | undefined {
  return declaredPage
}

export function subscribeHistoryFace(listener: () => void): () => void {
  faceListeners.add(listener)
  return () => { faceListeners.delete(listener) }
}

function faceSnapshot(): SessionPageFace['page'] | undefined {
  return declaredPage
}

export function useHistoryFace(): SessionPageFace['page'] | undefined {
  return useSyncExternalStore(subscribeHistoryFace, faceSnapshot, faceSnapshot)
}

export function watchHistoryFaces(ctx: ClientCtx): void {
  ctx.inject(['remote', 'remote.session'], (c) => {
    try {
      const session = (c as ClientCtx & { remote?: { session?: SessionPageFace } }).remote?.session
      setPageFace(session !== undefined ? readPageOf(session) : undefined)
    } catch {
      setPageFace(undefined)
    }
    return () => { setPageFace(undefined) }
  })
}

function rowsOf(response: unknown): readonly unknown[] {
  let payload: unknown = response
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const r = payload as { ok?: unknown; value?: unknown }
    if (r.ok !== true || r.value === null || typeof r.value !== 'object') {
      throw new Error('history rpc failed')
    }
    payload = r.value
  }
  if (payload === null || typeof payload !== 'object') throw new Error('history rpc failed')
  const rows = (payload as { records?: unknown }).records
  if (!Array.isArray(rows)) throw new Error('history rpc failed')
  return rows
}

function pageReaderOf(addressOf: () => SessionAddressLike): ((seq: number) => Promise<unknown>) | undefined {
  const page = declaredPage
  if (page === undefined) return undefined
  return (seq) => {
    return page({
      address: addressOf(),
      throughSeq: seq,
      beforeSeq: seq + 1,
    }, new AbortController().signal)
  }
}

export function makeContentFetcher(
  addressOf: () => SessionAddressLike,
): ContentFetcher | undefined {
  const read = pageReaderOf(addressOf)
  if (read === undefined) return undefined
  const cache = makeRetentionCache<number, ConversationNodeLike>('historyContent')
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const node = pageNodesOf(rowsOf(await read(seq))).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}

function headerContentOf(event: { type: string; data: Record<string, unknown> }): HeaderEpochContent | null {
  const { type, data } = event
  if (type === 'system/message') {
    const message = data.message !== null && typeof data.message === 'object'
      ? data.message as Record<string, unknown>
      : null
    const system = systemTextOf(message?.content)
    return system === null ? null : { system, tools: [] }
  }
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
  return { tools }
}

export function makeHeaderFetcher(
  addressOf: () => SessionAddressLike,
): HeaderFetcher | undefined {
  const read = pageReaderOf(addressOf)
  if (read === undefined) return undefined
  const cache = makeRetentionCache<number, HeaderEpochContent>('historyHeader')
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const rows = rowsOf(await read(seq))
    let picked: HeaderEpochContent | null = null
    for (const entry of rows) {
      const ev = eventOf(entry)
      if (ev === null || (ev.type !== 'request/header' && ev.type !== 'system/message')) continue
      const content = headerContentOf(ev)
      if (content === null) continue
      cache.set(ev.seq, content)
      if (ev.seq === seq) picked = content
    }
    return picked
  }
}
