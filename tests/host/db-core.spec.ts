import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../../src/host/db/open'
import { createDb, metaInt, metaSnapshot, setMeta } from '../../src/host/db/db'
import { admissionRows, admitRows, clearTombstones, familyRootOf, statusCounts, workspaceMirror } from '../../src/host/db/admission'
import { foldSession } from '../../src/host/db/ingest'
import { applyFoldEvents, decodeStateJson, prepareFoldState, stateToJson, deleteSessionChildRows, markFoldStatus, writeSessionFold } from '../../src/host/db/foldSession'
import { RowsSink } from '../../src/host/db/rows'
import { createTimelineState } from '../../src/host/foldState'
import { resolveBounds } from '../../src/host/config'
import { meta, sessions, sessionTombstones } from '../../src/host/db/schema'
import { assistantMessage, compaction, endSeed, header, planMode, stepEnd, stepStart, systemMessage, toolCall, toolResult, userMessage } from './helpers/events'
import { fakeCtx } from './helpers/ctx'

const text = (value: string) => [{ type: 'text', text: value }]

const BOUNDS = resolveBounds({})

function makeCorpus() {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  const fake = fakeCtx({
    workspaceRegistry: {
      list: () => [{ title: 'workspace-one', sessionIds: ['root', 'child', 'fork'] }],
      archivedSessionIds: ['fork'],
    },
    sessionProjectionCache: {
      cachedSnapshot: (header: Record<string, unknown>) => ({
        values: {
          title: `title-${String(header.id)}`,
          sessionListMetadata: { blank: false, lastPromptAt: 500 },
        },
      }),
    },
    sessionProjections: {
      snapshot: () => ({ values: { title: 'live-title', sessionListMetadata: { blank: false, lastPromptAt: 700 } } }),
    },
    agents: { get: (id: string) => id === 'root' ? { status: 'running' } : undefined },
  }, { injectAll: true })
  const entries = [
    { id: 'root', header: { id: 'root', createdAt: 100, cwd: '/repo/root' }, live: false },
    { id: 'child', header: { id: 'child', createdAt: 200, cwd: '/repo/root', parentSession: 'root', origin: 'subagent', isSeeded: true, delegationDepth: 1 }, live: false },
    { id: 'fork', header: { id: 'fork', createdAt: 300, cwd: '/repo/fork', parentSession: 'root' }, live: false },
    { id: 'other', header: { id: 'other', createdAt: 400, cwd: '/repo/other' }, live: true, session: {} },
  ]
  admitRows(db, admissionRows(fake.ctx, entries))
  foldSession({ db, sessionId: 'root', title: 'title-root', cwd: '/repo/root', events: rootLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'child', title: 'title-child', cwd: '/repo/root', isSeeded: true, events: childLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'fork', title: 'title-fork', cwd: '/repo/fork', events: forkLog(), bounds: BOUNDS, incremental: false })
  foldSession({ db, sessionId: 'other', title: 'title-other', cwd: '/repo/other', events: otherLog(), bounds: BOUNDS, incremental: false })
  return { opened, db, fake }
}

function rootLog() {
  return [
    header(0, { tools: [{ name: 'bash', description: 'run' }, { name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek', reason: 'initial' }),
    systemMessage(1),
    userMessage(2, text('hello root')),
    stepStart(3, { time: 1003 }),
    assistantMessage(4, { turn: 1, step: 1, time: 2000, usage: { inputTokens: 10, outputTokens: 5 }, stream: [{ type: 'chunk', time: 1500, chunk: { type: 'text-delta', text: 'x' } }] }),
    toolCall(5, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }), turn: 1, step: 1 }),
    toolResult(6, { callId: 'c1', content: text('ok'), meta: { cwd: '/repo' } }),
    stepEnd(7, { time: 4000 }),
    planMode(8, { active: true }),
    compaction(9, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [2] }),
    header(10, { tools: [{ name: 'bash' }], model: 'deepseek-v4-pro', provider: 'deepseek', reason: 'change' }),
    userMessage(11, text('second turn')),
    stepStart(12, { time: 12000 }),
    assistantMessage(13, { turn: 2, step: 1, time: 13000, usage: { inputTokens: 3, outputTokens: 2 } }),
    stepEnd(14, { time: 14000 }),
  ]
}

function childLog() {
  return [
    header(0, { tools: [{ name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('inherited prompt')),
    assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } }),
    endSeed(3, { inherited: true }),
    userMessage(4, text('child prompt')),
    stepStart(5, { time: 5000 }),
    assistantMessage(6, { turn: 2, step: 1, usage: { inputTokens: 7, outputTokens: 3 } }),
    stepEnd(7, { time: 6000 }),
  ]
}

function forkLog() {
  return [
    header(0, { tools: [{ name: 'read' }], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('fork prompt')),
    stepStart(2, { time: 2000 }),
    assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 2 } }),
    stepEnd(4, { time: 3000 }),
  ]
}

