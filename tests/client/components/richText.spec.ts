// RichText/RichSwitch/useRichMode (src/client/components/richText.tsx):
// markdown mode renders through the REAL shared MarkdownText; raw mode is an
// exact-text <pre>; the switch drives the mode hook.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeRichText } from '../../../src/client/components/richText'
import type { RichMode } from '../../../src/client/components/richText'
import { click, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const { RichText, RichSwitch, useRichMode } = makeRichText(kit)

const SAMPLE = '# Title\n\nsome **bold** text'

/** Harness wiring the hook to the switch and the body, like the detail cards do. */
function Harness(props: { text: string }) {
  const [mode, setMode] = useRichMode()
  return h('div', {}, h(RichSwitch, { mode, onPick: setMode }), h(RichText, { text: props.text, mode }))
}

describe('RichText', () => {
  test('md mode renders real markdown through the shared MarkdownText', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'md' }))
    const box = query(m.container, '.lc-ts-desc-md')
    assert.equal(query(box, 'h1').textContent, 'Title')
    assert.equal(query(box, 'strong').textContent, 'bold')
    await m.unmount()
  })

  test('raw mode renders the exact source in a <pre>', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'raw' }))
    const pre = query(m.container, 'pre.lc-ts-desc-body')
    assert.equal(pre.textContent, SAMPLE)
    assert.equal(queryAll(m.container, 'h1').length, 0)
    await m.unmount()
  })
})

describe('RichSwitch', () => {
  test('two segments with titles; the active mode carries the on class; clicks report the pick', async () => {
    const picks: RichMode[] = []
    const m = await mount(h(RichSwitch, { mode: 'md', onPick: m2 => picks.push(m2) }))
    const buttons = queryAll(m.container, '.lc-rich-seg-btn')
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].textContent, 'Raw')
    assert.equal(buttons[0].getAttribute('title'), 'View Raw Text')
    assert.ok(!buttons[0].className.includes('lc-rich-seg-on'))
    assert.equal(buttons[1].textContent, 'Markdown')
    assert.equal(buttons[1].getAttribute('title'), 'View as Markdown')
    assert.ok(buttons[1].className.includes('lc-rich-seg-on'))
    await click(buttons[0])
    await click(buttons[1])
    assert.deepEqual(picks, ['raw', 'md'])
    await m.unmount()
  })

  test('raw mode marks the raw segment active instead', async () => {
    const m = await mount(h(RichSwitch, { mode: 'raw', onPick: () => {} }))
    const buttons = queryAll(m.container, '.lc-rich-seg-btn')
    assert.ok(buttons[0].className.includes('lc-rich-seg-on'))
    assert.ok(!buttons[1].className.includes('lc-rich-seg-on'))
    await m.unmount()
  })
})

describe('useRichMode', () => {
  test('defaults to markdown and flips to raw via the switch', async () => {
    const m = await mount(h(Harness, { text: SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-md'))
    const buttons = queryAll(m.container, '.lc-rich-seg-btn')
    await click(buttons[0]) // Raw
    assert.equal(query(m.container, 'pre.lc-ts-desc-body').textContent, SAMPLE)
    await click(queryAll(m.container, '.lc-rich-seg-btn')[1]) // back to Markdown
    assert.equal(query(m.container, '.lc-ts-desc-md h1').textContent, 'Title')
    await m.unmount()
  })
})
