// @vitest-environment jsdom
import assert from 'node:assert/strict'
import * as React from 'react'
import { describe, test } from 'vitest'
import { PREVIEW_INDENT } from '../../src/tui/browser'
import { wrapCells } from '../../src/tui/model'
import { createContextScene } from '../../src/tui/scene'
import type { SurfaceNode } from '../../src/shared/types'
import { fakeFormat, pressScene, render, sceneUi, staticSource, timelineFixture, type InputHolder } from './helpers'

const cjk = (n: number, from: number): string => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + from + i)).join('')
const essay = Array.from({ length: 9 }, (_, i) => `Paragraph ${i + 1}: ${'the context grows and is compacted '.repeat(3).trim()}.`).join('\n\n')

const nodes: SurfaceNode[] = [
  ...Array.from({ length: 7 }, (_, i): SurfaceNode => ({ seq: i * 2 + 1, cat: 'user', tokens: 300, text: cjk(80, i * 80) })),
  { seq: 20, cat: 'inject', tokens: 900, name: 'notes', text: essay },
]

/** Expand every collapsed row while stepping down once, collecting each rendered line; stops when the cursor stays put. */
async function walk(width: number, height: number): Promise<{ seen: Set<string>; maxRows: number }> {
  const input: InputHolder = {}
  const Scene = createContextScene({
    source: staticSource({ timeline: timelineFixture({ nodes, archive: [], requests: [] }) }),
    defaults: () => ({}),
    opening: () => ({ serial: 1, tab: 'browser' }),
  })
  const view = await render(React.createElement(Scene, { React, ui: sceneUi(input, { columns: width, rows: height }), close: () => {} }))
  const seen = new Set<string>()
  let maxRows = 0
  let previous = ''
  for (let steps = 0; steps < 600; steps++) {
    const body = [...view.container.querySelectorAll('[data-box]')]
      .find(el => el.firstElementChild?.tagName === 'SPAN' && el.firstElementChild.textContent?.startsWith('Context Browser') === true)
    assert.ok(body !== undefined)
    maxRows = Math.max(maxRows, body.children.length)
    for (const row of [...body.children].slice(1)) seen.add(row.textContent ?? '')
    const selected = body.querySelector('[data-inverse="1"]')?.textContent ?? ''
    const position = `${selected}|${[...body.children].map(row => row.textContent).join('/')}`
    if (selected.startsWith('▸ ')) {
      await pressScene(input, '', { return: true })
      continue
    }
    if (position === previous) break
    previous = position
    await pressScene(input, '', { downArrow: true })
  }
  await view.unmount()
  return { seen, maxRows }
}

describe('browser scrolling by physical lines', () => {
  for (const [width, height] of [[80, 24], [120, 30]] as const) {
    test(`${width}×${height}: every wrapped line of long CJK and multi-paragraph previews is reachable within the body`, async () => {
      const { seen, maxRows } = await walk(width, height)
      assert.ok(maxRows <= height - 2, `the body (${height - 2} rows) never overflows: drew ${maxRows}`)
      const lines = nodes.flatMap(node => wrapCells(node.text ?? '', width - PREVIEW_INDENT, fakeFormat.cells))
      assert.ok(lines.length > height, 'the previews are taller than the screen')
      assert.ok(lines.includes(''), 'the essay keeps its blank lines between paragraphs')
      // A blank line draws as one space, so it still takes its row on a terminal.
      for (const text of lines) assert.ok(seen.has(text === '' ? ' ' : text), `reached: ${text.slice(0, 20)}…`)
      assert.ok(lines.every(text => fakeFormat.cells(text) <= width - PREVIEW_INDENT), 'each line fits its row')
    })
  }

  test('PgDn walks a preview taller than the body a page at a time', async () => {
    const input: InputHolder = {}
    const Scene = createContextScene({
      source: staticSource({ timeline: timelineFixture({ nodes: [nodes[7]], archive: [], requests: [] }) }),
      defaults: () => ({}),
      opening: () => ({ serial: 1, tab: 'browser' }),
    })
    const view = await render(React.createElement(Scene, { React, ui: sceneUi(input, { columns: 40, rows: 12 }), close: () => {} }))
    for (let i = 0; i < 3; i++) await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    const lines = wrapCells(essay, 40 - PREVIEW_INDENT, fakeFormat.cells)
    // Half as many presses as lines: only a key that moves more than one row gets there.
    for (let i = 0; i < Math.ceil(lines.length / 2); i++) await pressScene(input, '', { pageDown: true })
    assert.ok(view.container.textContent?.includes('Paragraph 9:'), 'the end of the preview is on screen')
    await view.unmount()
  })
})

describe('wrapCells', () => {
  test('wraps by display cells, after the last space when there is one, and keeps blank paragraphs', () => {
    assert.deepEqual(wrapCells('alpha beta gamma', 11, fakeFormat.cells), ['alpha beta', 'gamma'])
    assert.deepEqual(wrapCells('abcdefghij', 4, fakeFormat.cells), ['abcd', 'efgh', 'ij'])
    assert.deepEqual(wrapCells('一二三四五', 4, fakeFormat.cells), ['一二', '三四', '五'])
    assert.deepEqual(wrapCells('a\n\nb', 10, fakeFormat.cells), ['a', '', 'b'])
    assert.deepEqual(wrapCells('one two', 3, fakeFormat.cells), ['one', 'two'], 'a word that fills the line keeps the next one whole')
    assert.deepEqual(wrapCells('a\tb\r\nc\u001b[31md', 10, fakeFormat.cells), ['a b', 'c[31md'], 'tabs become spaces, controls drop')
  })
})
