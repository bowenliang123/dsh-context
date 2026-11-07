import { lruTouch, lruTrim } from './boundedCache'
import type { TokenSpan } from './services'

export interface ModalStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(open: boolean): void
}

const MODAL_STORES_MAX = 32

const stores = new Map<string, ModalStore>()

export function modalStoreOf(sessionId: string): ModalStore {
  const existing = stores.get(sessionId)
  if (existing !== undefined) {
    lruTouch(stores, sessionId)
    return existing
  }
  let open = false
  const listeners = new Set<() => void>()
  const store: ModalStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => open,
    set(next) {
      if (next === open) return
      open = next
      for (const listener of listeners) listener()
    },
  }
  stores.set(sessionId, store)
  lruTrim(stores, MODAL_STORES_MAX)
  return store
}

export type ConsumeGuard =
  | { kind: 'span'; span: TokenSpan }
  | { kind: 'bare-token'; token: string }

const pendingConsume = new Map<string, ConsumeGuard>()

export function setPendingConsume(sessionId: string, guard: ConsumeGuard): void {
  pendingConsume.set(sessionId, guard)
}

export function takePendingConsume(sessionId: string): ConsumeGuard | undefined {
  const guard = pendingConsume.get(sessionId)
  if (guard !== undefined) pendingConsume.delete(sessionId)
  return guard
}
