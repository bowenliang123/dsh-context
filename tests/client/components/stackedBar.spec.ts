import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeLegend, makeStackedBar, SEGMENT_ANIMATION_MAX } from '../../../src/client/components/stackedBar'
import type { PartsPart } from '../../../src/client/categories'
import type { ContextReserve } from '../../../src/client/reserve'
import { click, hover, makeKit, mount, query, queryAll, tipRows, unhover } from '../helpers/kit'

const kit = makeKit()
const StackedBar = makeStackedBar(kit)
const Legend = makeLegend(kit)

function part(key: string, value: number, raw?: number): PartsPart {
  return { key, color: '#123456', value, ...(raw !== undefined ? { raw } : {}) }
}

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

  test('segment widths split the used total or the window; zero-value parts are skipped and a custom height applies', async () => {
    const full = await mount(h(StackedBar, { parts: [part('system', 700), part('user', 300)] }))
    assert.deepEqual(queryAll(full.container, '.lc-stacked-seg').map(s => s.style.width), ['70%', '30%'])
    assert.equal(queryAll(full.container, '.lc-stacked-free').length, 0)
    await full.unmount()

    const windowed = await mount(h(StackedBar, { parts: [part('user', 1000)], max: 2000 }))
    assert.equal(query(windowed.container, '.lc-stacked-seg').style.width, '50%')
    assert.equal(query(windowed.container, '.lc-stacked-free').style.width, '50%')
    await windowed.unmount()

    const over = await mount(h(StackedBar, { parts: [part('user', 1000)], max: 500 }))
    assert.equal(query(over.container, '.lc-stacked-seg').style.width, '100%')
    assert.equal(queryAll(over.container, '.lc-stacked-free').length, 0)
    await over.unmount()

    const custom = await mount(h(StackedBar, { parts: [part('user', 0), part('system', 100)], height: 22 }))
    assert.equal(queryAll(custom.container, '.lc-stacked-seg').length, 1)
    assert.equal(query(custom.container, '.lc-stacked').style.height, '22px')
    await custom.unmount()
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
    assert.equal(slot(query(m.container, '.lc-stacked-free')), '2')
    for (const mask of queryAll(m.container, '.lc-reserve')) assert.equal(slot(mask), '')
    await m.unmount()

    const capped = await mount(h(StackedBar, { parts: Array.from({ length: 12 }, (_, i) => part(`band-${i}`, i + 1)), max: 200 }))
    const cappedSegs = queryAll(capped.container, '.lc-stacked-seg')
    assert.equal(cappedSegs.length, 12)
    assert.equal(slot(cappedSegs[0]), '0')
    assert.equal(slot(cappedSegs[8]), '8')
    assert.equal(slot(cappedSegs[11]), '8')
    assert.equal(slot(query(capped.container, '.lc-stacked-free')), '9')
    await capped.unmount()
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
    await hover(segs[0])
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

  test('an unresolvable hover key: no free track dims without a tooltip; a zero-value part floats none', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 1000)], hoverKey: 'free' }))
    assert.ok(query(m.container, '.lc-stacked').className.includes('lc-stacked-dim'))
    assert.equal(queryAll(m.container, '.lc-stacked-free').length, 0)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()

    const zero = await mount(h(StackedBar, { parts: [part('zero', 0)], hoverKey: 'zero' }))
    assert.equal(query(zero.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await zero.unmount()
  })

  test('rawTotal 0 (raw explicitly zero): tooltip percentage falls back to 0%', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 100, 0)], hoverKey: 'user' }))
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), ['User Messages', '≈0 · 0% of used context', null])
    await m.unmount()
  })

  test('degenerate negative counts pin scale to 0 while a free track opens: free tooltip shows 0%', async () => {
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
    pin(tip, 60)
    await m.update(h(StackedBar, { ...props, hoverKey: 'user' }))
    assert.equal(tip.style.left, '27.5%')
    assert.equal(tip.style.transform, '')
    pin(tip, 260)
    await m.update(h(StackedBar, { ...props, hoverKey: 'free' }))
    assert.equal(tip.style.transform, 'translateX(calc(-50% - 30px))')
    await m.update(h(StackedBar, { ...props, hoverKey: null }))
    assert.equal(tip.style.transform, '')
    pin(wrap, 400)
    pin(tip, 300)
    await m.update(h(StackedBar, props))
    assert.equal(tip.style.transform, 'translateX(calc(-50% + 140px))')
    pin(wrap, 0)
    pin(tip, 0)
    await m.update(h(StackedBar, { ...props, hoverKey: 'user' }))
    assert.equal(tip.style.transform, '')
    pin(wrap, 400)
    pin(tip, 0)
    await m.update(h(StackedBar, { ...props, hoverKey: 'free' }))
    assert.equal(tip.style.transform, '')
    pin(wrap, 0)
    pin(tip, 300)
    await m.update(h(StackedBar, props))
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
    assert.equal(queryAll(m.container, '.lc-trigger').length, 0)
    await hover(headroom)
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.deepEqual(tipRows(tip), ['Compaction Headroom', '100', 'Auto-compaction is expected to fire at 80% of the window'])
    assert.equal(tip.style.left, '85%')
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
    await unhover(headroom)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await hover(output)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['LLM Output Reservation', '100', 'The model\'s maximum output tokens'])
    assert.equal(query(m.container, '.lc-bar-tip').style.left, '95%')
    await unhover(query(m.container, '.lc-stacked'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')

    const over = await mount(h(HoverHarness, { parts: [part('user', 2000)], max: 1000, reserve: RESERVE }))
    assert.equal(query(over.container, '.lc-reserve-headroom').style.left, '40%')
    assert.equal(query(over.container, '.lc-reserve-headroom').style.width, '5%')
    assert.equal(query(over.container, '.lc-reserve-output').style.left, '45%')
    await over.unmount()
  })

  test('a bound window fraction: true-size masks at the window tail, the trigger as its own line', async () => {
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
    await hover(headroom)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['Compaction Headroom', '60', 'Buffer kept free ahead of the output reservation'])
    await unhover(headroom)
    await hover(line)
    const tip = query(m.container, '.lc-bar-tip')
    assert.deepEqual(tipRows(tip), ['Auto-compaction trigger', '800 · 80% of window', 'Compaction fires when the used tokens reach this line'])
    assert.equal(tip.style.left, '80%')
    assert.equal(query(m.container, '.lc-stacked').className, 'lc-stacked')
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

    const zero = await mount(h(Legend, { parts: [part('user', 0)] }))
    assert.equal(query(zero.container, '.lc-chip-nums').textContent, '≈0')
    assert.equal(queryAll(zero.container, 'em').length, 0)
    await zero.unmount()
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

    const inert = await mount(h(Legend, { parts: [part('user', 10)], hoverKey: null }))
    const chip = query(inert.container, '.lc-chip')
    await hover(chip)
    await unhover(chip)
    assert.ok(!chip.className.includes('lc-chip-on'))
    await inert.unmount()
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
    assert.equal(segs[0].style.width, `${90 * (100 - 2 * floor) / 90}%`)
    await m.unmount()
  })

  test('a single visible band spans the bar regardless of the floor; zero-value parts stay skipped; no band below the floor keeps exact widths', async () => {
    const m = await mount(h(StackedBar, { parts: [part('user', 0), part('system', 100)], minBand: 10 }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 1)
    assert.equal(segs[0].style.width, '100%')
    await m.unmount()
    const m2 = await mount(h(StackedBar, { parts: [part('assistant', 99), part('user', 1)], minBand: 0 }))
    assert.deepEqual(queryAll(m2.container, '.lc-stacked-seg').map(s => s.style.width), ['99%', '1%'])
    await m2.unmount()
  })

  test('past the segment cap the entrance animation is dropped, band for band', async () => {
    const few = await mount(h(StackedBar, { parts: [part('user', 4), part('system', 3), part('assistant', 2), part('inject', 1)] }))
    assert.ok(queryAll(few.container, '.lc-stacked-seg').every(s => s.className.includes('animate-lc-stacked-in')))
    await few.unmount()

    const atCap = Array.from({ length: SEGMENT_ANIMATION_MAX }, (_, i) => part('n' + String(i), 10))
    const capped = await mount(h(StackedBar, { parts: atCap }))
    const cappedSegs = queryAll(capped.container, '.lc-stacked-seg')
    assert.ok(cappedSegs.every(s => s.className.includes('animate-lc-stacked-in')))
    assert.equal(capped.container.querySelectorAll('.lc-stacked-seg')[0].getAttribute('style')?.includes('--lc-i'), true)
    await capped.unmount()

    const many = Array.from({ length: SEGMENT_ANIMATION_MAX + 1 }, (_, i) => part('n' + String(i), 10))
    const m = await mount(h(StackedBar, { parts: many }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, many.length)
    assert.deepEqual(segs.filter(s => /animate-/.test(s.className)), [])
    assert.equal(segs[0].getAttribute('style')?.includes('--lc-i'), false, 'no stagger delay left behind')
    await m.unmount()
  })
})

