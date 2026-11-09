import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { currentSessionOf, projectOf, UNGROUPED_KEY } from '../../src/client/overviewModel'
import { dayRangeWindow, orderedDayRange, rangeWindowOf } from '../../src/client/overviewQuery'

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

const CURRENT_SESSION_KEY = 'dsh.sessions.current'

function pin(id: string | null): void {
  if (id === null) localStorage.removeItem(CURRENT_SESSION_KEY)
  else localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify({ sessionId: id }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('overview current-session seat', () => {
  test('the persisted ui-workspace selection anchors the id and the sessions seat supplies its cwd', () => {
    const selectOf = (snapshot: unknown) => ({ useSessions: (select: (value: unknown) => unknown) => select(snapshot) })
    pin('a')
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: { cwd: '/repo/a' } } })), { id: 'a', cwd: '/repo/a' })
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: {} } })), { id: 'a' })
    assert.deepEqual(currentSessionOf(selectOf({ byId: {} })), { id: 'a' })
    pin('b')
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: { cwd: '/repo/a' } } })), { id: 'b' })
    assert.deepEqual(currentSessionOf(selectOf(null)), { id: 'b' })
    assert.deepEqual(currentSessionOf({}), { id: 'b' })
    assert.deepEqual(currentSessionOf({ useSessions: 7 }), { id: 'b' })
    assert.deepEqual(currentSessionOf({ useSessions: () => { throw new Error('seat down') } }), { id: 'b' })
  })

  test('a missing, malformed or inaccessible selection degrades to no current session', () => {
    pin(null)
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, 'not json')
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, '{"sessionId":7}')
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, '{"sessionId":""}')
    assert.equal(currentSessionOf({}), null)
    vi.stubGlobal('localStorage', undefined)
    assert.equal(currentSessionOf({}), null)
  })

  test('equivalent snapshots produce the same selector key, so unrelated session updates cannot repaint', () => {
    pin('a')
    const keyOf = (snapshot: unknown): unknown => {
      let key: unknown
      const read = (select: (value: unknown) => unknown): unknown => { key = select(snapshot); return key }
      currentSessionOf({ useSessions: read })
      return key
    }
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' } }, ids: ['a'] }), 'a\u0000/repo/a')
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' } }, ids: ['a', 'b'] }), 'a\u0000/repo/a')
    pin('b')
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' }, b: { cwd: '/repo/b' } }, ids: ['a', 'b'] }), 'b\u0000/repo/b')
  })

  test('projectOf folds a workspace path to its title and treats the bare root as unnamed', () => {
    assert.equal(projectOf(undefined), undefined)
    assert.equal(projectOf(''), undefined)
    assert.equal(projectOf('/'), undefined)
    assert.equal(projectOf('/Users/bw/dev/dsh-context'), 'dsh-context')
    assert.equal(UNGROUPED_KEY, '__ungrouped__')
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
