// Tests for the step-boundary message identity guard (src/host/stepIdentity.ts)
// — the issue #51 compatibility layer. The harness's load path refuses a
// session whose log holds an unidentified `user/message`, while the runtime
// append path never checks; the guard mints ids at the `agent/pre-step` seam
// so a stripped message can no longer persist unidentified.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { identifiedMessages, watchStepIdentity, type PreStepDecision } from '../../src/host/stepIdentity'

/** A well-formed identified message. */
function identified(id = 'm-1'): Record<string, unknown> {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

describe('identifiedMessages', () => {
  test('an all-identified list returns undefined and copies nothing', () => {
    const messages = [identified('a'), identified('b')]
    assert.equal(identifiedMessages(messages), undefined)
  })

  test('a missing, empty, null, or non-string id is minted; other fields survive', () => {
    const broken = [
      { role: 'user', source: { kind: 'user' }, content: [] },
      { id: '', role: 'user' },
      { id: null },
      { id: 42 },
    ]
    const fixed = identifiedMessages(broken)
    assert.ok(fixed !== undefined)
    assert.equal(fixed.length, broken.length)
    for (const [index, message] of fixed.entries()) {
      assert.match((message as { id: string }).id, /^dshctx-[0-9a-f-]{36}$/, `entry ${index} minted`)
    }
    assert.deepEqual(
      fixed.map(message => ({ ...(message as object), id: undefined })),
      broken.map(message => ({ ...(message as object), id: undefined })),
      'every non-id field passes through',
    )
  })

  test('untouched entries keep their references; minted ids are unique', () => {
    const good = identified('keep')
    const fixed = identifiedMessages([good, {}, good])
    assert.ok(fixed !== undefined)
    assert.equal(fixed[0], good)
    assert.equal(fixed[2], good)
    assert.notEqual((fixed[1] as { id: string }).id, (fixed[0] as { id: string }).id)
  })

  test('non-object entries stay verbatim (unfixable without inventing a container)', () => {
    const messages = [null, 42, 'x']
    assert.equal(identifiedMessages(messages), undefined)
  })

  test('a prefix-only mint happens before the first broken entry', () => {
    const good = identified('head')
    const broken = { role: 'user' }
    const fixed = identifiedMessages([good, good, broken])
    assert.ok(fixed !== undefined)
    assert.equal(fixed[0], good)
    assert.equal(fixed[1], good)
    assert.match((fixed[2] as { id: string }).id, /^dshctx-/)
  })
})

describe('watchStepIdentity', () => {
  /** Boot a context with the guard and dispatch one pre-step waterfall. */
  async function drive(inner: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const ctx = new Context()
    watchStepIdentity(ctx)
    return ctx.waterfall('agent/pre-step', { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 }, inner)
  }

  test('an enter decision with an unidentified message comes back minted', async () => {
    const decision: PreStepDecision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
    const result = await drive(() => Promise.resolve(decision))
    assert.equal(result.kind, 'enter')
    assert.match((result.messages![0] as { id: string }).id, /^dshctx-/)
    assert.equal((result.messages![0] as { role: string }).role, 'user', 'the rest of the message survives')
  })

  test('an identified decision passes through by reference', async () => {
    const decision = { kind: 'enter', messages: [identified('m-9')] }
    assert.equal(await drive(() => Promise.resolve(decision)), decision)
  })

  test('a reject decision passes through untouched', async () => {
    const decision = { kind: 'reject' }
    assert.equal(await drive(() => Promise.resolve(decision)), decision)
  })

  test('a decision without a message list passes through untouched', async () => {
    const decision = { kind: 'enter' }
    assert.equal(await drive(() => Promise.resolve(decision)), decision)
  })

  test('a hostile decision (throwing property access) passes through verbatim', async () => {
    const decision = {
      get kind(): string { throw new Error('hostile decision') },
    }
    assert.equal(await drive(() => Promise.resolve(decision)), decision)
  })

  test('a hostile entry (throwing on id access) fails the whole guard open', async () => {
    const decision = {
      kind: 'enter',
      get messages(): unknown[] { throw new Error('hostile messages') },
    }
    assert.equal(await drive(() => Promise.resolve(decision)), decision)
  })

  test('the guard rides outermost: it post-processes what later listeners returned', async () => {
    const ctx = new Context()
    const order: string[] = []
    watchStepIdentity(ctx)
    ctx.on('agent/pre-step', async (_input, next) => {
      order.push('inner-pre')
      const decision = await next()
      order.push('inner-post')
      return decision
    })
    const result = await ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [{ role: 'user' }] } as PreStepDecision),
    )
    assert.deepEqual(order, ['inner-pre', 'inner-post'])
    assert.match(((result.messages as unknown[])[0]! as { id: string }).id, /^dshctx-/, 'the message the loop would append is identified')
  })
})
