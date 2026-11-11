import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { jsonOf, makeRichText, type RichMode } from '../../../src/client/components/richText'
import { click, hover, makeKit, mount, query, queryAll, settle, text } from '../helpers/kit'
import { makeEventList, makeEventText } from '../../../src/client/components/events'
import { fmtTime } from '../../../src/client/format'
import { type ContextEventRecord } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'

describe('richText', () => {

const kit = makeKit()
const { RichText, RichSwitch, useRichMode } = makeRichText(kit)

const SAMPLE = '# Title\n\nsome **bold** text'
const JSON_SAMPLE = '{"name": "dsh", "meta": {"tags": ["a", "b"], "ver": 2}}'

function rawText(container: ParentNode): string {
  return queryAll(container, '.lc-ts-line').map(line => line.textContent).join('\n')
}

function Harness(props: { text: string }) {
  const [mode, setMode, json] = useRichMode(props.text)
  return h('div', {}, h(RichSwitch, { mode, json, onPick: setMode }), h(RichText, { text: props.text, mode }))
}

describe('RichText', () => {
  test('md mode renders real markdown through the shared MarkdownText', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'md' }))
    const box = query(m.container, '.lc-ts-desc-md')
    assert.equal(query(box, 'h1').textContent, 'Title')
    assert.equal(query(box, 'strong').textContent, 'bold')
    await m.unmount()
  })

  test('raw mode renders one numbered line span per source line, dropping only a trailing newline row', async () => {
    const m = await mount(h(RichText, { text: SAMPLE, mode: 'raw' }))
    assert.equal(rawText(m.container), SAMPLE)
    assert.equal(queryAll(m.container, '.lc-ts-line').length, 3)
    assert.equal(queryAll(m.container, 'h1').length, 0)
    await m.unmount()

    const trailing = await mount(h(RichText, { text: 'a\n\nb\n', mode: 'raw' }))
    assert.deepEqual(queryAll(trailing.container, '.lc-ts-line').map(line => line.textContent), ['a', '', 'b'])
    await trailing.unmount()

    const empty = await mount(h(RichText, { text: '', mode: 'raw' }))
    assert.deepEqual(queryAll(empty.container, '.lc-ts-line').map(line => line.textContent), [''])
    await empty.unmount()
  })

  test('json mode renders the tree two levels deep and restores the previously focused element', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const m = await mount(h(RichText, { text: JSON_SAMPLE, mode: 'json' }))
    const tree = query(m.container, '.lc-ts-desc-json [role=tree]')
    assert.equal(tree.getAttribute('aria-label'), 'JSON Content')
    const rows = queryAll(m.container, '[role=treeitem]')
    assert.equal(rows.length, 4)
    assert.match(rows.map(r => r.textContent).join('|'), /tags/)
    assert.equal(document.activeElement, outside, 'the second-level auto-open never steals focus')
    await hover(rows[0])
    const copy = query(m.container, '[data-json-copy-button]')
    assert.equal(copy.getAttribute('title'), 'Copy value; right-click for copy options')
    outside.remove()
    await m.unmount()
  })

  test('json mode caps the second-level auto-open at 100 nodes', async () => {
    const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, { v: i }])))
    const m = await mount(h(RichText, { text: wide, mode: 'json' }))
    const open = queryAll(m.container, '[data-json-expander][aria-expanded=true]')
    assert.equal(open.length, 100)
    await m.unmount()
  })

  test('a data swap keeps a still-keyed node expanded without re-toggling it', async () => {
    const m = await mount(h(RichText, { text: '{"a": {"x": 1}}', mode: 'json' }))
    assert.equal(queryAll(m.container, '[role=treeitem]').length, 2)
    await m.update(h(RichText, { text: '{"a": {"y": 2}}', mode: 'json' }))
    const rows = queryAll(m.container, '[role=treeitem]')
    assert.equal(rows.length, 2, 'the swap did not collapse or double-toggle the keyed node')
    assert.match(rows[1].textContent ?? '', /y/)
    await m.unmount()
  })

  test('json mode on a text that no longer parses degrades to markdown', async () => {
    const m = await mount(h(RichText, { text: '{not json', mode: 'json' }))
    assert.ok(query(m.container, '.lc-ts-desc-md'))
    assert.equal(queryAll(m.container, '[role=tree]').length, 0)
    await m.unmount()
  })
})

