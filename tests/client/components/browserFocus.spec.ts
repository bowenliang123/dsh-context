import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextHeaders } from '../../../src/shared/types'
import type { ConversationNodeLike } from '../../../src/client/services'
import { click, mount, query, queryAll, surfaceNode, text } from '../helpers/kit'
import { Browser, catRow, pickStep, props, req, tl } from './browserHarness'

describe('ContextBrowser focus bridges', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, systemTokens: 3,
      tools: [
        { name: 'beta', tokens: 50 },
        { name: 'alpha', tokens: 10 },
      ],
    }],
  }
  const data = tl({
    current: { system: 10, tools: 60, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 80 },
    requests: [req({ seq: 10, turn: 1, step: 0, total: 80 }), req({ seq: 20, turn: 1, step: 1, total: 80 })],
    nodes: [surfaceNode({ seq: 1, tokens: 5, text: 'focusable' }), surfaceNode({ seq: 11, cat: 'assistant', tokens: 5, text: 'answer' })],
  })
  const convNodes: ConversationNodeLike[] = [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'focusable' }] }]

  test('nodeFocus selects the step, opens the node, reveals it within the card only, and clears', async () => {
    const scrolls: unknown[] = []
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) { scrolls.push(arg) } as never
    try {
      let handled = 0
      const m = await mount(h(Browser, props({ data, headers, convNodes })))
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 'live', key: 'n1', cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.equal(handled, 1)
      const onRows = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(onRows.length, 1)
      assert.ok(text(onRows[0]).includes('focusable'))
      assert.deepEqual(scrolls, [], 'the open row reveals inside the card — never a scrollIntoView that could drag the page')
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 20, key: 'n1', cat: 'user' },
        onNodeFocusHandled: () => { handled += 1 },
      })))
      assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 1'))
      assert.equal(handled, 2)
      await m.update(h(Browser, props({
        data, headers, convNodes,
        nodeFocus: { step: 'live', key: 'n999', cat: 'user' },
      })))
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0)
      await m.unmount()
    } finally {
      Element.prototype.scrollIntoView = orig
    }
  })

  test('pinSeq selects the pinned step and unpinning returns to live (accordion resets)', async () => {
    const m = await mount(h(Browser, props({ data, headers })))
    await click(catRow(m, 'user'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 1)
    await m.update(h(Browser, props({ data, headers, pinSeq: 10 })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Turn 1 · Step 0'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 0, 'pinning resets the accordion')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '10')
    await m.update(h(Browser, props({ data, headers, pinSeq: null })))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Live · Next Request'))
    await m.unmount()
  })
})

describe('ContextBrowser open-category reporting', () => {
  test('toggling categories and step picks report the open category outward', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 }), req({ seq: 20, turn: 2, step: 0 })],
      nodes: [
        surfaceNode({ seq: 1, cat: 'user', text: 'hi' }),
        surfaceNode({ seq: 2, cat: 'user', text: 'again' }),
        surfaceNode({ seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'out' }),
      ],
    })
    const opens: (string | null)[] = []
    const onOpenCat = (c: string | null): void => { opens.push(c) }
    const m = await mount(h(Browser, props({ data, onOpenCat })))
    assert.deepEqual(opens, [null], 'the mount-time pin pass reports the closed accordion')
    await click(catRow(m, 'user'))
    assert.deepEqual(opens, [null, 'user'])
    await click(catRow(m, 'user'))
    assert.deepEqual(opens, [null, 'user', null])
    await click(catRow(m, 'tool'))
    assert.deepEqual(opens, [null, 'user', null, 'tool'])
    await pickStep(m, '20')
    assert.deepEqual(opens, [null, 'user', null, 'tool', null], 'a step pick closes the open category')
    await m.unmount()

    const data2 = tl({ requests: [req({ seq: 10, turn: 1, step: 0 })], nodes: [surfaceNode({ seq: 1, cat: 'user', text: 'hi' })] })
    const opens2: (string | null)[] = []
    const onOpenCat2 = (c: string | null): void => { opens2.push(c) }
    const m2 = await mount(h(Browser, props({ data: data2, onOpenCat: onOpenCat2 })))
    await m2.update(h(Browser, props({ data: data2, onOpenCat: onOpenCat2, pinSeq: 10 })))
    assert.deepEqual(opens2, [null, null], 'pinning resets the accordion')
    await m2.update(h(Browser, props({
      data: data2, onOpenCat: onOpenCat2, pinSeq: 10,
      nodeFocus: { step: 'live', key: 'n1', cat: 'tool' },
      onNodeFocusHandled: () => {},
    })))
    assert.deepEqual(opens2, [null, null, 'tool'], 'the reveal opens the node category')
    await m2.unmount()
  })

  test('catFocus opens the named category on the live surface, picking the kind chip', async () => {
    const data = tl({
      requests: [req({ seq: 10, turn: 1, step: 0 })],
      nodes: [
        surfaceNode({ seq: 1, cat: 'skill', tokens: 5, skill: 'pdf', text: 'instructions' }),
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 5, text: 'an answer' }),
        surfaceNode({ seq: 3, cat: 'assistant', tokens: 5, calls: ['bash'] }),
      ],
    })
    const opens: (string | null)[] = []
    const onOpenCat = (c: string | null): void => { opens.push(c) }
    let handled = 0
    const m = await mount(h(Browser, props({ data, onOpenCat })))
    await m.update(h(Browser, props({
      data,
      onOpenCat,
      catFocus: { cat: 'assistant', kind: 'answer' },
      onCatFocusHandled: () => { handled += 1 },
    })))
    assert.equal(handled, 1)
    assert.deepEqual(opens, [null, 'assistant'])
    assert.ok(catRow(m, 'assistant').className.includes('lc-br-cat-open'))
    const assistantCat = catRow(m, 'assistant').parentElement as HTMLElement
    const chips = queryAll(assistantCat, '.lc-gran-btn')
    const answerChip = chips.find(b => text(b).includes('Answer'))
    assert.ok(answerChip !== undefined && answerChip.className.includes('lc-gran-on'), 'the answer chip is picked')
    const shownRows = queryAll(assistantCat, '.lc-br-elem')
    assert.equal(shownRows.length, 1, 'only the textual reply survives the answer filter')
    assert.ok(text(shownRows[0]).includes('an answer'))
    await m.update(h(Browser, props({
      data,
      onOpenCat,
      catFocus: { cat: 'skill' },
      onCatFocusHandled: () => { handled += 1 },
    })))
    assert.equal(handled, 2)
    assert.deepEqual(opens, [null, 'assistant', 'skill'])
    assert.ok(catRow(m, 'skill').className.includes('lc-br-cat-open'))
    assert.ok(!catRow(m, 'assistant').className.includes('lc-br-cat-open'), 'the previous category closed')
    await m.unmount()
  })
})



