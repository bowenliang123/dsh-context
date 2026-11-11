import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeLegend, makeStackedBar, SEGMENT_ANIMATION_MAX } from '../../../src/client/components/stackedBar'
import { type PartsPart } from '../../../src/client/categories'
import { type ContextReserve } from '../../../src/client/reserve'
import { click, hover, makeKit, mount, query, queryAll, tipRows, unhover, surfaceNode, text } from '../helpers/kit'
import { makeRequestDetail } from '../../../src/client/components/requestDetail'
import { type RequestRecord, type ContextEventRecord, type SurfaceNode } from '../../../src/shared/types'
import { type ConversationNodeLike } from '../../../src/client/services'
import { type StepBrief } from '../../../src/client/brief'

describe('stackedBar', () => {

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
})

describe('requestDetail', () => {

const kit = makeKit()
const RequestDetail = makeRequestDetail(kit, makeStackedBar(kit), makeLegend(kit))

function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    time: 1_700_000_000_000, seq: 10, turn: 1, step: 1,
    system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 250, total: 1300,
    ...over,
  }
}


const FULL = { system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 250, total: 1300 }

const CHIP_ANATOMY = ['', 'lc-chip-label', 'lc-chip-nums']
const anatomy = (container: HTMLElement): string[][] =>
  queryAll(container, '.lc-legend .lc-chip').map(c => Array.from(c.children).map(el => el.className.split(' ')[0]))

