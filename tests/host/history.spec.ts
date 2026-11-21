import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { HISTORY_ROUTE, watchHistoryChannel } from '../../src/host/history'
import { historyBounds, resolveBounds } from '../../src/host/config'
import { OPEN_GATE, SKIP_GATE, connectionOf, fakeCtx, observationOf, postJson } from './helpers/ctx'
import { assistantMessage, compaction, header, planMode, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'
import { buildTimelineDetail } from '../../src/host/foldWire'
import type { TimelineEvent } from '../../src/host/fold'
import type { ContextEventRecord, HistoryPage, RequestRecord } from '../../src/shared/types'

const BOUNDS = resolveBounds({})
const LIMITS = historyBounds(BOUNDS)

function log(): TimelineEvent[] {
  const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
  let seq = 2
  for (let i = 0; i < 1_600; i++) {
    events.push(userMessage(seq++, [{ type: 'text', text: 'q' + String(i) }], { kind: 'user' }))
    events.push(assistantMessage(seq++, { turn: 1 + Math.floor(i / 2), step: i % 2, usage: { inputTokens: 10, outputTokens: 5 } }))
    if (i % 2 === 0) events.push(compaction(seq++, 'summary', { shadowedTokenCount: 1, shadowedSeqs: [] }))
  }
  events.push(planMode(seq++, { active: true }))
  return events
}

const STATE = driveTimeline(log(), LIMITS).state

function liveCtx(detailState = STATE) {
  const fake = fakeCtx({
    connection: connectionOf(),
    sessions: { get: () => ({}) },
  })
  watchHistoryChannel(fake.ctx, BOUNDS, { detailState: async () => detailState })
  return fake
}

async function page(fake: ReturnType<typeof liveCtx>, body: Record<string, unknown>): Promise<HistoryPage> {
  const response = await postJson(fake.captured, HISTORY_ROUTE, { sessionId: 's', ...body })
  assert.equal(response.ok, true)
  return response.value as HistoryPage
}

function walk(rows: readonly { seq: number }[], first: HistoryPage): void {
  assert.equal(first.total, STATE.requests.length)
  assert.equal(first.atEnd, true)
  assert.deepEqual(first.rows, rows.slice(rows.length - first.rows.length))
}

describe('history route', () => {
  test('history bounds remove every session collection cap', () => {
    const full = historyBounds(BOUNDS)
    for (const key of ['maxRequestSteps', 'maxKeptTurns', 'maxEvents', 'maxNodes', 'maxArchiveNodes', 'maxFileOps', 'maxSpans'] as const) {
      assert.equal(full[key], Number.MAX_SAFE_INTEGER)
    }
  })

  test('mounts only with a connection', () => {
    const bare = fakeCtx({})
    watchHistoryChannel(bare.ctx, BOUNDS)
    assert.equal(bare.captured.path, undefined)
    const fake = liveCtx()
    assert.equal(fake.captured.path, '/api/dsh-context/history')
  })

  test('rejects malformed requests', async () => {
    const fake = liveCtx()
    for (const body of [{}, { sessionId: '', part: 'requests' }, { sessionId: 's', part: 'nope' }]) {
      const response = await postJson(fake.captured, HISTORY_ROUTE, body)
      assert.equal(response.ok, false)
    }
    const request = await fake.captured.fetch!(new Request('http://x', { method: 'POST', body: '{' }))
    assert.equal((await request.json() as { ok: boolean }).ok, false)
  })

  test('pages requests from the full pre-cap history without loss', async () => {
    assert.ok((STATE.turnRuns ?? 0) > 300)
    const fake = liveCtx()
    const first = await page(fake, { part: 'requests' })
    walk(STATE.requests, first)
    const all: RequestRecord[] = [...first.rows as RequestRecord[]]
    let cursor = first.beforeSeq
    let guard = 0
    while (cursor !== undefined) {
      const next = await page(fake, { part: 'requests', beforeSeq: cursor, limit: 400 })
      all.unshift(...next.rows as RequestRecord[])
      cursor = next.beforeSeq
      assert.ok(guard++ < 10)
    }
    assert.deepEqual(all, STATE.requests)
  })

  test('pages every retained event, including events past the legacy cap', async () => {
    const fake = liveCtx()
    const first = await page(fake, { part: 'events', limit: 1_000 })
    assert.equal(first.total, STATE.events.length)
    assert.ok(first.total > 400)
    assert.equal((first.rows.at(-1) as ContextEventRecord).kind, 'mode')
  })

  test('keeps a same-seq event run together at a page boundary', async () => {
    const state = {
      ...driveTimeline([]).state,
      events: [
        { seq: 4, time: 4, kind: 'inject', form: 'context' },
        { seq: 5, time: 5, kind: 'todo-add', count: 1 },
        { seq: 5, time: 5, kind: 'todo-done', count: 1, items: ['a'] },
      ] as ContextEventRecord[],
    }
    const fake = liveCtx(state)
    const first = await page(fake, { part: 'events', limit: 1 })
    assert.deepEqual((first.rows as ContextEventRecord[]).map(row => row.kind), ['todo-add', 'todo-done'])
    assert.deepEqual((first.rows as ContextEventRecord[]).map(row => row.ord), [1, 2])
    const second = await page(fake, { part: 'events', limit: 1, beforeSeq: first.beforeSeq })
    assert.deepEqual((second.rows as ContextEventRecord[]).map(row => row.seq), [4])
    assert.equal(second.beforeSeq, undefined)
  })

  test('pages nodes, archive, files, commands and spans through index cursors', async () => {
    const base = driveTimeline([]).state
    const state = {
      ...base,
      surface: [
        { seq: 1, cat: 'user', tokens: 1 },
        { seq: 2, cat: 'assistant', tokens: 2 },
        { seq: 3, cat: 'tool', tokens: 3 },
      ],
      archived: [
        { seq: 4, cat: 'user', tokens: 4, gone: 8 },
        { seq: 5, cat: 'tool', tokens: 5, gone: 9 },
      ],
      fileOps: [
        { seq: 6, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 },
        { seq: 6, path: 'b.ts', kind: 'write', tool: 'write', err: false, added: 1, removed: 0 },
      ],
      spans: [
        { kind: 'ttft', start: 10, end: 20 },
        { kind: 'other', start: 20, end: 30 },
      ],
    } as never
    const fake = liveCtx(state)
    const expected = { nodes: 3, archive: 2, files: 2, spans: 2 }
    for (const [part, total] of Object.entries(expected)) {
      const all: unknown[] = []
      let cursor: number | undefined
      let seq = false
      for (let guard = 0; guard < 10; guard++) {
        const current = await page(fake, {
          part,
          limit: 1,
          ...(cursor === undefined ? {} : seq ? { beforeSeq: cursor } : { beforeIndex: cursor }),
        })
        assert.equal(current.total, total)
        all.unshift(...current.rows)
        seq = current.beforeSeq !== undefined
        cursor = current.beforeSeq ?? current.beforeIndex
        if (cursor === undefined) break
      }
      assert.equal(all.length, total, part)
    }
    const rejected = await postJson(fake.captured, HISTORY_ROUTE, { sessionId: 's', part: 'commands' })
    assert.equal(rejected.ok, false)
  })

  test('milestones exclude non-milestone events and page independently', async () => {
    const fake = liveCtx()
    const first = await page(fake, { part: 'milestones', limit: 1_000 })
    const rows = first.rows as ContextEventRecord[]
    assert.equal(first.total, STATE.events.filter(event => event.kind !== 'mode').length)
    assert.ok(rows.every(row => row.kind !== 'mode'))
    assert.ok(rows.every(row => row.kind === 'compaction'))
  })

  test('clamps limits and handles empty pages', async () => {
    const fake = liveCtx()
    const zero = await page(fake, { part: 'requests', limit: 0 })
    assert.equal(zero.rows.length, 1)
    const huge = await page(fake, { part: 'requests', limit: 999_999 })
    assert.equal(huge.rows.length, 1_000)
    const none = await page(fake, { part: 'requests', beforeSeq: 0 })
    assert.equal(none.rows.length, 0)
    assert.equal(none.atStart, true)
  })

  test('cold sessions serve the full history', async () => {
    const events = log()
    let calls = 0
    const observation = observationOf(events as never[], { revision: 'rev-1' })
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => { calls++; return Promise.resolve(observation) } },
      sessionPersistence: { id: 'persistence' },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const first = await page(fake, { part: 'requests' })
    assert.equal(first.total, 1_600)
    assert.equal(first.live, false)
    const eventsPage = await page(fake, { part: 'events' })
    assert.equal(eventsPage.total, STATE.events.length)
    assert.equal(calls, 1)
  })

  test('cold sessions without a revision use the log cursor', async () => {
    const observation = observationOf(log() as never[])
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => Promise.resolve(observation) },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const first = await page(fake, { part: 'requests' })
    assert.equal(first.total, 1_600)
  })

  test('legacy detail still clamps a full-history state to its wire caps', () => {
    const detail = buildTimelineDetail(STATE, BOUNDS)
    assert.equal(detail.requests.length, 1_500)
    assert.equal(detail.events.length, 400)
  })

  test('a failed live shadow falls back and a throwing session lookup is contained', async () => {
    const noShadow = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => ({}) },
    })
    watchHistoryChannel(noShadow.ctx, BOUNDS)
    const noValue = await postJson(noShadow.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(noValue.value, null)

    const fallback = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => ({}) },
    })
    watchHistoryChannel(fallback.ctx, BOUNDS, { detailState: async () => { throw new Error('seed failed') } })
    const response = await postJson(fallback.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(response.value, null)

    const thrown = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => { throw new Error('lookup failed') } },
    })
    watchHistoryChannel(thrown.ctx, BOUNDS)
    const failed = await postJson(thrown.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(failed.ok, false)
  })

  test('cold history skips unreadable observations and optional gates', async () => {
    const unreadable = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => Promise.resolve({ events: 'bad' }) },
    })
    watchHistoryChannel(unreadable.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const missing = await postJson(unreadable.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(missing.value, null)

    const skipped = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => Promise.resolve(observationOf([] as never[])) },
    })
    watchHistoryChannel(skipped.ctx, BOUNDS, { coldReads: SKIP_GATE })
    const value = await postJson(skipped.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(value.value, null)
  })

  test('ignores malformed cursors and limits', async () => {
    const fake = liveCtx()
    const badCursor = await page(fake, { part: 'requests', beforeSeq: 'x', limit: 'x' })
    assert.equal(badCursor.total, STATE.requests.length)
    const badLimit = await page(fake, { part: 'requests', limit: -4 })
    assert.equal(badLimit.rows.length, 1)
  })

  test('serves an empty state and rejects a null body', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => ({}) },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { detailState: async () => driveTimeline([]).state })
    const empty = await page(fake, { part: 'requests' })
    assert.equal(empty.total, 0)
    assert.equal(empty.last, -1)
    const nullBody = await postJson(fake.captured, HISTORY_ROUTE, null)
    assert.equal(nullBody.ok, false)
  })

  test('uses the empty and non-numeric cold cursor fallbacks', async () => {
    for (const events of [[], [{ seq: 'x' }]]) {
      const fake = fakeCtx({
        connection: connectionOf(),
        sessionQuery: { observeSession: () => Promise.resolve(observationOf(events as never[])) },
      })
      watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
      const value = await page(fake, { part: 'events' })
      assert.equal(value.total, 0)
    }
  })

  test('contains a non-Error session lookup failure', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => { throw 'boom' } },
    })
    watchHistoryChannel(fake.ctx, BOUNDS)
    const failed = await postJson(fake.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(failed.ok, false)
  })

  test('reads cold logs through persistence without the session-query cache', async () => {
    let closed = 0
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionPersistence: {
        identity: 'persistence',
        open: async () => ({
          read: async () => ({ events: log() }),
          close: async () => { closed++ },
        }),
      },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const first = await page(fake, { part: 'requests' })
    assert.equal(first.total, 1_600)
    assert.equal(closed, 1)
  })

  test('reuses a cold fold while the persistence revision is unchanged', async () => {
    let opens = 0
    let stats = 0
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionPersistence: {
        identity: 'persistence',
        stat: async () => { stats++; return { revision: 'rev-1' } },
        open: async () => {
          opens++
          return { read: async () => ({ events: log() }), close: async () => {} }
        },
      },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const first = await page(fake, { part: 'requests' })
    const second = await page(fake, { part: 'requests', beforeSeq: first.beforeSeq })
    assert.equal(first.total, 1_600)
    assert.equal(second.total, 1_600)
    assert.equal(opens, 1)
    assert.equal(stats, 2)
  })

  test('refolds when the persistence revision changes', async () => {
    let opens = 0
    let revision = 'rev-1'
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionPersistence: {
        identity: 'persistence',
        stat: async () => ({ revision }),
        open: async () => {
          opens++
          return { read: async () => ({ events: log() }), close: async () => {} }
        },
      },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    await page(fake, { part: 'requests' })
    revision = 'rev-2'
    const changed = await page(fake, { part: 'requests' })
    assert.equal(changed.total, 1_600)
    assert.equal(opens, 2)
  })

  test('ignores an unusable stat revision', async () => {
    for (const revision of ['', 7, undefined]) {
      let opens = 0
      const fake = fakeCtx({
        connection: connectionOf(),
        sessionPersistence: {
          identity: 'persistence',
          stat: async () => ({ revision }),
          open: async () => {
            opens++
            return { read: async () => ({ events: log() }), close: async () => {} }
          },
        },
      })
      watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
      const first = await page(fake, { part: 'requests' })
      const second = await page(fake, { part: 'requests' })
      assert.equal(first.total, 1_600)
      assert.equal(second.total, 1_600)
      assert.equal(opens, 1)
    }
  })

  test('falls back to freshness when the stat call fails', async () => {
    let opens = 0
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionPersistence: {
        identity: 'persistence',
        stat: async () => { throw new Error('stat failed') },
        open: async () => {
          opens++
          return { read: async () => ({ events: log() }), close: async () => {} }
        },
      },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    await page(fake, { part: 'requests' })
    await page(fake, { part: 'requests' })
    assert.equal(opens, 1)
  })

  test('a non-array durable read falls back and fails without an observer', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionPersistence: {
        identity: 'persistence',
        open: async () => ({
          read: async () => ({ events: 'bad' }),
          close: async () => {},
        }),
      },
    })
    watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const value = await postJson(fake.captured, HISTORY_ROUTE, { sessionId: 's', part: 'requests' })
    assert.equal(value.value, null)
  })

  test('a stale cold cache revalidates and reuses the same revision', async () => {
    let calls = 0
    let now = 1_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const observation = observationOf(log() as never[], { revision: 'rev-1' })
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => { calls++; return Promise.resolve(observation) } },
      sessionPersistence: { id: 'persistence' },
    })
    try {
      watchHistoryChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
      await page(fake, { part: 'requests' })
      now += 10_000
      const second = await page(fake, { part: 'requests' })
      assert.equal(second.total, 1_600)
      assert.equal(calls, 2)
    } finally {
      spy.mockRestore()
    }
  })
})
