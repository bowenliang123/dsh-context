// The horizontal-overscroll guard (src/client/overscroll.ts): a swipe the scroller cannot consume must be
// canceled so the browser never reads it as a history swipe; everything the scroller CAN consume, and every
// vertical-dominant gesture, passes through untouched.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { containHorizontalOverscroll } from '../../src/client/overscroll'
import { wheel } from './helpers/kit'

/** A div with test-controlled scroll metrics (jsdom lays nothing out). */
function scroller(scrollLeft: number, clientWidth: number, scrollWidth: number): HTMLDivElement {
  const el = document.createElement('div')
  let left = scrollLeft
  Object.defineProperties(el, {
    scrollLeft: { configurable: true, get: () => left, set: (v: number) => { left = v } },
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
  })
  return el
}

describe('containHorizontalOverscroll', () => {
  test('cancels only the horizontal gestures the scroller cannot consume', () => {
    const el = scroller(100, 100, 300)
    const release = containHorizontalOverscroll(el)

    // Mid-scroll both directions belong to the scroller.
    assert.equal(wheel(el, 30, 0), false, 'rightward mid-scroll')
    assert.equal(wheel(el, -30, 0), false, 'leftward mid-scroll')
    // Vertical-dominant and vertical-only gestures belong to the page's own scrolling.
    assert.equal(wheel(el, 30, 120), false, 'vertical-dominant at the edge')
    assert.equal(wheel(el, 0, 0), false, 'no horizontal component')
    // The right edge (1px tolerance) is where the browser would start its history swipe.
    el.scrollLeft = 200
    assert.equal(wheel(el, 30, 0), true, 'right edge')
    assert.equal(wheel(el, -30, 0), false, 'leftward off the right edge scrolls back')
    // The left edge cancels the leftward swipe only.
    el.scrollLeft = 0
    assert.equal(wheel(el, -30, 0), true, 'left edge')
    assert.equal(wheel(el, 30, 0), false, 'rightward off the left edge scrolls on')
    // Fractional device-pixel offsets land just short of the exact end.
    el.scrollLeft = 199.5
    assert.equal(wheel(el, 30, 0), true, 'right edge with a fractional offset')

    release()
    assert.equal(wheel(el, 30, 0), false, 'the disposer removed the listener')
  })
})