describe('ContextBrowser step picker bounds', () => {
  test('a long session caps the option list to the newest steps and follows an older selection', async () => {
    const requests = Array.from({ length: 600 }, (_, i) => req({ seq: i + 1, turn: i + 1, step: 0 }))
    const data = tl({ requests, nodes: [surfaceNode({ seq: 1, tokens: 5 })] })
    const m = await mount(h(Browser, props({ data, headers: null })))
    try {
      let options = queryAll(m.container, 'select.lc-br-pick option')
      assert.equal(options.length, 501, 'live view lists the live option plus the newest 500 steps')
      await m.update(h(Browser, props({ data, headers: null, pinSeq: 40 })))
      options = queryAll(m.container, 'select.lc-br-pick option')
      assert.equal(options.length, 501, 'an old selection re-anchors the option window around it')
      const select = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
      assert.equal(select.value, '40', 'the pinned old step stays selectable in the windowed list')
      assert.ok(text(select).includes('Turn 260'), 'the window centers on the pinned step')
      await m.update(h(Browser, props({ data, headers: null, pinSeq: null })))
      options = queryAll(m.container, 'select.lc-br-pick option')
      assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
      assert.ok(options.length <= 501)
    } finally {
      await m.unmount()
    }
  })

  test('a session at or below the cap lists every step', async () => {
    const requests = Array.from({ length: 500 }, (_, i) => req({ seq: i + 1, turn: i + 1, step: 0 }))
    const data = tl({ requests, nodes: [surfaceNode({ seq: 1, tokens: 5 })] })
    const m = await mount(h(Browser, props({ data, headers: null })))
    try {
      const options = queryAll(m.container, 'select.lc-br-pick option')
      assert.equal(options.length, 501)
      assert.ok(text(query(m.container, 'select.lc-br-pick')).includes('Turn 1 ·'))
    } finally {
      await m.unmount()
    }
  })
})
