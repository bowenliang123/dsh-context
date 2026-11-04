import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystemTokens } from '../../src/shared/estimate'
import { createContextHeadersDefinition } from '../../src/host/headers'
import type { HeadersState } from '../../src/host/headers'
import { header, foreign } from './helpers/events'
import { assertPlainJson } from './helpers/projection'
import type { TimelineEvent } from '../../src/host/fold'

function headerEvent(seq: number, rawHeader: unknown): TimelineEvent {
  return { type: 'request/header', seq, time: seq * 1000, data: { header: rawHeader, reason: 'initial' } }
}

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
    assert.equal(def.wire.summary, false, 'pinned: session/list rows never carry per-turn tools[] (issue #225)')

    const init = def.init()
    assert.deepEqual(init, { headers: [] })

    const state = def.apply(init, header(1, {
      tools: [{ name: 'bash', description: 'run a command' }],
    }) as never)
    assert.notEqual(state, init, 'a header event produces a new state')
    assertPlainJson(state)
    assert.equal(state.headers.length, 1)
    assert.equal(state.headers[0].seq, 1)
    assert.ok(!('systemTokens' in state.headers[0]), 'a supported log header never carries a system prompt')
    assert.equal(state.headers[0].tools.length, 1)
    assert.equal(state.headers[0].tools[0].name, 'bash')

    const view = def.wire.view(state)
    assert.equal(view.headers.length, 1)
    assert.equal(view.headers[0].tools[0].name, 'bash')
    assert.ok(!('description' in view.headers[0].tools[0]), 'descriptions stay in the log')
    assert.ok(!('schema' in view.headers[0].tools[0]), 'schemas stay in the log')
    assert.ok(!('system' in view.headers[0]), 'system text stays in the log')

    const withSystem = def.apply(init, headerEvent(2, { system: 'You are an agent.', tools: [] }) as never)
    assert.ok(!('system' in withSystem.headers[0]), 'a logged system prompt never enters the fold')
    assert.ok(!('systemTokens' in withSystem.headers[0]), 'and is never priced into state')
    const systemView = def.wire.view(withSystem)
    assert.ok(!('system' in systemView.headers[0]))
    assert.ok(!('systemTokens' in systemView.headers[0]))
  })

  test('non-epoch events, unusable headers, and a repeated epoch seq return the same state reference', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [header(1, { tools: [] })])
    assert.equal(def.apply(state, foreign(2) as never), state)
    for (const [seq, raw] of [[2, null], [3, undefined], [4, 42]] as const) {
      assert.equal(def.apply(state, headerEvent(seq, raw) as never), state, `header ${String(raw)} is not an epoch`)
    }
    assert.equal(def.apply(state, { type: 'request/header', seq: 5, time: 5000 } as never), state)
    assert.equal(def.apply(state, header(1, { tools: [] }) as never), state, 'duplicate epoch suppressed')
    assert.equal(state.headers.length, 1)
  })

  test('a non-array tools field folds to an empty list; tool entries degrade bad names and drop content', () => {
    const nonArray = createContextHeadersDefinition()
    assert.deepEqual(nonArray.wire.view(fold(nonArray, [headerEvent(1, { tools: 'nope' })])).headers[0].tools, [])

    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 42, description: 'kept' },
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
      assert.ok(!('plugin' in tool), 'without a resolver no plugin is ever added')
    }
  })

  test('retention caps at the 50 newest epochs', () => {
    const def = createContextHeadersDefinition()
    const events = Array.from({ length: 55 }, (_, i) => header(i + 1, { tools: [] }))
    const state = fold(def, events)
    assert.equal(state.headers.length, 50)
    assert.equal(state.headers[0].seq, 6, 'the oldest five epochs dropped')
    assert.equal(state.headers.at(-1)?.seq, 55)
  })

  test('view() copies records and tools off the state', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [headerEvent(1, { tools: [{ name: 'bash' }] })])
    const view = def.wire.view(state)
    view.headers[0].tools[0].name = 'mutated'
    view.headers[0].time = -1
    assert.equal(state.headers[0].tools[0].name, 'bash', 'mutating the view must not alias state')
    assert.ok(state.headers[0].time > 0)
  })

  test('a harness-provided plugin field rides the tool metadata verbatim', () => {
    const def = createContextHeadersDefinition()
    const view = def.wire.view(fold(def, [headerEvent(1, {
      tools: [
        { name: 'mcp__github__get_issue', plugin: 'mcp:github' },
        { name: 'plain', plugin: '' },
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
        { name: 'bash', plugin: 'logged-owner' },
        { name: 'unknown' },
      ],
    })]))
    const tools = view.headers[0].tools
    assert.equal(tools[0].plugin, '@deepseek-ai/dsh-tool-bash')
    assert.equal(tools[1].plugin, 'mcp:github')
    assert.equal(tools[2].plugin, 'logged-owner')
    assert.ok(!('plugin' in tools[3]))
    assert.ok(!('plugin' in fold(def, [headerEvent(9, { tools: [{ name: 'bash' }] })]).headers[0].tools[0]))
  })

})

