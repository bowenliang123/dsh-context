/**
 * Per-session snapshot cache — "stale-while-revalidate" for the Context tab.
 * Re-opening a session (or switching back to it) renders the last-known
 * data instantly instead of flashing the loading state, then the polling
 * effect refreshes it. Bounded by insertion order (oldest evicted first) so
 * memory stays flat across many sessions.
 */

import type { Snapshot } from '../shared/types'

const MAX_CACHED_SESSIONS = 10

const sessionCache = new Map<string, Snapshot>()

export function cacheGet(sessionId: string): Snapshot | undefined {
  return sessionCache.get(sessionId)
}

export function cachePut(sessionId: string, snapshot: Snapshot): void {
  sessionCache.set(sessionId, snapshot)
  if (sessionCache.size > MAX_CACHED_SESSIONS) {
    const oldest = sessionCache.keys().next().value
    if (oldest !== undefined) sessionCache.delete(oldest)
  }
}
