import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { openDatabase } from '../../src/host/db/open'
import { createDb } from '../../src/host/db/db'
import { eq } from 'drizzle-orm'
import {
  events, fileOps, headerEpochs, headerTools, requests, sessions, skillLoads, steps,
  surfaceNodes, systemPrompts, timingSpans, toolCalls,
} from '../../src/host/db/schema'
import {
  queryContext, queryDelta, queryEvents, queryFileOps, queryRequests, querySkillLoads,
  querySpans, querySteps, queryTimeline, queryToolCalls,
} from '../../src/host/db/queries/detail'
import { queryFamily } from '../../src/host/db/queries/family'
import type { CostSource } from '../../src/host/cost'

const COST: CostSource = {
  ready: () => true,
  usd: () => 1,
  read: () => ({ usd: 1, ready: true }),
  complete: () => true,
}

function dbWithRows() {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  for (const [id, extra] of [
    ['rich', { foldStatus: 'ok', familyRoot: 'rich', blank: 0 }],
    ['empty', { foldStatus: 'ok', familyRoot: 'empty', blank: 0 }],
    ['bare', { foldStatus: 'ok', familyRoot: 'bare', blank: 0 }],
  ] as const) {
    db.insert(sessions).values({
      id, createdAt: 1, updatedAt: 2, title: id, familyRoot: extra.familyRoot,
      foldStatus: extra.foldStatus, blank: extra.blank, seedCutSeq: id === 'rich' ? 5 : null,
      createdDay: '2026-01-01', model: 'm', provider: 'p', reasoningEffort: 'high',
      contextWindow: 100, maxOutputTokens: 10, curTotal: 1, lastUser: 'u', billedTokens: 2,
      lastSeq: 10, detailRev: 1, foldedAt: 1,
    }).run()
  }
  db.update(sessions).set({ model: null, provider: null, reasoningEffort: null, contextWindow: null, maxOutputTokens: null, lastUser: null, seedCutSeq: null, createdDay: null }).where(eq(sessions.id, 'empty')).run()
  db.update(sessions).set({ model: null, provider: null, foldStatus: 'failed', foldError: 'bad' }).where(eq(sessions.id, 'bare')).run()
  db.insert(surfaceNodes).values([
    {
      sessionId: 'rich', seq: 1, time: 1, cat: 'assistant', tokens: 2, reasoningTokens: 1,
      answerTokens: 1, callTokens: 1, imgs: 1, form: 'f', name: 'n', agent: 'a', tool: 't',
      skill: 's', isError: 1, calls: '["x"]', preview: 'text', previewTruncated: 1, goneSeq: 9,
    },
    { sessionId: 'rich', seq: 2, cat: 'user', tokens: 1 },
    { sessionId: 'rich', seq: 3, cat: 'inject', tokens: 1 },
    { sessionId: 'rich', seq: 4, cat: 'assistant', tokens: 1 },
    { sessionId: 'rich', seq: 8, cat: 'tool', tokens: 1, goneSeq: 30 },
    { sessionId: 'rich', seq: 9, cat: 'tool', tokens: 1, goneSeq: 20 },
    { sessionId: 'empty', seq: 1, cat: 'user', tokens: 0 },
  ]).run()
  db.insert(requests).values([
    {
      sessionId: 'rich', seq: 3, time: 3, day: '2026-01-01', turn: 1, step: 1, startsTurn: 1,
      isInherited: 1, systemTokens: 1, toolsTokens: 1, userTokens: 1, injectTokens: 1,
      skillTokens: 1, assistantTokens: 1, toolTokens: 1, totalTokens: 7, model: 'm', provider: 'p',
      period: 'peak', promptTokens: 1, inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1,
      outputTokens: 1, reasoningTokens: 1, genMs: 1, activeMs: 1,
    },
    { sessionId: 'empty', seq: 1, time: 1, day: '2026-01-01' },
    { sessionId: 'rich', seq: 19, time: 1, day: '2026-01-01' },
  ]).run()
  db.insert(steps).values([
    {
      sessionId: 'rich', seq: 4, turn: 1, step: 1, startTime: 1, endTime: 2, day: '2026-01-01',
      requestSeq: 3, wallMs: 1, activeMs: 1, waitMs: 1, idleMs: 1, toolBusyMs: 1, ttftMs: 1, beatsFull: 1,
    },
    { sessionId: 'empty', seq: 1, startTime: 1, day: '2026-01-01' },
  ]).run()
  db.insert(toolCalls).values([
    {
      sessionId: 'rich', seq: 5, callId: 'c1', resultSeq: 6, name: 'bash', plugin: 'p',
      transport: 1, codeMode: 1, parentSeq: 1, turn: 1, step: 1, day: '2026-01-01',
      startTime: 1, endTime: 2, durationMs: 1, isError: 1, status: 'failed', exitCode: 1,
      exitInferred: 1, signal: 'sig', timedOut: 1, stopped: 1, denied: 1, derived: 1,
      background: 1, timeoutMs: 1, sandbox: 's', cmd: 'ls', cmdTruncated: 1,
      cmdDescription: 'd', cmdCwd: '/w', program: 'ls', outChars: 1, outTruncated: 1, stderr: 1,
    },
    { sessionId: 'rich', seq: 7, callId: 'c2', name: 'read', day: '', startTime: 2 },
    { sessionId: 'rich', seq: 17, callId: 'c4', name: 'read', resultSeq: 18, day: '2026-01-01', startTime: 3 },
    { sessionId: 'empty', seq: 1, callId: 'c3', name: 'read', day: '2026-01-01', startTime: 1 },
  ]).run()
  db.insert(fileOps).values([
    { sessionId: 'rich', seq: 10, ordinal: 0, kind: 'read', tool: 'read', path: '/c', readStart: 1, readCount: 1, readEst: 0 },
    {
      sessionId: 'rich', seq: 8, ordinal: 0, time: 1, kind: 'read', tool: 'read', path: '/a',
      isError: 1, linesAdded: 1, linesRemoved: 1, detail: 'd', hits: 1, readStart: 1, readCount: 1,
      readEst: 1, parentSeq: 1, program: 'p', isPattern: 1,
    },
    { sessionId: 'rich', seq: 9, ordinal: 0, kind: 'search', tool: 'grep', path: '/b' },
  ]).run()
  db.insert(events).values([
    { sessionId: 'rich', seq: 2, time: 1, kind: 'inject' },
    { sessionId: 'rich', seq: 5, time: 1, kind: 'inject' },
    {
      sessionId: 'rich', seq: 10, time: 1, kind: 'model', sub: 's', form: 'f', name: 'n',
      agent: 'a', detail: 'd', tokens: 1, grossTokens: 1, nodeCount: 1, modelFrom: 'a', modelTo: 'b',
    },
    { sessionId: 'rich', seq: 11, time: 2, kind: 'inject' },
    { sessionId: 'rich', seq: 18, time: 2, kind: 'inject' },
    { sessionId: 'empty', seq: 2, time: 2, kind: 'inject' },
  ]).run()
  db.insert(systemPrompts).values([
    { sessionId: 'rich', seq: 12, time: 1, tokens: 1, goneSeq: 2 },
    { sessionId: 'rich', seq: 13, time: 2, tokens: 1 },
  ]).run()
  db.insert(headerEpochs).values([{ sessionId: 'rich', seq: 14, time: 1, reason: 'initial' }]).run()
  db.insert(headerTools).values([{ sessionId: 'rich', epochSeq: 14, ordinal: 0, name: 'bash', tokens: 1, plugin: 'p' }]).run()
  db.insert(skillLoads).values([{ sessionId: 'rich', seq: 15, time: 1, day: '2026-01-01', name: 'skill', source: 'invocation' }]).run()
  db.insert(timingSpans).values([
    { sessionId: 'rich', spanSeq: 0, seq: 4, startTime: 1, endTime: 2, kind: 'text' },
    { sessionId: 'rich', spanSeq: 1, seq: 4, startTime: 1, endTime: 2, kind: 'reasoning' },
    { sessionId: 'rich', spanSeq: 2, seq: 4, startTime: 1, endTime: 2, kind: 'toolarg' },
  ]).run()
  db.insert(skillLoads).values([{ sessionId: 'rich', seq: 16, time: 2, day: '2026-01-02', name: 'other', source: 'result' }]).run()
  return { opened, db }
}

