// RichText/RichSwitch/RichCopy/useRichMode (src/client/components/richText.tsx):
// markdown mode renders through the REAL shared MarkdownText; raw mode is an
// exact-text line-numbered <pre>; the switch drives the mode hook; the copy
// control writes the exact source through the harness clipboard primitive.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeRichText } from '../../../src/client/components/richText'
import type { RichMode } from '../../../src/client/components/richText'
import { click, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const { RichText, RichSwitch, useRichMode } = makeRichText(kit)

const SAMPLE = '# Title\n\nsome **bold** text'

/** The raw body re-joined from its rendered line spans, i.e. the exact source text. */
function rawText(container: ParentNode): string {
  return queryAll(container, '.lc-ts-line').map(line => line.textContent).join('\n')
}

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

  test('raw mode renders the exact source as one numbered line span per source line', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'raw' }))
    const pre = query(m.container, 'pre.lc-ts-desc-body')
    assert.equal(rawText(m.container), SAMPLE)
    assert.equal(queryAll(pre, '.lc-ts-line').length, 3)
    assert.equal(queryAll(m.container, 'h1').length, 0)
    await m.unmount()
  })

  test('raw mode drops the row of a trailing newline but keeps interior empty lines', async () => {
    const m = await mount(h(RichText, { text: 'a\n\nb\n', mode: 'raw' }))
    assert.deepEqual(queryAll(m.container, '.lc-ts-line').map(line => line.textContent), ['a', '', 'b'])
    await m.unmount()
  })

  test('raw mode of empty text keeps a single empty line', async () => {
    const m = await mount(h(RichText, { text: '', mode: 'raw' }))
    assert.deepEqual(queryAll(m.container, '.lc-ts-line').map(line => line.textContent), [''])
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
    assert.equal(rawText(m.container), SAMPLE)
    await click(queryAll(m.container, '.lc-rich-seg-btn')[1]) // back to Markdown
    assert.equal(query(m.container, '.lc-ts-desc-md h1').textContent, 'Title')
    await m.unmount()
  })
})

describe('RichCopy', () => {
  const { RichCopy } = makeRichText(kit)

  /** jsdom ships no clipboard API; stub the async one for the accepted path. */
  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
  }

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window.navigator, 'clipboard')
  })

  test('an accepted write flips to the check glyph, ignores a repeat click, then resets', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    stubClipboard(async (text) => { writes.push(text) })
    const m = await mount(h(RichCopy, { text: SAMPLE }))
    const button = query(m.container, '.lc-rich-copy')
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await click(button)
    assert.deepEqual(writes, [SAMPLE], 'the exact source text reached the clipboard host')
    assert.ok(button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copied')
    await click(button) // inside the confirmation window: no second write
    assert.deepEqual(writes, [SAMPLE])
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await m.unmount()
  })

  test('a rejected host write claims no success (no clipboard in jsdom)', async () => {
    const m = await mount(h(RichCopy, { text: SAMPLE }))
    const button = query(m.container, '.lc-rich-copy')
    await click(button)
    assert.ok(!button.className.includes('lc-rich-copy-on'))
    assert.equal(button.getAttribute('title'), 'Copy Raw Text')
    await m.unmount()
  })
})
