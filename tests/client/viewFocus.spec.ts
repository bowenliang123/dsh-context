import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { act, createElement as h } from 'react'
import { activateViewTab, currentFleetMemberFocus, openContextSidebar, requestContextFocus, requestFleetMemberFocus, subscribeContextFocus, takeContextFocus, useFleetMemberFocus } from '../../src/client/viewFocus'
import { disposeRetention } from '../../src/client/retention'
import { asClientCtx, TestClientCtx } from './helpers/harness'
import { mount } from './helpers/kit'

describe('context focus relay', () => {
  test('one request survives until taken; a fresh request replaces it and sessions are isolated', () => {
    requestContextFocus('sv-relay', 42)
    assert.equal(takeContextFocus('sv-relay'), 42)
    assert.equal(takeContextFocus('sv-relay'), null, 'one-shot: a second take finds nothing')
    requestContextFocus('sv-race', 7)
    requestContextFocus('sv-race', 9)
    assert.equal(takeContextFocus('sv-race'), 9, 'the latest click wins')
    requestContextFocus('sv-other', 1)
    assert.equal(takeContextFocus('sv-other'), 1)
    assert.equal(takeContextFocus('sv-unknown'), null)
  })
})

describe('context focus subscription', () => {
  test('every record wakes the subscriber; the unsubscribe stops delivery', () => {
    let hits = 0
    const off = subscribeContextFocus(() => { hits++ })
    requestContextFocus('sv-a', 1)
    assert.equal(hits, 1)
    requestContextFocus('sv-b', 2)
    assert.equal(hits, 2, 'other-session records wake the view too — it takes only its own entry')
    off()
    requestContextFocus('sv-a', 3)
    assert.equal(hits, 2, 'the detached listener hears nothing')
    takeContextFocus('sv-a')
    takeContextFocus('sv-b')
  })

  test('a listener unsubscribing another mid-notify skips it (later records do not re-run it)', () => {
    let late = 0
    let offLate: () => void = () => {}
    const offRemover = subscribeContextFocus(() => { offLate() })
    offLate = subscribeContextFocus(() => { late++ })
    requestContextFocus('sv-mid', 1)
    assert.equal(late, 0, 'an element removed before iteration reaches it never runs')
    requestContextFocus('sv-mid', 2)
    assert.equal(late, 0, 'and it stays detached')
    offRemover()
    takeContextFocus('sv-mid')
  })
})

describe('openContextSidebar', () => {
  test('opens the registered kind through the sidebarRight face; absent or verb-less faces report false', () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openTab: (kind: string) => { opened.push(kind) } } } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), true)
    assert.deepEqual(opened, ['dsh-context'])

    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx())), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: {} } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: null } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: 'x' } }))), false)
  })

  test('a hostile face — throwing read or openTab — reports false, never throws', () => {
    const throwingRead = {
      get(_name: string): unknown { throw new Error('boom') },
    } as unknown as TestClientCtx
    assert.equal(openContextSidebar(asClientCtx(throwingRead)), false)
    const ctx = new TestClientCtx({ services: {
      sidebarRight: { openTab: () => { throw new Error('no session surface mounted') } },
    } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), false)
  })
})

describe('activateViewTab', () => {
  test('clicks the inactive tab matching the label, skips the active one, and reports misses', () => {
    type Counted = HTMLElement & { __clicks: () => number }
    const bar = document.createElement('div')
    const mk = (label: string, selected: boolean): Counted => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      if (selected) b.setAttribute('aria-selected', 'true')
      b.textContent = label
      let clicks = 0
      b.addEventListener('click', () => { clicks++ })
      const counted = Object.assign(b, { __clicks: () => clicks })
      bar.appendChild(counted)
      return counted
    }
    const chat = mk('Chat', true)
    const context = mk('Context', false)
    const trajectory = mk('Trajectory', false)
    document.body.appendChild(bar)
    try {
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)
      assert.equal(chat.__clicks(), 0)

      context.setAttribute('aria-selected', 'true')
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)

      context.setAttribute('aria-selected', 'false')
      context.textContent = '  Context '
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 2)

      assert.equal(activateViewTab('Missing'), false)
      assert.equal(trajectory.__clicks(), 0)
    } finally {
      bar.remove()
    }
  })
})

describe('focus relays stay bounded and release on dispose', () => {
  test('the pending focus map keeps only its newest sixteen sessions', () => {
    for (let i = 0; i < 17; i++) requestContextFocus('focus-cap-' + i, i)
    assert.equal(takeContextFocus('focus-cap-0'), null)
    assert.equal(takeContextFocus('focus-cap-16'), 16)
  })

  test('the member focus map keeps only its newest eight sessions', () => {
    for (let i = 0; i < 9; i++) requestFleetMemberFocus('member-cap-' + i, 'm' + i)
    assert.equal(currentFleetMemberFocus('member-cap-0'), null)
    assert.equal(currentFleetMemberFocus('member-cap-8'), 'm8')
  })

  test('dispose clears pending relays and listeners', () => {
    let hits = 0
    subscribeContextFocus(() => { hits++ })
    requestContextFocus('focus-dispose', 3)
    requestFleetMemberFocus('member-dispose', 'm')
    disposeRetention()
    assert.equal(takeContextFocus('focus-dispose'), null)
    assert.equal(currentFleetMemberFocus('member-dispose'), null)
    const before = hits
    requestContextFocus('focus-after-1', 1)
    requestContextFocus('focus-after-2', 2)
    assert.equal(hits, before, 'the disposed listeners hear nothing')
    takeContextFocus('focus-after-1')
    takeContextFocus('focus-after-2')
  })
})

describe('useFleetMemberFocus', () => {
  test('follows the recorded member and detaches on a session change', async () => {
    const box: { current: string | null } = { current: null }
    function Probe(props: { sessionId?: string }): null {
      box.current = useFleetMemberFocus(props.sessionId)
      return null
    }
    const m = await mount(h(Probe, { sessionId: 'member-session' }))
    try {
      assert.equal(box.current, null, 'no focus recorded yet')
      await act(async () => { requestFleetMemberFocus('member-session', 'm1') })
      assert.equal(box.current, 'm1')
      await m.update(h(Probe, { sessionId: '' }))
      await act(async () => { requestFleetMemberFocus('member-session', 'm2') })
      assert.equal(box.current, 'm1', 'the detached probe hears nothing')
    } finally {
      await m.unmount()
    }
  })
})
