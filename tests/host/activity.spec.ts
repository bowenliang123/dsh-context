import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyActivity, contextActivitySchema, createContextActivityDefinition } from '../../src/host/activity'
import { isBeijingPeak } from '../../src/host/fold'
import { dayKeyOf } from '../../src/shared/days'

function at(daysFromNewYear: number): number {
  return new Date(2026, 0, 1 + daysFromNewYear, 12).getTime()
}

function assistantMessage(time: number, usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: usage === undefined ? {} : { usage },
  } as never
}

function turnMessage(time: number, turn: number, usage?: unknown): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: { turn, ...(usage === undefined ? {} : { usage }) },
  } as never
}

describe('contextActivity unit: shape', () => {
  test('the definition contract holds and both schemas accept every folded field', () => {
    const def = createContextActivityDefinition()
    assert.equal(def.key, 'contextActivity')
    assert.equal(def.stateVersion, 6, 'the daily turns/tool/wall/per-tool/per-command tallies are the sixth shape')
    assert.deepEqual(def.init(), { days: {} })
    let state = applyActivity(def.init(), requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 3, outputTokens: 2 }))
    const view = def.wire.view(state)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.deepEqual(view.days, state.days, 'the view copies the entries whole')
    assert.notEqual(view.days, state.days, 'the view detaches the ledger map itself')
    const persisted = structuredClone(state.days)
    view.days['2099-12-31'] = { tokens: 1, requests: 1 }
    assert.deepEqual(state.days, persisted, 'a key added to the view never reaches the fold')
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: -1 } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 'x', requests: 1 } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: {}, model: 'm', provider: 'p', stepStart: 1 }).success, true)
    assert.equal(def.stateSchema.safeParse({ days: {}, lastTurn: 3, toolStarts: { c1: { start: 1, day: '2026-01-01' } } }).success, true)
    assert.equal(def.stateSchema.safeParse({ days: {}, toolStarts: { c1: { start: 1, day: '2026-01-01', name: 'read' } } }).success, true)
    assert.equal(def.stateSchema.safeParse({ days: {}, toolStarts: { c1: { start: -1, day: '2026-01-01' } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, turns: 1, toolCalls: 2, toolsMs: 1.5, wallMs: 2 } } }).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, turns: 1.5 } } }).success, false)
    assert.equal(contextActivitySchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, turns: 1, toolCalls: 2, toolsMs: 1.5, wallMs: 2 } } }).success, true)
    assert.equal(def.stateSchema.safeParse({
      days: { '2026-01-01': { tokens: 0, requests: 0, tools: { read: { n: 2, last: 1 } }, cmds: { git: { n: 1, last: 1 } } } },
    }).success, true)
    assert.equal(def.stateSchema.safeParse({
      days: { '2026-01-01': { tokens: 0, requests: 0, tools: { read: { n: 2, last: 1, x: 1 } } } },
    }).success, false, 'a tally carries exactly n and last')

    const bad = { days: { '2026-01-01': { tokens: 1, requests: 1, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 'x' } } } } } } }
    assert.equal(def.stateSchema.safeParse(bad).success, false)
    assert.equal(contextActivitySchema.safeParse(bad).success, false)
  })

  test('the skill-day schema accepts its tally and pending claims, and refuses a malformed one', () => {
    const def = createContextActivityDefinition()
    const skillState = applyActivity(def.init(), skillInvocation(at(0), INVOCATION))
    const skillView = def.wire.view(skillState)
    assert.equal(def.wire.viewSchema.safeParse(skillView).success, true)
    assert.equal(def.stateSchema.safeParse(skillState).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1.5, last: 0 } } } } }).success, false, 'a fractional tally')
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1 } } } } }).success, false, 'a missing last')
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1, last: Number.NaN } } } } }).success, false, 'a non-finite last')
    assert.equal(def.stateSchema.safeParse({ days: {}, skillCalls: ['c1'] }).success, true, 'pending skill-call claims round-trip')
    assert.equal(def.stateSchema.safeParse({ days: {}, skillCalls: [7] }).success, false, 'claims are strings')
  })
})

