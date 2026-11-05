export interface ScrollPos {
  top?: number
  left?: number
}

function reducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function resolveBehavior(behavior: ScrollBehavior): ScrollBehavior {
  return behavior === 'smooth' && reducedMotion() ? 'instant' : behavior
}

export function scrollToPos(el: Element, pos: ScrollPos, behavior: ScrollBehavior = 'smooth'): void {
  const resolved = resolveBehavior(behavior)
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: pos.top, left: pos.left, behavior: resolved })
    return
  }
  if (pos.top !== undefined) el.scrollTop = pos.top
  if (pos.left !== undefined) el.scrollLeft = pos.left
}

const settleRuns = new WeakMap<Element, number>()

export function settleReveal(el: HTMLElement, align: () => boolean, budget = 90): void {
  const run = (settleRuns.get(el) ?? 0) + 1
  settleRuns.set(el, run)
  let lastTop = el.scrollTop
  let lastLeft = el.scrollLeft
  let ticks = 0
  let active = true
  const stop = (): void => { active = false }
  const detach = (): void => {
    el.removeEventListener('wheel', stop)
    el.removeEventListener('touchstart', stop)
    el.removeEventListener('pointerdown', stop)
    el.removeEventListener('keydown', stop)
  }
  el.addEventListener('wheel', stop, { passive: true })
  el.addEventListener('touchstart', stop, { passive: true })
  el.addEventListener('pointerdown', stop, { passive: true })
  el.addEventListener('keydown', stop)
  const step = (): void => {
    if (!active || settleRuns.get(el) !== run) {
      detach()
      return
    }
    ticks += 1
    if (ticks >= budget) {
      detach()
      return
    }
    const still = el.scrollTop === lastTop && el.scrollLeft === lastLeft
    lastTop = el.scrollTop
    lastLeft = el.scrollLeft
    if (!still || align()) {
      requestAnimationFrame(step)
      return
    }
    detach()
  }
  align()
  requestAnimationFrame(step)
}

export function scrollIntoViewIfPossible(el: Element | null, options?: ScrollIntoViewOptions): void {
  if (el === null || typeof el.scrollIntoView !== 'function') return
  if (options?.behavior === 'smooth' && reducedMotion()) {
    el.scrollIntoView({ ...options, behavior: 'instant' })
    return
  }
  el.scrollIntoView(options)
}

export function revealInScrollParent(anchor: Element, behavior: ScrollBehavior = 'smooth'): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        scrollToPos(el, { top: el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top }, behavior)
        return true
      }
    }
  } catch {}
  return false
}

function scrollerInCard(card: Element, row: Element): HTMLElement | null {
  let scroller: HTMLElement | null = row.parentElement
  while (scroller !== null && scroller !== card && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement
  }
  return scroller === null || scroller === card ? null : scroller
}

export function revealRowInCard(card: Element | null, row: Element | null, behavior: ScrollBehavior = 'smooth'): void {
  if (card === null || row === null || !card.contains(row)) return
  const scroller = scrollerInCard(card, row)
  if (scroller === null) return
  const rb = row.getBoundingClientRect()
  const sb = scroller.getBoundingClientRect()
  const visTop = Math.max(sb.top, 0)
  const visBottom = Math.min(sb.bottom, window.innerHeight)
  if (rb.top < visTop) scrollToPos(scroller, { top: scroller.scrollTop - (visTop - rb.top) }, behavior)
  else if (rb.bottom > visBottom) scrollToPos(scroller, { top: scroller.scrollTop + rb.bottom - visBottom }, behavior)
}
