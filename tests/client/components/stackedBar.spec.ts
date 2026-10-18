import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import type { PartsPart } from '../../../src/client/categories'
import type { ContextReserve } from '../../../src/client/reserve'
import { click, hover, makeKit, mount, query, queryAll, tipRows, unhover } from '../helpers/kit'

const kit = makeKit()
const StackedBar = makeStackedBar(kit)
const Legend = makeLegend(kit)

function part(key: string, value: number, raw?: number): PartsPart {
  return { key, color: '#123456', value, ...(raw !== undefined ? { raw } : {}) }
}

/** A parent that really holds the hover key, so hovering re-renders the bar. */
function HoverHarness(props: { parts: PartsPart[]; max?: number; minBand?: number; reserve?: ContextReserve }) {
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

describe('StackedBar entrance grow', () => {
  test('segments and the free track carry the grow-in stagger slots in layout order; the reserve masks stay unanimated', async () => {
    const m = await mount(h(StackedBar, {
      parts: [part('system', 700), part('user', 300)],
      max: 2000,
      reserve: { threshold: 1400, headroom: 300, output: 300 },
    }))
    const slot = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--lc-i')
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(slot(segs[0]), '0')
    assert.equal(slot(segs[1]), '1')
    // The free track opens right after the last occupied segment; the masks carry no slot.
    assert.equal(slot(query(m.container, '.lc-stacked-free')), '2')
    for (const mask of queryAll(m.container, '.lc-reserve')) assert.equal(slot(mask), '')
    await m.unmount()
  })

  test('the stagger caps so a long DNA band list settles fast', async () => {
    // Twelve occupied bands: past the cap every late band joins at the same slot, the free track one after.
    const parts = Array.from({ length: 12 }, (_, i) => part(`band-${i}`, i + 1))
    const m = await mount(h(StackedBar, { parts, max: 200 }))
    const slot = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--lc-i')
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 12)
    assert.equal(slot(segs[0]), '0')
    assert.equal(slot(segs[8]), '8')
    assert.equal(slot(segs[11]), '8')
    assert.equal(slot(query(m.container, '.lc-stacked-free')), '9')
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
    assert.equal(tip.getAttribute('role'), 'tooltip')
    assert.deepEqual(tipRows(tip), ['User Messages', '≈900 · 88% of used context', null])
    assert.equal(tip.style.left, '27.5%')
    assert.equal(tip.style.transform, '')
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    assert.equal(query(m.container, '.lc-occupied-box').className, 'lc-occupied-box')
    await m.unmount()
  })

  test('the first tiny segment anchors the tooltip to its true center; raw count drives the figure row', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('system', 100, 120), part('user', 900)], max: 2000 }))
    await hover(queryAll(m.container, '.lc-stacked-seg')[0])
    const tip = query(m.container, '.lc-bar-tip')
    assert.deepEqual(tipRows(tip), ['System Prompt', '≈120 · 12% of used context', null])
    assert.equal(tip.style.left, '2.5%')
    await m.unmount()
  })

  test('hovering the free track shows the free-window tooltip', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('user', 1000)], max: 2000 }))
    await hover(query(m.container, '.lc-stacked-free'))
    assert.ok(query(m.container, '.lc-stacked-free').className.includes('lc-stacked-free-on'))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), ['Free Window', '1.0k · 50% of window', null])
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
    assert.deepEqual(tipRows(tip), ['User Messages', '≈0 · 0% of used context', null])
    await m.unmount()
  })

  test('degenerate negative counts pin scale to 0 while a free track opens: free tooltip shows 0%', async () => {
    // Token counts are never negative in production; this guards the scale>0
    // fallback in the free-tooltip math against corrupt input.
    const m = await mount(h(StackedBar, { parts: [part('user', -5)], max: 0, hoverKey: 'free' }))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), ['Free Window', '5 · 0% of window', null])
    await m.unmount()
  })

  test('a tip that would overhang the bar is shifted back inside by its own measured width', async () => {
    const props = { parts: [part('system', 100, 120), part('user', 900)], max: 2000, hoverKey: 'system' }
    const m = await mount(h(StackedBar, props))
    const wrap = query(m.container, '.lc-stacked-wrap')
    const tip = query(m.container, '.lc-bar-tip')
    // jsdom lays nothing out: pin the two boxes the measure pass reads.
    const pin = (el: Element, width: number): void => {
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width, height: 0, right: width, bottom: 0 }),
      })
    }
    pin(wrap, 400)
    pin(tip, 300)
    // Segment 0 centers at 2.5% → 10px, so the left half overhangs by 140.
    await m.update(h(StackedBar, props))
    assert.equal(tip.style.transform, 'translateX(calc(-50% + 140px))')
    // A tip that fits keeps the bare percentage anchor, unshifted.
    pin(tip, 60)
    await m.update(h(StackedBar, { ...props, hoverKey: 'user' }))
    assert.equal(tip.style.left, '27.5%')
    assert.equal(tip.style.transform, '')
    // The free track centers at 75% → 300px; a wider tip now overhangs on the RIGHT instead.
    pin(tip, 260)
    await m.update(h(StackedBar, { ...props, hoverKey: 'free' }))
    assert.equal(tip.style.transform, 'translateX(calc(-50% - 30px))')
    // Dropping the hover retracts the shift along with the bubble.
    await m.update(h(StackedBar, { ...props, hoverKey: null }))
    assert.equal(tip.style.transform, '')
    await m.unmount()
  })

  test('a tip whose boxes collapse to zero width clears a previous shift', async () => {
    const props = { parts: [part('system', 100, 120), part('user', 900)], max: 2000, hoverKey: 'system' }
    const m = await mount(h(StackedBar, props))
    const wrap = query(m.container, '.lc-stacked-wrap')
    const tip = query(m.container, '.lc-bar-tip')
    const pin = (el: Element, width: number): void => {
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, width, height: 0, right: width, bottom: 0 }),
      })
    }
    pin(wrap, 400)
    pin(tip, 300)
    await m.update(h(StackedBar, props))
    assert.equal(tip.style.transform, 'translateX(calc(-50% + 140px))')
    pin(wrap, 0)
    pin(tip, 0)
    await m.update(h(StackedBar, props))
    assert.equal(tip.style.transform, '')
    await m.unmount()
  })

  test('a tip whose boxes lay out at zero width keeps the bare anchor', async () => {
    // jsdom reports zero rects: the measure pass must bail out without shifting the bubble.
    const m = await mount(h(StackedBar, { parts: [part('system', 100, 120), part('user', 900)], max: 2000, hoverKey: 'system' }))
    const tip = query(m.container, '.lc-bar-tip')
    await m.update(h(StackedBar, { parts: [part('system', 100, 120), part('user', 900)], max: 2000, hoverKey: 'system' }))
    assert.equal(tip.style.transform, '')
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

describe('StackedBar reserve masks', () => {
  const RESERVE = { threshold: 800, headroom: 100, output: 100 }

  test('a bound pressure budget: the two masks tile the window tail from the trigger, no line', async () => {
    const m = await mount(h(HoverHarness, { parts: [part('user', 100)], max: 1000, reserve: RESERVE }))
    const headroom = query(m.container, '.lc-reserve-headroom')
    assert.equal(headroom.style.left, '80%')
    assert.equal(headroom.style.width, '10%')
    const output = query(m.container, '.lc-reserve-output')
    assert.equal(output.style.left, '90%')
    assert.equal(output.style.width, '10%')
    // The headroom mask's own left edge IS the trigger, so no separate line is drawn.
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
    await hover(headroom)
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), ['Compaction Headroom', '100', 'Auto-compaction is expected to fire at 80% of the window'])
    assert.equal(tip.style.left, '85%')
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked') // hoverKey cleared
    await unhover(headroom)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await hover(output)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['LLM Output Reservation', '100', 'The model\'s maximum output tokens'])
    assert.equal(query(m.container, '.lc-bar-tip').style.left, '95%')
    // Stack-level mouseleave also clears an active mask hover.
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('a bound window fraction: true-size masks at the window tail, the trigger as its own line', async () => {
    // threshold 800 sits strictly left of the masks' 840 edge: headroom + output (160) < 20% of the window.
    const reserve = { threshold: 800, headroom: 60, output: 100 }
    const m = await mount(h(HoverHarness, { parts: [part('user', 100)], max: 1000, reserve }))
    const headroom = query(m.container, '.lc-reserve-headroom')
    assert.equal(headroom.style.left, '84%')
    assert.equal(headroom.style.width, '6%')
    const output = query(m.container, '.lc-reserve-output')
    assert.equal(output.style.left, '90%')
    assert.equal(output.style.width, '10%')
    const line = query(m.container, '.lc-trigger')
    assert.equal(line.style.left, '80%')
    // The headroom mask describes only itself; the trigger fact belongs to the line.
    await hover(headroom)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['Compaction Headroom', '60', 'Buffer kept free ahead of the output reservation'])
    await unhover(headroom)
    await hover(line)
    const tip = query(m.container, '.lc-bar-tip')
    assert.deepEqual(tipRows(tip), ['Auto-compaction trigger', '800 · 80% of window', 'Compaction fires when the used tokens reach this line'])
    assert.equal(tip.style.left, '80%')
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked') // hoverKey cleared
    await unhover(line)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('a zero-extent mask is dropped; an output-only reserve renders the rightmost mask alone', async () => {
    const m = await mount(h(HoverHarness, {
      parts: [part('user', 100)],
      max: 1000,
      reserve: { threshold: 1000, headroom: 0, output: 0 },
    }))
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
    await m.update(h(HoverHarness, {
      parts: [part('user', 100)],
      max: 1000,
      reserve: { threshold: 900, headroom: 0, output: 100 },
    }))
    assert.equal(queryAll(m.container, '.lc-reserve-headroom').length, 0)
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
    const output = query(m.container, '.lc-reserve-output')
    assert.equal(output.style.left, '90%')
    assert.equal(output.style.width, '10%')
    await m.unmount()
  })

  test('a used region past the window rescales the masks with the track', async () => {
    const m = await mount(h(HoverHarness, {
      parts: [part('user', 2000)],
      max: 1000,
      reserve: RESERVE,
    }))
    // scale = the occupied total: the window tail now occupies the bar's second half.
    assert.equal(query(m.container, '.lc-reserve-headroom').style.left, '40%')
    assert.equal(query(m.container, '.lc-reserve-headroom').style.width, '5%')
    assert.equal(query(m.container, '.lc-reserve-output').style.left, '45%')
    await m.unmount()
  })

  test('not rendered without a positive window, even when configured', async () => {
    const reserve = RESERVE
    const m = await mount(h(StackedBar, { parts: [part('user', 100)], reserve }))
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
    await m.update(h(StackedBar, { parts: [part('user', 100)], max: 0, reserve }))
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
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
    assert.deepEqual(tipRows(tip), ['bash · 09:00:00', '≈30 · 30% of used context', null])
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
    assert.deepEqual(tipRows(tip), ['User Messages', '≈10 · 1% of used context', null])
    assert.equal(tip.style.left, '97.5%', 'the anchor is the floored sliver\'s rendered center, not the true 99% one')
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