describe('StackedBar keyboard picks', () => {
  test('segments pick on Enter and Space only when a pick handler is wired, and legend chips drive hover from focus', async () => {
    const picks: string[] = []
    const m = await mount(h(StackedBar, { parts: [part('user', 4), part('system', 3)], onPickKey: key => { picks.push(key) } }))
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs[0].getAttribute('role'), 'button')
    assert.equal(segs[0].getAttribute('tabindex'), '0')
    await act(async () => { segs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    assert.deepEqual(picks, [])
    await act(async () => { segs[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    assert.deepEqual(picks, ['user'])
    await act(async () => { segs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    assert.deepEqual(picks, ['user', 'system'])
    await m.unmount()

    const inert = await mount(h(StackedBar, { parts: [part('user', 4)] }))
    assert.equal(query(inert.container, '.lc-stacked-seg').getAttribute('role'), null)
    await inert.unmount()

    const hovers: (string | null)[] = []
    const legend = await mount(h(Legend, { parts: [part('user', 4), part('system', 3)], onHoverKey: key => { hovers.push(key) } }))
    const chip = queryAll(legend.container, '.lc-chip')[0]
    assert.equal(chip.getAttribute('tabindex'), '0')
    await act(async () => { chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    await act(async () => { chip.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.deepEqual(hovers, ['user', null])
    await legend.unmount()

    const guarded = await mount(h(Legend, { parts: [part('user', 4)] }))
    assert.equal(guarded.container.querySelector('.lc-chip')?.getAttribute('tabindex'), null)
    await guarded.unmount()
  })
})
