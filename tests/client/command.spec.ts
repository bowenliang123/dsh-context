// The /context slash command (src/client/command.ts): soft service
// dependency, trigger-source registration, candidates, pick, and enter
// adjudication over a faithful harness ctx. Session ids are unique per test
// so the module-level modal/consume state never leaks between cases.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { registerContextCommand } from '../../src/client/command'
import { DICT_EN } from '../../src/client/i18n'
import { modalStoreOf, takePendingConsume } from '../../src/client/modalStore'
import type { InputTriggersFace } from '../../src/client/services'
import { asClientCtx, TestClientCtx } from './helpers/harness'
import { makeKit } from './helpers/kit'

type Source = Parameters<InputTriggersFace['registerSource']>[0]

/** A real in-memory input-trigger face (registerSource records + disposes). */
class TestInputTriggers {
  readonly sources: Source[] = []

  registerSource(src: Source): () => void {
    this.sources.push(src)
    return () => {
      const i = this.sources.indexOf(src)
      if (i >= 0) this.sources.splice(i, 1)
    }
  }
}

const SIGNAL = new AbortController().signal

function setup(): { ctx: TestClientCtx; inputTriggers: TestInputTriggers; source: Source } {
  const inputTriggers = new TestInputTriggers()
  const ctx = new TestClientCtx({ services: { inputTriggers } })
  registerContextCommand(asClientCtx(ctx), makeKit())
  assert.equal(inputTriggers.sources.length, 1)
  return { ctx, inputTriggers, source: inputTriggers.sources[0] }
}

describe('registerContextCommand', () => {
  test('without the input-triggers service nothing registers and disposal is safe', () => {
    const ctx = new TestClientCtx()
    registerContextCommand(asClientCtx(ctx), makeKit())
    ctx.dispose()
  })

  test('a service provided with a foreign shape registers nothing', () => {
    // The inject callback fires on the service NAME; a value that is not a
    // trigger face (a half-composed module, a producer drift) must degrade
    // to the no-command state instead of throwing at apply.
    const ctx = new TestClientCtx({ services: { inputTriggers: { registerSource: 42 } } })
    registerContextCommand(asClientCtx(ctx), makeKit())
    ctx.dispose()
  })

  test('with the service it registers one "/" source named context at order 1', () => {
    const { ctx, inputTriggers, source } = setup()
    assert.equal(source.trigger, '/')
    assert.equal(source.name, 'context')
    assert.equal(source.order, 1)
    ctx.dispose()
    assert.equal(inputTriggers.sources.length, 0)
  })
})

describe('candidates', () => {
  test('a non-leading position yields no candidates', async () => {
    const { source } = setup()
    assert.deepEqual(await source.candidates({ sessionId: 'cmd-pos' }, { query: '', position: 'trailing', signal: SIGNAL }), [])
  })

  test('an empty query yields the context candidate', async () => {
    const { source } = setup()
    const candidates = await source.candidates({ sessionId: 'cmd-empty' }, { query: '', position: 'leading', signal: SIGNAL })
    assert.deepEqual(candidates, [{ name: 'context', description: DICT_EN['cmd.desc'] }])
  })

  test('a matching prefix yields the candidate; a mismatch yields none', async () => {
    const { source } = setup()
    const session = { sessionId: 'cmd-prefix' }
    const hit = await source.candidates(session, { query: 'con', position: 'leading', signal: SIGNAL })
    assert.equal(hit.length, 1)
    assert.equal(hit[0].name, 'context')
    assert.deepEqual(await source.candidates(session, { query: 'xyz', position: 'leading', signal: SIGNAL }), [])
  })

  test('the query match is case- and whitespace-insensitive', async () => {
    const { source } = setup()
    const candidates = await source.candidates({ sessionId: 'cmd-case' }, { query: ' CONTEXT ', position: 'leading', signal: SIGNAL })
    assert.equal(candidates.length, 1)
  })
})

describe('onPick', () => {
  test('records the span guard, opens the modal, and answers handled', () => {
    const { source } = setup()
    const span = { start: 0, end: 8, draftRev: 3 }
    const outcome = source.onPick({
      candidate: { name: 'context' },
      session: { sessionId: 'cmd-pick' },
      position: 'leading',
      via: 'menu',
      span,
    })
    assert.equal(outcome, 'handled')
    assert.equal(modalStoreOf('cmd-pick').getSnapshot(), true)
    assert.deepEqual(takePendingConsume('cmd-pick'), { kind: 'span', span })
  })
})

describe('matchEnter', () => {
  // The contract marks matchEnter optional; registerContextCommand always
  // provides it, and the spec asserts that registration shape once.
  test('the bare /context line arms the bare-token guard, opens the modal, and answers handled', async () => {
    const { source } = setup()
    assert.ok(source.matchEnter, 'the /context source registers matchEnter')
    const outcome = await source.matchEnter({ sessionId: 'cmd-enter' }, '/context', SIGNAL)
    assert.equal(outcome, 'handled')
    assert.equal(modalStoreOf('cmd-enter').getSnapshot(), true)
    assert.deepEqual(takePendingConsume('cmd-enter'), { kind: 'bare-token', token: '/context' })
  })

  test('a /context line with trailing text is not matched', async () => {
    const { source } = setup()
    assert.ok(source.matchEnter)
    assert.equal(await source.matchEnter({ sessionId: 'cmd-extra' }, '/context extra', SIGNAL), undefined)
    assert.equal(takePendingConsume('cmd-extra'), undefined)
  })

  test('any other line is not matched', async () => {
    const { source } = setup()
    assert.ok(source.matchEnter)
    assert.equal(await source.matchEnter({ sessionId: 'cmd-other' }, 'hello', SIGNAL), undefined)
  })
})
