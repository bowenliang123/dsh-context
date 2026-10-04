// The Context emblem (src/client/icon.tsx): the bundled metered window that
// fills the right-Sidebar tab type's two glyph seats — the guide capsule and
// the chip title — in its polychrome default, plus the sidebar-foot entry seat
// in the mono variant. Bundled rather than read off the harness primitives, so
// these specs render the real component. The same artwork is exported
// statically as the package-root icon.svg the Host's package-meta reader serves
// to the Plugins page; a spec pins the two in lockstep.

import { readFile } from 'node:fs/promises'
import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ContextIcon, makeContextTabTitle } from '../../src/client/icon'
import { makeKit, mount, query, text } from './helpers/kit'

/** One element as `tag attr="…" …`, its attributes sorted so the comparison ignores their order. */
function describeElement(tag: string, attributes: Iterable<[string, string]>): string {
  return [tag.toLowerCase(), ...[...attributes].map(([name, value]) => `${name}="${value}"`).sort()].join(' ')
}

/** Every element the artwork paints, in paint order, read off the file's own markup. */
function paintedFromMarkup(markup: string): string[] {
  return [...markup.matchAll(/<([a-z]+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/gi)].map(([, tag, body]) =>
    describeElement(
      tag,
      [...body.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value] as [string, string]),
    ),
  )
}

/** The same list, read off a rendered container. */
function paintedFromDom(container: Element): string[] {
  return [...container.querySelectorAll('svg *')].map(el =>
    describeElement(
      el.tagName,
      [...el.attributes].map(attribute => [attribute.name, attribute.value] as [string, string]),
    ),
  )
}

/** The component carries the instance through the artwork's ids; fold that back to the file's own prefix. */
const unscoped = (painted: string[]): string[] => painted.map(
  element => element.replace(/ctx_meter_[a-z0-9]+_/gi, 'ctx_meter_'),
)

describe('ContextIcon', () => {
  test('draws the emblem at the requested edge', async () => {
    const m = await mount(h(ContextIcon, { size: 16, className: 'lc-title-icon' }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 36 36')
    assert.equal(svg.getAttribute('class'), 'lc-title-icon')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    // `fill="none"` on the root is what keeps the frame a stroke instead of a
    // black block — the file declares it, so the inlined copy must too.
    assert.equal(svg.getAttribute('fill'), 'none')
    assert.equal(
      query<SVGLinearGradientElement>(m.container, 'linearGradient').getAttribute('gradientUnits'),
      'userSpaceOnUse',
    )
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

  test('gives each instance its own gradient id', async () => {
    // The emblem fills four seats at once, so two copies routinely share a
    // page; a repeated id would resolve both to whichever came first.
    const m = await mount(h('div', null, h(ContextIcon, {}), h(ContextIcon, { mono: true })))
    const ids = [...m.container.querySelectorAll('linearGradient')].map(gradient => gradient.getAttribute('id'))
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
    await m.unmount()
  })

  test('the mono seat trades every paint for the current colour', async () => {
    const m = await mount(h(ContextIcon, { mono: true }))
    const paints = [...m.container.querySelectorAll('svg *')]
      .flatMap(el => ['fill', 'stroke'].map(name => el.getAttribute(name)))
      .filter((value): value is string => value !== null)
    assert.ok(paints.length > 0, 'the artwork paints at least one element')
    assert.ok(paints.every(value => value === 'currentColor'))
    await m.unmount()
  })

  test('the package-root icon.svg stays in lockstep with the component', async () => {
    // The static file is what the Host's package-meta reader serves to the
    // Plugins page (package.json `icon`), so a component edit that skips the
    // file — or a manual file edit that skips the component — fails here.
    const raw = await readFile('icon.svg', 'utf8')
    const artwork = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>')).trim().replace(/>\s+</g, '><')
    const m = await mount(h(ContextIcon, {}))
    const rendered = unscoped(paintedFromDom(m.container))
    await m.unmount()
    assert.deepEqual(rendered, paintedFromMarkup(artwork))
    assert.match(raw, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 36 36" fill="none">/)
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
