/** Hand a wheel delta the rows region cannot use to the operative page scrollport.
 *
 * The region carries `overscroll-behavior: contain` (styles/browser.css) so a scrub past its ends never
 * drags the page — and the card's fixed head — out of view. Chromium applies that boundary to a region
 * with nothing to scroll as well: every category collapsed is the common case, and the wheel then dies
 * inside the card while the page under it cannot move. This resolves the host scrollport the way the
 * reveal helpers do and moves it by `deltaY` pixels. False — never a throw — when the region has its own
 * overflow to scroll, or when no ancestor can take the delta. */

export function wheelToPage(region: Element, deltaY: number): boolean {
  if (region.scrollHeight > region.clientHeight) return false
  try {
    for (let el = region.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      // The OPERATIVE scroller, not just an overflow-styled one: a box that grows with its content
      // (an outer dialog around the filled card) reports auto yet never moves.
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += deltaY
        return true
      }
    }
  } catch { /* the page degrades to no scroll */ }
  return false
}
