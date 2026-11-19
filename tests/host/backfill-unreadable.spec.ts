import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { watchActivityBackfill } from '../../src/host/backfill'
import { arm, assertIssueDetail, captureLogs, FAST_PACING, fakeState, trigger, until } from './helpers/backfill'

describe('watchActivityBackfill host-refused logs', () => {
  test('a host-refused log reports unreadable instead of a fold failure and is retried on the next pass', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'good', cwd: '/repo/good' } },
      { header: { id: 'corrupt', cwd: '/repo/corrupt' } },
    ])
    let refuse = true
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async (id: string) => {
          if (id === 'corrupt' && refuse) {
            const error = new Error('stored log is corrupt: assistant/message repeats advertised tool call abc')
            error.name = 'SessionPersistenceCorruptionError'
            throw error
          }
          return {
            header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
            inheritedEventCount: 0,
            read: async () => ({ events: [] }),
            close: async () => {},
          }
        },
      },
    })
    const lines = captureLogs(ctx)
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    await until(() => (handle.coverage().complete ? true : undefined), 'the unreadable pass settled')
    assert.deepEqual(handle.coverage(), {
      complete: true,
      remaining: 0,
      failed: 0,
      running: false,
      total: 2,
      covered: 1,
      unsupported: 0,
      unreadable: 1,
      unreadableSessions: [{
        id: 'corrupt',
        reason: 'SessionPersistenceCorruptionError: stored log is corrupt: assistant/message repeats advertised tool call abc',
      }],
    })
    const warns = lines.filter(line => line.level === 'warn')
    assert.equal(warns.length, 1, 'one warn names the refused log')
    assert.match(warns[0].text, /cannot read "corrupt"/)
    assert.match(warns[0].text, /SessionPersistenceCorruptionError/)
    assert.ok(lines.some(line => line.level === 'info' && /left 1 session\(s\) unreadable/.test(line.text)))
    refuse = false
    await trigger(route)
    await until(
      () => (handle.coverage().unreadable === 0 && handle.coverage().covered === 2 ? true : undefined),
      'the next pass retried the log once the host could read it',
    )
    assert.deepEqual(handle.coverage(), {
      complete: true, remaining: 0, failed: 0, running: false, total: 2, covered: 2, unsupported: 0, unreadable: 0,
    })
    handle()
  })

  test('unreadable detail is bounded and reasons are truncated', async () => {
    const ctx = new Context()
    const ids = Array.from({ length: 17 }, (_, index) => `bad${index}`)
    const state = fakeState(ids.map(id => ({ header: { id, cwd: `/repo/${id}` } })))
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async () => {
          const error = new Error('x'.repeat(400))
          error.name = 'SessionPersistenceCorruptionError'
          throw error
        },
      },
    })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    await until(() => (handle.coverage().complete ? true : undefined), 'the unreadable pass settled')
    const coverage = handle.coverage()
    assert.equal(coverage.unreadable, 17)
    assertIssueDetail(coverage.unreadableSessions, 'bad0')
    assert.equal(coverage.failed, 0)
    assert.equal(coverage.remaining, 0)
    handle()
  })
})
