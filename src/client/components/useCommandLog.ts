import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from '../commands'
import type { CommandPageFetcher } from '../commandPages'

const PAGE_PAUSE_MS = 30

type FillState =
  | { status: 'idle' }
  | { status: 'done' }
  | { status: 'loading'; cursor: number; total?: number }
  | { status: 'failed'; cursor: number }

export interface CommandLog {
  records: Command[]
  status: FillState['status']
  total?: number
  retry: () => void
}

export type CommandFill = Pick<CommandLog, 'status' | 'total'> & { retry?: () => void }

interface LogStore {
  scope: string
  fetcher: CommandPageFetcher | undefined
  known: ReadonlyMap<number, Command>
  fill: FillState
}

function knownWithServed(prev: ReadonlyMap<number, Command>, served: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of served) {
    if (prev.get(rec.seq) === rec) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

function knownWithPage(prev: ReadonlyMap<number, Command>, incoming: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of incoming) {
    if (prev.has(rec.seq)) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

export function useCommandLog(
  served: readonly Command[],
  floor: number | undefined,
  fetchOlder: CommandPageFetcher | undefined,
  scope?: string,
): CommandLog {
  const scopeKey = scope ?? ''
  const [store, setStore] = useState<LogStore>(() => ({ scope: scopeKey, fetcher: fetchOlder, known: new Map(), fill: { status: 'idle' } }))
  const sourceChanged = store.fetcher !== undefined && fetchOlder !== undefined && store.fetcher !== fetchOlder
  if (store.scope !== scopeKey || sourceChanged) {
    setStore({ scope: scopeKey, fetcher: fetchOlder, known: new Map(), fill: { status: 'idle' } })
  } else if (store.fetcher !== fetchOlder) {
    setStore({ ...store, fetcher: fetchOlder })
  }
  const cursorTarget = useRef(0)
  useEffect(() => {
    if (served.length === 0 || floor === undefined) return
    setStore((prev) => {
      const known = knownWithServed(prev.known, served)
      return known === prev.known ? prev : { ...prev, known }
    })
  }, [served, floor, scopeKey, fetchOlder])
  const records = useMemo<Command[]>(() => {
    if (floor === undefined || store.known.size === 0) return served as Command[]
    const merged = new Map(store.known)
    for (const rec of served) merged.set(rec.seq, rec)
    return [...merged.values()]
  }, [served, store.known, floor])
  useEffect(() => {
    if (store.fill.status !== 'idle' || floor === undefined || served.length === 0 || fetchOlder === undefined) return
    const cursor = floor + 1
    cursorTarget.current = cursor
    setStore(prev => ({ ...prev, fill: { status: 'loading', cursor } }))
  }, [store.fill.status, floor, served.length, fetchOlder, scopeKey])
  useEffect(() => {
    if (store.fill.status !== 'loading' || fetchOlder === undefined) return
    const cursor = store.fill.cursor
    let live = true
    const timer = setTimeout(() => {
      void fetchOlder(cursor).then(
        (result) => {
          if (!live) return
          setStore((prev) => {
            if (result === null) return { ...prev, fill: { status: 'failed', cursor } }
            const known = result.commands.length > 0 ? knownWithPage(prev.known, result.commands) : prev.known
            let oldest = cursor
            for (const rec of result.commands) if (rec.seq < oldest) oldest = rec.seq
            if (result.atStart) return { ...prev, known, fill: { status: 'done' } }
            if (oldest >= cursor) return { ...prev, known, fill: { status: 'failed', cursor } }
            cursorTarget.current = oldest
            return { ...prev, known, fill: { status: 'loading', cursor: oldest, total: result.total } }
          })
        },
        () => {
          if (live) setStore(prev => ({ ...prev, fill: { status: 'failed', cursor } }))
        },
      )
    }, PAGE_PAUSE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [store.fill, fetchOlder, scopeKey])
  useEffect(() => {
    if (store.fill.status !== 'loading' || fetchOlder !== undefined) return
    const cursor = store.fill.cursor
    setStore(prev => ({ ...prev, fill: { status: 'failed', cursor } }))
  }, [store.fill, fetchOlder, scopeKey])
  const retry = useCallback(() => {
    setStore((prev) => {
      if (prev.fill.status !== 'failed') return prev
      cursorTarget.current = prev.fill.cursor
      return { ...prev, fill: { status: 'loading', cursor: prev.fill.cursor } }
    })
  }, [])
  const fill = store.fill
  return {
    records,
    status: fill.status,
    ...(fill.status === 'loading' && fill.total !== undefined ? { total: fill.total } : {}),
    retry,
  }
}
