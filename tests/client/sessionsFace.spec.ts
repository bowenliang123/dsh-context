// The sessions-face channel (src/client/sessionsFace.ts): the live read a React
// seat gets, the declared-inject watcher that announces service arrival and
// revocation, and the auto-heal a mount that raced the service depends on.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { subscribeSessionsFace, useSessionsFace, watchSessionsFace } from '../../src/client/sessionsFace'
import type { ReactElement } from 'react'
import { asClientCtx, TestClientCtx, TestSessionList } from './helpers/harness'
import { flush, mount } from './helpers/kit'

/** A minimal outward sessions service: one valid list feed. */
function sessionsService(): { list: TestSessionList['list'] } {
  return { list: new TestSessionList({}).list }
}

describe('useSessionsFace', () => {
  test('a seat mounted before the service reads no face, then heals when it lands', async () => {
    const ctx = new TestClientCtx()
    function Probe(): ReactElement {
      const face = useSessionsFace(asClientCtx(ctx))
      return h('div', null, face === null ? 'no-face' : 'has-face')
    }
    watchSessionsFace(asClientCtx(ctx))
    const m = await mount(h(Probe))
    assert.equal(m.container.textContent, 'no-face', 'the service is not composed yet')
    // The service lands mid-mount: the watcher announces, the seat re-reads and
    // re-renders — the whole point, since the cost cell's degrade is silent.
    await act(async () => { ctx.setService('sessions', sessionsService()) })
    await flush()
    assert.equal(m.container.textContent, 'has-face')
    await m.unmount()
  })
})

describe('watchSessionsFace', () => {
  test('an already-composed service fires immediately, and disposal announces the loss', () => {
    const ctx = new TestClientCtx({ services: { sessions: sessionsService() } })
    let heard = 0
    const stop = subscribeSessionsFace(() => { heard++ })
    watchSessionsFace(asClientCtx(ctx))
    assert.equal(heard, 1, 'the inject callback fires on the service already present')
    ctx.dispose()
    assert.equal(heard, 2, 'unloading the fiber announces the revocation')
    // A service armed after the fiber retired reaches nobody.
    ctx.setService('sessions', sessionsService())
    assert.equal(heard, 2)
    stop()
  })

  test('a harness that never composes the service leaves the wait pending', () => {
    const ctx = new TestClientCtx()
    let heard = 0
    const stop = subscribeSessionsFace(() => { heard++ })
    watchSessionsFace(asClientCtx(ctx))
    assert.equal(heard, 0)
    stop()
  })
})