describe('jsonOf', () => {
  test('parses whole-text objects and arrays; rejects non-bracket leads, broken payloads, and trailing garbage', () => {
    assert.deepEqual(jsonOf('{"a": 1}'), { a: 1 })
    assert.deepEqual(jsonOf('  [1, "x"]\n'), [1, 'x'])
    assert.deepEqual(jsonOf('{}'), {})
    assert.equal(jsonOf('plain text'), null)
    assert.equal(jsonOf('"quoted"'), null)
    assert.equal(jsonOf('{not json'), null)
    assert.equal(jsonOf('{"a": 1} extra'), null)
  })
})

describe('RichSwitch', () => {
  test('two segments with titles; the active mode carries the on class; clicks report the pick', async () => {
    const picks: RichMode[] = []
    const m = await mount(h(RichSwitch, { mode: 'md', onPick: m2 => picks.push(m2) }))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].textContent, 'Raw')
    assert.equal(buttons[0].getAttribute('title'), 'View Raw Text')
    assert.ok(!buttons[0].className.includes('lc-gran-on'))
    assert.equal(buttons[1].textContent, 'Markdown')
    assert.equal(buttons[1].getAttribute('title'), 'View as Markdown')
    assert.ok(buttons[1].className.includes('lc-gran-on'))
    await click(buttons[0])
    await click(buttons[1])
    assert.deepEqual(picks, ['raw', 'md'])
    await m.unmount()

    const json = await mount(h(RichSwitch, { mode: 'json', json: true, onPick: () => {} }))
    const jsonButtons = queryAll(json.container, '.lc-gran-btn')
    assert.deepEqual(jsonButtons.map(b => b.textContent), ['Raw', 'JSON'])
    assert.equal(jsonButtons[1].getAttribute('title'), 'View as JSON Tree')
    assert.ok(jsonButtons[1].className.includes('lc-gran-on'))
    await json.unmount()
  })
})

