import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  activityOf,
  contextBreakdownOf,
  contextPressureOf,
  conversationNodesOf,
  costFullyQuantified,
  entrySeated,
  headersOf,
  imageLoaderOf,
  numOf,
  seedConversationViewVia,
  sessionAddressOf,
  timelineOf,
  activeMsOf,
  timingOf,
  tokenUsageOf,
  workspaceOf,
} from '../../src/client/services'
import { CONTEXT_VIEW_ID, type ClientCtx, type ConversationNodeLike } from '../../src/client/services'
import type { TimingTotals } from '../../src/shared/types'

const useChatOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T) => sel(snapshot))

const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx

describe('conversationNodesOf — the chat-seat window join', () => {
  const nodes: ConversationNodeLike[] = [{ kind: 'user', seq: 1 }, { kind: 'assistant', seq: 2 }]

  test('serves the chat seat (ChatSnapshot.legacy.nodes)', () => {
    const out = conversationNodesOf({ useChat: useChatOf({ legacy: { nodes } }) })
    assert.equal(out, nodes)
  })

  test('absent seats, non-array payloads, and hostile seats degrade to undefined', () => {
    assert.equal(conversationNodesOf({}), undefined)
    assert.equal(conversationNodesOf({ useChat: useChatOf({}) }), undefined, 'chat snapshot without legacy')
    assert.equal(conversationNodesOf({ useChat: useChatOf(null) }), undefined, 'null snapshot')
    assert.equal(conversationNodesOf({ useChat: () => { throw new Error('boom') } }), undefined, 'hostile seat')
  })
})

describe('imageLoaderOf — the uiConversation loader', () => {
  const attachment = { attachmentId: 'a1' }

  test('uses the uiConversation.imageUrl face', async () => {
    const calls: string[] = []
    const load = imageLoaderOf(ctxWith({ uiConversation: { imageUrl: (sid: string, att: { attachmentId: string }) => {
      calls.push(sid + ':' + att.attachmentId)
      return Promise.resolve('blob:modern')
    } } }), 'sv')
    assert.equal(await load!(attachment), 'blob:modern')
    assert.deepEqual(calls, ['sv:a1'])
  })

  test('absent faces, bad session ids, and hostile service reads degrade to undefined', () => {
    assert.equal(imageLoaderOf(ctxWith({}), 'sv'), undefined)
    assert.equal(imageLoaderOf(ctxWith({ uiConversation: {} }), 'sv'), undefined)
    assert.equal(imageLoaderOf(ctxWith({}), undefined), undefined)
    assert.equal(imageLoaderOf(ctxWith({}), ''), undefined)
    const ctxThrows = { get: (): never => { throw new Error('service absent') } } as unknown as ClientCtx
    assert.equal(imageLoaderOf(ctxThrows, 'sv'), undefined)
  })
})

describe('numOf', () => {
  test('finite numbers pass through; NaN/Infinity and non-numbers degrade to 0', () => {
    for (const value of [42, 0, -1.5]) assert.equal(numOf(value), value)
    for (const value of [NaN, Infinity, -Infinity, '7', undefined, null, {}]) assert.equal(numOf(value), 0)
  })
})