describe('applyActivity: event filtering', () => {
  test('non-assistant events and settlements with unreadable times return the state unchanged (same reference)', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    for (const type of ['user/message', 'request/header', 'turn/start', 'bogus/event']) {
      assert.ok(applyActivity(state, { type, seq: 1, time: at(0), data: {} } as never) === state, type)
    }
    assert.ok(applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 1 })) === state, 'NaN time')
    assert.ok(applyActivity(state, assistantMessage(1e30, { inputTokens: 1 })) === state, 'out-of-range time')
    assert.ok(applyActivity(state, assistantMessage(-2 * 86_400_000, { inputTokens: 1 })) === state, 'pre-epoch time')
    assert.deepEqual(state, { days: {} })
  })

  test('a tagged fork/seed marker resets the ledger; the untagged resume marker keeps it', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 10 }))
    state = applyActivity(state, { type: 'step/start', seq: 2, time: at(0), data: {} } as never)
    const seeded = state
    assert.ok(seeded.stepStart !== undefined)

    for (const data of [undefined, null, {}, { inherited: 'yes' }]) {
      assert.ok(
        applyActivity(seeded, { type: 'session/end-seed', seq: 3, time: at(0), data } as never) === seeded,
        `data ${JSON.stringify(data)} must not reset`,
      )
    }
    assert.deepEqual(seeded.days, { '2026-01-01': { tokens: 10, requests: 1 } })

    let cursored = applyActivity(seeded, turnMessage(at(0), 1, {}))
    cursored = applyActivity(cursored, toolCall(at(0), 'c1', 'bash'))
    assert.ok(cursored.lastTurn !== undefined && cursored.toolStarts !== undefined)
    const cut = applyActivity(cursored, { type: 'session/end-seed', seq: 3, time: at(0), data: { inherited: true } } as never)
    assert.deepEqual(cut, { days: {} }, 'the inherited ledger, step slot, turn cursor, and pending tool starts die at the cut')

    const after = applyActivity(cut, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(after.days, { '2026-01-02': { tokens: 3, requests: 1 } })
  })
})

describe('applyActivity: the ledger', () => {
  test('a metered settlement books its disjoint bucket sum; same-day adds, distinct days key apart', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 5,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 21, requests: 1 } })
    state = applyActivity(state, assistantMessage(at(0), { outputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 22, requests: 2 },
      '2026-01-02': { tokens: 3, requests: 1 },
    })
  })

  test('unreadable usage counts its request without tokens; usable buckets are sanitized', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0)))
    state = applyActivity(state, assistantMessage(at(0), null))
    state = applyActivity(state, assistantMessage(at(0), 'usage'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 'x', outputTokens: null }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 4 } })
    const sanitized = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10.4,
      cacheReadTokens: -7,
      cacheWriteTokens: '6',
      outputTokens: Number.NaN,
    }))
    assert.deepEqual(sanitized.days, { '2026-01-01': { tokens: 16, requests: 1 } }, 'fractions round, negatives clamp, garbage reads absent')
  })

  test('the persisted previous state is never mutated (copy-on-write on the settlement and skill paths)', () => {
    const before = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const after = applyActivity(before, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(before.days, { '2026-01-01': { tokens: 1, requests: 1 } })
    assert.ok(before !== after)
    assert.ok(before.days !== after.days)
    const skillBefore = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    const skillAfter = applyActivity(skillBefore, skillInvocation(at(0), INVOCATION))
    assert.deepEqual(skillBefore.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
    assert.deepEqual(skillAfter.days['2026-01-01'].skills, { tdd: { n: 2, last: at(0) } })
  })

  test('the retention cap evicts the oldest day keys with their priced record', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false, 'the oldest day dropped with its fee')
    assert.equal(keys.includes('2026-01-02'), true, 'the kept suffix starts the next day')
    assert.ok(state.days['2027-02-05'].cost !== undefined, 'the kept suffix keeps its fee')
    state = applyActivity(state, assistantMessage(at(400), { inputTokens: 1 }))
    assert.equal(Object.keys(state.days).length, 400)
    assert.equal(state.days['2027-02-05'].requests, 2)
  })
})

