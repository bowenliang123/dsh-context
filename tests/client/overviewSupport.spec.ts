import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { projectOf, refreshSessions, sessionsSnapshotOf, UNGROUPED_KEY } from '../../src/client/overviewModel'
import { dayRangeWindow, orderedDayRange, rangeWindowOf } from '../../src/client/overviewQuery'
import { TestClientCtx, asClientCtx } from './helpers/harness'

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

describe('overview snapshot seats', () => {
  test('the sessions seat passes its selector through and a throwing seat degrades to null', () => {
    assert.deepEqual(sessionsSnapshotOf({ useSessions: (select: (snapshot: unknown) => unknown) => select({ ids: ['a'] }) }), { ids: ['a'] })
    assert.equal(sessionsSnapshotOf({}), null)
    assert.equal(sessionsSnapshotOf({ useSessions: 7 }), null)
    assert.equal(sessionsSnapshotOf({ useSessions: () => { throw new Error('seat down') } }), null)
  })

  test('projectOf folds a workspace path to its title and treats the bare root as unnamed', () => {
    assert.equal(projectOf(undefined), undefined)
    assert.equal(projectOf(''), undefined)
    assert.equal(projectOf('/'), undefined)
    assert.equal(projectOf('/Users/bw/dev/dsh-context'), 'dsh-context')
    assert.equal(UNGROUPED_KEY, '__ungrouped__')
  })
})

describe('refreshSessions seam', () => {
  test('an absent, non-refreshing or throwing sessions face never escapes', async () => {
    const absent = new TestClientCtx()
    assert.doesNotThrow(() => { refreshSessions(asClientCtx(absent)) })
    const plain = new TestClientCtx({ services: { sessions: {} } })
    assert.doesNotThrow(() => { refreshSessions(asClientCtx(plain)) })
    let refreshed = 0
    const good = new TestClientCtx({ services: { sessions: { refresh: () => { refreshed += 1; return Promise.resolve() } } } })
    refreshSessions(asClientCtx(good))
    await Promise.resolve()
    assert.equal(refreshed, 1)
    const rejecting = new TestClientCtx({ services: { sessions: { refresh: () => Promise.reject(new Error('down')) } } })
    assert.doesNotThrow(() => { refreshSessions(asClientCtx(rejecting)) })
    await Promise.resolve()
    const throwing = new TestClientCtx({ services: { sessions: { refresh: () => { throw new Error('sync down') } } } })
    assert.doesNotThrow(() => { refreshSessions(asClientCtx(throwing)) })
  })
})

describe('overview range windows', () => {
  test('range windows start at midnight, the period floor or never', () => {
    assert.deepEqual(rangeWindowOf('all', NOW), { start: null, end: null })
    assert.deepEqual(rangeWindowOf('today', NOW), { start: new Date(NOW).setHours(0, 0, 0, 0), end: null })
    assert.deepEqual(rangeWindowOf('7d', NOW), { start: NOW - 7 * 86_400_000, end: null })
    assert.deepEqual(rangeWindowOf('30d', NOW), { start: NOW - 30 * 86_400_000, end: null })
  })

  test('day ranges order both ends and reject unreadable keys', () => {
    assert.deepEqual(orderedDayRange('2026-09-16', '2026-09-10'), { from: '2026-09-10', to: '2026-09-16' })
    assert.deepEqual(orderedDayRange('2026-09-10', '2026-09-16'), { from: '2026-09-10', to: '2026-09-16' })
    assert.equal(dayRangeWindow({ from: 'junk', to: '2026-09-16' }), null)
    const window = dayRangeWindow({ from: '2026-09-10', to: '2026-09-16' })
    assert.ok(window !== null)
    assert.ok((window.start ?? 0) < (window.end ?? 0))
  })
})
