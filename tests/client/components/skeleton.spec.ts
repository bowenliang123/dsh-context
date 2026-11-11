import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createElement as h } from 'react'
import { LoadingLane, SkeletonBar, SkeletonPlot, SkeletonRows } from '../../../src/client/components/skeleton'
import { mount, query, queryAll } from '../helpers/kit'

describe('skeleton primitives', () => {
  test('the bar carries its base class and appends an optional caller class', async () => {
    const base = await mount(h(SkeletonBar, {}))
    assert.equal(query(base.container, '.lc-skel-bar').className, 'lc-skel-bar')
    await base.unmount()
    const named = await mount(h(SkeletonBar, { className: 'lc-skel-note' }))
    assert.equal(query(named.container, '.lc-skel-bar').className, 'lc-skel-bar lc-skel-note')
    await named.unmount()
  })

  test('rows default to six bars and honor a count or class', async () => {
    const plain = await mount(h(SkeletonRows, {}))
    assert.equal(plain.container.querySelectorAll('.lc-skel-rows > .lc-skel-bar').length, 6)
    await plain.unmount()
    const tuned = await mount(h(SkeletonRows, { rows: 3, className: 'lc-ov-tallies-skel' }))
    const box = query(tuned.container, '.lc-skel-rows')
    assert.equal(box.className, 'lc-skel-rows lc-ov-tallies-skel')
    assert.equal(box.querySelectorAll('.lc-skel-bar').length, 3)
    await tuned.unmount()
  })

  test('the plot lays out fourteen bars and the lane reserves its rows', async () => {
    const plot = await mount(h(SkeletonPlot, {}))
    assert.equal(queryAll(plot.container, '.lc-skel-plot > .lc-skel-bar').length, 14)
    await plot.unmount()
    const lane = await mount(h(LoadingLane, { className: 'lc-cmd-lane' }))
    const box = query(lane.container, '.lc-lane.lc-loading-lane.lc-cmd-lane')
    assert.equal(box.getAttribute('aria-busy'), 'true')
    assert.equal(box.querySelectorAll('.lc-skel-bar').length, 9)
    await lane.unmount()
  })
})
