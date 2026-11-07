import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE, HEADS_ROUTE } from './apiRoutes'
import { BoundedCache, byteSizeOf } from './boundedCache'
import { postRoute } from './route'
import { asRecord, timelineOf } from './services'

export interface AgentHeads {
  headOf(id: string): Promise<ContextTimeline | null>
  headOfMany?(ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>>
}

export function makeHeadFetcher(sessionId: string): (() => Promise<ContextTimeline | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(
    DETAIL_ROUTE,
    { sessionId, head: true },
    value => timelineOf(asRecord(value)?.head),
    { label: 'head' },
  )
}

export function headsOf(value: unknown): Map<string, ContextTimeline> | null {
  const data = asRecord(value)
  if (data === null) return null
  const out = new Map<string, ContextTimeline>()
  for (const id of Object.keys(data)) {
    const entry = asRecord(data[id])
    const head = entry === null ? null : timelineOf(entry.head)
    if (head !== null) out.set(id, head)
  }
  return out
}

export function makeBatchHeadFetcher(ids: readonly string[]): () => Promise<Map<string, ContextTimeline> | null> {
  return () => postRoute(HEADS_ROUTE, { ids }, headsOf, { label: 'heads' })
}

export async function readHeads(heads: AgentHeads, ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>> {
  if (heads.headOfMany !== undefined) return heads.headOfMany(ids)
  const result = new Map<string, ContextTimeline>()
  const reads = await Promise.allSettled(ids.map(async id => ({ id, head: await heads.headOf(id) })))
  let failure: unknown
  for (const read of reads) {
    if (read.status === 'rejected') {
      failure = failure ?? read.reason
      continue
    }
    if (read.value.head !== null) result.set(read.value.id, read.value.head)
  }
  if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
  return result
}

const HEADS_MAX = 128

const HEAD_BATCH_SIZE = 64

const HEADS_BYTES_MAX = 1024 * 1024

interface HeadEntry {
  promise: Promise<ContextTimeline | null>
  bytes: number
}

export function makeAgentHeads(): AgentHeads {
  const heads = new BoundedCache<string, HeadEntry>({
    maxEntries: HEADS_MAX,
    maxBytes: HEADS_BYTES_MAX,
    sizeOf: entry => entry.bytes,
  })
  const inflight = new Map<string, HeadEntry>()
  return {
    headOf(id: string): Promise<ContextTimeline | null> {
      const cached = heads.get(id)
      if (cached !== undefined) return cached.promise
      const running = inflight.get(id)
      if (running !== undefined) return running.promise
      const fetcher = makeHeadFetcher(id)
      const entry: HeadEntry = { promise: Promise.resolve(null), bytes: 0 }
      const pending = fetcher !== undefined ? fetcher() : Promise.resolve(null)
      entry.promise = pending.then((head) => {
        inflight.delete(id)
        entry.bytes = head === null ? 0 : byteSizeOf(head)
        heads.set(id, entry)
        return head
      }, (error: unknown) => {
        inflight.delete(id)
        throw error
      })
      inflight.set(id, entry)
      return entry.promise
    },
    async headOfMany(ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>> {
      const result = new Map<string, ContextTimeline>()
      const needed: string[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const cached = heads.get(id)
        if (cached !== undefined) {
          const head = await cached.promise
          if (head !== null) result.set(id, head)
          continue
        }
        const running = inflight.get(id)
        if (running !== undefined) {
          const head = await running.promise
          if (head !== null) result.set(id, head)
          continue
        }
        needed.push(id)
      }
      const entries = new Map<string, HeadEntry>()
      for (let offset = 0; offset < needed.length; offset += HEAD_BATCH_SIZE) {
        const chunk = needed.slice(offset, offset + HEAD_BATCH_SIZE)
        const pending = makeBatchHeadFetcher(chunk)()
        for (const id of chunk) {
          const entry: HeadEntry = { promise: Promise.resolve(null), bytes: 0 }
          entry.promise = pending.then((batch) => {
            inflight.delete(id)
            const head = batch?.get(id) ?? null
            entry.bytes = head === null ? 0 : byteSizeOf(head)
            heads.set(id, entry)
            return head
          }, (error: unknown) => {
            inflight.delete(id)
            throw error
          })
          inflight.set(id, entry)
          entries.set(id, entry)
        }
      }
      const outcomes = await Promise.allSettled([...entries].map(async ([id, entry]) => ({ id, head: await entry.promise })))
      let failure: unknown
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          failure = failure ?? outcome.reason
          continue
        }
        if (outcome.value.head !== null) result.set(outcome.value.id, outcome.value.head)
      }
      if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
      return result
    },
  }
}

export function useSessionsSnapshot(face: SessionsFaceLike | null, coalesceMs = 0): unknown {
  const subscribe = useCallback((fn: () => void) => {
    if (face === null) return () => {}
    /* v8 ignore next 2 */
    if (face.list === undefined) return () => {}
    if (coalesceMs <= 0) return face.list.subscribe(fn)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = face.list.subscribe(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, coalesceMs)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [face, coalesceMs])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
