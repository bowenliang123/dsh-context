import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { revealInScrollParent, revealRowInCard, scrollIntoViewIfPossible } from '../../src/client/revealScroll'

const top = (t: number): DOMRect => ({ top: t }) as DOMRect

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
})
