// The Context emblem (src/client/icon.tsx): the bundled polychrome document
// sheet that fills the right-Sidebar tab type's two glyph seats — the guide
// capsule and the chip title. Bundled rather than read off the harness
// primitives, so these specs render the real component.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ContextIcon, makeContextTabTitle } from '../../src/client/icon'
import { makeKit, mount, query, queryAll, text } from './helpers/kit'

describe('ContextIcon', () => {
  test('draws the colourful sheet at the requested edge', async () => {
    const m = await mount(h(ContextIcon, { size: 16, className: 'lc-title-icon' }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 1024 1024')
    assert.equal(svg.getAttribute('class'), 'lc-title-icon')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    // Every stroke carries its own fixed fill — the sheet stays polychrome.
    const paths = queryAll<SVGPathElement>(m.container, 'path')
    assert.equal(paths.length, 10)
    const fills = paths.map(p => p.getAttribute('fill'))
    assert.ok(fills.every(f => typeof f === 'string' && f.startsWith('#')))
    assert.equal(new Set(fills).size, 6, 'the six palette colours all appear')
    await m.unmount()
  })

  test('defaults to a size and can drop the class', async () => {
    const m = await mount(h(ContextIcon, {}))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '20')
    assert.equal(svg.getAttribute('height'), '20')
    assert.equal(svg.getAttribute('class'), null)
    await m.unmount()
  })
})

describe('makeContextTabTitle — the chip-title seat', () => {
  test('renders the emblem beside the plugin label in the active locale', async () => {
    const { t } = makeKit()
    const Title = makeContextTabTitle(t)
    const m = await mount(h(Title))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    const label = query<HTMLSpanElement>(m.container, '.lc-title-label')
    assert.equal(text(label), 'Context')
    await m.unmount()
  })

  test('follows the bound translate at render (zh label)', async () => {
    const Title = makeContextTabTitle(makeKit('zh').t)
    const m = await mount(h(Title))
    assert.equal(text(m.container), '上下文')
    await m.unmount()
  })
})