function skillInvocation(time: number, source: unknown): SessionEvent {
  return { type: 'user/message', seq: 1, time, data: { source } } as never
}

function toolCall(time: number, callId: unknown, name: unknown): SessionEvent {
  return { type: 'tool/call', seq: 1, time, data: { callId, name } } as never
}

function skillResult(time: number, text: string, callId?: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time,
    data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
  } as never
}

const INVOCATION = { kind: 'skill-invocation', name: 'tdd', form: 'instructions' }

describe('applyActivity: skill loads', () => {
  test('a `/name` invocation or developer/message carrier books its name on its day', () => {
    const state = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 0, requests: 0, skills: { tdd: { n: 1, last: at(0) } } },
    })
    const developer = applyActivity({ days: {} }, {
      type: 'developer/message',
      seq: 1,
      time: at(0),
      data: { message: { source: INVOCATION } },
    } as never)
    assert.deepEqual(developer.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
  })

  test('a `skill`-tool result books the wrapper’s name only when paired to a `skill` call, by either call-id source', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    assert.deepEqual(state.skillCalls, ['c1'], 'the call arms the pairing claim')
    state = applyActivity(state, skillResult(at(0), '<skill_content name="ponytail">…</skill_content>', 'c1'))
    assert.deepEqual(state.days['2026-01-01'].skills, { ponytail: { n: 1, last: at(0) } })
    assert.equal(state.skillCalls, undefined, 'the claim consumes once')
    const viaSource = {
      type: 'tool/result',
      seq: 2,
      time: at(0),
      data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '<skill_content name="tdd">…</skill_content>' }] } },
    } as never
    const lifted = applyActivity(applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill')), viaSource)
    assert.deepEqual(lifted.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } }, 'the durable source callId pairs too')
  })

  test('a wrapper in another tool’s result books no skill (a `read` quoting the wrapper is no load)', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'read'))
    state = applyActivity(state, skillResult(at(0), 'source text quoting <skill_content name="…"> inline', 'c1'))
    assert.equal(state.days['2026-01-01'].skills, undefined)
    assert.equal(state.days['2026-01-01'].toolCalls, 1, 'the read still prices its tool run')
    state = applyActivity(state, skillResult(at(0), '<skill_content name="ponytail">…</skill_content>', 'c9'))
    assert.equal(state.days['2026-01-01'].skills, undefined)
    assert.equal(state.days['2026-01-01'].toolCalls, 1)
  })

  test('a paired result without the wrapper consumes only its claim; sibling claims stay pending', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'skill'))
    state = applyActivity(state, skillResult(at(0), 'skill load failed', 'c1'))
    assert.equal(state.days['2026-01-01'].skills, undefined)
    assert.equal(state.days['2026-01-01'].toolCalls, 1)
    assert.equal(state.skillCalls, undefined)
    state = applyActivity(state, toolCall(at(0), 'c1', 'skill'))
    state = applyActivity(state, toolCall(at(0), 'c2', 'skill'))
    state = applyActivity(state, skillResult(at(0), '<skill_content name="tdd">…</skill_content>', 'c1'))
    assert.deepEqual(state.skillCalls, ['c2'], 'the drained claim leaves its sibling armed')
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } })
  })

  test('the pairing list is bounded and duplicate arms are inert', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, toolCall(at(0), 'c1', 'skill'))
    assert.ok(applyActivity(state, toolCall(at(0), 'c1', 'skill')) === state, 're-arming the same id is a no-op')
    for (let i = 0; i < 120; i++) {
      state = applyActivity(state, toolCall(at(0), `x${i}`, 'skill'))
    }
    assert.equal(state.skillCalls?.length, 100, 'the oldest pending claims drop first')
    assert.equal(state.skillCalls?.includes('c1'), false)
    for (const ev of [
      toolCall(at(0), 'c2', 'bash'),
      toolCall(at(0), 7, 'skill'),
      toolCall(at(0), '', 'skill'),
      toolCall(at(0), undefined, 'skill'),
      { type: 'tool/call', seq: 1, time: at(0), data: null } as never,
    ]) {
      assert.deepEqual(applyActivity(state, ev).skillCalls, state.skillCalls, JSON.stringify(ev.data))
    }
  })

  test('loads tally per name; the last instant never walks back on a disordered replay', () => {
    let state = applyActivity({ days: {} }, skillInvocation(at(0), INVOCATION))
    state = applyActivity(state, toolCall(at(0) + 60_000, 'c1', 'skill'))
    state = applyActivity(state, skillResult(at(0) + 60_000, '<skill_content name="tdd">…</skill_content>', 'c1'))
    state = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'tdd' }))
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 3, last: at(0) + 60_000 } })
    state = applyActivity(state, skillInvocation(at(1), INVOCATION))
    assert.deepEqual(state.days['2026-01-02'].skills, { tdd: { n: 1, last: at(1) } }, 'distinct days key apart')
  })

  test('non-load messages and hostile payloads return the state unchanged', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const cases: SessionEvent[] = [
      skillInvocation(at(0), undefined),
      skillInvocation(at(0), null),
      skillInvocation(at(0), 'skill-invocation'),
      skillInvocation(at(0), { kind: 'plugin', name: 'tdd' }),
      skillInvocation(at(0), { kind: 'skill-invocation' }),
      skillInvocation(at(0), { kind: 'skill-invocation', name: 7 }),
      skillInvocation(at(0), { kind: 'skill-invocation', name: '' }),
      { type: 'user/message', seq: 1, time: at(0), data: null } as never,
      { type: 'user/message', seq: 1, time: Number.NaN, data: { source: INVOCATION } } as never,
      skillResult(at(0), '<skill_content name="tdd">…</skill_content>'),
      { type: 'tool/result', seq: 1, time: at(0), data: null } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: null } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { toolCallId: 7 } } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { toolCallId: '' } } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { source: { callId: 9 } } } } as never,
      { type: 'tool/result', seq: 1, time: at(0), data: { message: { source: 'x' } } } as never,
    ]
    for (const event of cases) {
      assert.ok(applyActivity(state, event) === state, JSON.stringify(event.data))
    }
  })

  test('a skill load on a priced day keeps the day’s tokens and fee', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, skillInvocation(at(0), INVOCATION))
    const day = state.days['2026-01-01']
    assert.equal(day.tokens, 15)
    assert.equal(day.requests, 1)
    assert.ok(day.cost !== undefined, 'the pricing record rides on')
    assert.deepEqual(day.skills, { tdd: { n: 1, last: at(0) } })
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 2 }))
    assert.deepEqual(state.days['2026-01-01'].skills, { tdd: { n: 1, last: at(0) } }, 'a later settlement keeps the skill table')
  })

  test('a day’s name table is capped: new names drop, booked names keep tallying', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let i = 0; i < 100; i++) {
      state = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: `skill-${i}` }))
    }
    const capped = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'skill-100' }))
    assert.ok(capped === state, 'the 101st distinct name books nothing')
    const again = applyActivity(state, skillInvocation(at(0), { kind: 'skill-invocation', name: 'skill-0' }))
    assert.equal(again.days['2026-01-01'].skills?.['skill-0'].n, 2, 'a booked name still grows')
  })

})

