/**
 * The live registration gate a show/hide preference drives: `mount` registers whatever the preference serves
 * and returns those registrations' handles (the slot registry's own disposers, `unknown` because the face is
 * re-proved at the boundary), and this owner mounts, unmounts, and re-arms them as the store publishes.
 */

import type { ContextSettings } from './settings'

/** @returns the watcher's disposer: unsubscribe, then unwind whatever is mounted. */
export function watchGate(
  store: ContextSettings['store'],
  wanted: () => boolean,
  mount: () => readonly unknown[],
): () => void {
  let mounted = false
  let disposers: (() => void)[] = []
  const unmount = (): void => {
    while (disposers.length > 0) disposers.pop()?.()
  }
  const apply = (): void => {
    const want = wanted()
    if (want && !mounted) {
      mounted = true
      disposers = mount().filter((handle): handle is () => void => typeof handle === 'function')
    } else if (!want && mounted) {
      mounted = false
      unmount()
    }
  }
  apply()
  const unsubscribe = store.subscribe(apply)
  return () => {
    unsubscribe()
    if (mounted) {
      mounted = false
      unmount()
    }
  }
}
