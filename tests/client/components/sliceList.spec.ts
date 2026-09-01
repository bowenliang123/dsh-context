// SliceList (src/client/components/sliceList.tsx) rendered with real React:
// the donut legend rows — the primary line (color dot, label, bold share)
// over the secondary quantity line.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeSliceList } from '../../../src/client/components/sliceList'
import { makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const SliceList = makeSliceList(kit)

describe('SliceList', () => {
  test('rows render the primary line and the secondary count line in order', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3m 20s · 9 runs' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.lc-sl-pct')?.textContent, '84%')
    assert.equal(rows[0].querySelector('.lc-sl-dot')?.getAttribute('style'), 'background: rgb(255, 0, 0);')
    assert.equal(rows[0].querySelector('.lc-sl-label')?.textContent, 'Alpha')
    assert.equal(rows[0].querySelector('.lc-sl-sub')?.textContent, '204.9k')
    assert.equal(rows[1].querySelector('.lc-sl-pct')?.textContent, '<1%')
    assert.equal(rows[1].querySelector('.lc-sl-sub')?.textContent, '3m 20s · 9 runs')
    await m.unmount()
  })

  test('a zero-figure row dims; an empty count renders no secondary line', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '0%', count: '—', dim: true },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '—', count: '' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.ok(rows[0].className.includes('lc-sl-row-dim'))
    assert.ok(!rows[1].className.includes('lc-sl-row-dim'))
    // Only the row carrying a count grows the secondary line.
    assert.equal(queryAll(m.container, '.lc-sl-sub').length, 1)
    assert.equal(queryAll(m.container, '.lc-sl-pct').length, 2)
    assert.ok(text(m.container).includes('—'))
    await m.unmount()
  })

  test('an empty row list renders the container only', async () => {
    const m = await mount(h(SliceList, { rows: [] }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
    assert.ok(queryAll(m.container, '.lc-sl').length === 1)
    await m.unmount()
  })
})