describe('hostile tool entries', () => {
  test('null and primitive entries degrade to unnamed JSON-priced tools and never leak content into state', () => {
    const def = createContextHeadersDefinition()
    const state = fold(def, [headerEvent(1, {
      tools: [
        null,
        42,
        'x',
        [],
        { name: 123, extra: { deep: [true, 'x'] } },
        { name: 'read', parameters: { type: 'object', properties: {} } },
      ],
    })])
    assert.deepEqual(state.headers[0].tools.map(t => t.name), ['?', '?', '?', '?', '?', 'read'])
    for (const tool of state.headers[0].tools) {
      assert.ok(Number.isInteger(tool.tokens) && tool.tokens >= 0, 'tool tokens priced')
      assert.deepEqual(Object.keys(tool).filter(k => k !== 'name' && k !== 'tokens' && k !== 'plugin'), [])
    }
  })

})

describe('read-compat over v1 rows', () => {
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
    assert.deepEqual(def.stateSchema.parse(structuredClone(v1State())), v1State())
    const view = def.wire.view(v1State())
    assert.equal(def.wire.viewSchema.safeParse(view).success, true, 'normalized view passes the strict wire schema')
    assert.equal(view.headers[0].systemTokens, estimateSystemTokens('You are an agent.'), 'legacy system text priced at view time')
    assert.ok(!('system' in view.headers[0]), 'system text stripped from the wire')
    assert.deepEqual(view.headers[0].tools, [
      { name: 'bash', tokens: 12 },
      { name: 'mcp__gh__issue', tokens: 8, plugin: 'mcp:github' },
    ], 'descriptions and schemas stripped; attribution kept')
    assert.ok(!('systemTokens' in view.headers[1]), 'a v1 epoch without system text stays absent')
    assert.deepEqual(view.headers[1].tools, [{ name: 'read', tokens: 5 }])
  })

  test('new epochs fold alongside seeded v1 epochs and the cap keeps trimming', () => {
    const def = createContextHeadersDefinition()
    let state: HeadersState = v1State()
    state = def.apply(state, header(10, { tools: [{ name: 'write' }] }) as never)
    assert.equal(state.headers.length, 3)
    const view = def.wire.view(state)
    assert.ok(!('systemTokens' in view.headers[2]), 'new folds stay metadata-only on the wire')
    assert.ok(!('system' in state.headers[2]), 'new folds stay metadata-only in state')
    assert.ok('system' in state.headers[0], 'seeded legacy epochs keep their state shape until they age out')

    for (let seq = 11; seq <= 60; seq++) state = def.apply(state, header(seq) as never)
    assert.equal(state.headers.length, 50)
    assert.equal(state.headers[0].seq, 11, 'the seeded v1 epoch aged out first')
  })
})