describe('timelineOf', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, assistantReasoning: 3, assistantAnswerTokens: 2, assistantCallTokens: 1, tool: 6, total: 7 }

  test('a well-formed wire value passes through by reference; non-records stay null', () => {
    const wire = {
      ok: true,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      contextWindow: 128000,
      current,
      generatedReasoning: 2,
      requests: [],
      events: [],
      nodes: [],
      archive: [],
      droppedNodes: 0,
    }
    assert.equal(timelineOf(wire), wire)
    for (const bad of [null, undefined, 5, 'x']) assert.equal(timelineOf(bad), null)
  })

  test('current missing/non-object rebuilds a zeroed breakdown; partial fields are numOf-coerced', () => {
    for (const bad of [{}, { current: null }, { current: 7 }]) {
      assert.deepEqual(timelineOf(bad)?.current, { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, assistantReasoning: 0, assistantAnswerTokens: 0, assistantCallTokens: 0, tool: 0, total: 0 })
    }
    const out = timelineOf({ current: { system: 12, tools: 'x', user: undefined } })
    assert.deepEqual(out?.current, { system: 12, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, assistantReasoning: 0, assistantAnswerTokens: 0, assistantCallTokens: 0, tool: 0, total: 0 })
  })

  test('the assistant subset fields survive the sanitizing path; a hostile generated count drops alone', () => {
    const out = timelineOf({ current: { system: 1, assistant: 5, assistantReasoning: 3, assistantAnswerTokens: 2, assistantCallTokens: 1 }, generatedReasoning: 4, generatedAnswerTokens: 1, generatedCallTokens: 1, requests: 'nope' })
    assert.equal(out?.current.assistantReasoning, 3)
    assert.equal(out?.current.assistantAnswerTokens, 2)
    assert.equal(out?.current.assistantCallTokens, 1)
    assert.equal(out?.generatedReasoning, 4)
    assert.equal(out?.generatedAnswerTokens, 1)
    assert.equal(out?.generatedCallTokens, 1)
    for (const bad of [-1, '4', Number.NaN, Number.POSITIVE_INFINITY]) {
      const dropped = timelineOf({ current: 1, generatedReasoning: bad, generatedAnswerTokens: bad, generatedCallTokens: bad, requests: 'nope' })
      assert.ok(dropped !== null)
      assert.ok(!('generatedReasoning' in dropped), String(bad))
      assert.ok(!('generatedAnswerTokens' in dropped), String(bad))
      assert.ok(!('generatedCallTokens' in dropped), String(bad))
    }
  })

  test('non-array collections become empty lists', () => {
    const out = timelineOf({
      current,
      requests: 'nope',
      events: 7,
      nodes: null,
      archive: undefined,
    })
    assert.ok(out !== null)
    assert.deepEqual(out.requests, [])
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.nodes, [])
    assert.deepEqual(out.archive, [])
  })

  test('a junk entry inside an otherwise well-formed value leaves the fast path and is dropped', () => {
    const good = { seq: 1, time: 1, system: 0, tools: 0, user: 1, inject: 0, assistant: 0, tool: 0, total: 1 }
    const out = timelineOf({ ok: true, current, requests: [good, null], events: [7], nodes: [{ kind: 'message', seq: 1 }, null, 42, 's'], archive: [], droppedNodes: 0 })
    assert.ok(out !== null)
    assert.deepEqual(out.requests, [good])
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.nodes, [{ kind: 'message', seq: 1 }])
  })

  test('model/provider/contextWindow/maxOutputTokens/reasoningEffort and the numeric tallies prove their shapes; malformed scalars drop alone', () => {
    const kept = timelineOf({ current: 1, model: 'm', provider: 'p', contextWindow: 100, maxOutputTokens: 256000, reasoningEffort: 'max' })
    assert.ok(kept !== null)
    assert.equal(kept.model, 'm')
    assert.equal(kept.provider, 'p')
    assert.equal(kept.contextWindow, 100)
    assert.equal(kept.maxOutputTokens, 256000)
    assert.equal(kept.reasoningEffort, 'max')
    const dropped = timelineOf({ current: 1, model: 5, provider: {}, contextWindow: 'x', reasoningEffort: 7 })
    assert.ok(dropped !== null)
    for (const key of ['model', 'provider', 'contextWindow', 'reasoningEffort']) assert.ok(!(key in dropped), key)
    for (const maxOutputTokens of ['256000', Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const capped = timelineOf({ current: 1, maxOutputTokens })
      assert.ok(capped !== null)
      assert.ok(!('maxOutputTokens' in capped), String(maxOutputTokens))
    }

    const scalars = timelineOf({
      current: 1, images: 3, toolCalls: 2, humanInputs: 5, surfaceFloor: 10, archiveFloor: 4, droppedNodes: 4,
    })
    assert.ok(scalars !== null)
    assert.deepEqual(
      [scalars.images, scalars.toolCalls, scalars.humanInputs, scalars.surfaceFloor, scalars.archiveFloor, scalars.droppedNodes],
      [3, 2, 5, 10, 4, 4],
    )
    const droppedScalars = timelineOf({
      current: 1, images: 'n', toolCalls: {}, humanInputs: 'x', surfaceFloor: null, archiveFloor: true, droppedNodes: 'x',
    })
    assert.ok(droppedScalars !== null)
    for (const key of ['images', 'toolCalls', 'humanInputs', 'surfaceFloor', 'archiveFloor']) assert.ok(!(key in droppedScalars), key)
    assert.equal(droppedScalars.droppedNodes, 0)
  })

  test('lastUser keeps a bounded string; empty or junk drops', () => {
    assert.equal(timelineOf({ current: 1, lastUser: 'fix the flaky spec' })?.lastUser, 'fix the flaky spec')
    assert.equal(timelineOf({ current: 1, lastUser: 'y'.repeat(500) })?.lastUser?.length, 200)
    assert.ok(!('lastUser' in (timelineOf({ current: 1, lastUser: '' }) ?? {})))
    for (const junk of [7, null, {}]) {
      const out = timelineOf({ current: 1, lastUser: junk })
      assert.ok(out !== null && !('lastUser' in out))
    }
  })

  test('cost is rebuilt per provider/model/period; garbage drops or zeroes', () => {
    const cost = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 5, cacheRead: 'x', cacheWrite: null, output: 7 },
          off: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
          junk: { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 },
          broken: null,
          'broken-array': [],
        },
        'deepseek-v4-pro': { peak: [], off: null },
        'broken-null': null,
        'broken-array': [],
      },
      junk: 'not-a-record',
      empty: {},
    }
    const kept = timelineOf({ current: 1, cost })
    assert.ok(kept !== null)
    assert.deepEqual(kept.cost, {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 7 },
          off: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
        },
        'deepseek-v4-pro': {},
      },
      empty: {},
    })
    assert.notEqual(kept.cost, cost, 'the served buckets are a rebuilt copy, never the raw value')
    for (const bad of [[], null, 5]) {
      const out = timelineOf({ current: 1, cost: bad })
      assert.ok(out !== null)
      assert.ok(!('cost' in out))
    }
    const proven = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } } } }
    const base = { current: { system: 1, tools: 1, user: 1, inject: 1, skill: 1, assistant: 1, tool: 1, total: 8 }, requests: [], events: [], nodes: [], archive: [] }
    assert.equal(timelineOf({ ...base, cost: proven })?.cost, proven, 'a structurally proven cost keeps the fast path reference')
    assert.ok(!('cost' in (timelineOf({ ...base, cost: 'junk' }) ?? {})), 'a hostile cost drops through the sanitizer')
  })

  test('the unsupported gate record survives the sanitizing slow path only when well-formed', () => {
    const kept = timelineOf({ current: 1, unsupported: { current: '0.1.1-rc.2', minimum: '0.2.0-rc.2' } })
    assert.ok(kept !== null)
    assert.deepEqual(kept.unsupported, { current: '0.1.1-rc.2', minimum: '0.2.0-rc.2' })
    for (const bad of ['x', null, {}, { current: 1, minimum: 'm' }, { current: 'c' }]) {
      const out = timelineOf({ current: 1, unsupported: bad })
      assert.ok(out !== null)
      assert.ok(!('unsupported' in out), JSON.stringify(bad))
    }
  })

  test('the split-generation slim head: counters/anchor/revision and their own ledgers survive', () => {
    const head = {
      ok: true,
      model: 'm',
      current,
      counts: { turns: 3, steps: 12, injects: 2, compactions: 1, prunes: 0, skills: 4 },
      last: { seq: 9, total: 100, prompt: 90 },
      detailRev: 12,
      humanInputs: 2,
      answers: 3,
      fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      fileOpsFloor: 5,
      commands: [{ seq: 3, time: 1, tool: 'bash', cmd: 'ls', start: 1, status: 'completed', err: false }],
      commandsFloor: 2,
      commandStats: { runs: 7, failed: 1, ms: 900, bg: 1 },
      spans: [{ kind: 'ttft', start: 0, end: 100 }, null],
    }
    const out = timelineOf(head)
    assert.ok(out !== null)
    assert.deepEqual(out.counts, { turns: 3, steps: 12, injects: 2, compactions: 1, prunes: 0, skills: 4 })
    assert.equal(out.humanInputs, 2)
    assert.equal(out.answers, 3)
    assert.deepEqual(out.last, { seq: 9, total: 100, prompt: 90 })
    assert.equal(out.detailRev, 12)
    assert.equal(out.fileOps?.length, 1, 'the op log survives the head sanitize')
    assert.equal(out.fileOpsFloor, 5)
    assert.equal(out.commands?.length, 1, 'the command log survives the head sanitize')
    assert.equal(out.commandsFloor, 2)
    assert.deepEqual(out.commandStats, { runs: 7, failed: 1, ms: 900, bg: 1 })
    assert.equal(out.spans?.length, 1, 'the strip spans survive, junk entries dropped')
    const noStats = timelineOf({ current, commandStats: 'junk' })
    assert.ok(noStats !== null && !('commandStats' in noStats))

    const partial = timelineOf({ current, counts: { turns: 2, steps: 'many' }, last: { seq: 'x' }, detailRev: 'r', answers: 'many' })
    assert.ok(partial !== null)
    assert.deepEqual(partial.counts, { turns: 2, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
    assert.ok(!('answers' in partial), 'a wrong-typed answers tally drops like any other scalar')
    assert.ok(!('last' in partial), 'a wrong-typed seq drops the anchor whole')
    assert.ok(!('detailRev' in partial), 'a wrong-typed revision drops the marker (reads as the inline generation)')
    const noCounts = timelineOf({ current, counts: 'junk', last: null, detailRev: NaN })
    assert.ok(noCounts !== null)
    assert.ok(!('counts' in noCounts))
    assert.ok(!('last' in noCounts))
    assert.ok(!('detailRev' in noCounts))
    const badTotal = timelineOf({ current, last: { seq: 1, total: 'x' } })
    assert.ok(badTotal !== null && !('last' in badTotal))
    const noPrompt = timelineOf({ current, last: { seq: 1, total: 7 } })
    assert.ok(noPrompt !== null)
    assert.deepEqual(noPrompt.last, { seq: 1, total: 7 })
  })
})

