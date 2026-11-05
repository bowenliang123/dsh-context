import { useEffect } from 'react'
import { asRecord, seatOf } from './services'
import { detailStoreOf } from './timelineSource'

const WARM_DELAY_MS = 900

const MAX_PENDING = 32

interface PendingWarm {
  timer: ReturnType<typeof setTimeout>
  rev: number
}

const pending = new Map<string, PendingWarm>()

export function scheduleSessionWarm(sessionId: unknown, rev: number | null): void {
  if (typeof sessionId !== 'string' || sessionId === '' || rev === null || !Number.isFinite(rev) || rev < 0) return
  const known = pending.get(sessionId)
  if (known !== undefined) {
    if (rev > known.rev) known.rev = rev
    return
  }
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    detailStoreOf(sessionId).warm(rev)
  }, WARM_DELAY_MS)
  pending.set(sessionId, { timer, rev })
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value as string
    const entry = pending.get(oldest) as PendingWarm
    clearTimeout(entry.timer)
    pending.delete(oldest)
  }
}

export function cancelSessionWarm(sessionId: string): void {
  const entry = pending.get(sessionId)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  pending.delete(sessionId)
}

export function resetSessionWarm(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

type ProjectionSeat = (key: string) => unknown

const NO_PROJECTION: ProjectionSeat = () => undefined

export function useSessionDetailWarm(sessionId: unknown, useProjection: unknown): void {
  const read = seatOf(useProjection, NO_PROJECTION)
  const head = read('contextTimeline')
  const rev = asRecord(head)?.detailRev
  const warmRev = typeof rev === 'number' && Number.isFinite(rev) && rev >= 0 ? rev : null
  useEffect(() => {
    scheduleSessionWarm(sessionId, warmRev)
  }, [sessionId, warmRev])
  useEffect(() => () => {
    if (typeof sessionId === 'string') cancelSessionWarm(sessionId)
  }, [sessionId])
}
