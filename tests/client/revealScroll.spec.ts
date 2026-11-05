import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { revealInScrollParent, revealRowInCard, scrollIntoViewIfPossible, scrollToPos, settleReveal } from '../../src/client/revealScroll'

const top = (t: number): DOMRect => ({ top: t }) as DOMRect

afterEach(() => {
  vi.unstubAllGlobals()
})

function queueFrames(): { flush: () => void } {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  return {
    flush: (): void => {
      while (frames.length > 0) frames.shift()?.(0)
    },
  }
}

function spyScrollTo(el: HTMLElement): ScrollToOptions[] {
  const calls: ScrollToOptions[] = []
  Object.defineProperty(el, 'scrollTo', {
    value: (options?: ScrollToOptions): void => {
      if (options !== undefined) calls.push(options)
    },
  })
  return calls
}

function stubReducedMotion(reduced: boolean | 'throw'): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    if (query !== '(prefers-reduced-motion: reduce)') throw new Error('unexpected query')
    if (reduced === 'throw') throw new Error('boom')
    return { matches: reduced }
  })
}

function mounted(oy: 'auto' | 'scroll', scrollerTop: number, anchorTop: number): { scroller: HTMLDivElement; anchor: HTMLDivElement } {
  const scroller = document.createElement('div')
  scroller.style.overflowY = oy
  Object.defineProperty(scroller, 'scrollHeight', { value: 500 })
  Object.defineProperty(scroller, 'clientHeight', { value: 200 })
  scroller.getBoundingClientRect = () => top(scrollerTop)
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => top(anchorTop)
  scroller.appendChild(anchor)
  document.body.appendChild(scroller)
  return { scroller, anchor }
}

describe('revealInScrollParent', () => {
  test("scrolls the nearest 'auto' or 'scroll' ancestor so the anchor tops its scrollport; a grow-with-content box is skipped", () => {
    const auto = mounted('auto', 100, 450)
    auto.scroller.scrollTop = 42
    assert.equal(revealInScrollParent(auto.anchor), true)
    assert.equal(auto.scroller.scrollTop, 392, 'the rect delta lands the anchor flush: 42 + (450 − 100)')
    auto.scroller.remove()

    const scroll = mounted('scroll', 0, 200)
    assert.equal(revealInScrollParent(scroll.anchor), true)
    assert.equal(scroll.scroller.scrollTop, 200)
    scroll.scroller.remove()

    const grown = mounted('auto', 0, 300)
    const inner = document.createElement('div')
    inner.style.overflowY = 'auto'
    Object.defineProperty(inner, 'scrollHeight', { value: 300 })
    Object.defineProperty(inner, 'clientHeight', { value: 300 })
    inner.appendChild(grown.anchor)
    grown.scroller.appendChild(inner)
    assert.equal(revealInScrollParent(grown.anchor), true)
    assert.equal(grown.scroller.scrollTop, 300, 'the real scroller above takes the delta')
    grown.scroller.remove()
  })

  test('with a live scrollTo the delta is applied through it as a smooth scroll, leaving scrollTop untouched', () => {
    const auto = mounted('auto', 100, 450)
    auto.scroller.scrollTop = 42
    const calls = spyScrollTo(auto.scroller)
    assert.equal(revealInScrollParent(auto.anchor), true)
    assert.deepEqual(calls, [{ top: 392, left: undefined, behavior: 'smooth' }])
    assert.equal(auto.scroller.scrollTop, 42)
    auto.scroller.remove()
  })

  test('reduced motion downgrades the smooth scroll to an instant one, and a throwing matchMedia keeps it smooth', () => {
    stubReducedMotion(true)
    const reduced = mounted('auto', 0, 260)
    const reducedCalls = spyScrollTo(reduced.scroller)
    assert.equal(revealInScrollParent(reduced.anchor), true)
    assert.deepEqual(reducedCalls, [{ top: 260, left: undefined, behavior: 'instant' }])
    reduced.scroller.remove()

    stubReducedMotion('throw')
    const noisy = mounted('auto', 0, 260)
    const noisyCalls = spyScrollTo(noisy.scroller)
    assert.equal(revealInScrollParent(noisy.anchor), true)
    assert.deepEqual(noisyCalls, [{ top: 260, left: undefined, behavior: 'smooth' }])
    noisy.scroller.remove()
  })

  test('a plain ancestor chain to body, a detached anchor, and a hostile chain all report false without throwing', () => {
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    assert.equal(revealInScrollParent(plain), false)
    plain.remove()
    assert.equal(revealInScrollParent(document.createElement('div')), false)
    const hostile = {
      get parentElement(): never { throw new Error('boom') },
    } as unknown as Element
    assert.equal(revealInScrollParent(hostile), false)
  })
})