function requestHeader(model: unknown, provider: unknown): SessionEvent {
  return {
    type: 'request/header',
    seq: 1,
    time: at(0),
    data: { header: { config: { model, provider } } },
  } as never
}

function stepStart(time: number): SessionEvent {
  return { type: 'step/start', seq: 1, time, data: {} } as never
}

function stepEnd(time: number): SessionEvent {
  return { type: 'step/end', seq: 1, time, data: {} } as never
}

const PEAK_UTC = Date.UTC(2026, 0, 1, 2)
const OFF_UTC = Date.UTC(2026, 0, 3, 12)

describe('applyActivity: the route in force', () => {
  test('a header books later settlements under its (provider, model); the last header wins', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, requestHeader('glm-5', 'zai-coding-cn'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 3 }))
    const day = state.days[dayKeyOf(PEAK_UTC) ?? '']
    assert.deepEqual(day?.cost, {
      'deepseek-official': { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5 } } },
      'zai-coding-cn': { 'glm-5': { peak: { uncached: 3, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
  })

  test('a header without readable route fields returns the state unchanged (same reference)', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    for (const ev of [
      { type: 'request/header', seq: 1, time: at(0), data: null },
      { type: 'request/header', seq: 1, time: at(0), data: {} },
      { type: 'request/header', seq: 1, time: at(0), data: { header: null } },
      { type: 'request/header', seq: 1, time: at(0), data: { header: { config: 'x' } } },
      { type: 'request/header', seq: 1, time: at(0), data: { header: { config: { model: 7, provider: true } } } },
    ] as never as SessionEvent[]) {
      assert.ok(applyActivity(state, ev) === state)
    }
    const routed = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    assert.ok(applyActivity(routed, requestHeader('deepseek-v4', 'deepseek-official')) === routed, 'an identical header is no change, no copy')
  })

  test('a provider-only header tracks the provider without a model field; a model without a provider books under the empty provider', () => {
    let state = applyActivity({ days: {} }, requestHeader(undefined, 'deepseek-official'))
    assert.ok(!('model' in state), 'the absent model stays absent (plain-JSON precondition)')
    assert.equal(state.provider, 'deepseek-official')
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 2 }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 2, requests: 1 } }, 'no model, no fabricated fee')

    state = applyActivity({ days: {} }, requestHeader('deepseek-v4', undefined))
    state = applyActivity(state, assistantMessage(OFF_UTC, { inputTokens: 10 }))
    const day = state.days[dayKeyOf(OFF_UTC) ?? '']
    assert.deepEqual(day?.cost, { '': { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      'an unattributed provider is not DeepSeek, so its usage books under peak and is never doubled')
  })
})