describe('contextPressureOf', () => {
  test('the three wire fields pass, each re-proved as a finite number; the rest drops individually', () => {
    assert.deepEqual(
      contextPressureOf({ pressureTokens: 10, projectedTokens: 30, contextWindow: 128000 }),
      { pressureTokens: 10, projectedTokens: 30, contextWindow: 128000 },
    )
    assert.deepEqual(contextPressureOf({ pressureTokens: 10, surfaceTokens: 20 }), { pressureTokens: 10 })
    assert.deepEqual(contextPressureOf({ projectedTokens: 'x' }), {})
    assert.deepEqual(contextPressureOf({ contextWindow: Number.NaN }), {})
    assert.deepEqual(contextPressureOf({}), {})
    for (const bad of [null, undefined, 42]) assert.equal(contextPressureOf(bad), null)
  })
})

describe('contextBreakdownOf', () => {
  test('all three finite numbers pass as a value; a non-record or missing/non-finite field degrades the whole to null', () => {
    assert.deepEqual(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: 3 }), {
      systemTokens: 1,
      toolsTokens: 2,
      messageTokens: 3,
    })
    for (const bad of [null, 'x']) assert.equal(contextBreakdownOf(bad), null)
    for (const bad of [
      { toolsTokens: 2, messageTokens: 3 },
      { systemTokens: NaN, toolsTokens: 2, messageTokens: 3 },
      { systemTokens: 1, toolsTokens: 'x', messageTokens: 3 },
      { systemTokens: 1, toolsTokens: Infinity, messageTokens: 3 },
      { systemTokens: 1, toolsTokens: 2, messageTokens: undefined },
      { systemTokens: 1, toolsTokens: 2, messageTokens: -Infinity },
    ]) assert.equal(contextBreakdownOf(bad), null, JSON.stringify(bad))
  })
})

describe('tokenUsageOf', () => {
  test('the four-bucket wire value passes as a value; a missing/wrong-typed/non-finite bucket degrades the WHOLE value to null', () => {
    const good = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    assert.deepEqual(tokenUsageOf(good), good)
    assert.equal(tokenUsageOf({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 }), null, 'missing bucket')
    assert.equal(tokenUsageOf({ total: { input: 100 } }), null, 'a foreign record shape')
    for (const key of Object.keys(good) as (keyof typeof good)[]) {
      assert.equal(tokenUsageOf({ ...good, [key]: 'x' }), null, `${key} wrong-typed`)
      assert.equal(tokenUsageOf({ ...good, [key]: Number.NaN }), null, `${key} non-finite`)
    }
    for (const bad of [null, undefined, 3]) assert.equal(tokenUsageOf(bad), null)
  })
})