describe('useRichMode', () => {
  test('defaults to markdown and flips to raw via the switch', async () => {
    const m = await mount(h(Harness, { text: SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-md'))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    await click(buttons[0])
    assert.equal(rawText(m.container), SAMPLE)
    await click(queryAll(m.container, '.lc-gran-btn')[1])
    assert.equal(query(m.container, '.lc-ts-desc-md h1').textContent, 'Title')
    await m.unmount()
  })

  test('a JSON body opens on the tree, markdown unoffered; raw stays one click away', async () => {
    const m = await mount(h(Harness, { text: JSON_SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-json [role=tree]'))
    const buttons = queryAll(m.container, '.lc-gran-btn')
    assert.deepEqual(buttons.map(b => b.textContent), ['Raw', 'JSON'])
    await click(buttons[0])
    assert.equal(rawText(m.container), JSON_SAMPLE)
    await click(queryAll(m.container, '.lc-gran-btn')[1])
    assert.ok(query(m.container, '.lc-ts-desc-json [role=tree]'))
    await m.unmount()
  })

  test('a stale json pick falls back to markdown when the body stops parsing', async () => {
    const m = await mount(h(Harness, { text: JSON_SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-json'))
    await m.update(h(Harness, { text: SAMPLE }))
    assert.ok(query(m.container, '.lc-ts-desc-md'), 'the explicit json pick did not survive a non-JSON body')
    assert.deepEqual(queryAll(m.container, '.lc-gran-btn').map(b => b.textContent), ['Raw', 'Markdown'])
    await m.unmount()
  })
})

describe('RichCopy', () => {
  const { RichCopy } = makeRichText(kit)

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
    await click(button)
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

describe('useRichFind', () => {
  const { useRichFind } = makeRichText(kit)

  afterEach(() => {
    vi.useRealTimers()
  })

  function FindHarness(props: { text: string; mode?: RichMode }) {
    const find = useRichFind(props.text, props.mode ?? 'raw')
    return h('div', {},
      find.button,
      find.bar,
      h('div', { key: find.bodyKey, ref: find.bodyRef },
        h(RichText, { text: props.text, mode: props.mode ?? 'raw' })))
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function openFind(container: HTMLElement): Promise<HTMLInputElement> {
    await click(query(container, '.lc-find-btn'))
    return query<HTMLInputElement>(container, '.lc-find-input')
  }

  async function settle(): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  }

  function barButtons(container: HTMLElement): HTMLElement[] {
    return queryAll(query(container, '.lc-find'), '.lc-find-btn')
  }

  test('the toggle opens the bar with the input focused; the close button folds it back', async () => {
    const m = await mount(h(FindHarness, { text: SAMPLE }))
    const toggle = query(m.container, '.lc-find-btn')
    assert.equal(toggle.getAttribute('title'), 'Find in Text')
    assert.equal(queryAll(m.container, '.lc-find').length, 0)
    await click(toggle)
    const input = query<HTMLInputElement>(m.container, '.lc-find-input')
    assert.equal(document.activeElement, input, 'the input takes focus on open')
    assert.equal(input.placeholder, 'Find…')
    assert.ok(toggle.className.includes('lc-find-btn-on'))
    const close = barButtons(m.container)[2]
    assert.equal(close.getAttribute('title'), 'Close Find')
    await click(close)
    assert.equal(queryAll(m.container, '.lc-find').length, 0)
    assert.ok(!query(m.container, '.lc-find-btn').className.includes('lc-find-btn-on'))
    await m.unmount()
  })

  test('a settled query highlights case-insensitive matches and counts the active one', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'Alpha beta ALPHA other' }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0, 'no scan before the debounce settles')
    await settle()
    const marks = queryAll(m.container, '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['Alpha', 'ALPHA'])
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/2')
    assert.ok(marks[0].className.includes('lc-find-mark-on'))
    assert.equal(queryAll(m.container, '.lc-find-mark-on').length, 1)
    await m.unmount()

    const rapid = await mount(h(FindHarness, { text: 'alpha alphabet beta' }))
    const rapidInput = await openFind(rapid.container)
    await type(rapidInput, 'a')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await type(rapidInput, 'al')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    assert.equal(queryAll(rapid.container, '.lc-find-mark').length, 0, 'keystrokes inside the window never scanned')
    await type(rapidInput, 'alp')
    await settle()
    assert.deepEqual(queryAll(rapid.container, '.lc-find-mark').map(x => x.textContent), ['alp', 'alp'])
    await rapid.unmount()
  })

  test('Enter and Shift+Enter cycle the active match with wraparound; the chevrons do the same', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'one two one two one' }))
    const input = await openFind(m.container)
    await type(input, 'one')
    await settle()
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3')
    const enter = (shift: boolean) => act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }))
    })
    await enter(false)
    assert.equal(query(m.container, '.lc-find-count').textContent, '2/3')
    await enter(false)
    await enter(false)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3', 'Enter wraps past the last match')
    await enter(true)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3', 'Shift+Enter walks backwards')
    const [prev, next] = barButtons(m.container)
    assert.equal(prev.getAttribute('title'), 'Previous Match')
    assert.equal(next.getAttribute('title'), 'Next Match')
    await click(next)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/3')
    await click(prev)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3')
    assert.ok(queryAll(m.container, '.lc-find-mark')[2].className.includes('lc-find-mark-on'))
    await m.unmount()
  })

  test('Escape clears the query and marks first, then folds the bar; the body text is byte-identical afterwards', async () => {
    vi.useFakeTimers()
    const source = 'Alpha beta ALPHA other'
    const m = await mount(h(FindHarness, { text: source }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 2)
    assert.equal(rawText(m.container), source, 'marks never alter the copyable source text')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, 'alpha', 'a modified Escape does not clear')
    assert.equal(queryAll(m.container, '.lc-find').length, 1, 'nor does it fold the bar')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(input.value, '', 'the typed query is cleared first')
    assert.equal(queryAll(m.container, '.lc-find').length, 1, 'the bar stays open for a fresh query')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    assert.equal(queryAll(m.container, '.lc-find').length, 0, 'an empty field folds the bar')
    assert.equal(rawText(m.container), source, 'the restore rebuilt the exact original text nodes')
    await m.unmount()
  })

  test('a match spanning two text nodes is marked across both, and the restore rebuilds them', async () => {
    vi.useFakeTimers()
    const Body = () => h('div', {},
      h('span', { style: { color: 'red' } }, 'alpha '),
      h('span', {}, 'beta gamma'))
    function SplitHarness() {
      const find = useRichFind('alpha beta gamma', 'raw')
      return h('div', {}, find.button, find.bar,
        h('div', { key: find.bodyKey, ref: find.bodyRef, className: 'split-body' }, h(Body, {})))
    }
    const m = await mount(h(SplitHarness, {}))
    const input = await openFind(m.container)
    await type(input, 'alpha beta')
    await settle()
    const marks = queryAll(m.container, '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['alpha ', 'beta'], 'one mark per text node the match covers')
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1', 'the pieces count as one match')
    assert.ok(marks.every(mark => mark.className.includes('lc-find-mark-on')), 'every piece of the active match carries the active tone')
    await type(input, '')
    const body = query(m.container, '.split-body')
    assert.equal(queryAll(body, '.lc-find-mark').length, 0)
    assert.deepEqual(queryAll(body, 'span').map(span => span.textContent), ['alpha ', 'beta gamma'], 'the split nodes are back in one piece each')
    await m.unmount()
  })

  test('deleting the whole query clears the marks at once, without the debounce', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'alpha beta' }))
    const input = await openFind(m.container)
    await type(input, 'alpha')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 1)
    await type(input, '')
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 0, 'an empty query applies immediately')
    assert.equal(queryAll(m.container, '.lc-find-count').length, 0)
    await m.unmount()
  })

  test('zero matches shows 0/0 and disables the chevrons; stray keys and Enter are harmless', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'alpha beta' }))
    const input = await openFind(m.container)
    await type(input, 'zzz')
    await settle()
    assert.equal(query(m.container, '.lc-find-count').textContent, '0/0')
    const [prev, next] = barButtons(m.container)
    assert.ok((prev as HTMLButtonElement).disabled)
    assert.ok((next as HTMLButtonElement).disabled)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    assert.equal(query(m.container, '.lc-find-count').textContent, '0/0')
    await m.unmount()
  })

  test('a body swap under a live lens clamps the active index onto the shorter match list', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: 'one one one' }))
    const input = await openFind(m.container)
    await type(input, 'one')
    await settle()
    const [, next] = barButtons(m.container)
    await click(next)
    await click(next)
    assert.equal(query(m.container, '.lc-find-count').textContent, '3/3')
    await m.update(h(FindHarness, { text: 'one two' }))
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1', 'the active match fell back onto the last survivor')
    assert.equal(queryAll(m.container, '.lc-find-mark-on').length, 1)
    assert.equal(rawText(m.container), 'one two', 'the new body renders its exact source')
    await m.unmount()
  })

  test('matches beyond the cap stop at 500 rendered marks and the counter admits it', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: Array(600).fill('x').join(' ') }))
    const input = await openFind(m.container)
    await type(input, 'x')
    await settle()
    assert.equal(queryAll(m.container, '.lc-find-mark').length, 500)
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/500+')
    await m.unmount()
  })

  test('markdown mode marks the rendered body too', async () => {
    vi.useFakeTimers()
    const m = await mount(h(FindHarness, { text: SAMPLE, mode: 'md' }))
    const input = await openFind(m.container)
    await type(input, 'bold')
    await settle()
    const marks = queryAll(query(m.container, '.lc-ts-desc-md'), '.lc-find-mark')
    assert.deepEqual(marks.map(x => x.textContent), ['bold'])
    assert.equal(query(m.container, '.lc-find-count').textContent, '1/1')
    await m.unmount()
  })
})
})

