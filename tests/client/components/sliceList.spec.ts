// SliceList (src/client/components/sliceList.tsx) rendered with real React:
// the donut legend rows — leading share, color dot, label, trailing quantity.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeSliceList } from '../../../src/client/components/sliceList'
import { makeKit, mount, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const SliceList = makeSliceList(kit)

describe('SliceList', () => {
  test('rows render pct, dot, label, and count in order', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3 次 · 42ms' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.lc-sl-pct')?.textContent, '84%')
    assert.equal(rows[0].querySelector('.lc-sl-dot')?.getAttribute('style'), 'background: rgb(255, 0, 0);')
    assert.equal(rows[0].querySelector('.lc-sl-label')?.textContent, 'Alpha')
    assert.equal(rows[0].querySelector('.lc-sl-count')?.textContent, '204.9k')
    assert.equal(rows[1].querySelector('.lc-sl-pct')?.textContent, '<1%')
    await m.unmount()
  })

  test('an empty count renders no cell; rows pass hostile strings through', async () => {
    const m = await mount(h(SliceList, {
      rows: [{ key: 'a', color: '#ff0000', label: 'Alpha', pct: '—', count: '' }],
    }))
    assert.equal(queryAll(m.container, '.lc-sl-count').length, 0)
    assert.equal(queryAll(m.container, '.lc-sl-pct').length, 1)
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