describe('timingOf', () => {
  const wellFormed = {
    wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9,
    tools: { bash: { calls: 5, ms: 20_000 }, read: { calls: 4, ms: 10_000 } },
  }

  test('a well-formed value round-trips every scalar and row; non-records stay null', () => {
    assert.deepEqual(timingOf(wellFormed), wellFormed)
    for (const bad of [null, undefined, 'x', 5]) assert.equal(timingOf(bad), null)
  })

  test('wrong-typed or negative scalars zero out', () => {
    const out = timingOf({ wallMs: -1, ttftMs: 'x', genMs: NaN, calls: Infinity, toolsMs: Infinity, toolCalls: 3 })
    assert.deepEqual(out, { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 3, tools: {} })
  })

  test('rows failing the shape drop individually; a non-record tools map degrades to an empty ranking', () => {
    const out = timingOf({
      wallMs: 10, tools: {
        good: { calls: 1, ms: 5 },
        noCalls: { ms: 5 },
        negMs: { calls: 1, ms: -5 },
        nullRow: null,
        numRow: 7,
      },
    })
    assert.deepEqual(out?.tools, { good: { calls: 1, ms: 5 } })
    for (const tools of [null, 'x', 5, [ { calls: 1, ms: 1 } ]]) {
      const empty = timingOf({ wallMs: 1, tools })
      assert.deepEqual(empty?.tools, {})
    }
  })

  test('a hostile __proto__ row is skipped, not assigned as the prototype', () => {
    const out = timingOf({ wallMs: 1, tools: JSON.parse('{"__proto__": {"calls": 1, "ms": 5}}') })
    assert.deepEqual(out?.tools, {})
    assert.equal(Object.getPrototypeOf(out?.tools ?? {}), Object.prototype)
  })

  test('the idle carve and the hostile idle scalar ride the optional face; activeMsOf prices wall minus idle', () => {
    assert.deepEqual(timingOf({ ...wellFormed, idleMs: 5_000 }), { ...wellFormed, idleMs: 5_000 })
    assert.ok(!('idleMs' in (timingOf({ ...wellFormed, idleMs: -1, toolBusyMs: 3 }) ?? {})), 'a negative carve degrades to absent')
    for (const timing of [null, undefined]) assert.equal(activeMsOf(timing), 0)
    assert.equal(activeMsOf({ ...wellFormed, wallMs: 0, idleMs: 5_000 }), 0)
    assert.equal(activeMsOf({ ...wellFormed, idleMs: 0 }), 60_000, 'a zero carve keeps the wall')
    assert.equal(activeMsOf({ ...wellFormed, idleMs: Number.NaN }), 60_000, 'a hostile carve keeps the wall')
    assert.equal(activeMsOf({ ...wellFormed, idleMs: 90_000 }), 0, 'the carve clamps to the wall')
    assert.equal(activeMsOf(wellFormed), 60_000, 'a pre-field row keeps the wall')
    assert.equal(activeMsOf({ ...wellFormed, idleMs: 5_000 }), 55_000)
  })

  test('optional split and block fields stay ABSENT when absent, pass through when well-formed, and drop alone when hostile', () => {
    const bare = timingOf(wellFormed)
    assert.ok(bare !== null)
    for (const k of ['reasoningMs', 'textMs', 'toolArgMs', 'reasoningBlocks', 'textBlocks', 'toolArgBlocks']) {
      assert.equal(Object.hasOwn(bare, k), false, `${k} stays absent`)
    }
    const split = { reasoningMs: 5_000, textMs: 2_000, toolArgMs: 3_000, reasoningBlocks: 3, textBlocks: 1, toolArgBlocks: 9 }
    assert.deepEqual(timingOf({ ...wellFormed, ...split }), { ...wellFormed, ...split })
    const out = timingOf({ ...wellFormed, reasoningMs: 'x', textMs: -5, toolArgMs: 1_000, reasoningBlocks: 'x', textBlocks: -1, toolArgBlocks: 4 })
    assert.equal(out?.reasoningMs, undefined)
    assert.equal(out?.textMs, undefined)
    assert.equal(out?.toolArgMs, 1_000)
    assert.equal(out?.reasoningBlocks, undefined)
    assert.equal(out?.textBlocks, undefined)
    assert.equal(out?.toolArgBlocks, 4)
    for (const field of ['reasoningMs', 'textBlocks'] as const) {
      const out2 = timingOf({ ...wellFormed, [field]: Number.NaN })
      assert.equal(out2?.[field], undefined, `${field} cannot slip through`)
      assert.equal(out2?.wallMs, wellFormed.wallMs)
    }
  })
})

describe('timelineOf — the live system-prompt nodes', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 7 }
  const base = { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }

  test('a well-formed systems list passes through by reference (fast path)', () => {
    const wire = { ...base, systems: [{ seq: 3, time: 300, tokens: 42 }] }
    assert.equal(timelineOf(wire), wire)
  })

  test('a malformed list takes the sanitizing slow path: entries re-proved and seq-ordered', () => {
    const wire = {
      ...base,
      systems: [
        { seq: 9, time: 900, tokens: 5 },
        null,
        7,
        { seq: 'x', time: 1, tokens: 1 },
        { seq: 2, time: Number.NaN, tokens: 1 },
        { seq: 2, time: 200, tokens: 'nope' },
        { seq: 2, time: 200, tokens: 8 },
        { seq: 5, time: 500, tokens: 3 },
      ],
    }
    const out = timelineOf(wire)
    assert.ok(out !== (wire as unknown))
    assert.deepEqual(out?.systems, [
      { seq: 2, time: 200, tokens: 8 },
      { seq: 5, time: 500, tokens: 3 },
      { seq: 9, time: 900, tokens: 5 },
    ])
  })

  test('an absent systems key stays absent; a non-list becomes empty', () => {
    assert.equal('systems' in (timelineOf(base) ?? {}), false)
    assert.deepEqual(timelineOf({ ...base, systems: 'nope' })?.systems, [])
  })
})

describe('timelineOf — timing integration', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, skill: 0, assistant: 5, tool: 6, total: 7 }
  const base = { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }
  const timing: TimingTotals = { wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9, tools: { bash: { calls: 5, ms: 20_000 } } }

  test('a well-formed timing passes through by reference (fast path)', () => {
    const wire = { ...base, timing }
    assert.equal(timelineOf(wire), wire)
    const busy = { ...timing, toolBusyMs: 25_000 }
    assert.equal(timelineOf({ ...base, timing: busy })?.timing, busy, 'the optional busy union tolerates the fast path')
  })

  test('a non-record timing is omitted entirely (no null-valued key)', () => {
    const out = timelineOf({ ...base, timing: 'corrupt' })
    assert.ok(out !== null)
    assert.ok(!('timing' in out))
  })

  test('every timingFastOk rejection arm routes down the sanitizing slow path', () => {
    const sanitized = (timingValue: unknown): TimingTotals => {
      const out = timelineOf({ ...base, timing: timingValue })
      assert.ok(out !== null)
      return out.timing as TimingTotals
    }
    assert.deepEqual(sanitized({ ...timing, wallMs: 'x' }), { ...timing, wallMs: 0 })
    for (const tools of [null, [{ calls: 1, ms: 1 }], 5]) {
      assert.deepEqual(sanitized({ ...timing, tools }), { ...timing, tools: {} })
    }
    assert.deepEqual(sanitized({ ...timing, tools: { bash: null } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: 5 } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 'x', ms: 1 } } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 1, ms: 'x' } } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, reasoningMs: 'x' }), timing)
    assert.deepEqual(sanitized({ ...timing, textMs: Number.NaN }), timing)
    assert.deepEqual(sanitized({ ...timing, toolArgMs: -1 }), timing)
    for (const bad of ['x', -1, Number.NaN]) assert.deepEqual(sanitized({ ...timing, toolBusyMs: bad }), timing)
    assert.deepEqual(sanitized({ ...timing, toolBusyMs: 25_000 }), { ...timing, toolBusyMs: 25_000 })
    assert.deepEqual(sanitized({ ...timing, wallMs: 'x', toolBusyMs: 25_000 }), { ...timing, wallMs: 0, toolBusyMs: 25_000 })
  })
})