describe('events', () => {

const kit = makeKit()
const { eventLabel, eventLabelParts, eventAt } = makeEventText(kit.t)
const EventList = makeEventList(kit)

function ev(over: Partial<ContextEventRecord> & { kind: ContextEventRecord['kind'] }): ContextEventRecord {
  return { seq: 1, time: 0, ...over }
}

describe('makeEventText.eventLabel', () => {
  test('compaction counts the replaced messages; prune, model switch, and mode labels resolve', () => {
    assert.equal(eventLabel(ev({ kind: 'compaction', count: 3 })), 'Context compacted (summary replaced 3 messages)')
    assert.equal(eventLabel(ev({ kind: 'compaction' })), 'Context compacted (summary replaced 0 messages)')
    assert.equal(eventLabel(ev({ kind: 'prune' })), 'Tool output pruned')
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a', to: 'b' })), 'Model switched: a → b')
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a' })), 'Model switched: a → ?')
    assert.equal(eventLabel(ev({ kind: 'model', to: 'b' })), 'Model switched: ? → b')
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.on' })), 'Plan mode on')
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.off' })), 'Plan mode off')
    assert.equal(eventLabel(ev({ kind: 'mode' })), 'ev.mode.?')
  })

  test('inject labels: skill injects name the skill, plain injects label their form then append name and detail', () => {
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill', name: 'code-review' })), 'Skill Injection · code-review')
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill' })), 'Skill Injection · ?')
    assert.equal(eventLabel(ev({ kind: 'inject' })), 'Context Injection')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice' })), 'Notice')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook' })), 'Notice · hook')
    assert.equal(eventLabel(ev({ kind: 'inject', detail: 'from the producer' })), 'Context Injection · from the producer')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook', detail: 'd' })), 'Notice · hook · d')
  })
})

