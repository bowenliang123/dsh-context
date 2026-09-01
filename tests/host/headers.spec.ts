// Unit tests for the contextHeaders projection unit (src/host/headers.ts) —
// the request-header EPOCH METADATA behind the timeline's envelope figures.
// The unit is pure init/apply/view: each case drives real event envelopes
// through the real definition (no harness plumbing).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystem } from '../../src/host/pricing'
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
  test('init/apply/view fold header epoch metadata', () => {
    const def = createContextHeadersDefinition()
    assert.equal(def.key, 'contextHeaders')
    assert.equal(def.stateVersion, 1, 'pinned: a bump would orphan idle cold sessions (no refresh channel)')

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
    assert.equal(state.headers[0].systemTokens, estimateSystem('You are an agent.'))
    assert.equal(state.headers[0].tools.length, 1)
    assert.equal(state.headers[0].tools[0].name, 'bash')

    const view = def.wire.view(state)
    assert.equal(view.headers.length, 1)
    assert.equal(view.headers[0].tools[0].name, 'bash')
    assert.ok(!('description' in view.headers[0].tools[0]), 'descriptions stay in the log')
    assert.ok(!('schema' in view.headers[0].tools[0]), 'schemas stay in the log')
    assert.ok(!('system' in view.headers[0]), 'system text stays in the log')
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

  test('tool entries degrade bad names; descriptions and schemas never ride the record', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 42, description: 'kept' }, // non-string name → '?'
        { name: 'a', description: 7 },
        { name: 'b', description: '' },
        { name: 'c', description: 'ok', schema: { type: 'object' } },
      ],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools[0].name, '?')
    assert.equal(tools[1].name, 'a')
    assert.equal(tools[2].name, 'b')
    assert.equal(tools[3].name, 'c')
    for (const tool of tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.ok(!('description' in tool), 'descriptions stay in the durable log')
      assert.ok(!('schema' in tool), 'schemas stay in the durable log')
    }
  })

  test('systemTokens is omitted unless a non-empty system string was logged', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [
      headerEvent(1, { system: 42 }),
      headerEvent(2, { system: '' }),
      headerEvent(3, { system: 'sys' }),
    ]))
    assert.ok(!('systemTokens' in view.headers[0]))
    assert.ok(!('systemTokens' in view.headers[1]))
    assert.equal(view.headers[2].systemTokens, estimateSystem('sys'))
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
    view.headers[0].time = -1
    assert.equal(state.headers[0].tools[0].name, 'bash', 'mutating the view must not alias state')
    assert.ok(state.headers[0].time > 0)
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

  test('a harness-provided plugin field rides the tool metadata verbatim', () => {
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
      assert.ok(!('schema' in tool), 'the raw entry never rides the metadata record')
    }
  })

  test('hostile shapes a committed log can hold keep the state lossless JSON and bounded', () => {
    // Committed event data is already the harness's lossless-JSON snapshot (session.append
    // throws on anything else), so the hostile surface here is wrong-SHAPED plain JSON —
    // never functions, undefined-valued properties, or exotic objects. Content-sized
    // junk (nested schema bodies) must not leak into the metadata state.
    const def = createContextHeadersDefinition()
    const state = fold(def, [headerEvent(1, {
      tools: [
        null,
        42,
        [],
        { name: 123, extra: { deep: [true, 'x'] } }, // wrong-typed name, nested junk
        { name: 'read', parameters: { type: 'object', properties: {} } },
      ],
    })])
    assert.equal(state.headers[0].tools.length, 5)
    for (const tool of state.headers[0].tools) {
      assert.deepEqual(Object.keys(tool).filter(k => k !== 'name' && k !== 'tokens' && k !== 'plugin'), [])
    }
  })
})

describe('read-compat over v1 rows', () => {
  /** A v1-era state: content-bearing records exactly as the old build persisted them. */
  function v1State(): HeadersState {
    return {
      headers: [
        {
          seq: 1, time: 1000, system: 'You are an agent.',
          tools: [
            { name: 'bash', tokens: 12, description: 'run a command', schema: { type: 'object' } },
            { name: 'mcp__gh__issue', tokens: 8, plugin: 'mcp:github' },
          ],
        },
        { seq: 9, time: 9000, tools: [{ name: 'read', tokens: 5, description: 'read a file', schema: {} }] },
      ],
    }
  }

  test('a v1 cached row seeds the fold and the view normalizes it to metadata', () => {
    const def = createContextHeadersDefinition()
    // The state schema accepts the v1 shape — the row is usable, not discarded.
    assert.deepEqual(def.stateSchema.parse(structuredClone(v1State())), v1State())
    const view = def.wire.view(v1State())
    assert.equal(def.wire.viewSchema.safeParse(view).success, true, 'normalized view passes the strict wire schema')
    assert.equal(view.headers[0].systemTokens, estimateSystem('You are an agent.'), 'legacy system text priced at view time')
    assert.ok(!('system' in view.headers[0]), 'system text stripped from the wire')
    assert.deepEqual(view.headers[0].tools, [
      { name: 'bash', tokens: 12 },
      { name: 'mcp__gh__issue', tokens: 8, plugin: 'mcp:github' },
    ], 'descriptions and schemas stripped; attribution kept')
    assert.ok(!('systemTokens' in view.headers[1]), 'a v1 epoch without system text stays absent')
    assert.deepEqual(view.headers[1].tools, [{ name: 'read', tokens: 5 }])
  })

  test('the resolver fills plugins on seeded legacy entries at view time', () => {
    const def = createContextHeadersDefinition(name => (name === 'bash' ? '@deepseek-ai/dsh-tool-bash' : undefined))
    const view = def.wire.view(v1State())
    assert.equal(view.headers[0].tools[0].plugin, '@deepseek-ai/dsh-tool-bash', 'absent plugin resolved')
    assert.equal(view.headers[0].tools[1].plugin, 'mcp:github', 'logged plugin never overridden')
  })

  test('new epochs fold alongside seeded v1 epochs and the cap keeps trimming', () => {
    const def = createContextHeadersDefinition()
    let state: HeadersState = v1State()
    state = def.apply(state, header(10, { system: 'next', tools: [{ name: 'write' }] }) as never)
    assert.equal(state.headers.length, 3)
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(view.headers[2].systemTokens, estimateSystem('next'))
    assert.ok(!('system' in state.headers[2]), 'new folds stay metadata-only in state')
    assert.ok('system' in state.headers[0], 'seeded legacy epochs keep their state shape until they age out')

    // Retention: the oldest epochs leave regardless of generation.
    for (let seq = 11; seq <= 60; seq++) state = def.apply(state, header(seq, { system: 's' }) as never)
    assert.equal(state.headers.length, 50)
    assert.equal(state.headers[0].seq, 11, 'the seeded v1 epoch aged out first')
  })
})
