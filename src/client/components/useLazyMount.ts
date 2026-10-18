import { useEffect, useState, type RefObject } from 'react'

/** Give the idle slice (or the timeout fallback) room to mount the deferred block without blocking a scroll frame. */
const IDLE_TIMEOUT_MS = 200

/**
 * Mount a below-the-fold block only once its placeholder nears the conversation viewport (or, without
 * IntersectionObserver, immediately): the first commit then stays small and the deferred cards mount in an
 * idle slice instead of stretching the open's long task. The placeholder keeps the row's measured height.
 */
export function useLazyMount(ref: RefObject<HTMLElement | null>, force = false): boolean {
  const [mounted, setMounted] = useState(() => force || typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (mounted) return
    if (force) {
      setMounted(true)
      return
    }
    const el = ref.current
    if (el === null) return
    /* v8 ignore start -- jsdom has neither IntersectionObserver nor layout: without it the block mounts at once. */
    let idle = 0
    const reveal = (): void => {
      if (typeof requestIdleCallback === 'function') {
        idle = requestIdleCallback(() => { setMounted(true) }, { timeout: IDLE_TIMEOUT_MS })
      } else {
        idle = window.setTimeout(() => { setMounted(true) }, 0)
      }
    }
    const root = el.closest('[data-conversation-scroll]')
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect()
        reveal()
      }
    }, { root: root instanceof Element ? root : null, rootMargin: '200px' })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (idle !== 0) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
        else clearTimeout(idle)
      }
    }
    /* v8 ignore stop */
  }, [ref, mounted, force])
  return mounted
}