describe('applyActivity: the initiation stamp', () => {
  test('a settlement books the day its step STARTED; step/end clears the stamp so the next books its own day', () => {
    const late = new Date(2026, 0, 1, 23, 30).getTime()
    const early = new Date(2026, 0, 2, 0, 30).getTime()
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(late))
    state = applyActivity(state, assistantMessage(early, { inputTokens: 6 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-01'], 'the initiation day, not the settlement day')
    assert.equal(state.days['2026-01-01'].tokens, 6)
    state = applyActivity(state, stepEnd(early))
    assert.ok(!('stepStart' in state), 'the field is deleted, never materialized as undefined')
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-01', '2026-01-02'])
    assert.equal(state.days['2026-01-02'].tokens, 2)
  })

  test('an unreadable settlement time still books over a valid stamp', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 9 }))
    assert.deepEqual(state.days, {
      '2026-01-01': {
        tokens: 9,
        requests: 1,
        cost: { 'deepseek-official': { 'deepseek-v4': { [isBeijingPeak(at(0)) ? 'peak' : 'off']: { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      },
    })
  })

  test('a non-finite step/start never arms the slot; a stale stamp stays armed like the timeline fold', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, stepStart(Number.NaN))
    assert.ok(applyActivity(state, stepStart(Number.NaN)) === state)
    state = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepEnd(at(1)))
    assert.ok(!('stepStart' in state), 'step/end clears the armed stamp')
    assert.ok(applyActivity(state, stepEnd(at(2))) === state, 'step/end over an unarmed slot returns the same reference')
  })
})

