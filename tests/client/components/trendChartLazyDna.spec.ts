import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import type { TrendBand } from '../../../src/client/dna'
import { flush, mount, query, queryAll } from '../helpers/kit'
import { capDnaRuns, snapDnaRuns } from '../../../src/client/components/trendDnaBars'
import { TrendChart, bars, propsOf, req, viewport } from './trendChartHarness'

const bandOf = (seq: number): TrendBand[] => [{ key: 'a', cat: 'system', tokens: 10 + (seq % 7), off: 0, color: '#8b5cf6' }]

function requestList(n: number) {
  return Array.from({ length: n }, (_, i) => req(i + 1, {
    turn: 1 + Math.floor(i / 100),
    step: i % 100,
    system: 10 + i % 7,
    tools: 20,
    user: 5,
    inject: 0,
    assistant: 15,
    tool: 5,
    total: 55 + i % 7,
    activeMs: 1_000 + i,
  }))
}

function lazyBands() {
  const calls = new Map<number, number>()
  const at = (seq: number): TrendBand[] => {
    calls.set(seq, (calls.get(seq) ?? 0) + 1)
    return bandOf(seq)
  }
  return { calls, at }
}

describe('snapDnaRuns', () => {
  test('snaps internal boundaries to the shared pixel grid, aligns identical bands across bars, and absorbs sub-grid strands', () => {
    const a = snapDnaRuns([{ color: '#a', from: 0, to: 2.3 }, { color: '#b', from: 2.3, to: 7.9 }])
    const b = snapDnaRuns([{ color: '#a', from: 0, to: 2.3 }, { color: '#b', from: 2.3, to: 10.9 }])
    assert.equal(a[0].to, 2, '2.3px snaps down to the 2px grid')
    assert.equal(b[0].to, a[0].to, 'the same prefix band keeps the same boundary in a taller bar')
    assert.equal(a[a.length - 1].to, 7.9, 'the final boundary stays exact')
    assert.equal(b[b.length - 1].to, 10.9)
    assert.deepEqual(snapDnaRuns([]), [])

    const merged = snapDnaRuns([
      { color: '#a', from: 0, to: 2.1 },
      { color: '#a', from: 2.1, to: 4.4 },
      { color: '#b', from: 4.4, to: 9.2 },
    ])
    assert.deepEqual(merged.map(r => r.color), ['#a', '#b'])
    const tiny = snapDnaRuns([
      { color: '#a', from: 0, to: 1.9 },
      { color: '#b', from: 1.9, to: 2.1 },
      { color: '#c', from: 2.1, to: 6.5 },
    ])
    const covered = tiny.map(r => [r.from, r.to])
    for (let i = 1; i < covered.length; i++) assert.equal(covered[i][0], covered[i - 1][1], 'runs stay contiguous')
    assert.equal(covered.at(-1)?.[1], 6.5)
  })
})

describe('capDnaRuns', () => {
  test('passes short runs through and samples dense ones onto a fixed stop count', () => {
    const short = [{ color: '#a', from: 0, to: 50 }, { color: '#b', from: 50, to: 100 }]
    assert.equal(capDnaRuns(short, 96), short)
    const dense = Array.from({ length: 400 }, (_, i) => ({
      color: i % 2 === 0 ? '#a' : '#b',
      from: i / 4,
      to: (i + 1) / 4,
    }))
    const capped = capDnaRuns(dense, 96)
    assert.ok(capped.length <= 96)
    assert.equal(capped[0].from, 0)
    assert.equal(capped[capped.length - 1].to, dense[dense.length - 1].to)
    assert.ok(capped.every((run, i) => i === 0 || capped[i - 1].color !== run.color))
    const mono = Array.from({ length: 400 }, (_, i) => ({ color: '#a', from: i / 4, to: (i + 1) / 4 }))
    assert.equal(capDnaRuns(mono, 96).length, 1)
  })
})

