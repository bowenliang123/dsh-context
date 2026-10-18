import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimingSpan } from '../../../src/shared/types'
import { makeTimingStrip, timingGradientOf } from '../../../src/client/components/timingStrip'
import { flush, makeKit, mount, query, queryAll, hover, unhover } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const Strip = makeTimingStrip(kit)
const StripZh = makeTimingStrip(kitZh)

/** Local HH:MM:SS exactly as the kit's fmtTime renders it (a timezone-free assertion). */
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

// A 50-second session window (epoch 1s → 51s) holding 40s of ACTIVE time: the three decode slices, then tools and overhead — with 5s idle
// gaps between them (21s → 26s and 41s → 46s) that must take NO track on the strip.
const SPANS: TimingSpan[] = [
  { kind: 'ttft', start: 1_000, end: 6_000 },
  { kind: 'reasoning', start: 6_000, end: 16_000 },
  { kind: 'text', start: 16_000, end: 21_000 },
  { kind: 'tools', start: 26_000, end: 41_000 },
  { kind: 'other', start: 46_000, end: 51_000 },
]

const segsOf = (container: HTMLElement): HTMLElement[] => queryAll(container, '.lc-tstrip-seg')
const leftsOf = (container: HTMLElement): number[] => segsOf(container).map(s => parseFloat(s.style.left))
const widthsOf = (container: HTMLElement): number[] => segsOf(container).map(s => parseFloat(s.style.width))