describe('revealRowInCard', () => {
  const rect = (t: number, b: number): DOMRect => ({ top: t, bottom: b }) as DOMRect

  function mounted(rowTop: number, rowBottom: number, regionOverflow = true): {
    page: HTMLDivElement; card: HTMLDivElement; region: HTMLDivElement; row: HTMLDivElement
  } {
    const page = document.createElement('div')
    const card = document.createElement('div')
    const region = document.createElement('div')
    const row = document.createElement('div')
    region.appendChild(row)
    card.appendChild(region)
    page.appendChild(card)
    document.body.appendChild(page)
    Object.defineProperty(region, 'scrollHeight', { value: regionOverflow ? 600 : 300 })
    Object.defineProperty(region, 'clientHeight', { value: regionOverflow ? 200 : 300 })
    region.getBoundingClientRect = () => rect(0, 200)
    row.getBoundingClientRect = () => rect(rowTop, rowBottom)
    region.scrollTop = 30
    page.scrollTop = 55
    return { page, card, region, row }
  }

  test('a row above or below the visible slice scrolls the rows region to it; a fully visible row scrolls nothing', () => {
    const above = mounted(-10, 20)
    revealRowInCard(above.region.parentElement, above.row)
    assert.equal(above.region.scrollTop, 20, 'the row reaches the slice top: 30 − (0 − (−10))')
    assert.equal(above.page.scrollTop, 55, 'nothing above the card moves')
    const below = mounted(250, 280)
    revealRowInCard(below.region.parentElement, below.row)
    assert.equal(below.region.scrollTop, 110, 'the row reaches the slice bottom: 30 + (280 − 200)')

    const visible = mounted(10, 60)
    revealRowInCard(visible.region.parentElement, visible.row)
    assert.equal(visible.region.scrollTop, 30)
    assert.equal(visible.page.scrollTop, 55)
  })

  test('with a live scrollTo the adjustment rides through it as a smooth scroll', () => {
    const above = mounted(-10, 20)
    const calls = spyScrollTo(above.region)
    revealRowInCard(above.region.parentElement, above.row)
    assert.deepEqual(calls, [{ top: 20, left: undefined, behavior: 'smooth' }])
    assert.equal(above.region.scrollTop, 30)
    assert.equal(above.page.scrollTop, 55)
  })

  test('a region that does not overflow ends the walk at the card; a null card, null row, or outside row does nothing', () => {
    const still = mounted(250, 280, false)
    revealRowInCard(still.card, still.row)
    assert.equal(still.region.scrollTop, 30)
    assert.equal(still.card.scrollTop, 0)
    assert.equal(still.page.scrollTop, 55)

    const { card, row } = mounted(0, 10)
    const stranger = document.createElement('div')
    document.body.appendChild(stranger)
    assert.doesNotThrow(() => {
      revealRowInCard(null, row)
      revealRowInCard(card, null)
      revealRowInCard(card, stranger)
    })
    stranger.remove()
  })

})

function box(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: 10, writable: true })
  Object.defineProperty(el, 'scrollLeft', { value: 20, writable: true })
  return el
}