describe('makeEventText.eventLabelParts', () => {
  test('an injection leads with its context form and trails its source name and account; other kinds are all tail', () => {
    assert.deepEqual(eventLabelParts(ev({ kind: 'inject', form: 'notice' })), { lead: 'Notice', tail: '' })
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'inject', form: 'notice', name: 'hook', detail: 'd' })),
      { lead: 'Notice', tail: ' · hook · d' },
    )
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'inject', sub: 'skill', name: 'code-review' })),
      { lead: 'Skill Injection', tail: ' · code-review' },
    )
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'compaction', count: 2 })),
      { lead: '', tail: 'Context compacted (summary replaced 2 messages)' },
    )
  })
})

describe('makeEventText.eventAt', () => {
  test('boundary events label the gap or their single point; a partial from-side and missing turn/step degrade', () => {
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 4, fromTurn: 2, fromStep: 3 })), 'T2 S3→4')
    assert.equal(eventAt(ev({ kind: 'prune', turn: 51, step: 1, fromTurn: 50, fromStep: 8 })), 'T50 S8 → T51 S1')
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3 })), 'T2 S3')
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3, fromTurn: 2 })), 'T2 S3')
    assert.equal(eventAt(ev({ kind: 'compaction' })), null)
    assert.equal(eventAt(ev({ kind: 'prune', turn: 1 })), null)
    assert.equal(eventAt(ev({ kind: 'inject', turn: 1, step: 2 })), 'T1 S2')
    assert.equal(eventAt(ev({ kind: 'model' })), null)
  })
})