describe('applyActivity: turn, tool-run, and step-time attribution', () => {
  const late = new Date(2026, 0, 1, 23, 30).getTime()
  const early = new Date(2026, 0, 2, 0, 30).getTime()

  test('a turn books once, on the initiation day of its first settlement', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, turnMessage(at(0), 7, { inputTokens: 1 }))
    state = applyActivity(state, stepEnd(at(0)))
    state = applyActivity(state, stepStart(at(1)))
    state = applyActivity(state, turnMessage(at(1), 7, { inputTokens: 1 }))
    state = applyActivity(state, stepEnd(at(1)))
    assert.equal(state.days['2026-01-01'].turns, 1)
    assert.equal(state.days['2026-01-02'].turns, undefined, 'the same turn never re-books on a later day')
    state = applyActivity(state, stepStart(at(1)))
    state = applyActivity(state, turnMessage(at(1), 8, { inputTokens: 1 }))
    assert.equal(state.days['2026-01-02'].turns, 1, 'the next turn books its own day')
  })

  test('a tool run and a step wall time book on the step-start day, and a later settlement keeps the tallies', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(late))
    state = applyActivity(state, toolCall(late, 'c1', 'bash'))
    state = applyActivity(state, skillResult(early, 'done', 'c1'))
    assert.equal(state.days['2026-01-01'].toolCalls, 1)
    assert.equal(state.days['2026-01-01'].toolsMs, early - late)
    assert.equal(state.days['2026-01-02'], undefined)
    state = applyActivity(state, assistantMessage(early, { inputTokens: 1 }))
    assert.equal(state.days['2026-01-01'].toolCalls, 1, 'a later settlement keeps the tool tally')
    assert.equal(state.days['2026-01-01'].toolsMs, early - late)
    const walled = applyActivity(applyActivity({ days: {} }, stepStart(late)), stepEnd(early))
    assert.equal(walled.days['2026-01-01'].wallMs, early - late)
    assert.equal(walled.days['2026-01-02'], undefined)
    const walledSettled = applyActivity(walled, assistantMessage(late, { inputTokens: 1 }))
    assert.equal(walledSettled.days['2026-01-01'].wallMs, early - late, 'a later settlement keeps the wall tally')
    const walledAgain = applyActivity(applyActivity(walled, stepStart(late + 1000)), stepEnd(late + 2000))
    assert.equal(walledAgain.days['2026-01-01'].wallMs, (early - late) + 1000, 'wall time accumulates across steps on the day')
  })

  test('an unreadable or undatable tool start never arms', () => {
    const state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    assert.ok(applyActivity(state, toolCall(Number.NaN, 'c1', 'bash')) === state, 'a non-finite start')
    assert.ok(applyActivity(state, toolCall(1e30, 'c2', 'bash')) === state, 'a start outside the day-key range')
    const negative = applyActivity(state, stepStart(-2 * 86_400_000))
    assert.equal(applyActivity(negative, toolCall(at(0), 'c3', 'bash')).toolStarts, undefined, 'a step stamp with no local day')
  })

})

function toolResultAt(time: number, callId: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: 1,
    time,
    data: { message: { toolCallId: callId, content: [] } },
  } as never
}

function commandCall(time: number, callId: unknown, name: unknown, args?: unknown): SessionEvent {
  return { type: 'tool/call', seq: 1, time, data: { callId, name, arguments: args } } as never
}

describe('applyActivity: the per-tool table', () => {
  test('a paired result books its tool name on the step day; a nameless call books only the run count', () => {
    let state = applyActivity({ days: {} }, stepStart(at(0)))
    state = applyActivity(state, toolCall(at(0), 'c1', 'read'))
    state = applyActivity(state, toolResultAt(at(0) + 500, 'c1'))
    state = applyActivity(state, toolCall(at(0), 'c2', 'read'))
    state = applyActivity(state, toolResultAt(at(0) + 900, 'c2'))
    state = applyActivity(state, toolCall(at(0), 'c3', 'grep'))
    state = applyActivity(state, toolResultAt(at(0) + 1000, 'c3'))
    const day = state.days['2026-01-01']
    assert.equal(day.toolCalls, 3)
    assert.equal(day.toolsMs, 2400)
    assert.deepEqual(day.tools, {
      read: { n: 2, last: at(0) + 900 },
      grep: { n: 1, last: at(0) + 1000 },
    })

    const nameless = applyActivity(applyActivity({ days: {} }, toolCall(at(0), 'c9', 7)), toolResultAt(at(0), 'c9'))
    assert.equal(nameless.days['2026-01-01'].toolCalls, 1)
    assert.equal(nameless.days['2026-01-01'].tools, undefined)
  })

  test('an unreadable result time keeps the start instant as the last stamp', () => {
    let state = applyActivity({ days: {} }, toolCall(at(0), 'c1', 'read'))
    state = applyActivity(state, toolResultAt(Number.NaN, 'c1'))
    assert.deepEqual(state.days['2026-01-01'].tools, { read: { n: 1, last: at(0) } })
  })

  test('a day’s tool table is capped: new names drop, booked names keep tallying', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let i = 0; i < 64; i++) {
      state = applyActivity(state, toolCall(at(0), `c${i}`, `tool-${i}`))
      state = applyActivity(state, toolResultAt(at(0), `c${i}`))
    }
    const capped = applyActivity(applyActivity(state, toolCall(at(0), 'x', 'tool-64')), toolResultAt(at(0), 'x'))
    assert.deepEqual(capped.days['2026-01-01'].tools, state.days['2026-01-01'].tools, 'the 65th distinct name books no table entry')
    assert.equal(capped.days['2026-01-01'].toolCalls, 65, 'the run itself still counts')
    const again = applyActivity(applyActivity(capped, toolCall(at(0), 'y', 'tool-0')), toolResultAt(at(0), 'y'))
    assert.equal(again.days['2026-01-01'].tools?.['tool-0'].n, 2, 'a booked name still grows')
  })
})

