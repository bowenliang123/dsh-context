// The `contextActivity` projection unit (src/host/activity.ts): the daily
// ledger fold — event filtering, usage sanitizing, day accumulation, the
// retention cap, the copying view, and the schema roundtrip.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyActivity, contextActivitySchema, createContextActivityDefinition } from '../../src/host/activity'
import { isPeakUtc } from '../../src/host/fold'
import { driveTimeline } from './helpers/projection'
import { header, stepStart as timelineStepStart, assistantMessage as timelineMessage } from './helpers/events'
import { dayKeyOf } from '../../src/shared/days'

/** Local noon of a day offset from 2026-01-01 — deterministic in every timezone. */
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

describe('contextActivity unit: shape', () => {
  test('the definition carries the contract fields', () => {
    const def = createContextActivityDefinition()
    assert.equal(def.key, 'contextActivity')
    assert.equal(def.stateVersion, 4, 'historical pricing periods rebuild on upgrade')
    assert.deepEqual(def.init(), { days: {} })
  })

  test('the wire view passes its schema; the state schema round-trips a folded state', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 3, outputTokens: 2 }))
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: -1 } } }).success, false)
    assert.equal(def.stateSchema.safeParse({ days: { '2026-01-01': { tokens: 'x', requests: 1 } } }).success, false)
  })
})

describe('applyActivity: event filtering', () => {
  test('non-assistant events return the state unchanged (same reference)', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    for (const type of ['user/message', 'request/header', 'turn/start', 'bogus/event']) {
      assert.ok(applyActivity(state, { type, seq: 1, time: at(0), data: {} } as never) === state, type)
    }
  })

  test('a settlement with an unreadable time is dropped whole', () => {
    const def = createContextActivityDefinition()
    const state = def.init()
    assert.ok(applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 1 })) === state, 'NaN time')
    assert.ok(applyActivity(state, assistantMessage(1e30, { inputTokens: 1 })) === state, 'out-of-range time')
    assert.ok(applyActivity(state, assistantMessage(-2 * 86_400_000, { inputTokens: 1 })) === state, 'pre-epoch time')
    assert.deepEqual(state, { days: {} })
  })

  test('a tagged fork/seed marker resets the ledger; the untagged resume marker keeps it', () => {
    // A seeded fork's inherited prefix: one settlement the parent session
    // already booked, plus the step slot its open tail left armed (issue #94).
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

    const cut = applyActivity(seeded, { type: 'session/end-seed', seq: 3, time: at(0), data: { inherited: true } } as never)
    assert.deepEqual(cut, { days: {} }, 'the inherited ledger and the armed step slot die at the cut')

    const after = applyActivity(cut, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(after.days, { '2026-01-02': { tokens: 3, requests: 1 } })
  })
})

describe('applyActivity: the ledger', () => {
  test('a metered settlement books the disjoint buckets summed into its day', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 5,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 21, requests: 1 } })
  })

  test('same-day settlements accumulate; distinct days key apart', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 10, outputTokens: 5 }))
    state = applyActivity(state, assistantMessage(at(0), { outputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 3 }))
    assert.deepEqual(state.days, {
      '2026-01-01': { tokens: 16, requests: 2 },
      '2026-01-02': { tokens: 3, requests: 1 },
    })
  })

  test('a settlement without usage counts its request without fabricating tokens', () => {
    let state = applyActivity({ days: {} }, assistantMessage(at(0)))
    state = applyActivity(state, assistantMessage(at(0), null))
    state = applyActivity(state, assistantMessage(at(0), 'usage'))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 3 } })
  })

  test('usage buckets are sanitized: fractions round, negatives clamp, garbage reads absent', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), {
      inputTokens: 10.4,
      cacheReadTokens: -7,
      cacheWriteTokens: '6',
      outputTokens: Number.NaN,
    }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 16, requests: 1 } })
  })

  test('a fully unreadable usage object books zero tokens but keeps the request', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 'x', outputTokens: null }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 0, requests: 1 } })
  })

  test('the persisted previous state is never mutated (copy-on-write)', () => {
    const before = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 1 }))
    const after = applyActivity(before, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(before.days, { '2026-01-01': { tokens: 1, requests: 1 } })
    assert.ok(before !== after)
    assert.ok(before.days !== after.days)
  })

  test('the retention cap evicts the oldest day keys (chronological = lexicographic)', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false, 'the oldest day dropped')
    assert.equal(keys.includes('2026-01-02'), true, 'the kept suffix starts the next day')
    // Later folds within the cap keep every day.
    state = applyActivity(state, assistantMessage(at(400), { inputTokens: 1 }))
    assert.equal(Object.keys(state.days).length, 400)
    assert.equal(state.days['2027-02-05'].requests, 2)
  })
})

describe('contextActivity unit: the view', () => {
  test('the view copies the ledger (the wire never shares the fold’s record)', () => {
    const def = createContextActivityDefinition()
    const state = applyActivity(def.init(), assistantMessage(at(0), { inputTokens: 1 }))
    const view = def.wire.view(state)
    assert.ok(view.days !== state.days)
    view.days['2026-01-01'].tokens = 999
    assert.equal(state.days['2026-01-01'].tokens, 1)
  })
})

/** A `request/header` event carrying the route in force (the fold's only model/provider source). */
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