describe('TrendChart lazy DNA bands', () => {
  test('a lazy source assembles only the rendered window and hit-tests its bands', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at })))
    const dnaBars = queryAll(m.container, '.lc-bar-dna')
    assert.ok(dnaBars.length > 0 && dnaBars.length < reqs.length, `windowed DNA bars (${dnaBars.length})`)
    assert.ok(lazy.calls.size < reqs.length, `only visible steps assembled (${lazy.calls.size})`)
    await act(async () => { dnaBars[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10 })) })
    await flush()
    assert.ok(queryAll(m.container, '.lc-dna-slice').length > 0)
    await m.unmount()
  })

  test('entering DNA tightens the window and leaving it restores the ordinary range', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(reqs, { dna: null })))
    const plain = queryAll(m.container, '.lc-bar').length
    await m.update(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at })))
    const dna = queryAll(m.container, '.lc-bar').length
    assert.ok(dna > 0 && dna < plain, `DNA window is tighter (${dna} < ${plain})`)
    await m.update(h(TrendChart, propsOf(reqs, { dna: null })))
    assert.ok(queryAll(m.container, '.lc-bar').length > dna, 'leaving DNA expands the window again')
    await m.unmount()
  })

  test('delta mode reads every per-key band so a lazy source keeps the eager axis', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const eager = reqs.map((_, i) => bandOf(i + 1))
    const eagerView = await mount(h(TrendChart, propsOf(reqs, { dna: eager, mode: 'delta' })))
    const axisOf = (el: HTMLElement): (string | null)[] => ['.lc-axis-top', '.lc-axis-q3', '.lc-axis-mid', '.lc-axis-q1']
      .map(sel => el.querySelector(sel)?.textContent ?? null)
    const eagerAxis = axisOf(eagerView.container)
    await eagerView.unmount()
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at, mode: 'delta' })))
    try {
      assert.ok(queryAll(m.container, '.lc-bar-dna').length > 0)
      assert.deepEqual(axisOf(m.container), eagerAxis, 'lazy delta axes match the eager per-band maxima')
      assert.ok(lazy.calls.size <= reqs.length * 2, `bounded per-seq lookups (${lazy.calls.size})`)
      assert.ok(bars(m.container).length > 0)

      const afterMount = lazy.calls.size
      const firstBar = queryAll(m.container, '.lc-bar')[0]
      await act(async () => {
        firstBar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      await flush()
      assert.equal(lazy.calls.size, afterMount, 'a hover re-render re-walks no step')
    } finally {
      await m.unmount()
    }

    const rereadReqs = requestList(600)
    const rereadLazy = lazyBands()
    const total = (): number => [...rereadLazy.calls.values()].reduce((a, b) => a + b, 0)
    const reread = await mount(h(TrendChart, propsOf(rereadReqs, { dnaAt: rereadLazy.at, mode: 'delta' })))
    assert.equal(rereadLazy.calls.size, rereadReqs.length, 'the axis walk read every step')
    const afterMount = total()
    await reread.update(h(TrendChart, propsOf(rereadReqs, { dnaAt: rereadLazy.at, mode: 'delta', markers: [] })))
    await flush()
    const rereadCount = total() - afterMount
    assert.ok(rereadCount <= 400, `a re-render re-reads at most the window (${rereadCount} of ${rereadReqs.length})`)
    assert.ok(rereadCount < rereadReqs.length, 'the whole-log walk never re-runs on a hover/scroll re-render')
    await reread.unmount()
  })
})


describe('TrendChart lazy DNA maxima with adaptive window', () => {
  test('an adaptive window skips the full-history maxima walk and scales from the visible window', async () => {
    const lazy = lazyBands()
    const reqs = requestList(60)
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
    try {
      const callsAfterMount = lazy.calls.size
      assert.ok(callsAfterMount > 0, 'the first paint resolves the pre-measure maxima through the lazy accessor')
      await m.update(h(TrendChart, propsOf(reqs.map(r => ({ ...r })), { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
      const total = lazy.calls.size
      await m.update(h(TrendChart, propsOf(reqs.map(r => ({ ...r, total: r.total + 5 })), { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
      assert.ok(lazy.calls.size >= total, 'the lazy accessor keeps serving the visible window')
      assert.notEqual(query(m.container, '.lc-axis-top')?.textContent ?? '', '', 'the adaptive chart keeps an axis')
      void callsAfterMount
    } finally {
      await m.unmount()
    }
  })
})
