// ContextJump (src/client/components/contextJump.tsx) — the assistant-action
// jump button rendered for real: seat props re-proved, the clicked reply's
// request seq resolved off the served node seat, the relay + tab activation
// driven through the real viewFocus module.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeContextJumpButton } from '../../../src/client/components/contextJump'
import type { ConversationNodeLike, UseSessionLike } from '../../../src/client/services'
import { takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { h } from '../../../src/client/react'
import { click, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const Jump = makeContextJumpButton(kit)

const SESSION = 'sv-jump'

/** The chat node seat: the session snapshot arm carrying assistant nodes with message ids (hostile shapes forced past the seat type). */
function sessionWith(nodes: unknown): { useSession?: UseSessionLike } {
  return { useSession: (sel => sel({ nodes: nodes as readonly ConversationNodeLike[] })) as UseSessionLike }
}

const reply = { kind: 'assistant', seq: 4, messageId: 'msg-4' }
const toolNode = { kind: 'tool', seq: 3, messageId: 'msg-tool' }

describe('ContextJump — seat guards', () => {
  test('a non-string or empty message id renders nothing', async () => {
    const m1 = await mount(h(Jump, {}))
    assert.equal(queryAll(m1.container, 'button').length, 0)
    await m1.unmount()
    const m2 = await mount(h(Jump, { messageId: '' }))
    assert.equal(queryAll(m2.container, 'button').length, 0)
    await m2.unmount()
    const m3 = await mount(h(Jump, { messageId: 42 }))
    assert.equal(queryAll(m3.container, 'button').length, 0)
    await m3.unmount()
  })

  test('renders the labelled icon button for a finalized reply', async () => {
    const m = await mount(h(Jump, { messageId: 'msg-4' }))
    const btn = query(m.container, 'button.lc-jump')
    assert.equal(btn.getAttribute('aria-label'), DICT_EN['jump.title'])
    assert.ok(btn.querySelector('svg') !== null)
    await m.unmount()
  })

  test('a click with no served node seat switches tabs and mints no focus', async () => {
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION }))
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null)
    await m.unmount()
  })
})

describe('ContextJump — click flow', () => {
  test('resolves the reply seq off the session seat, records the relay, and activates the tab', async () => {
    const bar = document.createElement('div')
    const chat = document.createElement('button')
    chat.setAttribute('role', 'tab')
    chat.setAttribute('aria-selected', 'true')
    chat.textContent = 'Chat'
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.append(chat, context)
    document.body.appendChild(bar)
    try {
      const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION, ...sessionWith([reply, toolNode]) }))
      await click(query(m.container, 'button.lc-jump'))
      assert.equal(takeContextFocus(SESSION), 4, 'the clicked reply’s request seq rides the relay')
      assert.equal(contextClicks, 1, 'the Context tab button was clicked')
      assert.equal(takeContextFocus(SESSION), null)
      await m.unmount()
    } finally {
      bar.remove()
    }
  })

  test('the seq resolution prefers the matching assistant node and drops non-finite seqs', async () => {
    const m = await mount(h(Jump, { messageId: 'msg-tool', sessionId: SESSION, ...sessionWith([reply, toolNode]) }))
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a tool node never mints a focus')
    await m.unmount()

    const broken = { kind: 'assistant', seq: Number.NaN, messageId: 'msg-x' }
    const m2 = await mount(h(Jump, { messageId: 'msg-x', sessionId: SESSION, ...sessionWith([broken]) }))
    await click(query(m2.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a non-finite seq never mints a focus')
    await m2.unmount()
  })

  test('a hostile node that throws on property access is skipped, not fatal', async () => {
    const hostile = { get kind(): string { throw new Error('boom') } }
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION, ...sessionWith([hostile, reply]) }))
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), 4, 'the real reply after the hostile element still resolves')
    await m.unmount()

    const hostileMatch = {
      get kind(): string { return 'assistant' },
      get messageId(): string { throw new Error('boom') },
    }
    const m2 = await mount(h(Jump, { messageId: 'msg-9', sessionId: SESSION, ...sessionWith([hostileMatch]) }))
    await click(query(m2.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a hostile match candidate degrades to no focus')
    await m2.unmount()
  })

  test('an unknown reply and a missing session still switch tabs, minting no relay entry', async () => {
    const bar = document.createElement('div')
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.appendChild(context)
    document.body.appendChild(bar)
    try {
      const m = await mount(h(Jump, { messageId: 'msg-none', sessionId: SESSION, ...sessionWith([reply]) }))
      await click(query(m.container, 'button.lc-jump'))
      assert.equal(takeContextFocus(SESSION), null)
      assert.equal(contextClicks, 1, 'the tab still opens, just without a pinned step')
      await m.unmount()

      const m2 = await mount(h(Jump, { messageId: 'msg-4', sessionId: 7, ...sessionWith([reply]) }))
      await click(query(m2.container, 'button.lc-jump'))
      assert.equal(contextClicks, 2)
      await m2.unmount()
    } finally {
      bar.remove()
    }
  })
})
