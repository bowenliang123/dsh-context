// Donut (src/client/components/donut.tsx) rendered with real React:
// proportional SVG segments around the center label, with the empty ring
// fallback and hostile-value skips.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeDonut } from '../../../src/client/components/donut'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Donut = makeDonut(kit)

describe('Donut', () => {
  test('segments render one circle each, in order, with accumulating offsets', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 30 },
        { key: 'b', color: '#00ff00', value: 70 },
      ],
      centerTop: '2h 14m',
      centerSub: 'active time',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 2)
    const dash = (el: Element): string => el.getAttribute('stroke-dasharray') ?? ''
    const offset = (el: Element): number => Number(el.getAttribute('stroke-dashoffset'))
    assert.equal(dash(circles[0]), '30 70')
    assert.equal(offset(circles[0]), 125)
    assert.equal(dash(circles[1]), '70 30')
    assert.equal(offset(circles[1]), 95)
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '2h 14m')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'active time')
    await m.unmount()
  })

  test('non-positive and non-finite values are skipped', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 0 },
        { key: 'b', color: '#00ff00', value: -5 },
        { key: 'c', color: '#0000ff', value: Number.NaN },
        { key: 'd', color: '#ffffff', value: 100 },
      ],
      centerTop: 'x',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 1)
    assert.equal(circles[0].getAttribute('stroke'), '#ffffff')
    await m.unmount()
  })

  test('an all-zero total renders the neutral track ring, no segment circles', async () => {
    const m = await mount(h(Donut, {
      segments: [{ key: 'a', color: '#ff0000', value: 0 }],
      centerTop: '—',
    }))
    assert.equal(queryAll(m.container, 'circle').length, 1)
    assert.ok(query(m.container, '.lc-donut-track'))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    // No center sub when absent.
    assert.equal(queryAll(m.container, '.lc-donut-center span').length, 0)
    await m.unmount()
  })

  test('an empty segment list renders the track too', async () => {
    const m = await mount(h(Donut, { segments: [], centerTop: '—' }))
    assert.ok(query(m.container, '.lc-donut-track'))
    assert.ok(text(m.container).includes('—'))
    await m.unmount()
  })
})
