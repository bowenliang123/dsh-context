import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyActivity, createContextActivityDefinition } from '../../src/host/activity'
import { volatileField } from '../../src/host/config'
import { headerRecordsOf, createContextHeadersDefinition } from '../../src/host/headers'
import { mountPostRoute, revisionOf } from '../../src/host/postRoute'
import { detectPluginVersion } from '../../src/host/version'
import { connectionOf, fakeCtx } from './helpers/ctx'

const at = (time = 1) => ({ type: 'assistant/message', seq: 1, time, data: {} }) as unknown as SessionEvent

describe('host module edges', () => {
  test('volatileField keeps a plain schema as-is', () => {
    const field = { kind: 'plain' }
    assert.equal(volatileField(field as never), field)
  })

  test('detectPluginVersion reads this package manifest and falls back to zero', () => {
    assert.match(detectPluginVersion(), /^\d+\.\d+\.\d+/)
    const empty = mkdtempSync(join(tmpdir(), 'dscx-version-'))
    assert.equal(detectPluginVersion(empty), '0.0.0')
    rmSync(empty, { recursive: true, force: true })
  })

  test('revisionOf ignores non-object observations and blank revisions', () => {
    for (const value of [undefined, null, 7, 'x', [], {}]) {
      assert.equal(revisionOf(value), undefined)
    }
    assert.equal(revisionOf({ revision: '' }), undefined)
    assert.equal(revisionOf({ revision: 'r1' }), 'r1')
  })

  test('mountPostRoute skips an absent handler and toggles its gate', async () => {
    const fake = fakeCtx({ connection: connectionOf() }, { injectAll: true })
    mountPostRoute({
      ctx: fake.ctx, deps: ['connection'], path: '/skip', label: 'skip',
      handler: () => undefined,
    })
    assert.equal(fake.routes.size, 0)
    const gate = { live: false }
    mountPostRoute({
      ctx: fake.ctx, deps: ['connection'], path: '/gate', label: 'gate', gate,
      handler: () => async () => Response.json({ ok: true }),
    })
    assert.equal(gate.live, true)
    assert.equal(fake.routes.has('/gate'), true)
    fake.dispose()
  })

  test('activity definition applies through its public shape and preserves booked turns', () => {
    const def = createContextActivityDefinition()
    const first = def.apply(def.init(), at())
    assert.deepEqual(first.days, { '1970-01-01': { tokens: 0, requests: 1 } })
    const started = applyActivity(def.init(), { type: 'step/start', seq: 1, time: new Date(2026, 0, 1, 12).getTime(), data: {} } as never)
    const booked = applyActivity(started, { type: 'assistant/message', seq: 2, time: new Date(2026, 0, 1, 12).getTime(), data: { turn: 1, usage: { inputTokens: 1 } } } as never)
    const copied = applyActivity(booked, { type: 'assistant/message', seq: 3, time: new Date(2026, 0, 1, 13).getTime(), data: { turn: 1, usage: { inputTokens: 1 } } } as never)
    const stepped = applyActivity(copied, { type: 'step/end', seq: 4, time: new Date(2026, 0, 1, 13, 5).getTime(), data: {} } as never)
    assert.equal(stepped.days['2026-01-01'].turns, 1)
    assert.equal(stepped.days['2026-01-01'].requests, 2)
    assert.equal((stepped.days['2026-01-01'].wallMs ?? 0) > 0, true)
  })
})

describe('context headers', () => {
  const headerEvent = (seq: number, data: unknown) => ({ type: 'request/header', seq, time: seq, data }) as never

  test('records reject absent payloads and accept hostile tools', () => {
    const def = createContextHeadersDefinition()
    const state = def.init()
    assert.equal(def.apply(state, { type: 'user/message' } as never), state)
    assert.equal(def.apply(state, headerEvent(1, undefined)), state)
    assert.equal(def.apply(state, headerEvent(1, { header: null })), state)
    assert.equal(def.apply(state, headerEvent(1, { header: 'x' })), state)
    const recorded = def.apply(state, headerEvent(1, {
      header: { tools: [null, 7, { name: 42 }, { name: 'plain' }, { name: 'plug', plugin: 'p' }, { name: 'empty', plugin: '' }] },
    }))
    assert.equal(recorded.headers.length, 1)
    assert.deepEqual(recorded.headers[0].tools.map(tool => tool.name), ['?', '?', '?', 'plain', 'plug', 'empty'])
    assert.deepEqual(recorded.headers[0].tools.map(tool => tool.plugin), [undefined, undefined, undefined, undefined, 'p', undefined])
    const noTools = def.apply(state, headerEvent(2, { header: { tools: 'nope' } }))
    assert.deepEqual(noTools.headers[0].tools, [])
  })

  test('wire rows resolve plugins, estimate systems and keep explicit token totals', () => {
    const records = headerRecordsOf({
      headers: [
        { seq: 1, time: 1, tools: [{ name: 'plain', tokens: 1 }, { name: 'resolved', tokens: 2 }, { name: 'named', tokens: 3, plugin: '' }] },
        { seq: 2, time: 2, tools: [], system: 'hello world' },
        { seq: 3, time: 3, tools: [], system: 'ignored', systemTokens: 9 },
        { seq: 4, time: 4, tools: [], system: '' },
      ],
    }, name => name === 'resolved' ? 'plugin:resolved' : undefined)
    assert.deepEqual(records[0].tools, [
      { name: 'plain', tokens: 1 },
      { name: 'resolved', tokens: 2, plugin: 'plugin:resolved' },
      { name: 'named', tokens: 3, plugin: '' },
    ])
    assert.equal((records[1].systemTokens ?? 0) > 0, true)
    assert.equal(records[2].systemTokens, 9)
    assert.equal(records[3].systemTokens, undefined)
    const bare = headerRecordsOf({ headers: [{ seq: 1, time: 1, tools: [{ name: 'plain', tokens: 1 }] }] })
    assert.deepEqual(bare[0].tools, [{ name: 'plain', tokens: 1 }])
  })

  test('apply drops repeated sequence numbers and caps the ledger', () => {
    const def = createContextHeadersDefinition()
    let state = def.apply(def.init(), headerEvent(1, { header: { tools: [] } }))
    const repeated = def.apply(state, headerEvent(1, { header: { tools: [] } }))
    assert.equal(repeated, state)
    for (let seq = 2; seq <= 55; seq++) state = def.apply(state, headerEvent(seq, { header: { tools: [] } }))
    assert.equal(state.headers.length, 50)
    assert.equal(state.headers[0].seq, 6)
    assert.equal(state.headers[49].seq, 55)
  })
})