describe('headersOf', () => {
  test('a malformed envelope, epoch, or tool entry degrades the WHOLE value to null', () => {
    for (const value of [
      null,
      7,
      {},
      { headers: 'x' },
      { headers: [null] },
      { headers: ['s'] },
      { headers: [{ tools: 'x' }] },
      { headers: [{ tools: [], systemTokens: 'x' }] },
      { headers: [{ tools: [], systemTokens: Number.NaN }] },
      { headers: [{ tools: [42] }] },
      { headers: [{ tools: [null] }] },
      { headers: [{ tools: [{ name: 7, tokens: 10 }] }] },
      { headers: [{ tools: [{ name: 'bash' }] }] },
      { headers: [{ tools: [{ name: 'bash', tokens: 'x' }] }] },
      { headers: [{ tools: [{ name: 'bash', tokens: Number.NaN }] }] },
      { headers: [{ tools: [{ name: 'bash', tokens: 1, plugin: 7 }] }] },
    ]) assert.equal(headersOf(value), null, JSON.stringify(value))
  })

  test('a tool entry with an optional plugin string passes, and a valid value keeps its reference', () => {
    const value = {
      headers: [
        { seq: 1, time: 1000, tools: [], systemTokens: 12 },
        { seq: 2, time: 2000, tools: [{ name: 'bash', tokens: 10, plugin: 'mcp:x' }] },
      ],
    }
    assert.equal(headersOf(value), value)
    const plain = { headers: [{ seq: 1, time: 1000, tools: [{ name: 'bash', tokens: 10 }], systemTokens: 12 }] }
    assert.equal(headersOf(plain), plain)
  })

  test('a legacy content-bearing epoch (pre-#37 wire) normalizes to the metadata shape; mixed generations price only the unpriced entries', () => {
    const legacy = { headers: [{ seq: 12, time: 1000, system: 'x'.repeat(16), tools: [{ name: 'bash', tokens: 815 }] }] }
    const legacyOut = headersOf(legacy)
    assert.equal(legacyOut?.headers[0]?.systemTokens, 8)
    assert.equal((legacyOut?.headers[0] as { system?: string }).system, 'x'.repeat(16))
    const value = {
      headers: [
        { seq: 0, time: 500, system: 'x'.repeat(16), tools: [] },
        { seq: 1, time: 1000, system: 'prompt', tools: [] },
        { seq: 2, time: 2000, system: 'kept', systemTokens: 55, tools: [] },
        { seq: 3, time: 3000, tools: [] },
      ],
    }
    const out = headersOf(value)
    assert.equal(out?.headers[0]?.systemTokens, 8)
    assert.equal(out?.headers[1]?.systemTokens, Math.ceil(6 / 4) + 4)
    assert.equal(out?.headers[2]?.systemTokens, 55)
    assert.equal(out?.headers[3]?.systemTokens, undefined)
    const unpriced = headersOf({ headers: [{ seq: 1, time: 1, system: '', tools: [] }, { seq: 2, time: 2, system: 7, tools: [] }] })
    assert.equal(unpriced?.headers[0]?.systemTokens, undefined)
    assert.equal(unpriced?.headers[1]?.systemTokens, undefined)
  })
})

describe('workspaceOf', () => {
  test('reads the session row cwd off the sessions list snapshot', () => {
    const ctx = ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: '/repo' } } }) } } })
    assert.equal(workspaceOf(ctx, 'sv'), '/repo')
    assert.equal(workspaceOf(ctx, 'other'), undefined)
  })

  test('absent, malformed, or hostile faces degrade to undefined', () => {
    const throwProp = (): never => { throw new Error('boom') }
    assert.equal(workspaceOf(ctxWith({}), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: {} }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: 7 } } }) } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: '/repo' } } }) } } }), undefined), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: throwProp } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => Object.defineProperty({}, 'byId', { get: throwProp }) } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: Object.defineProperty({}, 'sv', { get: throwProp }) }) } } }), 'sv'), undefined)
    const ctxThrows = { get: throwProp } as unknown as ClientCtx
    assert.equal(workspaceOf(ctxThrows, 'sv'), undefined)
  })
})

describe('sessionAddressOf — the address a history read must carry', () => {
  const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx
  const address = (id: string) => ({ parentSessionId: 'p', childSessionId: id, mode: 'continuable' })

  test('a plain session keeps the session address', () => {
    assert.deepEqual(sessionAddressOf(ctxWith({}), 's'), { kind: 'session', sessionId: 's' })
    assert.deepEqual(sessionAddressOf(ctxWith({ sessions: { subagentAddress: () => undefined } }), 's'), { kind: 'session', sessionId: 's' })
    assert.deepEqual(sessionAddressOf(ctxWith({}), ''), { kind: 'session', sessionId: '' })
  })

  test('a subagent child carries its direct parent and the harness mode', () => {
    const ctx = ctxWith({ sessions: { subagentAddress: address } })
    assert.deepEqual(sessionAddressOf(ctx, 'c'), { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
    assert.deepEqual(
      sessionAddressOf(ctxWith({ sessions: { subagentAddress: () => ({ ...address('c'), mode: 'one-shot' }) } }), 'c'),
      { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' },
    )
  })

  test('an unrecognized or absent mode degrades to the host-accepted unknown', () => {
    for (const mode of [undefined, 'external', 7]) {
      const ctx = ctxWith({ sessions: { subagentAddress: () => ({ ...address('c'), mode }) } })
      assert.deepEqual(sessionAddressOf(ctx, 'c'), { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'unknown' })
    }
  })

  test('the listed subagent row is the fallback the summary-less line needs', () => {
    const ctx = ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { c: { origin: 'subagent', parentId: 'p' } } }) } } })
    assert.deepEqual(sessionAddressOf(ctx, 'c'), { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'unknown' })
    const fork = ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { c: { parentId: 'p' } } }) } } })
    assert.deepEqual(sessionAddressOf(fork, 'c'), { kind: 'session', sessionId: 'c' }, 'a fork seed is no subagent edge')
  })

  test('a shapeless parent never becomes an address', () => {
    const cases = [
      { parentSessionId: '' },
      { parentSessionId: 7 },
      { parentSessionId: 'c' },
    ]
    for (const shape of cases) {
      const ctx = ctxWith({ sessions: { subagentAddress: () => ({ ...shape, childSessionId: 'c' }) } })
      assert.deepEqual(sessionAddressOf(ctx, 'c'), { kind: 'session', sessionId: 'c' })
    }
    const rows = [
      { origin: 'subagent', parentId: '' },
      { origin: 'subagent', parentId: 7 },
      { origin: 'subagent', parentId: 'c' },
    ]
    for (const row of rows) {
      const ctx = ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { c: row } }) } } })
      assert.deepEqual(sessionAddressOf(ctx, 'c'), { kind: 'session', sessionId: 'c' })
    }
    const throwAll = (): never => { throw new Error('boom') }
    assert.deepEqual(sessionAddressOf({ get: throwAll } as unknown as ClientCtx, 'c'), { kind: 'session', sessionId: 'c' })
    assert.deepEqual(
      sessionAddressOf(ctxWith({ sessions: { subagentAddress: throwAll } }), 'c'),
      { kind: 'session', sessionId: 'c' },
    )
  })
})


