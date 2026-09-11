/**
 * The outward sessions service, as a subscribable fact.
 *
 * `sessionsFaceOf` reads the service off the client context, and cordis arms
 * services as their providing plugin loads: a mount can legitimately come up
 * before `sessions` exists, and the service can be rebuilt or withdrawn under a
 * live view. Resolving once at mount freezes whichever answer that first render
 * saw — and for the cost cell that degrade is invisible, because it just prices
 * the session alone, with no signal that the subagents are missing from the
 * figure.
 *
 * So the face is read LIVE, and this module owns only the announcement:
 * `watchSessionsFace` binds the DECLARED inject and pings the channel when the
 * service arrives or goes away, and the React seats re-read through
 * `useSyncExternalStore`. (historyPage's history face publishes its value
 * instead — it has non-React readers, which this channel has no need of.)
 */

import { useSyncExternalStore } from 'react'
import { sessionsFaceOf, type SessionsFaceLike } from './agentTree'
import type { ClientCtx } from './services'

const listeners = new Set<() => void>()

/** Subscribe to service arrival and revocation (the React seat's read trigger). */
export function subscribeSessionsFace(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Announce that the context's service composition changed. */
function announce(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * The sessions face this ctx exposes right now — null until the service lands.
 * Reading live is what keeps it from going stale: the same service reads back
 * as the same face value, which is exactly what `useSyncExternalStore`
 * compares to decide whether a re-read changed anything.
 */
export function useSessionsFace(ctx: ClientCtx): SessionsFaceLike | null {
  const read = (): SessionsFaceLike | null => sessionsFaceOf(ctx)
  return useSyncExternalStore(subscribeSessionsFace, read, read)
}

/**
 * Bind the sessions service through the DECLARED inject: the callback fires
 * once the service exists and its disposer runs when it goes away (plugin
 * unload, HMR rebuild), so a live seat hears about both instead of keeping its
 * first render's answer for the mount's whole lifetime. A harness that never
 * composes the service never fires, and the face simply stays null.
 */
export function watchSessionsFace(ctx: ClientCtx): void {
  ctx.inject(['sessions'], () => {
    announce()
    return () => { announce() }
  })
}
