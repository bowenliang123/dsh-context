import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import type { TrendBand } from '../../../src/client/dna'
import { flush, mount, queryAll } from '../helpers/kit'
import { capDnaRuns } from '../../../src/client/components/trendDnaBars'
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
    // Adjacent samples of the same colour coalesce into one run.
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
    try {
      const dnaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(dnaBars.length > 0 && dnaBars.length < reqs.length, `windowed DNA bars (${dnaBars.length})`)
      assert.ok(lazy.calls.size < reqs.length, `only visible steps assembled (${lazy.calls.size})`)
      // Hovering a DNA bar resolves the band under the pointer and paints the lifetime slice across the window.
      await act(async () => { dnaBars[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10 })) })
      await flush()
      assert.ok(queryAll(m.container, '.lc-dna-slice').length > 0)
    } finally {
      await m.unmount()
    }
  })

  test('entering DNA tightens the window and leaving it restores the ordinary range', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(reqs, { dna: null })))
    try {
      const plain = queryAll(m.container, '.lc-bar').length
      await m.update(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at })))
      const dna = queryAll(m.container, '.lc-bar').length
      assert.ok(dna > 0 && dna < plain, `DNA window is tighter (${dna} < ${plain})`)
      await m.update(h(TrendChart, propsOf(reqs, { dna: null })))
      assert.ok(queryAll(m.container, '.lc-bar').length > dna, 'leaving DNA expands the window again')
    } finally {
      await m.unmount()
    }
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
      // Exact churn bounds require every bar's key changes: no totals-based shortcut.
      assert.ok(lazy.calls.size <= reqs.length * 2, `bounded per-seq lookups (${lazy.calls.size})`)
      assert.ok(bars(m.container).length > 0)
    } finally {
      await m.unmount()
    }
  })
})
