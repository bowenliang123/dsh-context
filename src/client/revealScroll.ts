export function scrollIntoViewIfPossible(el: Element | null, options?: ScrollIntoViewOptions): void {
  if (el === null || typeof el.scrollIntoView !== 'function') return
  el.scrollIntoView(options)
}

export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
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

export function revealRowInCard(card: Element | null, row: Element | null): void {
  if (card === null || row === null || !card.contains(row)) return
  const scroller = scrollerInCard(card, row)
  if (scroller === null) return
  const rb = row.getBoundingClientRect()
  const sb = scroller.getBoundingClientRect()
  const visTop = Math.max(sb.top, 0)
  const visBottom = Math.min(sb.bottom, window.innerHeight)
  if (rb.top < visTop) scroller.scrollTop -= visTop - rb.top
  else if (rb.bottom > visBottom) scroller.scrollTop += rb.bottom - visBottom
}
