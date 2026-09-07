// StackedBar + Legend (src/client/components/stackedBar.tsx) rendered with
// real React through a state-holding hover harness, plus direct mounts for
// the scale/free/reserve/tooltip branch matrix.

import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import type { PartsPart } from '../../../src/client/categories'
import { click, hover, makeKit, mount, query, queryAll, unhover } from '../helpers/kit'

const kit = makeKit()
const StackedBar = makeStackedBar(kit)
const Legend = makeLegend(kit)

function part(key: string, value: number, raw?: number): PartsPart {
  return { key, color: '#123456', value, ...(raw !== undefined ? { raw } : {}) }
}

/** A parent that really holds the hover key, so hovering re-renders the bar. */
function HoverHarness(props: { parts: PartsPart[]; max?: number; minBand?: number; reserve?: { ratio: number; label: string } }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return h(StackedBar, { parts: props.parts, max: props.max, minBand: props.minBand, hoverKey, onHoverKey: setHoverKey, reserve: props.reserve })
}

describe('StackedBar layout', () => {
  test('empty parts: no segments, default height, zero-width occupied box, idle tooltip slot', async () => {
    const m = await mount(h(StackedBar, { parts: [] }))
    const stack = query(m.container, '.lc-stacked')
    assert.equal(stack.style.height, '14px')
    assert.equal(queryAll(m.container, '.lc-stacked-seg').length, 0)
    assert.equal(queryAll(m.container, '.lc-stacked-free').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    const box = query(m.container, '.lc-occupied-box')
    assert.equal(box.className, 'lc-occupied-box')
    assert.equal(box.style.width, '0%')
    const tip = query(m.container, '.lc-bar-tip')
    assert.equal(tip.className, 'lc-tip lc-bar-tip')
    assert.equal(tip.textContent, '')
    assert.equal(tip.style.left, '50%')
    await m.unmount()
  })

  test('max undefined: segments span the full bar, no free track', async () => {
    const m = await mount(h(StackedBar, { parts: [part('system', 700), part('user', 300)] }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 2)
    assert.equal(segs[0].style.width, '70%')
    assert.equal(segs[1].style.width, '30%')
    assert.equal(queryAll(m.container, '.lc-stacked-free').length, 0)
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
    await m.unmount()
  })

  test('max <= total: window ignored for widths, no free track', async () => {
    const m = await mount(h(StackedBar, { parts: [part('system', 100), part('user', 100)], max: 100 }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs[0].style.width, '50%')
    assert.equal(queryAll(m.container, '.lc-stacked-free').length, 0)
    await m.unmount()
  })

  test('max > total: free track fills the rest of the window', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 1000)], max: 2000 }))
    assert.equal(query(m.container, '.lc-stacked-seg').style.width, '50%')
    assert.equal(query(m.container, '.lc-stacked-free').style.width, '50%')
    await m.unmount()
  })

  test('zero-value parts are skipped; custom height applies', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 0), part('system', 100)], height: 22 }))
    assert.equal(queryAll(m.container, '.lc-stacked-seg').length, 1)
    assert.equal(query(m.container, '.lc-stacked').style.height, '22px')
    await m.unmount()
  })

  test('tip={false} drops the tooltip slot entirely', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 100)], tip: false, hoverKey: 'user' }))
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0)
    await m.unmount()
  })
})

