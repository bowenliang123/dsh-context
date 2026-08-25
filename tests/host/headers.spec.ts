// Unit tests for the contextHeaders projection unit (src/host/headers.ts) —
// the request-header CONTENT epochs behind the timeline's envelope figures.
// The unit is pure init/apply/view: each case drives real event envelopes
// through the real definition (no harness plumbing).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextHeadersDefinition } from '../../src/host/headers'
import type { HeadersState } from '../../src/host/headers'
import { header, foreign } from './helpers/events'
import type { TimelineEvent } from '../../src/host/fold'

type Def = ReturnType<typeof createContextHeadersDefinition>

/** The dual-contract fields ride the definition past its declared 0.1.0 return type. */
function compat(def: Def) {
  return def as unknown as {
    stateSchema: { parse: (value: unknown) => HeadersState }
    wire: {
      viewSchema: { safeParse: (value: unknown) => { success: boolean } }
      view: Def['view']
    }
  }
}

/** A raw request/header envelope with full control over the header payload. */
function headerEvent(seq: number, rawHeader: unknown): TimelineEvent {
  return { type: 'request/header', seq, time: seq * 1000, data: { header: rawHeader, reason: 'initial' } }
}

function fold(def: Def, events: TimelineEvent[]): HeadersState {
  let state = def.init()
  for (const ev of events) state = def.apply(state, ev as never)
  return state
}

describe('createContextHeadersDefinition', () => {
  test('init/apply/view fold header epochs', () => {
    const def = createContextHeadersDefinition()
    assert.equal(def.key, 'contextHeaders')
    assert.equal(def.stateVersion, 1)

    const init = def.init()
    assert.deepEqual(init, { headers: [] })

    const state = def.apply(init, header(1, {
      system: 'You are an agent.',
      tools: [{ name: 'bash', description: 'run a command' }],
    }) as never)
    assert.notEqual(state, init, 'a header event produces a new state')
    assert.equal(state.headers.length, 1)
    assert.equal(state.headers[0].seq, 1)
    assert.equal(state.headers[0].system, 'You are an agent.')
    assert.equal(state.headers[0].tools.length, 1)
    assert.equal(state.headers[0].tools[0].name, 'bash')

    const view = def.view(state)
    assert.equal(view.headers.length, 1)
    assert.equal(view.headers[0].tools[0].description, 'run a command')
  })

  test('a non-header event returns the same state reference', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [header(1, { system: 'sys' })])
    assert.equal(def.apply(state, foreign(2) as never), state)
  })

  test('null, undefined, and non-object headers return the same state reference', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [header(1, { system: 'sys' })])
    for (const [seq, raw] of [[2, null], [3, undefined], [4, 42]] as const) {
      assert.equal(def.apply(state, headerEvent(seq, raw) as never), state, `header ${String(raw)} is not an epoch`)
    }
  })

  test('a non-array tools field folds to an empty tool list', () => {
    const def = createContextHeadersDefinition()
    const view = def.view(fold(def, [headerEvent(1, { tools: 'nope' })]))
    assert.deepEqual(view.headers[0].tools, [])
  })

  test('tool entries degrade bad names and omit bad descriptions', () => {
    const def = createContextHeadersDefinition()
    const view = def.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 42, description: 'kept' }, // non-string name → '?'
        { name: 'a', description: 7 }, // non-string description → omitted
        { name: 'b', description: '' }, // empty description → omitted
        { name: 'c', description: 'ok' },
      ],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools[0].name, '?')
    assert.equal(tools[0].description, 'kept')
    assert.ok(!('description' in tools[1]))
    assert.ok(!('description' in tools[2]))
    assert.equal(tools[3].description, 'ok')
    for (const tool of tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.ok('schema' in tool, 'the raw schema rides the record')
    }
  })

  test('system is omitted unless a non-empty string', () => {
    const def = createContextHeadersDefinition()
    const view = def.view(fold(def, [
      headerEvent(1, { system: 42 }),
      headerEvent(2, { system: '' }),
      headerEvent(3, { system: 'sys' }),
    ]))
    assert.ok(!('system' in view.headers[0]))
    assert.ok(!('system' in view.headers[1]))
    assert.equal(view.headers[2].system, 'sys')
  })

  test('the same epoch seq twice in a row returns the same state reference', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [header(1, { system: 'a' })])
    assert.equal(def.apply(state, header(1, { system: 'b' }) as never), state, 'duplicate epoch suppressed')
    assert.equal(state.headers.length, 1)
  })

  test('retention caps at the 50 newest epochs', () => {
    const def = createContextHeadersDefinition()
    const events = Array.from({ length: 55 }, (_, i) => header(i + 1, { system: `s${i + 1}` }))
    const state = fold(def, events)
    assert.equal(state.headers.length, 50)
    assert.equal(state.headers[0].seq, 6, 'the oldest five epochs dropped')
    assert.equal(state.headers.at(-1)?.seq, 55)
  })

  test('view() copies records and tools off the state', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [headerEvent(1, { system: 'sys', tools: [{ name: 'bash' }] })])
    const view = def.view(state)
    view.headers[0].tools[0].name = 'mutated'
    view.headers[0].system = 'mutated'
    assert.equal(state.headers[0].tools[0].name, 'bash', 'mutating the view must not alias state')
    assert.equal(state.headers[0].system, 'sys')
  })

  test('schema, stateSchema, and the wire block validate a real folded view', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [
      header(1, {
        system: 'You are an agent.',
        tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
      }),
    ])
    const view = def.view(state)
    assert.equal(def.schema.safeParse(view).success, true, 'wire schema accepts the folded view')

    const c = compat(def)
    assert.deepEqual(c.stateSchema.parse(structuredClone(state)), state, 'state schema round-trips the fold state')
    assert.equal(c.wire.view, def.view, 'the wire block shares the view function')
    assert.equal(c.wire.viewSchema.safeParse(c.wire.view(state)).success, true)
  })
})
