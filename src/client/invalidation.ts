export type InvalidationKind = 'sessions' | 'overview' | 'fleet' | 'heads' | 'pricing'

export interface InvalidationEvent {
  kind: InvalidationKind
  sessionId?: string
  revision?: number
}

export interface InvalidationDetail {
  sessionId?: string
  revision?: number
}

export type InvalidationListener = (event: InvalidationEvent) => void

const listeners = new Set<InvalidationListener>()

export function invalidate(kind: InvalidationKind, detail: InvalidationDetail = {}): void {
  const event: InvalidationEvent = {
    kind,
    ...(detail.sessionId === undefined ? {} : { sessionId: detail.sessionId }),
    ...(detail.revision === undefined ? {} : { revision: detail.revision }),
  }
  for (const listener of [...listeners]) listener(event)
}

export function subscribeInvalidations(listener: InvalidationListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function resetInvalidations(): void {
  listeners.clear()
}