describe('StackedBar hover link', () => {
  test('hovering a segment lights it, dims the stack, frames the occupied box, and floats the tooltip', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('system', 100, 120), part('user', 900)], max: 2000 }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    await hover(segs[1])
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.ok(segs[1].className.includes('lc-stacked-seg-on'))
    assert.ok(!segs[0].className.includes('lc-stacked-seg-on'))
    const box = query(m.container, '.lc-occupied-box')
    assert.ok(box.className.includes('lc-occupied-box-on'))
    assert.equal(box.style.width, '50%')
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'User Messages ≈900 (88%) of used context')
    assert.equal(tip.style.left, '27.5%')
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    assert.equal(query(m.container, '.lc-occupied-box').className, 'lc-occupied-box')
    await m.unmount()
  })

  test('the first tiny segment clamps the tooltip to the 12% edge; raw count drives the tooltip figure', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('system', 100, 120), part('user', 900)], max: 2000 }))
    await hover(queryAll(m.container, '.lc-stacked-seg')[0])
    const tip = query(m.container, '.lc-bar-tip')
    assert.equal(tip.textContent, 'System Prompt ≈120 (12%) of used context')
    assert.equal(tip.style.left, '12%')
    await m.unmount()
  })

  test('hovering the free track shows the free-window tooltip', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('user', 1000)], max: 2000 }))
    await hover(query(m.container, '.lc-stacked-free'))
    assert.ok(query(m.container, '.lc-stacked-free').className.includes('lc-stacked-free-on'))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'Free Window 1.0k (50%)')
    assert.equal(tip.style.left, '75%')
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('hoverKey free without a free track: dimmed but no tooltip', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 1000)], hoverKey: 'free' }))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.equal(queryAll(m.container, '.lc-stacked-free').length, 0)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('hoverKey on a zero-value part: no tooltip (scale 0 and value 0 arms)', async () => {
    const m = await mount(h(StackedBar, { parts: [part('zero', 0)], hoverKey: 'zero' }))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('rawTotal 0 (raw explicitly zero): tooltip percentage falls back to 0%', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 100, 0)], hoverKey: 'user' }))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'User Messages ≈0 (0%) of used context')
    await m.unmount()
  })

  test('degenerate negative counts pin scale to 0 while a free track opens: free tooltip shows 0%', async () => {
    // Token counts are never negative in production; this guards the scale>0
    // fallback in the free-tooltip math against corrupt input.
    const m = await mount(h(StackedBar, { parts: [part('user', -5)], max: 0, hoverKey: 'free' }))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'Free Window 5 (0%)')
    await m.unmount()
  })

  test('hover without onHoverKey is a no-op and never throws', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 100)], max: 200 }))
    await hover(query(m.container, '.lc-stacked-seg'))
    await hover(query(m.container, '.lc-stacked-free'))
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
    await m.unmount()
  })
})