describe('activityOf', () => {
  const dayOf = (out: unknown, key = '2026-09-16'): Record<string, unknown> =>
    (out as { days: Record<string, Record<string, unknown>> }).days[key]

  test('absent or non-record values stay null; a well-formed payload passes through untouched (reference-stable)', () => {
    assert.equal(activityOf(null), null)
    assert.equal(activityOf(undefined), null)
    assert.equal(activityOf(7), null)
    assert.equal(activityOf('x'), null)
    assert.equal(activityOf({}), null, 'a record without a days map')
    assert.equal(activityOf({ days: 7 }), null)
    assert.equal(activityOf({ days: [] }), null, 'an array is not a ledger')
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1 }, '2026-09-15': { tokens: 0, requests: 3 } } }
    assert.ok(activityOf(wire) === (wire as never))
  })

  test('malformed entries drop individually; the readable days survive', () => {
    const out = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1 },
        '09-16': { tokens: 1, requests: 1 },
        '2026-09-17': null,
        '2026-09-18': [1, 2],
        '2026-09-19': { tokens: 'x', requests: 1 },
        '2026-09-20': { tokens: Number.NaN, requests: 1 },
        '2026-09-21': { tokens: -3, requests: 1 },
        '2026-09-22': { tokens: 1, requests: 'x' },
        '2026-09-23': { tokens: 1, requests: Number.POSITIVE_INFINITY },
        '2026-09-24': { tokens: 1, requests: -1 },
      },
    })
    assert.deepEqual(out, { days: { '2026-09-16': { tokens: 15, requests: 1 } } })
  })

  test('a well-formed day fee rides the pass-through, sparse leaves included', () => {
    const cost = { deepseek: { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 0, output: 2 } } } }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, cost } } }
    assert.ok(activityOf(wire) === (wire as never))
    const dirty = { days: { '2026-09-16': { tokens: 15, requests: 1, cost }, '09-16': { tokens: 1, requests: 1 } } }
    assert.deepEqual(activityOf(dirty), { days: { '2026-09-16': { tokens: 15, requests: 1, cost } } })
    const sparse = { deepseek: { 'deepseek-v4': { peak: { uncached: 1 } } } }
    const sparseWire = { days: { '2026-09-16': { tokens: 15, requests: 1, cost: sparse } } }
    assert.ok(activityOf(sparseWire) === (sparseWire as never), 'missing fields are not malformed')
  })

  test('a malformed day fee drops whole or zero-fills its own day; sibling days ride untouched', () => {
    assert.deepEqual(activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: 'x' },
        '2026-09-15': { tokens: 3, requests: 1, cost: { deepseek: 7 } },
        '2026-09-14': { tokens: 2, requests: 1, cost: {} },
      },
    }), {
      days: {
        '2026-09-16': { tokens: 15, requests: 1 },
        '2026-09-15': { tokens: 3, requests: 1 },
        '2026-09-14': { tokens: 2, requests: 1 },
      },
    }, 'a malformed or empty fee drops whole; the day survives')
    const garbage = { deepseek: { 'deepseek-v4': { peak: { uncached: 'x', cacheRead: 5, cacheWrite: 0, output: 2 } } } }
    const mixed = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: garbage },
        '2026-09-15': { tokens: 3, requests: 1 },
      },
    })
    assert.deepEqual(mixed, {
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 0, cacheRead: 5, cacheWrite: 0, output: 2 } } } } },
        '2026-09-15': { tokens: 3, requests: 1 },
      },
    }, 'the malformed leaf zero-fills; the sibling day rides untouched')
  })

  test('the clean proof reads own keys only; an inherited key neither proves nor drops a record', () => {
    const day = Object.assign(Object.create({ injected: { tokens: 1, requests: 1 } }), { tokens: 15, requests: 1 })
    const wire = { days: Object.assign(Object.create({ '1999-01-01': { tokens: 1, requests: 1 } }), { '2026-09-16': day }) }
    assert.ok(activityOf(wire) === (wire as never))
  })

  test('a malformed fee repairs deterministically: a bad level drops, a bad leaf zero-fills', () => {
    const inheritedCost = Object.assign(Object.create({ 'injected-model': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 1 } } }), {})
    const cases: [unknown, unknown][] = [
      [inheritedCost, undefined],
      [{ deepseek: [1] }, undefined],
      [{ deepseek: { 'deepseek-v4': [1] } }, { deepseek: {} }],
      [{ deepseek: { 'deepseek-v4': 7 } }, { deepseek: {} }],
      [{ deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 'x' } } } },
        { deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 0 } } } }],
    ]
    for (const [cost, expected] of cases) {
      const out = activityOf({ days: { '2026-09-16': { tokens: 1, requests: 1, cost } } })
      assert.deepEqual(dayOf(out).cost ?? undefined, expected, `cost fixture ${JSON.stringify(cost)}`)
      assert.deepEqual(dayOf(out).tokens, 1)
    }
  })

  test('a well-formed skill table rides the pass-through; malformed tallies and inherited-only tables fail the proof', () => {
    const inheritedSkills = Object.assign(Object.create({ ghost: { n: 1, last: 1 } }), { tdd: { n: 2, last: 3 } })
    const skillsOf = (out: unknown): unknown => dayOf(out).skills
    assert.deepEqual(skillsOf(activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: inheritedSkills } } })), { tdd: { n: 2, last: 3 } })
    assert.deepEqual(skillsOf(activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: 7 } } } })), undefined)
    assert.deepEqual(skillsOf(activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: [1] } } })), undefined)
    assert.deepEqual(skillsOf(activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: { n: -1, last: 3 } } } } })), undefined)
    const inheritedOnly = Object.create({ ghost: { n: 1, last: 1 } }) as Record<string, unknown>
    assert.deepEqual(skillsOf(activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: inheritedOnly } } })), undefined)
    const skills = { tdd: { n: 2, last: 1_758_000_000_000 } }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, skills } } }
    assert.ok(activityOf(wire) === (wire as never))
    const out = activityOf({
      days: {
        '2026-09-16': {
          tokens: 15,
          requests: 1,
          skills: {
            tdd: { n: 1, last: 5 },
            'bad-count': { n: 'x', last: 5 },
            'bad-last': { n: 1, last: Number.NaN },
            'neg-count': { n: -1, last: 5 },
            'not-record': null,
          },
        },
        '2026-09-17': { tokens: 1, requests: 1, skills: 'x' },
        '2026-09-18': { tokens: 1, requests: 1, skills: [] },
        '2026-09-19': { tokens: 1, requests: 1, skills: {} },
      },
    })
    assert.deepEqual(out, {
      days: {
        '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: { n: 1, last: 5 } } },
        '2026-09-17': { tokens: 1, requests: 1 },
        '2026-09-18': { tokens: 1, requests: 1 },
        '2026-09-19': { tokens: 1, requests: 1 },
      },
    }, 'non-record and empty-after-scrubbing tables drop whole; the days survive')
  })

  test('the tool and command tables repair like the skill table', () => {
    const clean = {
      days: {
        '2026-09-16': {
          tokens: 1,
          requests: 1,
          tools: { read: { n: 2, last: 5 } },
          cmds: { git: { n: 1, last: 6 } },
        },
      },
    }
    assert.ok(activityOf(clean) === (clean as never), 'clean tables ride the pass-through')
    const dirty = activityOf({
      days: {
        '2026-09-16': {
          tokens: 1,
          requests: 1,
          tools: { read: { n: 1 }, 'bad-name': { n: -1, last: 2 } },
          cmds: { git: { n: 2, last: 3 } },
        },
        '2026-09-17': { tokens: 1, requests: 1, tools: { read: { n: 2, last: 4 } }, cmds: [1] },
      },
    })
    assert.deepEqual(dayOf(dirty).tools, undefined, 'no readable tool tally leaves no table')
    assert.deepEqual(dayOf(dirty).cmds, { git: { n: 2, last: 3 } })
    assert.deepEqual(dayOf(dirty, '2026-09-17'), { tokens: 1, requests: 1, tools: { read: { n: 2, last: 4 } } }, 'a malformed command table drops alone')
  })

  test('the daily tallies ride the pass-through and the sanitized copy; malformed figures drop alone', () => {
    const tallies = { turns: 2, toolCalls: 3, toolsMs: 4.5, wallMs: 5 }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies } } }
    assert.ok(activityOf(wire) === wire, 'a clean payload keeps its reference')
    const dirty = { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies }, bad: { tokens: 1, requests: 1 } } }
    assert.deepEqual(activityOf(dirty), { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies } } })
    const out = activityOf({
      days: { '2026-09-16': { tokens: 15, requests: 1, turns: 'x', toolCalls: -1, toolsMs: Number.NaN, wallMs: Number.POSITIVE_INFINITY } },
    })
    assert.deepEqual(out, { days: { '2026-09-16': { tokens: 15, requests: 1 } } }, 'each malformed tally drops, the day survives')
  })
})