describe('RequestDetail header', () => {
  test('null request renders nothing', async () => {
    const m = await mount(h(RequestDetail, { request: null }))
    assert.equal(m.container.innerHTML, '')
    await m.unmount()
  })

  test('step detail: title, time, usage chips, per-category chips', async () => {
    const m = await mount(h(RequestDetail, {
      request: req({ prompt: 1000, output: 120, cacheRead: 500 }),
    }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Turn 1 · Step 1'))
    assert.ok(head.includes('Turn 1 · Step 1 of 1'), 'no stepsOf getter degrades to a 1-step turn')
    assert.ok(!head.includes('Last Step'), 'single-step request carries no last-step tag')
    assert.ok(!head.includes('Delta'), 'cumulative mode carries no delta tag')
    assert.ok(head.includes('Actual 1.0k'))
    assert.ok(head.includes('Output 120'))
    assert.ok(head.includes('Cache 50.00%'), 'real cacheHitPercent: 500/1000 truncated to two decimals')
    const ms = await mount(h(RequestDetail, { request: req({}), stepsOf: (turn) => (turn === 1 ? 7 : 1) }))
    assert.ok(text(query(ms.container, '.lc-detail-head')).includes('Turn 1 · Step 1 of 7'))
    await ms.unmount()
    const chips = queryAll(m.container, '.lc-legend .lc-chip')
    assert.equal(chips.length, 7)
    assert.ok(text(chips[0]).includes('System Prompt'))
    assert.ok(text(chips[0]).includes('≈100'))
    const pcts = queryAll(m.container, '.lc-chip-nums em').map(el => text(el))
    assert.ok(pcts.some(p => p.endsWith('%')), 'percentages rendered when total > 0')
    assert.equal(pcts[0], '8%', 'the share rides the used total: 100 of 1300')
    assert.deepEqual(anatomy(m.container), Array.from({ length: 7 }, () => CHIP_ANATOMY))
    await m.unmount()
  })

  test('usage chips drop out when the figures are absent; cache falls back to a dash when nothing was billed', async () => {
    const m = await mount(h(RequestDetail, { request: req({}) }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(!head.includes('Actual'))
    assert.ok(!head.includes('Output'))
    assert.ok(!head.includes('Cache'))
    await m.unmount()

    const m2 = await mount(h(RequestDetail, { request: req({ prompt: 0, cacheRead: 0 }) }))
    const head2 = text(query(m2.container, '.lc-detail-head'))
    assert.ok(head2.includes('Cache —%'), 'prompt 0 → cacheHitPercent null → dash')
    assert.ok(!head2.includes('Output'))
    await m2.unmount()
  })

  test('turn aggregate shows the step count and the last-step tag; stepCount 1 stays a step', async () => {
    const m = await mount(h(RequestDetail, { request: req({ turn: 2, stepCount: 3 }) }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Turn 2 · 3 steps'))
    assert.ok(head.includes('Last Step'))
    await m.unmount()

    const m2 = await mount(h(RequestDetail, { request: req({ turn: 2, step: 4, stepCount: 1 }) }))
    const head2 = text(query(m2.container, '.lc-detail-head'))
    assert.ok(head2.includes('Turn 2 · Step 4'))
    assert.ok(!head2.includes('Last Step'))
    await m2.unmount()

    const bare: RequestRecord = {
      time: 1_700_000_000_000, seq: 3,
      system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0, total: 4,
    }
    const m3 = await mount(h(RequestDetail, { request: bare }))
    assert.ok(text(query(m3.container, '.lc-detail-head')).includes('Turn 0 · Step 0'))
    await m3.unmount()
    const m4 = await mount(h(RequestDetail, { request: { ...bare, stepCount: 2 } }))
    assert.ok(text(query(m4.container, '.lc-detail-head')).includes('Turn 0 · 2 steps'))
    await m4.unmount()
  })

  test('boundary marker shows where the event happened; in-flight markers hide', async () => {
    const marker: ContextEventRecord = {
      seq: 9, time: 1_699_999_999_000, kind: 'compaction', count: 3,
      fromTurn: 2, fromStep: 3, turn: 2, step: 4,
    }
    const m = await mount(h(RequestDetail, { request: req({}), marker }))
    const chip = query(m.container, '.lc-detail-marker')
    assert.ok(text(chip).includes('✂ T2 S3→4'))
    assert.equal(chip.getAttribute('title'), 'Context compacted (summary replaced 3 messages)')
    await m.unmount()

    const m4 = await mount(h(RequestDetail, {
      request: req({}),
      marker: { seq: 9, time: 1, kind: 'prune' },
    }))
    assert.equal(queryAll(m4.container, '.lc-detail-marker').length, 0)
    await m4.unmount()

    const m5 = await mount(h(RequestDetail, { request: req({}), marker: null }))
    assert.equal(queryAll(m5.container, '.lc-detail-marker').length, 0)
    await m5.unmount()
  })
})

describe('RequestDetail delta mode', () => {
  test('signed deltas vs the previous record: net chip, signed chips, no usage chips', async () => {
    const request = req({ system: 150, tools: 200, user: 250, inject: 0, assistant: 300, tool: 350, total: 1250, prompt: 900 })
    const prev = req({ ...FULL, inject: 0 })
    const m = await mount(h(RequestDetail, { request, prev }))
    const head = text(query(m.container, '.lc-detail-head'))
    assert.ok(head.includes('Delta'), 'delta tag shown')
    assert.ok(!head.includes('Actual'), 'usage chips drop out in delta mode')
    const metric = query(m.container, '.lc-detail-metric')
    assert.ok(text(metric).includes('Δ 0'))
    assert.ok(!metric.className.includes('lc-detail-metric-up'))
    assert.ok(!metric.className.includes('lc-detail-metric-down'))
    const figs = queryAll(m.container, '.lc-chip-nums')
    assert.ok(text(figs[0]).includes('+50'))
    assert.ok(figs[0].className.includes('lc-chip-nums-up'))
    assert.ok(text(figs[2]).includes('-50'))
    assert.ok(figs[2].className.includes('lc-chip-nums-down'))
    assert.ok(!figs[1].className.includes('lc-chip-nums-up'), 'zero delta is neutral')
    assert.equal(queryAll(m.container, '.lc-chip-nums em').length, 0, 'a signed change carries no share')
    assert.deepEqual(anatomy(m.container), Array.from({ length: 7 }, () => CHIP_ANATOMY), 'delta chips carry no diverging bar')
    await m.unmount()
  })

  test('delta with prev null reads against zeros (all up); shrink-only deltas go down', async () => {
    const m = await mount(h(RequestDetail, { request: req({}), prev: null }))
    const metric = query(m.container, '.lc-detail-metric')
    assert.ok(metric.className.includes('lc-detail-metric-up'))
    assert.ok(text(metric).includes('Δ +1.3k'))
    assert.equal(queryAll(m.container, '.lc-chip-nums-down').length, 0)
    assert.equal(queryAll(m.container, '.lc-chip-nums-up').length, 6, 'every non-zero category reads up')
    await m.unmount()

    const m2 = await mount(h(RequestDetail, {
      request: req({ system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 }),
      prev: req({ ...FULL }),
    }))
    const metric2 = query(m2.container, '.lc-detail-metric')
    assert.ok(metric2.className.includes('lc-detail-metric-down'))
    assert.ok(text(metric2).includes('Δ -1.3k'))
    assert.equal(queryAll(m2.container, '.lc-chip-nums-up').length, 0)
    assert.equal(queryAll(m2.container, '.lc-chip-nums-down').length, 6)
    await m2.unmount()

    const zero = await mount(h(RequestDetail, {
      request: req({ system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 }),
    }))
    const zeroFigs = queryAll(zero.container, '.lc-chip-nums').map(el => text(el))
    assert.equal(zeroFigs.length, 7)
    assert.ok(zeroFigs.every(f => f === '≈0'))
    assert.equal(queryAll(zero.container, '.lc-chip-nums em').length, 0)
    await zero.unmount()
  })
})

describe('RequestDetail composition bar hover-link', () => {
  test('the mirrored hoverKey dims the bar, lights the matching segment and chip; the tip stays off', async () => {
    const m = await mount(h(RequestDetail, { request: req({}), hoverKey: 'tools' }))
    const bar = query(m.container, '.lc-stacked')
    assert.ok(bar.className.includes('lc-stacked-dim'), 'a mirrored hover dims the bar')
    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 6, 'all six categories render')
    assert.ok(segs[1].className.includes('lc-stacked-seg-on'), 'exactly the tools segment (CATS order) lights')
    assert.ok(segs.filter(s => s.className.includes('lc-stacked-seg-on')).length === 1)
    const chips = queryAll(m.container, '.lc-legend .lc-chip')
    assert.ok(chips[1].className.includes('lc-chip-on'), 'the tools chip lights too')
    assert.ok(chips.filter(c => c.className.includes('lc-chip-on')).length === 1)
    assert.equal(queryAll(m.container, '.lc-bar-tip').length, 0, 'a mirrored hover floats no tooltip')

    const m2 = await mount(h(RequestDetail, { request: req({}) }))
    assert.equal(query(m2.container, '.lc-stacked').className, 'lc-stacked')
    assert.equal(queryAll(m2.container, '.lc-chip-on').length, 0)
    assert.equal(queryAll(m2.container, '.lc-bar-tip').length, 0)
    await m2.unmount()
    await m.unmount()

    const delta = await mount(h(RequestDetail, { request: req({}), prev: req({ ...FULL }), hoverKey: 'user' }))
    const deltaChips = queryAll(delta.container, '.lc-legend .lc-chip')
    assert.ok(deltaChips[2].className.includes('lc-chip-on'), 'the user chip lights in delta mode')
    assert.ok(deltaChips.filter(c => c.className.includes('lc-chip-on')).length === 1)
    await delta.unmount()
  })
})

describe('RequestDetail brief section', () => {
  const convOk: ConversationNodeLike = {
    kind: 'tool-result', seq: 21,
    call: { name: 'bash', argsRaw: '{"description":"list files"}' },
    content: [{ type: 'text', text: 'a.txt' }],
  }

  test('the brief lane is constant: an absent brief reserves its height, not collapse', async () => {
    const m = await mount(h(RequestDetail, { request: req({}), brief: null }))
    assert.equal(queryAll(m.container, '.lc-brief').length, 1, 'the lane always renders')
    assert.equal(queryAll(m.container, '.lc-brief-row').length, 1, 'only the always-present In row placeholder')
    await m.unmount()
  })

  test('opener, inputs with overflow, and reply rows render with tags and previews', async () => {
    const brief: StepBrief = {
      opener: surfaceNode({ seq: 1, cat: 'user', text: 'please refactor this' }),
      inputs: [
        surfaceNode({ seq: 21, cat: 'tool', tool: 'bash' }),
        surfaceNode({ seq: 22, cat: 'inject', form: 'snapshot', text: 'state v2' }),
        surfaceNode({ seq: 23, cat: 'user', text: 'extra note', imgs: 3 }),
        surfaceNode({ seq: 24, cat: 'inject', form: 'notice' }),
      ],
      response: surfaceNode({ seq: 25, cat: 'assistant', calls: ['bash', 'write'], text: 'done' }),
    }
    const m = await mount(h(RequestDetail, {
      request: req({}), brief,
      convOf: (seq) => seq === 21 ? convOk : undefined,
    }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows.length, 3)
    assert.ok(text(rows[0]).includes('please refactor this'), 'opener row carries the user text')
    assert.ok(text(rows[0]).includes('User'), 'opener tagged as the turn opener')
    const chips = queryAll(rows[1], '.lc-brief-chip')
    assert.equal(chips.length, 3, 'inputs capped at MAX_CHIPS')
    assert.ok(text(rows[1]).includes('+1'), 'overflow pill counts the hidden inputs')
    assert.ok(text(chips[0]).includes('bash') && text(chips[0]).includes('list files'), 'tool chip: name tag + call summary')
    assert.ok(text(chips[1]).includes('State Snapshot') && text(chips[1]).includes('Snapshot: state v2'))
    assert.ok(text(chips[2]).includes('Image ×3'), 'user chip counts attachments')
    assert.equal(rows[0].tagName, 'DIV')
    assert.ok(!chips[0].className.includes('lc-brief-chip-link'))
    const replyChip = query(rows[2], '.lc-brief-chip')
    assert.ok(replyChip.className.includes('lc-brief-chip-grow'))
    assert.ok(text(replyChip).includes('bash › write'))
    assert.ok(text(replyChip).includes('done'))
    assert.equal(queryAll(m.container, '.lc-brief-tip').length, 3)
    assert.equal(chips[0].getAttribute('title'), 'bash · list files')
    await m.unmount()
  })

  test('locate linkage: row clicks locate their node; chip clicks locate their own node only', async () => {
    const calls: { seq: number; isResponse: boolean }[] = []
    const onLocate = (n: SurfaceNode, isResponse: boolean): void => {
      calls.push({ seq: n.seq, isResponse })
    }
    const brief: StepBrief = {
      opener: surfaceNode({ seq: 1, cat: 'user', text: 'open' }),
      inputs: [
        surfaceNode({ seq: 21, cat: 'tool', tool: 'bash', err: true }),
        surfaceNode({ seq: 22, cat: 'inject', form: 'catalog', text: 'tools changed' }),
      ],
      response: surfaceNode({ seq: 25, cat: 'assistant', text: 'reply text' }),
    }
    const m = await mount(h(RequestDetail, {
      request: req({}), brief, onLocate,
      convOf: (seq) => seq === 21 ? convOk : undefined,
    }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows[0].tagName, 'BUTTON', 'rows become buttons when locate is wired')
    assert.equal(queryAll(rows[1], '.lc-br-err-dot').length, 1)
    const chip = queryAll(rows[1], '.lc-brief-chip')[1]
    assert.ok(chip.className.includes('lc-brief-chip-link'))
    await click(chip)
    assert.deepEqual(calls, [{ seq: 22, isResponse: false }], 'stopPropagation keeps the row handler out')
    await click(rows[1] as HTMLElement)
    assert.deepEqual(calls[1], { seq: 21, isResponse: false })
    await click(rows[2] as HTMLElement)
    assert.deepEqual(calls[2], { seq: 25, isResponse: true })
    const replyChip = query(rows[2], '.lc-brief-chip')
    assert.ok((replyChip.getAttribute('title') ?? '').includes('Reveal in Context Browser'))
    await click(rows[0] as HTMLElement)
    assert.deepEqual(calls[3], { seq: 1, isResponse: false })
    await m.unmount()
  })

  test('chipParts cascade: tool/assistant/inject/user kinds and the skill-inject fallback', async () => {
    const inputs: SurfaceNode[] = [
      surfaceNode({ seq: 30, cat: 'skill', skill: 'code-review', tool: 'skill' }),
      surfaceNode({ seq: 31, cat: 'tool', tool: 'read' }),
      surfaceNode({ seq: 32, cat: 'tool' }),
      surfaceNode({ seq: 33, cat: 'assistant', calls: ['bash'], text: 'looking' }),
      surfaceNode({ seq: 34, cat: 'assistant', calls: ['write'] }),
      surfaceNode({ seq: 35, cat: 'assistant' }),
      surfaceNode({ seq: 36, cat: 'assistant', calls: [] }),
      surfaceNode({ seq: 37, cat: 'inject', form: 'relay', text: 'from agent' }),
      surfaceNode({ seq: 38, cat: 'inject', text: 'plain' }),
      surfaceNode({ seq: 39, cat: 'user', imgs: 1 }),
      surfaceNode({ seq: 40, cat: 'user', text: 'hi' }),
    ]
    const convs: Record<number, ConversationNodeLike> = {
      30: { kind: 'tool-result', seq: 30, call: { name: 'bash', argsRaw: '{"description":"load skill"}' } },
      34: { kind: 'assistant', seq: 34, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
      35: { kind: 'assistant', seq: 35, blocks: [{ kind: 'tool-call', name: 'read', argsRaw: '{}' }] },
      44: { kind: 'assistant', seq: 44, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
    }
    const render = async (list: SurfaceNode[]) => {
      const m = await mount(h(RequestDetail, {
        request: req({}),
        brief: { inputs: list },
        convOf: (seq) => convs[seq],
      }))
      return m
    }
    const chipText = (m: Awaited<ReturnType<typeof render>>, i: number) =>
      text(queryAll(m.container, '.lc-brief-chip')[i])

    const m1 = await render(inputs.slice(0, 3))
    assert.ok(chipText(m1, 0).includes('Skill · code-review') && chipText(m1, 0).includes('load skill'))
    assert.equal(chipText(m1, 1), 'read', 'tool name tag without a join leaves no text')
    assert.equal(chipText(m1, 2), 'Tool Result', 'untagged tool falls back to the placeholder text')
    await m1.unmount()

    const m2 = await render(inputs.slice(3, 6))
    assert.ok(chipText(m2, 0).includes('bash') && chipText(m2, 0).includes('looking'))
    assert.ok(chipText(m2, 1).includes('write') && chipText(m2, 1).includes('a.ts'), 'block summary through the join')
    assert.equal(chipText(m2, 2), 'read', 'breadcrumb from the join, no preview text')
    await m2.unmount()

    const m3 = await render(inputs.slice(6, 9))
    assert.equal(chipText(m3, 0), '(empty reply)')
    assert.ok(chipText(m3, 1).includes('Agent Relay') && chipText(m3, 1).includes('from agent'))
    assert.ok(chipText(m3, 2).includes('Context Injection') && chipText(m3, 2).includes('plain'))
    await m3.unmount()

    const m4 = await render(inputs.slice(9))
    assert.equal(chipText(m4, 0), 'Image', 'single image: no count suffix')
    assert.equal(chipText(m4, 1), 'hi')
    await m4.unmount()

    const m5 = await render([surfaceNode({ seq: 41, cat: 'skill', skill: 'ponytail' })])
    assert.equal(chipText(m5, 0), 'Skill · ponytail', 'a text-less skill row tags the name')
    await m5.unmount()
    const m6 = await render([surfaceNode({ seq: 42, cat: 'skill', skill: 'ponytail', text: 'notes inside' })])
    assert.ok(chipText(m6, 0).includes('Skill · ponytail') && chipText(m6, 0).includes('notes inside'))
    await m6.unmount()

    const m7 = await render([surfaceNode({ seq: 43, cat: 'mystery' as never, text: 'survivor' })])
    assert.equal(chipText(m7, 0), 'survivor', 'hostile cat renders its text plainly')
    await m7.unmount()
    const m8 = await render([surfaceNode({ seq: 44, cat: 'mystery' as never, calls: ['bash', 'read'] })])
    assert.equal(chipText(m8, 0), '', 'hostile cat with no text renders an inert chip')
    await m8.unmount()

    const m11 = await render([surfaceNode({ seq: 47, cat: 'skill', skill: 'grilling', tool: 'skill' })])
    assert.equal(chipText(m11, 0), 'Skill · grilling')
    await m11.unmount()
    const m11b = await render([
      surfaceNode({ seq: 471, cat: 'skill', form: 'catalog' }),
      surfaceNode({ seq: 472, cat: 'skill' }),
    ])
    assert.equal(chipText(m11b, 0), 'Catalog Update')
    assert.equal(chipText(m11b, 1), 'Context Injection')
    await m11b.unmount()
    const m12 = await render([surfaceNode({ seq: 48, cat: 'inject', form: 'notice' })])
    assert.equal(chipText(m12, 0), 'Notice')
    await m12.unmount()
  })

  test('the In row always renders: muted empty state when nothing entered, chips otherwise', async () => {
    const calls: { seq: number; isResponse: boolean }[] = []
    const onLocate = (n: SurfaceNode, isResponse: boolean): void => {
      calls.push({ seq: n.seq, isResponse })
    }
    const brief: StepBrief = {
      opener: surfaceNode({ seq: 1, cat: 'user' }),
      inputs: [],
    }
    const m = await mount(h(RequestDetail, { request: req({}), brief, onLocate }))
    const rows = queryAll(m.container, '.lc-brief-row')
    assert.equal(rows.length, 2, 'the opener row plus the ALWAYS-present In row')
    assert.equal(queryAll(rows[0], '.lc-brief-fact').length, 0, 'no fact tag on a plain user opener')
    assert.equal(queryAll(rows[0], '.lc-brief-text').length, 0, 'no text span without preview')
    assert.ok(text(rows[1]).includes('(nothing new)'), 'the empty In row carries the placeholder')
    assert.equal(queryAll(rows[1], '.lc-brief-chip').length, 0, 'empty state carries no chips')
    await click(rows[1] as HTMLElement)
    assert.deepEqual(calls, [], 'a row without a node stays inert even with locate wired')
    await m.unmount()

    const m2 = await mount(h(RequestDetail, {
      request: req({}),
      brief: { inputs: [surfaceNode({ seq: 5, cat: 'user', text: 'just input' })] },
    }))
    const rows2 = queryAll(m2.container, '.lc-brief-row')
    assert.equal(rows2.length, 1)
    assert.ok(text(rows2[0]).includes('In'), 'the single row is the inputs row')
    assert.equal(queryAll(m2.container, '.lc-brief-more').length, 0, 'no overflow pill at the cap')
    await m2.unmount()

    const m3 = await mount(h(RequestDetail, {
      request: req({}),
      brief: { opener: surfaceNode({ seq: 7, cat: 'user', text: 'see attached', imgs: 2 }), inputs: [] },
    }))
    const fact = query(m3.container, '.lc-brief-fact')
    assert.equal(text(fact), 'Image ×2')
    assert.ok(text(query(m3.container, '.lc-brief-text')).includes('see attached'))
    await m3.unmount()
  })
})
})