describe('TimingStrip', () => {
  test('every span packs by its share of the active time in occurrence order; the axis ticks the quartiles', async () => {
    const m = await mount(h(Strip, { spans: SPANS }))
    const segs = segsOf(m.container)
    assert.equal(segs.length, 5)
    // Width reads HOW LONG (5/10/5/15/5s of the 40s active total), position
    // reads the running share — the idle gaps (21s→26s, 41s→46s) take no track: tools sits at 50%, not at the wall-clock 62.5%.
    assert.deepEqual(leftsOf(m.container), [0, 12.5, 37.5, 50, 87.5])
    assert.deepEqual(widthsOf(m.container), [12.5, 25, 12.5, 37.5, 12.5])
    assert.deepEqual(segs.map(s => s.style.background), [
      'var(--color-blue-500)',
      'var(--color-violet-500)',
      'var(--color-pink-500)',
      'var(--color-teal-500)',
      'var(--color-slate-400)',
    ])
    // The axis: zero, the three quartiles, and the full span of the 40s ACTIVE total (not the 50s wall window).
    const ticks = queryAll(m.container, '.lc-tstrip-tick')
    assert.deepEqual(ticks.map(t => t.textContent), ['0', '10.0s', '20.0s', '30.0s', '40.0s'])
    assert.deepEqual(ticks.map(t => (t as HTMLElement).style.left), ['0%', '25%', '50%', '75%', '100%'])
    assert.ok(ticks[0].className.includes('lc-tstrip-tick-first'))
    assert.ok(!ticks[2].className.includes('lc-tstrip-tick-first') && !ticks[2].className.includes('lc-tstrip-tick-last'))
    assert.ok(ticks[4].className.includes('lc-tstrip-tick-last'))
    assert.equal(query(m.container, '.lc-tstrip').getAttribute('role'), 'img')
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('the grow-in rides ONE wrapper, never a per-band animation (a packed strip must not storm the compositor)', async () => {
    const spans: TimingSpan[] = []
    for (let i = 0; i < 300; i++) spans.push({ kind: 'tools', start: i * 1_000, end: i * 1_000 + 500 })
    const m = await mount(h(Strip, { spans }))
    const wrapper = queryAll(m.container, '.lc-tstrip-fill')
    assert.equal(wrapper.length, 1)
    assert.ok(wrapper[0].className.includes('animate-lc-stacked-in'))
    assert.ok(wrapper[0].className.includes('motion-reduce:animate-none'))
    // Every band sits INSIDE the wrapper (their percent offsets keep the bar's own box) and carries no animation of its own.
    assert.equal(wrapper[0].querySelectorAll('.lc-tstrip-seg').length, 300)
    assert.deepEqual(queryAll(m.container, '.lc-tstrip-seg').filter(s => /animate-/.test(s.className)), [])
    await m.unmount()
  })

  test('a span hover floats its tip — slice label, true duration, start instant — and relays the kind; leaving clears both', async () => {
    let relayed: string | null = 'unset'
    const m = await mount(h(Strip, { spans: SPANS, hoverKey: null, onHoverKey: (k) => { relayed = k } }))
    await hover(segsOf(m.container)[1])
    assert.equal(relayed, 'reasoning')
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, `Thinking 10.0s · ${timeOf(6_000)}`)
    // Centered on the band's rendered span: 12.5% + 25%/2 = 25%.
    assert.equal((tip as HTMLElement).style.left, '25%')
    await unhover(query(m.container, '.lc-tstrip-bar'))
    assert.equal(relayed, null)
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('the tip pins 10% off both edges for hairline end spans', async () => {
    const m = await mount(h(Strip, { spans: SPANS }))
    const segs = segsOf(m.container)
    await hover(segs[0])
    // 6.25% center clamps to the 10% floor.
    assert.equal((query(m.container, '.lc-bar-tip') as HTMLElement).style.left, '10%')
    await unhover(query(m.container, '.lc-tstrip-bar'))
    await hover(segs[4])
    // 93.75% center clamps to the 90% ceiling.
    assert.equal((query(m.container, '.lc-bar-tip') as HTMLElement).style.left, '90%')
    await m.unmount()
  })

  test('every span of the hovered KIND lights together and dims the rest, WITHOUT floating the tip (the mirror rule)', async () => {
    // A second ttft span (the next step's wait, sitting inside the wall-clock idle window — it packs all the same).
    const spans: TimingSpan[] = [...SPANS, { kind: 'ttft', start: 21_000, end: 26_000 }]
    const m = await mount(h(Strip, { spans, hoverKey: 'ttft' }))
    const on = queryAll(m.container, '.lc-tstrip-seg-on')
    assert.equal(on.length, 2)
    assert.equal(on[0], segsOf(m.container)[0])
    assert.equal(on[1], segsOf(m.container)[5])
    assert.ok(query(m.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('a packed strip paints gradient layers and hit-tests the full band model', async () => {
    const spans: TimingSpan[] = []
    for (let i = 0; i < 700; i++) spans.push({ kind: i % 2 === 0 ? 'ttft' : 'tools', start: i * 1_000, end: i * 1_000 + 500 })
    let relayed: string | null = 'unset'
    const m = await mount(h(Strip, { spans, onHoverKey: (k) => { relayed = k } }))
    // Thousands of sub-pixel divs would be pointless: the dense strip paints two gradients instead.
    assert.equal(segsOf(m.container).length, 0)
    const bar = query(m.container, '.lc-tstrip-bar')
    // A zero-width box cannot answer a hit and keeps the tip closed.
    await act(async () => { bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10 })) })
    await flush()
    assert.equal(queryAll(m.container, '.lc-bar-tip-on').length, 0)
    Object.defineProperty(bar, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1_000, height: 12, right: 1_000, bottom: 12 }),
    })
    await act(async () => { bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500 })) })
    await flush()
    // 700 equal 0.5s bands: half-way is band 350 (even → ttft).
    assert.equal(relayed, 'ttft')
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.ok(tip.textContent?.startsWith('TTFT 500ms'))
    assert.ok(tip.textContent?.includes(timeOf(350_000)))
    // Past the right edge clamps to the last band.
    await act(async () => { bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1_500 })) })
    await flush()
    assert.equal(relayed, 'tools')
    await unhover(bar)
    assert.equal(relayed, null)
    await m.unmount()
  })

  test('gradient stops coalesce contiguous same-kind runs', () => {
    const bands = [
      { kind: 'tools' as const, leftPct: 0, widthPct: 10 },
      { kind: 'tools' as const, leftPct: 10, widthPct: 10 },
      { kind: 'ttft' as const, leftPct: 20, widthPct: 10 },
    ]
    const base = timingGradientOf(bands, null)
    assert.equal((base.match(/--color-teal-500/g) || []).length, 1)
    assert.ok(base.includes('var(--color-teal-500) 0.0000% 20.0000%'))
    const hot = timingGradientOf(bands, 'tools')
    assert.ok(hot.includes('var(--color-teal-500) 0.0000% 20.0000%, transparent 20.0000% 30.0000%'))
  })

  test('a dense hover lights its kind through the hot layer', async () => {
    const spans: TimingSpan[] = []
    for (let i = 0; i < 700; i++) spans.push({ kind: i % 2 === 0 ? 'ttft' : 'tools', start: i * 1_000, end: i * 1_000 + 500 })
    const m = await mount(h(Strip, { spans, hoverKey: 'ttft' }))
    assert.ok(query(m.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'))
    const hot = query<HTMLElement>(m.container, '.lc-tstrip-gradient-hot')
    assert.ok(hot.style.background.includes('--color-blue-500'))
    await m.unmount()
  })

  test('a hover key naming no painted kind leaves the strip at rest', async () => {
    for (const hoverKey of ['toolarg', 'zz']) {
      const m = await mount(h(Strip, { spans: SPANS, hoverKey }))
      assert.ok(!query(m.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'), hoverKey)
      assert.equal(queryAll(m.container, '.lc-tstrip-seg-on').length, 0)
      await m.unmount()
    }
  })

  test('an inert strip (no relay) still floats its own tip', async () => {
    const m = await mount(h(Strip, { spans: SPANS }))
    await hover(segsOf(m.container)[3])
    assert.equal(query(m.container, '.lc-bar-tip').textContent, `Tool runs 15.0s · ${timeOf(26_000)}`)
    await unhover(query(m.container, '.lc-tstrip-bar'))
    assert.equal(query(m.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await m.unmount()
  })

  test('a hostile span — unknown kind, NaN or inverted instant — drops out whole', async () => {
    const hostile: TimingSpan[] = [
      { kind: 'nope', start: 2_000, end: 4_000 } as unknown as TimingSpan,
      { kind: 'ttft', start: Number.NaN, end: 4_000 },
      { kind: 'ttft', start: 2_000, end: Number.NaN },
      { kind: 'ttft', start: 4_000, end: 2_000 },
      { kind: 'ttft', start: 3_000, end: 3_000 },
      ...SPANS,
    ]
    const m = await mount(h(Strip, { spans: hostile }))
    assert.equal(segsOf(m.container).length, 5)
    assert.deepEqual(leftsOf(m.container), [0, 12.5, 37.5, 50, 87.5])
    await m.unmount()
  })

  test('an empty or all-hostile collection renders nothing', async () => {
    const collections: TimingSpan[][] = [
      [],
      [
        { kind: 'nope', start: 1, end: 2 } as unknown as TimingSpan,
        { kind: 'ttft', start: Number.NaN, end: 2 },
        { kind: 'ttft', start: 2, end: 1 },
      ],
    ]
    for (const spans of collections) {
      const m = await mount(h(Strip, { spans }))
      assert.equal(queryAll(m.container, '.lc-tstrip').length, 0, JSON.stringify(spans.length))
      await m.unmount()
    }
  })

  test('the aria label and the tip label localize', async () => {
    const m = await mount(h(StripZh, { spans: SPANS }))
    assert.equal(query(m.container, '.lc-tstrip').getAttribute('aria-label'), '耗时时间轴：各段按发生次序紧凑铺排，宽度为耗时占比，刻度为零、四分位与全程')
    await hover(segsOf(m.container)[0])
    assert.equal(query(m.container, '.lc-bar-tip').textContent, `模型等待 5.0s · ${timeOf(1_000)}`)
    await m.unmount()
  })
})
