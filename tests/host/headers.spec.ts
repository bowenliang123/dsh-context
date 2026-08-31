// Unit tests for the contextHeaders projection unit (src/host/headers.ts) —
// the request-header CONTENT epochs behind the timeline's envelope figures.
// The unit is pure init/apply/view: each case drives real event envelopes
// through the real definition (no harness plumbing).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextHeadersDefinition } from '../../src/host/headers'
import type { HeadersState } from '../../src/host/headers'
import { header, foreign } from './helpers/events'
import { assertPlainJson } from './helpers/projection'
import type { TimelineEvent } from '../../src/host/fold'

/** A raw request/header envelope with full control over the header payload. */
function headerEvent(seq: number, rawHeader: unknown): TimelineEvent {
  return { type: 'request/header', seq, time: seq * 1000, data: { header: rawHeader, reason: 'initial' } }
}

/** Fold events through the unit, pinning the plain-JSON state precondition on every result. */
function fold(def: ReturnType<typeof createContextHeadersDefinition>, events: TimelineEvent[]): HeadersState {
  let state = def.init()
  for (const ev of events) state = def.apply(state, ev as never)
  assertPlainJson(state)
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
    assertPlainJson(state)
    assert.equal(state.headers.length, 1)
    assert.equal(state.headers[0].seq, 1)
    assert.equal(state.headers[0].system, 'You are an agent.')
    assert.equal(state.headers[0].tools.length, 1)
    assert.equal(state.headers[0].tools[0].name, 'bash')

    const view = def.wire.view(state)
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
    const view = def.wire.view(fold(def, [headerEvent(1, { tools: 'nope' })]))
    assert.deepEqual(view.headers[0].tools, [])
  })

  test('tool entries degrade bad names and omit bad descriptions', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
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
    const view = def.wire.view(fold(def, [
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
    const view = def.wire.view(state)
    view.headers[0].tools[0].name = 'mutated'
    view.headers[0].system = 'mutated'
    assert.equal(state.headers[0].tools[0].name, 'bash', 'mutating the view must not alias state')
    assert.equal(state.headers[0].system, 'sys')
  })

  test('stateSchema and the wire block validate a real folded view', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [
      header(1, {
        system: 'You are an agent.',
        tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
      }),
    ])
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true, 'wire schema accepts the folded view')
    assert.deepEqual(def.stateSchema.parse(structuredClone(state)), state, 'state schema round-trips the fold state')
    assert.equal(def.wire.viewSchema.safeParse(def.wire.view(state)).success, true)
  })

  test('a harness-provided plugin field rides the raw tool entry verbatim', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 'mcp__github__get_issue', plugin: 'mcp:github' },
        { name: 'plain', plugin: '' }, // empty plugin behaves as absent
        { name: 'naked' },
      ],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools[0].plugin, 'mcp:github')
    assert.ok(!('plugin' in tools[1]))
    assert.ok(!('plugin' in tools[2]))
  })

  test('the resolver fills an absent plugin at view time and never overrides a logged one', () => {
    const resolve = (name: string): string | undefined =>
      name === 'bash' ? '@deepseek-ai/dsh-tool-bash' : name === 'mcp__github__x' ? 'mcp:github' : undefined
    const def = createContextHeadersDefinition(resolve)
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 'bash' },
        { name: 'mcp__github__x' },
        { name: 'bash', plugin: 'logged-owner' }, // logged wins over the resolver
        { name: 'unknown' },
      ],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools[0].plugin, '@deepseek-ai/dsh-tool-bash')
    assert.equal(tools[1].plugin, 'mcp:github')
    assert.equal(tools[2].plugin, 'logged-owner')
    assert.ok(!('plugin' in tools[3]))
    // The fill is a view-time projection: the folded state stays pure.
    assert.ok(!('plugin' in fold(def, [headerEvent(9, { tools: [{ name: 'bash' }] })]).headers[0].tools[0]))
  })

  test('without a resolver no plugin is ever added', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, { tools: [{ name: 'mcp__github__x' }] })]))
    assert.ok(!('plugin' in view.headers[0].tools[0]))
  })

  test('plugin-bearing state and views pass both schemas', () => {
    const def = createContextHeadersDefinition(name => (name === 'bash' ? '@deepseek-ai/dsh-tool-bash' : undefined))
    const state = fold(def, [headerEvent(1, {
      tools: [{ name: 'bash', plugin: 'mcp:github' }, { name: 'read' }],
    })])
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.deepEqual(def.stateSchema.parse(structuredClone(state)), state)
    assert.equal(def.wire.viewSchema.safeParse(def.wire.view(state)).success, true)
  })
})

describe('hostile tool entries', () => {
  test('null and primitive tool entries degrade to unnamed JSON-priced tools', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [null, 42, 'x', { name: 'bash' }],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools.length, 4)
    assert.equal(tools[0].name, '?')
    assert.equal(tools[1].name, '?')
    assert.equal(tools[2].name, '?')
    assert.equal(tools[3].name, 'bash')
    for (const tool of tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.ok('schema' in tool, 'the raw schema rides the record')
    }
  })

  test('hostile shapes a committed log can hold keep the state lossless JSON', () => {
    // Committed event data is already the harness's lossless-JSON snapshot (session.append
    // throws on anything else), so the hostile surface here is wrong-SHAPED plain JSON —
    // never functions, undefined-valued properties, or exotic objects.
    const def = createContextHeadersDefinition()
    const toolSchema = { name: 'bash', description: 'run a command', parameters: {} }
    const state = fold(def, [headerEvent(1, {
      tools: [
        null,
        42,
        [],
        { name: 123, extra: { deep: [true, 'x'] } }, // wrong-typed name, nested junk
        toolSchema, // an empty-object parameters schema is legal and must survive verbatim
        { name: 'read', parameters: { type: 'object', properties: {} } },
      ],
    })])
    assert.deepEqual(state.headers[0].tools[4].schema, toolSchema, 'a real ToolSchema entry rides verbatim')
    assert.deepEqual(
      state.headers[0].tools[5].schema,
      { name: 'read', parameters: { type: 'object', properties: {} } },
      'nested empty-object schemas survive verbatim',
    )
  })
})
