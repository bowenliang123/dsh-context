import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE } from './apiRoutes'
import { BoundedCache, byteSizeOf } from './boundedCache'
import { postRoute } from './route'
import { asRecord, timelineOf } from './services'

export interface AgentHeads {
  headOf(id: string): Promise<ContextTimeline | null>
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

const HEADS_MAX = 128

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