/** Deterministic UTC instants: Thursday 02:00 (a peak window) and Saturday 12:00 (off-peak). */
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
  })

  test('an identical header returns the same reference', () => {
    const state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    assert.ok(applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official')) === state, 'no change, no copy')
  })

  test('a provider-only header tracks the provider without materializing a model field', () => {
    let state = applyActivity({ days: {} }, requestHeader(undefined, 'deepseek-official'))
    assert.ok(!('model' in state), 'the absent model stays absent (plain-JSON precondition)')
    assert.equal(state.provider, 'deepseek-official')
    // No model in force: the settlement still books no fee.
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 2 }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 2, requests: 1 } })
  })

  test('a settlement with no route in force books its tokens and request but no fee', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0), { inputTokens: 4 }))
    assert.deepEqual(state.days, { '2026-01-01': { tokens: 4, requests: 1 } }, 'no model, no fabricated fee')
  })

  test('a model without a provider books under the empty provider, at list price', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', undefined))
    state = applyActivity(state, assistantMessage(OFF_UTC, { inputTokens: 10 }))
    const day = state.days[dayKeyOf(OFF_UTC) ?? '']
    assert.deepEqual(day?.cost, { '': { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      'an unattributed provider is not DeepSeek, so no off-peak halving')
  })
})

describe('applyActivity: the initiation stamp', () => {
  test('a settlement books the day its step STARTED, across local midnight', () => {
    const late = new Date(2026, 0, 1, 23, 30).getTime()
    const early = new Date(2026, 0, 2, 0, 30).getTime()
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(late))
    state = applyActivity(state, assistantMessage(early, { inputTokens: 6 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-01'], 'the initiation day, not the settlement day')
    assert.equal(state.days['2026-01-01'].tokens, 6)
  })

  test('step/end clears the stamp; the next settlement books its own day', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, stepEnd(at(0)))
    assert.ok(!('stepStart' in state), 'the field is deleted, never materialized as undefined')
    state = applyActivity(state, assistantMessage(at(1), { inputTokens: 2 }))
    assert.deepEqual(Object.keys(state.days), ['2026-01-02'])
  })

  test('an unreadable settlement time still books over a valid stamp', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(Number.NaN, { inputTokens: 9 }))
    assert.deepEqual(state.days, {
      '2026-01-01': {
        tokens: 9,
        requests: 1,
        cost: { 'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
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
    assert.ok(!('stepStart' in state), 'step/end without an armed slot is a no-op')
  })

  test('a step/end over an unarmed slot returns the state unchanged (same reference)', () => {
    const state = applyActivity({ days: {} }, assistantMessage(at(0)))
    assert.ok(applyActivity(state, stepEnd(at(0))) === state)
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
      'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 4, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
  })

  test('an unmetered settlement keeps the day’s existing record; the ledger never loses it', () => {
    let state = applyActivity({ days: {} }, requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1 }))
    state = applyActivity(state, assistantMessage(at(0)))
    assert.deepEqual(state.days['2026-01-01'], {
      tokens: 1,
      requests: 2,
      cost: { 'deepseek-official': { 'deepseek-v4': { [isPeakUtc(at(0)) ? 'peak' : 'off']: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
  })

  test('the retention cap evicts priced days with their day', () => {
    let state: ReturnType<typeof applyActivity> = { days: {} }
    state = applyActivity(state, requestHeader('deepseek-v4', 'deepseek-official'))
    for (let d = 0; d < 401; d++) {
      state = applyActivity(state, assistantMessage(at(d), { inputTokens: 1 }))
    }
    const keys = Object.keys(state.days)
    assert.equal(keys.length, 400)
    assert.equal(keys.includes('2026-01-01'), false)
    assert.ok(state.days['2027-02-05'].cost !== undefined, 'the kept suffix keeps its fee')
  })
})

describe('contextActivity unit: the schemas over the pricing record', () => {
  test('the state schema accepts the route and stamp fields; the wire passes its schema', () => {
    const def = createContextActivityDefinition()
    let state = applyActivity(def.init(), requestHeader('deepseek-v4', 'deepseek-official'))
    state = applyActivity(state, stepStart(at(0)))
    state = applyActivity(state, assistantMessage(at(0), { inputTokens: 1, outputTokens: 2 }))
    assert.equal(def.stateSchema.safeParse(state).success, true)
    assert.equal(def.stateSchema.safeParse({ days: {}, model: 'm', provider: 'p', stepStart: 1 }).success, true)
    const view = def.wire.view(state)
    assert.equal(def.wire.viewSchema.safeParse(view).success, true)
    assert.equal(contextActivitySchema.safeParse(view).success, true)
    assert.deepEqual(view.days, state.days, 'the view copies the entries whole')
  })

  test('a malformed pricing record fails both schemas (strict: no drift)', () => {
    const def = createContextActivityDefinition()
    const bad = {
      days: { '2026-01-01': { tokens: 1, requests: 1, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 'x' } } } } } },
    }
    assert.equal(def.stateSchema.safeParse(bad).success, false)
    assert.equal(def.wire.viewSchema.safeParse(bad).success, false)
    assert.equal(contextActivitySchema.safeParse(bad).success, false)
  })
})

describe('activity and timeline cost parity', () => {
  for (const [start, end] of [['00:59','01:01'], ['03:59','04:01'], ['05:59','06:01'], ['09:59','10:01']]) {
    test(`a step crossing ${start}→${end} keeps the same pricing period in both units`, () => {
      const from = Date.parse(`2026-01-05T${start}:00Z`)
      const to = Date.parse(`2026-01-05T${end}:00Z`)
      const events = [
        header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro', time: from }),
        timelineStepStart(2, { time: from }),
        timelineMessage(3, { time: to, usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 10 } }),
      ]
      const timeline = driveTimeline(events).state
      const activity = events.reduce((st, ev) => applyActivity(st, ev as never), createContextActivityDefinition().init())
      assert.deepEqual(activity.days[dayKeyOf(from)!].cost, timeline.cost)
    })
  }
})
