import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { applyTimeline, type TimelineEvent } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import { applyActivity, createContextActivityDefinition } from '../../src/host/activity'
import { driveTimeline } from './helpers/projection'
import { header, assistantMessage, assistantAttempt, endSeed, stepStart } from './helpers/events'

const instant = Date.parse('2026-01-05T02:00:00Z')
const a = { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20 }
const b = { inputTokens: 200, cacheReadTokens: 20, outputTokens: 10 }
const stream = (usage: unknown) => [{ type: 'chunk', time: instant, chunk: { type: 'usage', usage } }]
const attempt = (seq: number, usage: unknown, step = 1) => assistantAttempt(seq, { turn: 1, step, time: instant, stream: stream(usage) })
const message = (seq: number, usage: Record<string, unknown>) => assistantMessage(seq, { turn: 1, step: 1, time: instant, usage })
const retry = (seq: number, step = 1): TimelineEvent => ({ type: 'llm/retry-started', seq, time: instant, data: { turn: 1, step } })

function check(events: TimelineEvent[], expected: number, requests = 0): void {
  const log = [header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro', time: instant }), stepStart(2, { time: instant }), ...events]
  const timeline = driveTimeline(log).state
  const def = createContextActivityDefinition()
  const activity = log.reduce((st, ev) => applyActivity(st, ev), def.init())
  const cost = Object.values(timeline.cost?.['deepseek-official']?.['deepseek-v4-pro'] ?? {})
    .reduce((total, usage) => total + usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output, 0)
  assert.equal(cost, expected)
  assert.equal(Object.values(activity.days).reduce((n, day) => n + day.tokens, 0), expected)
  assert.equal(Object.values(activity.days).reduce((n, day) => n + day.requests, 0), requests)
  assert.equal(def.stateSchema.safeParse(activity).success, true)
}

describe('provider usage from both durable settlement shapes', () => {
  test('failed attempts still book provider-reported usage', () => check([attempt(3, a)], 170))
  test('an assistant message falls back to its last stream usage', () => {
    check([assistantMessage(3, { turn: 1, step: 1, time: instant, stream: [...stream(a), ...stream(b)] })], 230, 1)
  })
  test('top-level message usage takes precedence over stream usage', () => {
    check([assistantMessage(3, { turn: 1, step: 1, time: instant, usage: a, stream: stream(b) })], 170, 1)
  })
  test('a later sample replaces the earlier sample for the same attempt', () => check([attempt(3, a), message(4, b)], 230, 1))
  test('the retry-started boundary bills both attempts', () => check([attempt(3, a), retry(4), message(5, b)], 400, 1))
  test('a retry marker for a different step does not close this replacement slot', () => check([attempt(3, a), retry(4, 2), message(5, b)], 230, 1))
  test('identical attempt samples do not double bill', () => check([attempt(3, a), attempt(4, a)], 170))
  test('different steps contribute separately', () => check([attempt(3, a), attempt(4, b, 2)], 400))
  test('a fork seed clears inherited billing samples', () => {
    const log = [attempt(3, a), endSeed(4, { inherited: true }), header(5, { provider: 'deepseek-official', model: 'deepseek-v4-pro', time: instant }), message(6, b)]
    check(log, 230, 1)
  })
})

describe('replacement accounting across pricing routes and checkpoints', () => {
  test('an unpriced attempt is replaced without inventing a model fee', () => {
    const def = createContextActivityDefinition()
    const events = [attempt(1, a), message(2, b)]
    const result = events.reduce((st, ev) => applyActivity(st, ev), def.init())
    assert.equal(Object.values(result.days)[0].tokens, 230)
    assert.equal(Object.values(result.days)[0].cost, undefined)
    def.stateSchema.parse(result)
  })
  test.each(['2026-01-05T02:00:00Z', '2026-01-05T05:00:00Z'])('replacement rolls back the original route and period (%s) without mutating its checkpoint', started => {
    const later = Date.parse('2026-01-06T05:00:00Z')
    const original = { ...attempt(2, a), time: Date.parse(started) }
    const period = started.includes('02:00') ? 'peak' : 'off'
    const before = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      original,
    ]).state
    const snapshot = JSON.stringify(before)
    const routedTimeline = applyTimeline(before, header(3, { provider: 'deepseek-account', model: 'deepseek-v4-flash' }), resolveBounds({}))
    const after = applyTimeline(routedTimeline, assistantMessage(4, { turn: 1, step: 1, time: later, usage: b }), resolveBounds({}))
    assert.equal(after.cost?.['deepseek-official']['deepseek-v4-pro'][period]?.uncached, 0)
    assert.equal(after.cost?.['deepseek-account']['deepseek-v4-flash'].off?.uncached, 200)
    assert.equal(JSON.stringify(before), snapshot)
    const def = createContextActivityDefinition()
    const initial = [header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }), original]
      .reduce((st, ev) => applyActivity(st, ev), def.init())
    const saved = JSON.stringify(initial)
    const routed = applyActivity(initial, header(3, { provider: 'deepseek-account', model: 'deepseek-v4-flash' }))
    const replaced = applyActivity(routed, assistantMessage(4, { turn: 1, step: 1, time: later, usage: b }))
    assert.equal(Object.values(replaced.days).reduce((n, day) => n + day.tokens, 0), 230)
    assert.equal(JSON.stringify(initial), saved)
    def.stateSchema.parse(replaced)
  })
  test('a retained sample whose day has aged out cannot recreate evicted billing', () => {
    const def = createContextActivityDefinition()
    const previous = { ...def.init(), lastUsage: {
      turn: 1, step: 1, time: instant, provider: '', day: '2025-01-01',
      buckets: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20 },
    } }
    const next = applyActivity(previous, message(2, b))
    assert.equal(Object.values(next.days)[0].tokens, 230)
    assert.equal(next.days['2025-01-01'], undefined)
  })
  test('an attempt without reported usage is reference-stable', () => {
    const def = createContextActivityDefinition()
    const previous = def.init()
    assert.equal(applyActivity(previous, assistantAttempt(1, { time: instant })), previous)
  })
})
