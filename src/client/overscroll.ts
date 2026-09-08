/**
 * Stop a horizontal scroller's overscroll from reaching the browser's history navigation — the trackpad
 * swipe-back (left edge) and swipe-forward (right edge) gestures. The spec answer is `overscroll-behavior-x:
 * contain`, the harness's own idiom for its horizontal scrollers and what the sheets beside this module's
 * callers already set; it covers Chromium and Firefox, but WebKit still navigates on horizontal overscroll with
 * the property set (bug 240183), where a canceled wheel is the only lever. Without either, one swipe past the
 * edge of the trend chart or the agent graph leaves the whole app for another page in the tab's history.
 */

/**
 * Cancel the horizontal-dominant wheel gestures a scroller cannot consume — the ones the browser would
 * otherwise read as a history swipe. Vertical-dominant gestures are left alone: they belong to the page's own
 * scrolling, and the scrollers this guards only overflow horizontally.
 * @param el - the horizontal scroll container (the listener must be non-passive, so it cannot ride React's passive wheel seat).
 * @returns the disposer removing the listener.
 */
export function containHorizontalOverscroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0
    // 1px tolerance: fractional device-pixel scroll offsets land just short of the exact end.
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    if (atStart || atEnd) e.preventDefault()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => { el.removeEventListener('wheel', onWheel) }
}
