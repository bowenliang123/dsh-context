/** Hand a wheel delta the rows region cannot use to the operative page scrollport.
 *
 * The region carries `overscroll-behavior: contain` (styles/browser.css) so a scrub past its ends never
 * drags the page — and the card's fixed head — out of view. Chromium applies that boundary to a region
 * with nothing to scroll as well: every category collapsed is the common case, and the wheel then dies
 * inside the card while the page under it cannot move. The same happens at the region's ends, and over a
 * region that overflows by a fraction of a pixel. This resolves the host scrollport the way the reveal
 * helpers do and moves it by `deltaY` pixels. False — never a throw — when the region has room to scroll
 * that way, or when no scrollport can take the delta. */

export function wheelToPage(region: Element, deltaY: number): boolean {
  const room = region.scrollHeight - region.clientHeight
  // Only a region that can move in the wheel's direction keeps it: a wheel stopped at the end of the list
  // (or over a rounding-artifact overflow) would otherwise freeze the page under the card.
  const usable = room > 1 && (deltaY > 0 ? region.scrollTop < room - 0.5 : region.scrollTop > 0.5)
  if (usable) return false
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
    // A host may scroll the root element itself, which has no overflow-styled ancestor to find.
    const page = (document.scrollingElement as Element | null | undefined) ?? document.documentElement
    if (page.scrollHeight > page.clientHeight) {
      page.scrollTop += deltaY
      return true
    }
  } catch { /* the page degrades to no scroll */ }
  return false
}
