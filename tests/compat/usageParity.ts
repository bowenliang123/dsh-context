import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Baseline } from '../baselines'
import { stageFile } from './staging'
import { driveTimeline, timelineDef } from '../host/helpers/projection'
import { applyActivity, createContextActivityDefinition } from '../../src/host/activity'
import { assistantAttempt, assistantMessage, header } from '../host/helpers/events'
import type { TimelineEvent, TimelineState } from '../../src/host/fold'

const instant = Date.parse('2026-01-05T02:00:00Z')
const a = { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 7, outputTokens: 20 }
const b = { inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 9, outputTokens: 10 }
const stream = (usage: unknown) => [{ type: 'chunk', time: instant, chunk: { type: 'usage', usage } }]
const attempt = (seq: number, usage: unknown, step = 1) => assistantAttempt(seq, { turn: 1, step, time: instant, stream: stream(usage) })
const message = (seq: number, usage: typeof a) => assistantMessage(seq, { turn: 1, step: 1, time: instant, usage })
const retry = (seq: number, step = 1): TimelineEvent => ({ type: 'llm/retry-started', seq, time: instant, data: { turn: 1, step } })
const cases: TimelineEvent[][] = [
  [attempt(2, a)],
  [assistantMessage(2, { turn: 1, step: 1, time: instant, stream: [...stream(a), ...stream(b)] })],
  [assistantMessage(2, { turn: 1, step: 1, time: instant, usage: a, stream: stream(b) })],
  [attempt(2, a), message(3, b)],
  [attempt(2, a), retry(3), message(4, b)],
  [attempt(2, a), retry(3, 2), message(4, b)],
  [attempt(2, a), attempt(3, a)],
  [attempt(2, a), attempt(3, b, 2)],
  [attempt(2, a), assistantMessage(3, { turn: 1, step: 1, time: instant, stream: [] }), message(4, b)],
  [attempt(2, a), { ...retry(3), data: { turn: 2, step: 1 } }, message(4, b)],
]

interface Meter {
  init(): unknown
  apply(state: unknown, event: TimelineEvent): unknown
  wire: { view(state: unknown): { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number } }
}

export async function assertUsageParity(baseline: Baseline): Promise<void> {
  let source = ''
  for (const name of ['estimate.ts', 'surface-projection.ts', 'usage-projection.ts']) {
    const path = stageFile(baseline, 'packages/llm/token-meter/src/' + name, join('token-meter', name))
    if (name === 'usage-projection.ts') source = path
  }
  const { tokenUsageProjectionDefinition: meter } = await import(pathToFileURL(source).href) as { tokenUsageProjectionDefinition: Meter }
  for (const events of cases) {
    const log = [header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro', time: instant }), ...events]
    const metered = meter.wire.view(log.reduce((st, ev) => meter.apply(st, ev), meter.init()))
    const expected = metered.uncachedInputTokens + metered.cacheReadTokens + metered.cacheWriteTokens + metered.outputTokens
    const expectedBuckets = {
      uncached: metered.uncachedInputTokens,
      cacheRead: metered.cacheReadTokens,
      cacheWrite: metered.cacheWriteTokens,
      output: metered.outputTokens,
    }
    const timeline = driveTimeline(log).state
    const cost = Object.values(timeline.cost?.['deepseek-official']?.['deepseek-v4-pro'] ?? {})
      .reduce((n, usage) => n + usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output, 0)
    assert.equal(cost, expected)
    assert.deepEqual(timeline.cost?.['deepseek-official']?.['deepseek-v4-pro'].peak, expectedBuckets)
    const activityDef = createContextActivityDefinition()
    const activity = log.reduce((st, ev) => applyActivity(st, ev), activityDef.init())
    assert.equal(Object.values(activity.days).reduce((n, day) => n + day.tokens, 0), expected)
    assert.deepEqual(Object.values(activity.days)[0].cost, timeline.cost)
    // Checkpoint parsing must preserve the replacement slot across a restart.
    const def = timelineDef()
    const restored = log.reduce((st, ev) => def.stateSchema.parse(JSON.parse(JSON.stringify(def.apply(st, ev)))) as TimelineState, def.init())
    const restoredCost = Object.values(restored.cost?.['deepseek-official']?.['deepseek-v4-pro'] ?? {})
      .reduce((n, usage) => n + usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output, 0)
    assert.equal(restoredCost, expected)
    assert.deepEqual(restored.cost?.['deepseek-official']?.['deepseek-v4-pro'].peak, expectedBuckets)
    const restoredActivity = log.reduce((st, ev) => activityDef.stateSchema.parse(JSON.parse(JSON.stringify(applyActivity(st, ev)))), activityDef.init())
    assert.equal(Object.values(restoredActivity.days).reduce((n, day) => n + day.tokens, 0), expected)
    assert.deepEqual(Object.values(restoredActivity.days)[0].cost, restored.cost)
  }
}