describe('EventList', () => {
  test('rows render newest first with icons, kinds, labels, positions, tokens, and times', async () => {
    const time = new Date(2024, 0, 2, 3, 4, 5).getTime()
    const events: ContextEventRecord[] = [
      ev({ seq: 1, time, kind: 'inject', form: 'notice', tokens: 50, turn: 1, step: 1 }),
      ev({ seq: 2, time, kind: 'model', from: 'a', to: 'b' }),
      ev({ seq: 3, time, kind: 'compaction', count: 2, tokens: 100, grossTokens: 102 }),
      ev({ seq: 4, time, kind: 'mystery' as never }),
      ev({ seq: 5, time, kind: 'inject', tokens: 0 }),
    ]
    const m = await mount(h(EventList, { events }))
    const rows = queryAll(m.container, '.lc-event')
    assert.equal(rows.length, 5)

    assert.ok(text(rows[0]).includes('Context Injection'))
    assert.equal(query(rows[0], '.lc-event-label b').textContent, 'Context Injection')
    assert.equal(queryAll(rows[0], '.lc-event-tokens').length, 0)

    assert.equal(query(rows[1], '.lc-event-icon').textContent, '•')
    assert.equal(query(rows[1], '.lc-kind').textContent, 'kind.mystery')

    assert.equal(query(rows[2], '.lc-event-icon').textContent, '✂')
    const down = query(rows[2], '.lc-event-tokens')
    assert.ok(down.className.includes('lc-down'))
    assert.equal(down.textContent, '−100')
    assert.equal(down.getAttribute('title'), 'Removed 102; 100 net after the summary replacement')
    assert.equal(queryAll(rows[2], '.lc-event-at').length, 0)

    assert.ok(query(rows[3], '.lc-event-icon svg') instanceof SVGElement)
    assert.ok(text(rows[3]).includes('Model switched: a → b'))
    assert.equal(rows[3].querySelector('.lc-event-label b'), null, 'only an injection form is emphasized')
    assert.equal(query(rows[3], '.lc-kind').textContent, 'Switch')

    assert.ok(query(rows[4], '.lc-event-icon svg') instanceof SVGElement)
    assert.equal(query(rows[4], '.lc-event-label b').textContent, 'Notice')
    const up = query(rows[4], '.lc-event-tokens')
    assert.ok(up.className.includes('lc-up'))
    assert.equal(up.textContent, '+50')
    assert.equal(query(rows[4], '.lc-event-at').textContent, 'T1 S1')
    assert.equal(query(rows[4], '.lc-event-time').textContent, fmtTime(time))
    await m.unmount()
  })

  test('equal gross and net tokens omit the tooltip', async () => {
    const m = await mount(h(EventList, { events: [ev({ seq: 1, kind: 'compaction', tokens: 60, grossTokens: 60 })] }))
    assert.equal(query(m.container, '.lc-event-tokens').getAttribute('title'), null)
    await m.unmount()
  })

  test('truncation effect: jsdom widths are 0 so titles stay empty; a forced overflow syncs the title', async () => {
    const events = [
      ev({ seq: 1, kind: 'inject', form: 'notice' }),
      ev({ seq: 2, kind: 'prune' }),
    ]
    const m = await mount(h(EventList, { events }))
    const labels = queryAll(m.container, '.lc-event-label')
    assert.equal(labels[0].getAttribute('title'), '')
    assert.equal(labels[1].getAttribute('title'), '')

    Object.defineProperty(labels[0], 'scrollWidth', { value: 100, configurable: true })
    Object.defineProperty(labels[1], 'scrollWidth', { value: 100, configurable: true })
    labels[0].textContent = ''
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.equal(labels[0].getAttribute('title'), '')
    assert.equal(labels[1].getAttribute('title'), 'Notice')
    await m.unmount()
  })

  test('a resize while the list shows a remote state syncs nothing (no root yet)', async () => {
    const m = await mount(h(EventList, { events: [], state: 'loading' }))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.ok(query(m.container, '.lc-loading-lane') !== null, 'the loading lane stays painted')
    await m.unmount()
  })

  test('unmounting with a resize frame pending cancels it without touching a detached root', async () => {
    const events = [ev({ seq: 1, kind: 'prune' })]
    const m = await mount(h(EventList, { events }))
    Object.defineProperty(query(m.container, '.lc-event-label'), 'scrollWidth', { value: 100, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await m.unmount()
    })
    await settle(20)
    assert.ok(true, 'the cancelled frame never touched the detached root')
  })

  test('a resize while the list is empty (no rows, no root) does not throw; empty → non-empty → empty stays stable', async () => {
    const m = await mount(h(EventList, { events: [] }))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.ok(text(m.container).includes('No context events yet'))
    await m.update(h(EventList, { events: [ev({ seq: 1, kind: 'prune' })] }))
    assert.equal(queryAll(m.container, '.lc-event').length, 1)
    const label = query(m.container, '.lc-event-label')
    Object.defineProperty(label, 'scrollWidth', { value: 100, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.equal(label.getAttribute('title'), 'Tool output pruned')
    await m.update(h(EventList, { events: [] }))
    assert.ok(text(m.container).includes('No context events yet'))
    await m.unmount()
  })

  test('an appended event keeps every existing row mounted (seq-keyed, newest prepends)', async () => {
    const base = [
      ev({ seq: 1, kind: 'inject', form: 'notice', name: 'first' }),
      ev({ seq: 2, kind: 'prune' }),
    ]
    const m = await mount(h(EventList, { events: base }))
    const before = queryAll(m.container, '.lc-event')
    assert.equal(before.length, 2)

    await m.update(h(EventList, { events: [...base, ev({ seq: 3, kind: 'model', from: 'a', to: 'b' })] }))
    const after = queryAll(m.container, '.lc-event')
    assert.equal(after.length, 3)
    assert.ok(after[0] !== before[0], 'the new event prepends a new row')
    assert.equal(after[1], before[0], 'the previously-newest row keeps its DOM node')
    assert.equal(after[2], before[1], 'the oldest row keeps its DOM node')
    await m.unmount()
  })

  test('inject, compaction and prune rows link; other kinds and a handler-less list keep plain labels', async () => {
    const events = [
      ev({ seq: 1, kind: 'inject', form: 'notice', name: 'hook' }),
      ev({ seq: 2, kind: 'compaction', count: 2 }),
      ev({ seq: 3, kind: 'prune' }),
      ev({ seq: 4, kind: 'model', from: 'a', to: 'b' }),
    ]
    const focused: ContextEventRecord[] = []
    const m = await mount(h(EventList, { events, onEventFocus: e => { focused.push(e) } }))
    const rows = queryAll(m.container, '.lc-event')
    assert.equal(rows[0].querySelector('.lc-event-jump'), null)
    assert.equal(query(rows[0], '.lc-event-label').tagName, 'SPAN')
    const prune = query(rows[1], '.lc-event-jump')
    assert.equal(prune.tagName, 'BUTTON')
    assert.equal(prune.textContent, 'Tool output pruned')
    const compaction = query(rows[2], '.lc-event-jump')
    assert.equal(compaction.tagName, 'BUTTON')
    assert.ok(compaction.textContent?.includes('Context compacted'))
    const link = query(rows[3], '.lc-event-jump')
    assert.equal(link.tagName, 'BUTTON')
    assert.equal(link.textContent, 'Notice · hook')
    await click(link)
    await click(compaction)
    await click(prune)
    assert.deepEqual(focused.map(e => e.seq), [1, 2, 3])
    await m.unmount()

    const plain = await mount(h(EventList, { events }))
    assert.equal(queryAll(plain.container, '.lc-event-jump').length, 0)
    assert.equal(queryAll(plain.container, '.lc-event-label').length, 4)
    await plain.unmount()

    const focused2: ContextEventRecord[] = []
    const guarded = await mount(h(EventList, {
      events,
      onEventFocus: e => { focused2.push(e) },
      canEventFocus: e => e.kind === 'inject',
    }))
    const guardedRows = queryAll(guarded.container, '.lc-event')
    assert.equal(guardedRows[2].querySelector('.lc-event-jump'), null, 'the compaction has no landing step')
    assert.equal(query(guardedRows[2], '.lc-event-label').tagName, 'SPAN')
    await click(query(guardedRows[3], '.lc-event-jump'))
    assert.deepEqual(focused2.map(e => e.seq), [1])
    await guarded.unmount()
  })
})

describe('EventList — the split generation detail states', () => {
  test('a pending read shows the loading note; a failed read arms the retry, or falls back to the empty claim', async () => {
    const loading = await mount(h(EventList, { events: [], state: 'loading', onRetry: () => {} }))
    assert.ok(query(loading.container, '.lc-loading-lane') !== null, 'a pending read paints the loading lane')
    assert.ok(!text(loading.container).includes('No context events yet'))
    await loading.unmount()

    let retries = 0
    const m = await mount(h(EventList, { events: [], state: 'failed', onRetry: () => { retries++ } }))
    const retry = query(m.container, '.lc-br-retry')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await click(retry)
    assert.equal(retries, 1)

    const inert = await mount(h(EventList, { events: [], state: 'failed' }))
    assert.ok(text(inert.container).includes('No context events yet'), 'no retry wired — the plain empty state')
    await inert.unmount()
    await m.unmount()
  })
})
})