function otherLog() {
  return [
    header(0, { tools: [], model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(1, text('other prompt')),
  ]
}

describe('db corpus', () => {
  test('admits roots, subagent families and ordinary forks', () => {
    const { opened, db } = makeCorpus()
    const roots = db.select().from(sessions).all()
    assert.equal(roots.length, 4)
    assert.equal(familyRootOf(db, 'child'), 'root')
    assert.equal(familyRootOf(db, 'fork'), 'fork')
    assert.equal(familyRootOf(db, 'ghost'), 'ghost')
    assert.equal(statusCounts(db).covered, 4)
    assert.equal(roots.find(row => row.id === 'root')?.running, 1)
    assert.equal(roots.find(row => row.id === 'child')?.familyRoot, 'root')
    assert.equal(roots.find(row => row.id === 'fork')?.archived, 1)
    assert.equal(roots.find(row => row.id === 'root')?.title, 'title-root')
    opened.client.close()
  })

  test('serializes and restores a continuation state', () => {
    const state = createTimelineState()
    state.model = 'm'
    state.billedTokens = 7
    state.nextSpanSeq = 3
    const json = stateToJson(state)
    const restored = decodeStateJson(json)
    assert.equal(restored?.model, 'm')
    assert.equal(restored?.billedTokens, 7)
    assert.equal(restored?.nextSpanSeq, 3)
    assert.equal(decodeStateJson('not json'), null)
    assert.equal(decodeStateJson(JSON.stringify({ surface: 'bad' })), null)
    assert.equal(decodeStateJson('bad'), null)
  })

  test('workspace mirror survives hostile registries', () => {
    for (const registry of [
      undefined,
      {},
      { list: () => 'nope' },
      { list: () => [{ title: 'w', sessionIds: 'nope' }] },
      { list: () => { throw new Error('boom') } },
      { list: () => [], archivedSessionIds: 'nope' },
      { list: () => [], get archivedSessionIds() { throw new Error('boom') } },
    ]) {
      const fake = fakeCtx(registry === undefined ? {} : { workspaceRegistry: registry }, { injectAll: true })
      const mirror = workspaceMirror(fake.ctx)
      assert.equal(mirror.archived.size, 0)
      assert.equal(mirror.groups.size, 0)
    }
  })
})

describe('db lifecycle helpers', () => {
  test('deleteSessionChildRows, tombstones and fold status transitions', () => {
    const { opened, db } = makeCorpus()
    deleteSessionChildRows(db, 'root')
    assert.equal(db.select().from(sessions).where(eq(sessions.id, 'root')).get()?.foldStatus, 'pending')
    markFoldStatus(db, 'root', 'failed', 'x'.repeat(300))
    assert.equal(db.select().from(sessions).where(eq(sessions.id, 'root')).get()?.foldError?.length, 200)
    markFoldStatus(db, 'root', 'pending')
    db.insert(sessionTombstones).values({ id: 'root', deletedAt: 1, reason: 'missing-from-list' }).run()
    clearTombstones(db, ['root'])
    assert.equal(db.select().from(sessionTombstones).all().length, 0)
    writeSessionFold(db, { sessionId: 'root', title: 't', cwd: '/w' }, createTimelineState(), 5, 'ok')
    assert.equal(metaSnapshot(db).cleanShutdown, false)
    setMeta(db, 'data_generation', 'not-a-number')
    assert.equal(metaSnapshot(db).generation, 0)
    opened.client.close()
  })
})

describe('meta helpers', () => {
  test('falls back for absent and malformed meta values and exposes optional versions', () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    db.delete(sessions).run()
    setMeta(db, 'db_epoch', 'e')
    assert.equal(metaSnapshot(db).epoch, 'e')
    setMeta(db, 'harness_version', 'h')
    setMeta(db, 'plugin_version', 'p')
    assert.equal(metaSnapshot(db).harnessVersion, 'h')
    assert.equal(metaSnapshot(db).pluginVersion, 'p')
    setMeta(db, 'data_generation', 'NaN')
    assert.equal(metaSnapshot(db).generation, 0)
    db.delete(meta).where(eq(meta.key, 'db_epoch')).run()
    assert.equal(metaSnapshot(db).epoch, '0')
    assert.equal(metaInt(db, 'nope', 5), 5)
    opened.client.close()
  })
})

describe('admission branches', () => {
  test('covers mirror, projection, header and family fallbacks', () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      workspaceRegistry: {
        list: () => [
          { sessionIds: ['x'] },
          { title: 'w', sessionIds: [7, '', 'dup', 'dup'] },
        ],
        archivedSessionIds: [7, '', 'dup'],
      },
      sessionProjectionCache: { cachedSnapshot: (header: Record<string, unknown>) => header.id === 'd' ? null : ({ values: { sessionListMetadata: { blank: true } } }) },
      sessionProjections: { snapshot: () => null },
      agents: { get: () => { throw new Error('boom') } },
    }, { injectAll: true })
    const rows = admissionRows(fake.ctx, [
      { id: 'a', header: { id: 'a', createdAt: 'bad', cwd: '/repo/a', agentPreset: 'preset' }, live: false },
      { id: 'b', header: { id: 'b', createdAt: 1, parentSession: 'missing', origin: 'subagent' }, live: false },
      { id: 'c', header: { id: 'c', createdAt: 1 }, live: true, session: {} },
      { id: 'd', header: { id: 'd', createdAt: 1 }, live: false },
      { id: 'e', header: { id: 'e', createdAt: 1, cwd: '/' }, live: false },
    ])
    assert.equal(rows[0]?.createdAt, 0)
    assert.equal(rows[0]?.agentPreset, 'preset')
    assert.equal(rows[0]?.title, 'a')
    assert.equal(rows[1]?.familyRoot, 'b')
    assert.equal(rows[2]?.title, 'c')
    assert.equal(rows[4]?.title, 'e')
    admitRows(db, rows)
    assert.equal(familyRootOf(db, 'b'), 'b')
    db.insert(sessions).values({ id: 'x', createdAt: 1, familyRoot: 'y', updatedAt: 1, foldStatus: 'pending', parentSession: 'y', origin: 'subagent' }).run()
    db.insert(sessions).values({ id: 'y', createdAt: 1, familyRoot: 'x', updatedAt: 1, foldStatus: 'pending', parentSession: 'x', origin: 'subagent' }).run()
    assert.equal(familyRootOf(db, 'x'), 'x')
    for (const status of ['failed', 'unsupported', 'folding', 'deleting', 'pending'] as const) {
      db.update(sessions).set({ foldStatus: status }).where(eq(sessions.id, 'a')).run()
      assert.equal(statusCounts(db).total >= 1, true)
    }
    opened.client.close()
  })
})