describe('applyActivity: the per-day command table', () => {
  test('a command call books its head program on the initiation day; a call without a command books nothing', () => {
    let state = applyActivity({ days: {} }, stepStart(at(0)))
    state = applyActivity(state, commandCall(at(0), 'c1', 'bash', { command: 'cd /repo && git status' }))
    state = applyActivity(state, commandCall(at(0), 'c2', 'bash', { command: 'pnpm exec vitest run' }))
    state = applyActivity(state, commandCall(at(0), 'c3', 'run_code', { code: 'print(1)' }))
    state = applyActivity(state, commandCall(at(0), 'c4', 'read', { file_path: '/x' }))
    state = applyActivity(state, commandCall(at(0), 'c5', 'bash', { description: 'no command here' }))
    assert.deepEqual(state.days['2026-01-01'].cmds, {
      git: { n: 1, last: at(0) },
      pnpm: { n: 1, last: at(0) },
      run_code: { n: 1, last: at(0) },
    })
    assert.equal(state.days['2026-01-01'].toolCalls, undefined, 'a dispatch alone books no tool run')
    const settled = applyActivity(state, assistantMessage(at(0), { inputTokens: 1 }))
    assert.deepEqual(settled.days['2026-01-01'].cmds, state.days['2026-01-01'].cmds, 'a later settlement keeps the command table')
  })

  test('the command day follows the step stamp, and a JSON string of args parses too', () => {
    const late = new Date(2026, 0, 1, 23, 30).getTime()
    const early = new Date(2026, 0, 2, 0, 30).getTime()
    let state = applyActivity({ days: {} }, stepStart(late))
    state = applyActivity(state, commandCall(early, 'c1', 'pwsh', JSON.stringify({ command: 'git status' })))
    assert.deepEqual(state.days['2026-01-01'].cmds, { git: { n: 1, last: early } })
    assert.equal(state.days['2026-01-02'], undefined)
    const fallback = applyActivity({ days: {} }, commandCall(at(1), 'c2', 'bash', { command: '' }))
    assert.equal(fallback.days['2026-01-02'], undefined, 'an empty command derives no program')
  })

  test('a nested code-mode dispatch books its own run; a hostile dispatch stays inert', () => {
    const dispatch = (data: unknown, time = at(0)): SessionEvent =>
      ({ type: 'tool/ptc-dispatch-start', seq: 1, time, data } as never)
    const state = applyActivity({ days: {} }, dispatch({ name: 'bash', arguments: { command: 'node build.js' } }))
    assert.deepEqual(state.days['2026-01-01'].cmds, { node: { n: 1, last: at(0) } })
    for (const data of [null, {}, { name: 7, arguments: {} }, { name: 'bash' }, { name: 'read', arguments: { path: '/x' } }]) {
      assert.ok(applyActivity(state, dispatch(data)) === state, JSON.stringify(data))
    }
    assert.ok(
      applyActivity(state, { type: 'tool/ptc-dispatch-start', seq: 1, time: Number.NaN, data: { name: 'bash', arguments: { command: 'git' } } } as never) === state,
      'an unreadable instant books nothing',
    )
  })

  test('a day’s command table is capped: new programs drop, booked programs keep tallying', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let i = 0; i < 64; i++) {
      state = applyActivity(state, commandCall(at(0), `c${i}`, 'bash', { command: `prog${i} --flag` }))
    }
    const capped = applyActivity(state, commandCall(at(0), 'x', 'bash', { command: 'prog64' }))
    assert.deepEqual(capped.days['2026-01-01'].cmds, state.days['2026-01-01'].cmds, 'the 65th distinct program books nothing')
    const again = applyActivity(capped, commandCall(at(0), 'y', 'bash', { command: 'prog0' }))
    assert.equal(again.days['2026-01-01'].cmds?.prog0.n, 2, 'a booked program still grows')
  })
})