describe('entrySeated — the slot-ledger second-mount guard', () => {
  const ctxWith = (entries: unknown): ClientCtx => ({ slots: { entries: () => entries } } as unknown as ClientCtx)

  test('true when the ledger seats the id; false when the slot seats other ids only, or nothing', () => {
    const ctx = ctxWith([
      { component: () => null, options: { id: 'context-jump', order: 20 } },
    ])
    assert.equal(entrySeated(ctx, 'conversation.chat.assistant-actions', 'context-jump'), true)
    const other = ctxWith([{ component: () => null, options: { id: 'feedback' } }])
    assert.equal(entrySeated(other, 'conversation.chat.assistant-actions', 'context-jump'), false)
    const empty = ctxWith([])
    assert.equal(entrySeated(empty, 'conversation.chat.assistant-actions', 'context-jump'), false)
  })

  test('fail-open and shape-shifted ledgers read as unseated, and one bad entry never hides a real marker', () => {
    assert.equal(entrySeated({ slots: {} } as unknown as ClientCtx, 's', 'x'), false, 'no entries member')
    const primitive = { slots: { entries: 7 } } as unknown as ClientCtx
    assert.equal(entrySeated(primitive, 's', 'x'), false, 'entries is not callable')
    assert.equal(entrySeated(ctxWith('nope'), 's', 'x'), false, 'ledger is not an array')
    const hostile = { slots: { entries: () => { throw new Error('boom') } } } as unknown as ClientCtx
    assert.equal(entrySeated(hostile, 's', 'x'), false, 'the read throws')
    const mixed = ctxWith([
      null,
      'row',
      { component: () => null, options: 'not-a-record' },
      { component: () => null, options: { id: 'context-jump' } },
    ])
    assert.equal(entrySeated(mixed, 's', 'context-jump'), true)
    assert.equal(entrySeated(ctxWith([{ component: () => null, options: 7 }]), 's', 'context-jump'), false)
  })

  test('the ledger read is keyed by slot: the face is asked for the named slot only', () => {
    const asked: string[] = []
    const ctx = {
      slots: { entries: (name: string) => { asked.push(name); return [] } },
    } as unknown as ClientCtx
    assert.equal(entrySeated(ctx, 'conversation.chat.assistant-actions', 'context-jump'), false)
    assert.deepEqual(asked, ['conversation.chat.assistant-actions'])
  })
})