describe('query mapping extremes', () => {
  test('maps rich and empty rows through every detail route', () => {
    const { opened, db } = dbWithRows()
    const context = queryContext(db, COST, 'rich')
    assert.ok('ok' in context && context.ok === true)
    assert.equal(context.model, 'm')
    assert.equal(context.systems?.length, 1)
    const timeline = queryTimeline(db, 'rich', null, { limit: 10, archiveLimit: 10 })
    assert.ok(!('ok' in timeline))
    assert.equal(timeline.nodes.length, 3)
    assert.equal(timeline.archive.length, 3)
    const pinned = queryTimeline(db, 'rich', null, { limit: 1, archiveLimit: 1 })
    assert.ok(!('ok' in pinned))
    assert.equal(pinned.nodes.length > 0, true)
    assert.equal(pinned.archive.length, 1)
    const past = queryTimeline(db, 'rich', 12, { limit: 10, archiveLimit: 10 })
    assert.ok(!('ok' in past))
    const approximate = queryTimeline(db, 'rich', 10, { limit: 10, archiveLimit: 1 })
    assert.ok(!('ok' in approximate) && approximate.approximate === true)
    assert.ok(!('ok' in past))
    const requests = queryRequests(db, { sessionId: 'rich', limit: 10 })
    assert.equal(requests[0]?.cacheRead, 1)
    assert.equal(requests[0]?.activeMs, 1)
    const steps = querySteps(db, 'rich', undefined, 10)
    assert.equal(steps[0]?.ttft_ms, 1)
    const tools = queryToolCalls(db, { sessionId: 'rich', limit: 10 }, () => 'p')
    assert.equal(tools.items.find(item => item.call_id === 'c1')?.cmd, 'ls')
    assert.equal(tools.items.find(item => item.call_id === 'c1')?.duration_ms, 1)
    const files = queryFileOps(db, 'rich', 'list', { limit: 10 })
    assert.ok('items' in files && files.items.find(item => item.path === '/a')?.read !== undefined)
    assert.ok('paths' in queryFileOps(db, 'rich', 'paths', {}))
    assert.equal(queryEvents(db, 'empty', {}).length, 1)
    assert.equal(querySkillLoads(db, { sessionId: 'rich', name: 'skill' }).length, 1)
    const events = queryEvents(db, 'rich', {})
    assert.equal(events.find(event => event.kind === 'model')?.from, 'a')
    assert.equal(querySpans(db, 'rich', {}).length, 3)
    assert.equal(querySkillLoads(db, { sessionId: 'rich' }).length, 2)
    assert.equal(querySkillLoads(db, { sessionId: 'rich', name: 'skill', day: '2026-01-01', after: 0 }).length, 1)
    assert.equal(queryFamily(db, COST, 'rich').members.length, 1)
    assert.ok(queryDelta(db, 'rich', 12, 1) !== null)
    const empty = queryContext(db, COST, 'empty')
    assert.ok('ok' in empty && empty.ok === true)
    assert.equal(empty.model, undefined)
    assert.equal(queryRequests(db, { sessionId: 'empty' }).length, 1)
    assert.equal(querySteps(db, 'empty', undefined, 10).length, 1)
    const bare = queryContext(db, COST, 'bare')
    assert.ok('ok' in bare && bare.ok === false)
    db.update(sessions).set({ foldStatus: 'ok' }).where(eq(sessions.id, 'bare')).run()
    assert.ok('ok' in queryContext(db, COST, 'bare') && queryContext(db, COST, 'bare').ok === true)
    assert.equal(queryRequests(db, { sessionId: 'rich', day: '2026-01-01' }).length, 2)
    assert.equal(queryRequests(db, { sessionId: 'rich', model: 'm' }).length, 1)
    assert.equal(queryToolCalls(db, {}).items.length, 0)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', status: 'background' }).items.length, 1)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', status: 'slow', slowMs: 0 }).items.length >= 1, true)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', status: 'slow' }).items.length, 0)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', beforeSeq: 100 }).items.length >= 1, true)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', sort: 'slowest', cursor: { seq: 999 } }).items.length, 0)
    assert.equal(queryToolCalls(db, { sessionId: 'rich', sort: 'latest', cursor: { seq: 999 } }).items.length, 0)
    assert.ok(queryDelta(db, 'rich', 12, null) !== null)
    const emptyTimeline = queryTimeline(db, 'empty', null)
    assert.ok(!('ok' in emptyTimeline))
    assert.equal(emptyTimeline.nodes.length, 1)
    assert.equal(queryToolCalls(db, { sessionId: 'empty' }).items.length, 1)
    opened.client.close()
  })
})