describe('admission without projections', () => {
  test('a live entry with no snapshot face still admits from the header', () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({ sessionProjections: {} }, { injectAll: true })
    const rows = admissionRows(fake.ctx, [{ id: 'live', header: { id: 'live', createdAt: 1, cwd: '/w' }, live: true, session: {} }])
    admitRows(db, rows)
    assert.equal(db.select().from(sessions).all().length, 1)
    opened.client.close()
  })
})

describe('fold state edges', () => {
  test('decodes every malformed state shape and defaults the optional progress keys', () => {
    assert.equal(decodeStateJson(null), null)
    assert.equal(decodeStateJson(undefined), null)
    assert.equal(decodeStateJson(''), null)
    assert.equal(decodeStateJson('null'), null)
    assert.equal(decodeStateJson('1'), null)
    assert.equal(decodeStateJson(JSON.stringify({ surface: [], sums: {}, requests: [], events: [], commands: [] })), null)
    assert.equal(decodeStateJson(JSON.stringify({ surface: [], sums: {}, requests: 'x', events: [], commands: [] })), null)
    assert.equal(decodeStateJson(JSON.stringify({ surface: [], sums: {}, requests: [], events: [], commands: [], callNames: null })), null)
    const decoded = decodeStateJson(JSON.stringify({ surface: [], sums: {}, requests: [], events: [], commands: [], callNames: {} }))
    assert.equal(decoded?.billedTokens, 0)
    assert.equal(decoded?.nextSpanSeq, 0)
    assert.equal(prepareFoldState(undefined, undefined).sums.user, 0)
    assert.equal(prepareFoldState(undefined, true).isSeeded, true)
    const state = createTimelineState()
    delete (state as { billedTokens?: number }).billedTokens
    assert.equal(prepareFoldState(state, false).billedTokens, undefined)
    const { opened, db } = makeCorpus()
    writeSessionFold(db, { sessionId: 'root', title: 't' }, state, 1, 'ok')
    opened.client.close()
  })

  test('flushes a full sink chunk and ignores a non-numeric event seq', () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    db.insert(sessions).values({ id: 'root', createdAt: 1, familyRoot: 'root', updatedAt: 1, foldStatus: 'ok', title: 'root' }).run()
    const sink = new RowsSink('root')
    for (let seq = 0; seq < 2_005; seq++) sink.surface({ seq: 100_000 + seq, cat: 'user', tokens: 1 })
    const result = applyFoldEvents(db, 'root', createTimelineState(), [{ type: 'todo/write', seq: 'x', time: 1, data: {} } as never], BOUNDS, sink, () => {})
    assert.equal(result.rows, 2_005)
    assert.equal(result.lastSeq, -1)
    opened.client.close()
  })

  test('a fold write against a missing session rolls back the fold state', () => {
    const { opened, db } = makeCorpus()
    db.delete(sessions).where(eq(sessions.id, 'root')).run()
    assert.throws(() => writeSessionFold(db, { sessionId: 'root', title: 't' }, createTimelineState(), 1, 'ok'))
    opened.client.close()
  })
})