describe('applyActivity: the per-day pricing record', () => {
  test('DeepSeek peak windows book the doubled list price; off-peak books the plain one', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(PEAK_UTC, { inputTokens: 100, cacheReadTokens: 10 }))
    state = applyActivity(state, assistantMessage(OFF_UTC, { inputTokens: 100, cacheReadTokens: 10 }))
    assert.deepEqual(state.days[dayKeyOf(PEAK_UTC) ?? '']?.cost, {
      'deepseek-official': { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 10, cacheWrite: 0, output: 0 } } },
    })
    assert.deepEqual(state.days[dayKeyOf(OFF_UTC) ?? '']?.cost, {
      'deepseek-official': { 'deepseek-v4': { off: { uncached: 100, cacheRead: 10, cacheWrite: 0, output: 0 } } },
    })
  })

  test('same-day settlements accumulate into the day’s record', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 3 }))
    assert.deepEqual(state.days['2026-01-01'].cost, {
      'deepseek-official': { 'deepseek-v4': { [isBeijingPeak(at(0)) ? 'peak' : 'off']: { uncached: 4, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
  })

  test('an unmetered settlement keeps the day’s existing record; the ledger never loses it', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(0)))
    assert.deepEqual(state.days['2026-01-01'], {
      tokens: 1,
      requests: 2,
      cost: { 'deepseek-official': { 'deepseek-v4': { [isBeijingPeak(at(0)) ? 'peak' : 'off']: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
  })

})

describe('contextActivity unit: the schemas over the pricing record', () => {
  test('the served view never aliases a day\'s nested cost or tally records', () => {
    const def = createContextActivityDefinition()
    let state = applyActivity(def.init(), requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    state = applyActivity(state, skillInvocation(at(0), INVOCATION))
    state = applyActivity(state, toolCall(at(0), 'c1', 'read'))
    state = applyActivity(state, toolResultAt(at(0), 'c1'))
    state = applyActivity(state, commandCall(at(0), 'c2', 'bash', { command: 'git status' }))
    const view = def.wire.view(state)
    const day = Object.keys(state.days)[0]
    const served = view.days[day]
    const persisted = state.days[day]
    assert.ok(persisted.cost !== undefined && persisted.skills !== undefined, 'the fixture carries both records')
    assert.ok(persisted.tools !== undefined && persisted.cmds !== undefined, 'the fixture carries both tallies')
    assert.notEqual(served.cost, persisted.cost)
    assert.notEqual(served.cost?.['deepseek-official'], persisted.cost?.['deepseek-official'])
    assert.notEqual(served.cost?.['deepseek-official']?.['deepseek-v4'], persisted.cost?.['deepseek-official']?.['deepseek-v4'])
    assert.notEqual(served.cost?.['deepseek-official']?.['deepseek-v4']?.off, persisted.cost?.['deepseek-official']?.['deepseek-v4']?.off)
    assert.notEqual(served, persisted)
    assert.notEqual(served.skills, persisted.skills)
    assert.notEqual(served.skills?.tdd, persisted.skills?.tdd)
    assert.notEqual(served.tools, persisted.tools)
    assert.notEqual(served.tools?.read, persisted.tools?.read)
    assert.notEqual(served.cmds, persisted.cmds)
    assert.notEqual(served.cmds?.git, persisted.cmds?.git)
    assert.deepEqual(served, persisted)
    served.tokens = 999
    assert.equal(persisted.tokens, 3, 'mutating the view never reaches the fold’s record')
  })
})