describe('seedConversationViewVia — the pre-jump view preference', () => {
  test('seeds a fresh key and merges into an existing state, draft riding along', () => {
    globalThis.localStorage.clear()
    seedConversationViewVia('session-1', CONTEXT_VIEW_ID)
    assert.equal(globalThis.localStorage.getItem('dsh.conversation.session-1'), JSON.stringify({ view: 'context' }))
    globalThis.localStorage.setItem('dsh.conversation.session-2', JSON.stringify({ draft: { text: 'hi', references: [] }, view: 'chat', viewRequest: null }))
    seedConversationViewVia('session-2', CONTEXT_VIEW_ID)
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('dsh.conversation.session-2')!), {
      draft: { text: 'hi', references: [] }, view: 'context', viewRequest: null,
    })
    globalThis.localStorage.clear()
  })

  test('a malformed stored state is replaced whole; storage failures degrade silently', () => {
    globalThis.localStorage.clear()
    globalThis.localStorage.setItem('dsh.conversation.session-3', 'not-json')
    seedConversationViewVia('session-3', CONTEXT_VIEW_ID)
    assert.equal(globalThis.localStorage.getItem('dsh.conversation.session-3'), JSON.stringify({ view: 'context' }))
    globalThis.localStorage.setItem('dsh.conversation.session-4', '[1]')
    seedConversationViewVia('session-4', CONTEXT_VIEW_ID)
    assert.equal(globalThis.localStorage.getItem('dsh.conversation.session-4'), JSON.stringify({ view: 'context' }))
    const denied = (): never => { throw new Error('denied') }
    const getItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')
    const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')
    Object.defineProperty(Storage.prototype, 'getItem', { value: denied, configurable: true })
    Object.defineProperty(Storage.prototype, 'setItem', { value: denied, configurable: true })
    seedConversationViewVia('session-5', CONTEXT_VIEW_ID)
    if (getItem !== undefined) Object.defineProperty(Storage.prototype, 'getItem', getItem)
    if (setItem !== undefined) Object.defineProperty(Storage.prototype, 'setItem', setItem)
    assert.equal(globalThis.localStorage.getItem('dsh.conversation.session-5'), null)
    globalThis.localStorage.clear()
  })
})

describe('costFullyQuantified', () => {
  test('a merged-shape record aliases; every deviation sends the rebuild', () => {
    const bucket = { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }
    assert.equal(costFullyQuantified({ deepseek: { 'deepseek-v4': { peak: bucket, off: { ...bucket } } } }), true)
    assert.equal(costFullyQuantified(undefined), false, 'undefined is not a merged record')
    assert.equal(costFullyQuantified(null), false)
    assert.equal(costFullyQuantified(7), false)
    assert.equal(costFullyQuantified([1]), false)
    assert.equal(costFullyQuantified({}), false, 'no bucket ever merged')
    assert.equal(costFullyQuantified({ deepseek: 7 }), false, 'a non-record model level')
    assert.equal(costFullyQuantified({ deepseek: [1] }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: 7 } }), false, 'a non-record periods level')
    assert.equal(costFullyQuantified({ deepseek: { m: [1] } }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: { uncached: 'x', cacheRead: 1, cacheWrite: 1, output: 1 } } } }), false, 'a non-numeric bucket field')
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: [1] } } }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: { uncached: 1, cacheRead: 2 } } } }), false, 'a sparse bucket')
  })

  test('a garbage day repairs its scalar fields and keeps readable counters; a bad tally `last` fails the proof on its own', () => {
    const out = activityOf({
      days: {
        '2026-09-16': {
          tokens: 5, requests: 1, turns: 'x', toolCalls: -1, toolsMs: Number.NaN, wallMs: 7,
          cost: { deepseek: { m: { peak: [1], off: { uncached: 2, cacheRead: 2, cacheWrite: 2, output: 2 } } } },
        },
        '2026-09-15': { tokens: 5, requests: 1, skills: { tdd: { n: 0, last: 5 } } },
      },
    })
    assert.deepEqual(out, {
      days: {
        '2026-09-16': {
          tokens: 5, requests: 1, wallMs: 7,
          cost: { deepseek: { m: { off: { uncached: 2, cacheRead: 2, cacheWrite: 2, output: 2 } } } },
        },
        '2026-09-15': { tokens: 5, requests: 1, skills: { tdd: { n: 0, last: 5 } } },
      },
    })
    const counters = activityOf({
      days: {
        '2026-09-16': {
          tokens: 9, requests: 2, turns: 3, toolCalls: 4, toolsMs: 500, wallMs: 900,
          cost: { deepseek: 7 },
          skills: { tdd: { n: 1, last: 'x' } },
        },
      },
    })
    assert.deepEqual(counters, {
      days: { '2026-09-16': { tokens: 9, requests: 2, turns: 3, toolCalls: 4, toolsMs: 500, wallMs: 900 } },
    }, 'the malformed fee drops, the bad-last tally drops the table, the counters stay')
    const nanLast = activityOf({ days: { '2026-09-16': { tokens: 1, requests: 1, skills: { tdd: { n: 1, last: Number.NaN } } } } })
    assert.deepEqual(nanLast, { days: { '2026-09-16': { tokens: 1, requests: 1 } } })
  })

  test('an own __proto__ key at either level never aliases (the merge it stands in for drops it)', () => {
    const protoProvider = JSON.parse('{"__proto__":{"m":{"peak":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4}}}}') as Record<string, unknown>
    assert.ok(Object.keys(protoProvider).includes('__proto__'), 'the fixture really holds an own __proto__ key')
    assert.equal(costFullyQuantified(protoProvider), false)
    const protoModel = JSON.parse('{"deepseek":{"__proto__":{"peak":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4}}}}') as Record<string, unknown>
    assert.equal(costFullyQuantified(protoModel), false)
  })
})