describe('StackedBar reserve band', () => {
  test('rendered over the rightmost window slice; hover shows its label and yields the hover link', async () => {
    const m = await mount(h(HoverHarness, {
      parts: [part('user', 100)],
      max: 1000,
      reserve: { ratio: 0.8, label: 'reserved headroom' },
    }))
    const band = query(m.container, '.lc-reserve')
    assert.equal(band.style.left, '80%')
    assert.equal(band.style.width, '20%')
    await hover(band)
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'reserved headroom')
    assert.equal(tip.style.left, '88%') // clamped: 80 + 20/2 = 90 → 88
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked') // hoverKey cleared
    await unhover(band)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    // Stack-level mouseleave also clears an active reserve hover.
    await hover(band)
    assert.ok(query(m.container, '.lc-bar-tip').className.includes('lc-bar-tip-on'))
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('not rendered without a positive window, even when configured', async () => {
    const reserve = { ratio: 0.8, label: 'reserved headroom' }
    const m = await mount(h(StackedBar, { parts: [part('user', 100)], reserve }))
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    await m.update(h(StackedBar, { parts: [part('user', 100)], max: 0, reserve }))
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    await m.unmount()
  })
})

describe('Legend', () => {
  test('chips show raw counts and used-share percentages', async () => {
    const m = await mount(h(Legend, { parts: [part('system', 100, 120), part('user', 900)] }))
    const chips = queryAll(m.container, '.lc-chip')
    assert.equal(chips.length, 2)
    assert.equal(chips[0].getAttribute('title'), 'of used context')
    assert.equal(query(chips[0], '.lc-chip-label').textContent, 'System Prompt')
    assert.equal(query(chips[0], '.lc-chip-nums').textContent, '≈12012%')
    assert.equal(query(chips[1], '.lc-chip-nums').textContent, '≈90088%')
    await m.unmount()
  })

  test('total 0: chips render without the percentage figure', async () => {
    const m = await mount(h(Legend, { parts: [part('user', 0)] }))
    assert.equal(query(m.container, '.lc-chip-nums').textContent, '≈0')
    assert.equal(queryAll(m.container, 'em').length, 0)
    await m.unmount()
  })

  test('chip hover drives the shared hover key; matching chip lights up', async () => {
    const seen: (string | null)[] = []
    const m = await mount(h(Legend, { parts: [part('system', 100), part('user', 900)], hoverKey: 'user', onHoverKey: k => seen.push(k) }))
    const chips = queryAll(m.container, '.lc-chip')
    assert.ok(chips[1].className.includes('lc-chip-on'))
    assert.ok(!chips[0].className.includes('lc-chip-on'))
    await hover(chips[0])
    await unhover(chips[0])
    assert.deepEqual(seen, ['system', null])
    await m.unmount()
  })

  test('chip hover without onHoverKey is a no-op', async () => {
    const m = await mount(h(Legend, { parts: [part('user', 10)], hoverKey: null }))
    const chip = query(m.container, '.lc-chip')
    assert.ok(!chip.className.includes('lc-chip-on'))
    await hover(chip)
    await unhover(chip)
    await m.unmount()
  })
})
describe('StackedBar DNA bands', () => {
  test('a part label overrides the category name in the tooltip', async () => {
    const m = await mount(h(HoverHarness, {
      parts: [{ key: 'n3', color: '#123456', value: 30, label: 'bash · 09:00:00' }, part('user', 70)],
    }))
    await hover(queryAll(m.container, '.lc-stacked-seg')[0])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, 'bash · 09:00:00 ≈30 (30%) of used context')
    await m.unmount()
  })

  test('group hover: a mirrored category key lights every band of that group but floats no tooltip', async () => {
    const parts: PartsPart[] = [
      { key: 'n1', color: '#123456', value: 10, group: 'tool' },
      { key: 'n2', color: '#123456', value: 20, group: 'tool' },
      { key: 'n3', color: '#654321', value: 70, group: 'user' },
    ]
    const m = await mount(h(StackedBar, { parts, hoverKey: 'tool' }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.ok(segs[0].className.includes('lc-stacked-seg-on'))
    assert.ok(segs[1].className.includes('lc-stacked-seg-on'))
    assert.ok(!segs[2].className.includes('lc-stacked-seg-on'))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip', 'no exact key — no tooltip')
    // The exact key still lights just its own band.
    await m.update(h(StackedBar, { parts, hoverKey: 'n3' }))
    const segs2 = queryAll(m.container, '.lc-stacked-seg')
    assert.ok(!segs2[0].className.includes('lc-stacked-seg-on'))
    assert.ok(!segs2[1].className.includes('lc-stacked-seg-on'))
    assert.ok(segs2[2].className.includes('lc-stacked-seg-on'))
    await m.unmount()
  })

  test('onPickKey: segments gain the pick cursor and report their key on click', async () => {
    const picks: string[] = []
    const m = await mount(h(StackedBar, { parts: [part('a', 40), part('b', 60)], onPickKey: (k) => { picks.push(k) } }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.ok(segs[0].className.includes('lc-stacked-seg-pick'))
    assert.ok(segs[1].className.includes('lc-stacked-seg-pick'))
    await click(segs[1])
    assert.deepEqual(picks, ['b'])
    await m.unmount()
  })
})
describe('StackedBar minBand floor', () => {
  test('a sub-pixel band pins to the floor and the rest rescale; the tooltip keeps the true share', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('assistant', 990), part('user', 10)], minBand: 5 }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs[0].style.width, '95%')
    assert.equal(segs[1].style.width, '5%')
    await hover(segs[1])
    const tip = query(m.container, '.lc-bar-tip')
    assert.equal(tip.textContent, 'User Messages ≈10 (1%) of used context')
    assert.equal(tip.style.left, '88%', 'the tooltip clamps to the bar edge on a floored sliver')
    await m.unmount()
  })

  test('the floor caps at the equal split when bands outnumber it', async () => {
    const m = await mount(h(StackedBar, { parts: [part('assistant', 90), part('user', 5), part('tool', 5)], minBand: 50 }))
    const floor = Math.min(50, 100 / 3)
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs[1].style.width, `${floor}%`)
    assert.equal(segs[2].style.width, `${floor}%`)
    // The unpinned band rescales into the remaining room (the same arithmetic the component runs).
    assert.equal(segs[0].style.width, `${90 * (100 - 2 * floor) / 90}%`)
    await m.unmount()
  })

  test('a single visible band spans the bar regardless of the floor; zero-value parts stay skipped', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 0), part('system', 100)], minBand: 10 }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 1)
    assert.equal(segs[0].style.width, '100%')
    await m.unmount()
  })

  test('minBand 0 or no band below the floor keeps exact widths', async () => {
    const m = await mount(h(StackedBar, { parts: [part('assistant', 99), part('user', 1)], minBand: 0 }))
    assert.deepEqual(queryAll(m.container, '.lc-stacked-seg').map(s => s.style.width), ['99%', '1%'])
    await m.unmount()
    const m2 = await mount(h(StackedBar, { parts: [part('assistant', 60), part('user', 40)], minBand: 1 }))
    assert.deepEqual(queryAll(m2.container, '.lc-stacked-seg').map(s => s.style.width), ['60%', '40%'])
    await m2.unmount()
  })
})