describe('scrollToPos', () => {
  test('without scrollTo the top and left land as direct assignments, each axis only when present', () => {
    const both = box()
    scrollToPos(both, { top: 300, left: 90 })
    assert.equal(both.scrollTop, 300)
    assert.equal(both.scrollLeft, 90)

    const topOnly = box()
    scrollToPos(topOnly, { top: 44 })
    assert.equal(topOnly.scrollTop, 44)
    assert.equal(topOnly.scrollLeft, 20)

    const leftOnly = box()
    scrollToPos(leftOnly, { left: 44 })
    assert.equal(leftOnly.scrollTop, 10)
    assert.equal(leftOnly.scrollLeft, 44)
  })

  test('with a live scrollTo one call carries both axes and the default smooth behavior', () => {
    const el = box()
    const calls = spyScrollTo(el)
    scrollToPos(el, { top: 300, left: 90 })
    assert.deepEqual(calls, [{ top: 300, left: 90, behavior: 'smooth' }])
    assert.equal(el.scrollTop, 10)
    assert.equal(el.scrollLeft, 20)
  })

  test('an explicit behavior passes through; reduced motion downgrades smooth, and a throwing matchMedia does not', () => {
    const el = box()
    const calls = spyScrollTo(el)
    scrollToPos(el, { top: 1 }, 'instant')
    assert.deepEqual(calls, [{ top: 1, left: undefined, behavior: 'instant' }])

    stubReducedMotion(true)
    scrollToPos(el, { top: 2 })
    assert.deepEqual(calls[1], { top: 2, left: undefined, behavior: 'instant' })

    stubReducedMotion('throw')
    scrollToPos(el, { top: 3 })
    assert.deepEqual(calls[2], { top: 3, left: undefined, behavior: 'smooth' })
  })
})

describe('scrollIntoViewIfPossible', () => {
  test('a null element or one without the verb is a no-op; the live verb receives the options', () => {
    const bare = document.createElement('div')
    Object.defineProperty(bare, 'scrollIntoView', { value: undefined })
    assert.doesNotThrow(() => {
      scrollIntoViewIfPossible(null)
      scrollIntoViewIfPossible(bare)
    })
    const calls: (ScrollIntoViewOptions | undefined)[] = []
    const el = document.createElement('div')
    el.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { calls.push(options as ScrollIntoViewOptions | undefined) }
    scrollIntoViewIfPossible(el, { block: 'nearest', behavior: 'smooth' })
    assert.deepEqual(calls, [{ block: 'nearest', behavior: 'smooth' }])
  })

  test('reduced motion rewrites a requested smooth scroll into an instant one, keeping the rest of the options', () => {
    stubReducedMotion(true)
    const calls: (ScrollIntoViewOptions | undefined)[] = []
    const el = document.createElement('div')
    el.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { calls.push(options as ScrollIntoViewOptions | undefined) }
    scrollIntoViewIfPossible(el, { block: 'center', inline: 'center', behavior: 'smooth' })
    assert.deepEqual(calls, [{ block: 'center', inline: 'center', behavior: 'instant' }])
  })
})

describe('settleReveal', () => {
  test('issues the alignment once, waits out the glide, then re-checks once from the settled position', () => {
    const { flush } = queueFrames()
    const el = box()
    const issues: number[] = []
    const align = vi.fn((): boolean => {
      issues.push(el.scrollTop)
      if (issues.length === 1) {
        el.scrollTop = 300
        return true
      }
      return false
    })
    settleReveal(el, align)
    flush()
    assert.equal(align.mock.calls.length, 2, 'one issue and one settled re-check')
    assert.equal(el.scrollTop, 300)
  })

  test('an alignment already in place gets one settled re-check and stops without issuing', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => false)
    settleReveal(el, align)
    flush()
    assert.equal(align.mock.calls.length, 2)
    assert.equal(el.scrollTop, 10)
  })

  test('a stubborn alignment keeps re-issuing only up to the budget', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => true)
    settleReveal(el, align, 5)
    flush()
    assert.equal(align.mock.calls.length, 5)
  })

  test('a newer run on the same element supersedes the older loop', () => {
    const { flush } = queueFrames()
    const el = box()
    const first = vi.fn((): boolean => true)
    const second = vi.fn((): boolean => false)
    settleReveal(el, first)
    settleReveal(el, second)
    flush()
    assert.equal(first.mock.calls.length, 1, 'the superseded loop never frames again')
    assert.equal(second.mock.calls.length, 2)
  })

  test('user input on the scroller cancels the settle loop', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => true)
    settleReveal(el, align)
    el.dispatchEvent(new Event('wheel'))
    flush()
    assert.equal(align.mock.calls.length, 1)
  })
})
