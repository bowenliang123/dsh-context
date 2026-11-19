import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { watchActivityBackfill } from '../../src/host/backfill'
import { arm, assertIssueDetail, captureLogs, FAST_PACING, fakeState, trigger, until } from './helpers/backfill'

describe('watchActivityBackfill fold failures', () => {
  test('a fold failure carries its bounded reason and clears on a later pass', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'good', cwd: '/repo/good' } },
      { header: { id: 'bad', cwd: '/repo/bad' } },
    ])
    state.failReads.set('bad', new Error('projection cache row rejected'))
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    const failed = await until(
      () => (!handle.coverage().running && handle.coverage().failed === 1 ? handle.coverage() : undefined),
      'the failing pass settled',
    )
    assert.deepEqual(failed, {
      complete: false,
      remaining: 0,
      failed: 1,
      running: false,
      total: 2,
      covered: 1,
      unsupported: 0,
      unreadable: 0,
      failedSessions: [{ id: 'bad', reason: 'Error: projection cache row rejected' }],
    })
    assert.ok(lines.some(line => line.level === 'warn' && line.text.includes('projection backfill skipped "bad"')))
    state.failReads.delete('bad')
    await trigger(route)
    const healed = await until(
      () => (handle.coverage().complete && !handle.coverage().running ? handle.coverage() : undefined),
      'the retried pass healed the session',
    )
    assert.deepEqual(healed, {
      complete: true, remaining: 0, failed: 0, running: false, total: 2, covered: 2, unsupported: 0, unreadable: 0,
    })
    handle()
  })

  test('fold-failure detail is bounded and reasons are truncated', async () => {
    const ctx = new Context()
    const ids = Array.from({ length: 17 }, (_, index) => `bad${index}`)
    const state = fakeState(ids.map(id => ({ header: { id, cwd: `/repo/${id}` } })))
    for (const id of ids) state.failReads.set(id, new Error('x'.repeat(400)))
    const route = arm(ctx, state)
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    const coverage = await until(
      () => (!handle.coverage().running && handle.coverage().failed === 17 ? handle.coverage() : undefined),
      'the failing pass settled',
    )
    assert.equal(coverage.covered, 0)
    assert.equal(coverage.failed, 17)
    assertIssueDetail(coverage.failedSessions, 'bad0')
    handle()
  })
})
