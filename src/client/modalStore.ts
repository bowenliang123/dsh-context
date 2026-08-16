/**
 * Per-session open-state stores for the /context modal, plus the deferred
 * token-consume guards. Module-level so the state survives overlay remounts;
 * the trigger source (pick/enter) opens it, the overlay component subscribes
 * and renders. Implements the ObservableSnapshot pair the slot `hooks`
 * compartment binds as a `useContextModal` selector hook.
 */

import type { TokenSpan } from './services'

export interface ModalStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(open: boolean): void
}

const stores = new Map<string, ModalStore>()

export function modalStoreOf(sessionId: string): ModalStore {
  const existing = stores.get(sessionId)
  if (existing !== undefined) return existing
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
  return store
}

// ---- deferred token consumption -------------------------------------------
// The `/context` token stays in the composer while the modal is open and is
// consumed only when the modal closes. Each open path records the guard the
// input shell understands (span CAS for menu picks, bare-token equality for
// enter); the close path takes it and dispatches the scoped
// `slash/input-consume-token` event. A stale guard (the user typed meanwhile)
// fails soft inside the shell — the draft is left untouched.

export type ConsumeGuard =
  | { kind: 'span'; span: TokenSpan }
  | { kind: 'bare-token'; token: string }

const pendingConsume = new Map<string, ConsumeGuard>()

export function setPendingConsume(sessionId: string, guard: ConsumeGuard): void {
  pendingConsume.set(sessionId, guard)
}

/** Take (and clear) the guard recorded by the open path, if any. */
export function takePendingConsume(sessionId: string): ConsumeGuard | undefined {
  const guard = pendingConsume.get(sessionId)
  if (guard !== undefined) pendingConsume.delete(sessionId)
  return guard
}
