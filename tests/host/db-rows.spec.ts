import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { openDatabase } from '../../src/host/db/open'
import { createDb } from '../../src/host/db/db'
import { foldSession } from '../../src/host/db/ingest'
import { resolveBounds } from '../../src/host/config'
import { assistantMessage, header, stepEnd, stepStart, systemMessage, toolCall, toolResult, userMessage } from './helpers/events'
import { requests, steps, toolCalls, surfaceNodes, sessions } from '../../src/host/db/schema'
import { RowsSink, searchTextOf, writeBatch } from '../../src/host/db/rows'

const text = (value: string) => [{ type: 'text', text: value }]

function fixture() {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  db.insert(sessions).values({ id: 's1', createdAt: 1, familyRoot: 's1', updatedAt: 1, foldStatus: 'pending', title: 'demo' }).run()
  return { opened, db }
}

describe('db row projection', () => {
  test('projects a full session into rows', () => {
    const { opened, db } = fixture()
    const log = [
      header(1, { tools: [{ name: 'bash', description: 'run' }], model: 'deepseek-chat', provider: 'deepseek' }),
      systemMessage(2),
      userMessage(3, text('hello')),
      stepStart(4, { time: 4000 }),
      assistantMessage(5, { turn: 1, step: 1, time: 5000, usage: { inputTokens: 10, outputTokens: 4 } }),
      toolCall(6, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }), turn: 1, step: 1, time: 6000 }),
      toolResult(7, { callId: 'c1', content: text('ok'), meta: { cwd: '/w' }, time: 7000 }),
      stepEnd(8, { time: 8000 }),
    ]
    foldSession({
      db,
      sessionId: 's1',
      title: 'demo',
      cwd: '/w',
      events: log,
      bounds: resolveBounds({}),
      incremental: false,
    })
    assert.equal(db.select().from(requests).all().length, 1)
    assert.equal(db.select().from(steps).all().length, 1)
    assert.equal(db.select().from(toolCalls).all().length, 1)
    opened.client.close()
  })
})

describe('row sink surfaces', () => {
  test('emits every row shape, optional field and patch arm', () => {
    const { opened, db } = fixture()
    const sink = new RowsSink('s1', name => name === 'bash' ? 'plugin:bash' : undefined)
    sink.header({ seq: 1, time: 1, reason: 'initial', tools: [{ name: 'bash', tokens: 1 }, { name: 'x', tokens: 2, plugin: 'p' }] })
    sink.header({ seq: 2, time: 2, tools: [] })
    sink.system({ seq: 3, time: 3, tokens: 4 })
    sink.systemGone(3, 9)
    sink.surface({ seq: 4, time: 4, cat: 'user', tokens: 5, text: 'x'.repeat(2_001), calls: ['a'], err: true, imgs: 2, form: 'f', name: 'n', agent: 'a', tool: 't', skill: 's', reasoning: 1, answerTokens: 2, callTokens: 3, gone: 9 })
    sink.surface({ seq: 5, cat: 'assistant', tokens: 1 })
    sink.surfaceGone(4, 10)
    sink.request({
      seq: 6, time: 6, day: 'd', turn: 1, step: 2, startsTurn: true, inherited: true,
      system: 1, tools: 2, user: 3, inject: 4, skill: 5, assistant: 6, tool: 7, total: 28,
      model: 'm', provider: 'p', period: 'peak', prompt: 1, input: 2, cacheRead: 3, cacheWrite: 4,
      output: 5, reasoning: 6, genMs: 7,
    })
    sink.request({ seq: 7, time: 7, day: 'd', startsTurn: false, inherited: false, system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 })
    sink.requestActive(6, 9)
    sink.stepStart({ seq: 8, time: 8, day: 'd', beatsFull: true, turn: 1, step: 1 })
    sink.stepRequest(8, 6)
    sink.stepEnd({ seq: 8, endTime: 9, wallMs: 1, activeMs: 1, waitMs: 0, idleMs: 0, toolBusyMs: 0, ttftMs: 1, beatsFull: true })
    sink.stepEnd({ seq: 8, endTime: 9, wallMs: 1, activeMs: 1, waitMs: 0, idleMs: 0, toolBusyMs: 0, beatsFull: false })
    sink.toolCall({ seq: 10, time: 10, callId: 'c1', name: 'bash', turn: 1, step: 1, day: '', codeMode: true, parentSeq: 8, transport: true })
    sink.toolCall({ seq: 11, time: 11, callId: 'c2', name: 'x', day: 'd', codeMode: false, transport: false })
    sink.toolCallUpdate('c1', {
      resultSeq: 12, endTime: 12, durationMs: 2, isError: true, status: 'failed', exitCode: 1,
      exitInferred: true, signal: 'SIG', timedOut: true, stopped: true, denied: true, derived: true,
      background: true, outChars: 3, outTruncated: true, stderr: true, startTime: 10, transport: true,
    })
    sink.toolCallUpdate('c2', {
      isError: false, exitInferred: false, timedOut: false, stopped: false, denied: false,
      derived: false, background: false, outTruncated: false, stderr: false, transport: false,
    })
    sink.toolCallUpdate('c2', {})
    sink.command({
      seq: 13, time: 13, tool: 'bash', cmd: 'ls', start: 13, end: 14, status: 'completed', err: false,
      call: 'c3', resultSeq: 14, cmdTruncated: true, description: 'd', cwd: '/w', timeoutMs: 5,
      background: true, sandbox: 's', codeMode: true, parent: 12, turn: 1, step: 1, exit: 0,
      exitInferred: true, signal: 'sig', timedOut: true, stopped: true, denied: true, derived: true,
      outChars: 2, outTruncated: true, stderr: true,
    })
    sink.command({ seq: 15, time: 15, tool: 'bash', start: 15, status: 'running', err: true, call: 'c4' })
    sink.commandUpdate({
      seq: 15, time: 15, tool: 'bash', start: 15, end: 16, status: 'failed', err: true, call: 'c4',
      resultSeq: 16, cmd: 'ls', cmdTruncated: true, description: 'd', cwd: '/w', exit: 1,
      exitInferred: true, signal: 'sig', timedOut: true, stopped: true, denied: true, derived: true,
      background: true, outChars: 1, outTruncated: true, stderr: true,
    })
    sink.commandUpdate({ seq: 15, time: 15, tool: 'bash', start: 15, status: 'running', err: false })
    sink.command({ seq: 17, time: 17, tool: 'read', cmd: 'x', start: 17, status: 'running', err: false, call: 'c9' })
    sink.event({ seq: 17, time: 17, kind: 'model', sub: 's', form: 'f', name: 'n', agent: 'a', detail: 'd', tokens: 1, grossTokens: 2, count: 3, from: 'a', to: 'b' })
    sink.event({ seq: 18, time: 18, kind: 'inject' })
    sink.eventUpdate(17, { tokens: 2, grossTokens: 3 })
    sink.eventUpdate(17, {})
    sink.fileOps(19, [
      { seq: 19, path: '/a', kind: 'read', tool: 'read', time: 19, err: false, added: 0, removed: 0, read: { start: 1, count: 2 }, parent: 1, program: 'p', gone: 2 },
      { seq: 19, path: '/b', kind: 'search', tool: 'grep', err: true, added: 1, removed: 2, detail: 'd', hits: 3, read: { count: 4, est: true }, pattern: true },
      { seq: 19, path: '/c', kind: 'write', tool: 'write', err: false, added: 1, removed: 0 },
    ])
    sink.fileOps(20, [])
    sink.fileOps(20, [{ seq: 20, path: '/d', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }])
    sink.fileOps(20, [{ seq: 20, path: '/e', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }])
    sink.skillLoad({ seq: 21, time: 21, name: 'skill', source: 'result' })
    assert.equal(sink.span(22, [{ kind: 'text', start: 1, end: 2 }], 5), 6)
    assert.equal(sink.spanSeq(), 6)
    assert.ok(sink.drainSize() > 0)
    writeBatch(db, sink.take(), 's1')
    assert.equal(db.select().from(toolCalls).all().length >= 4, true)
    assert.equal(db.select().from(surfaceNodes).all().length >= 2, true)
    const invalid = new RowsSink('s1')
    invalid.command({ seq: 99, time: 99, tool: 'bash', cmd: '', start: Number.NaN, status: 'running', err: false })
    assert.equal(searchTextOf('T', null, 'U'), 't\n\nu'.replace('\n\n', '\n'))
    opened.client.close()
  })
})

describe('incremental ingest', () => {
  test('a no-op incremental fold leaves every row untouched', () => {
    const { opened, db } = fixture()
    foldSession({
      db, sessionId: 's1', title: 'demo', events: [], bounds: resolveBounds({}), incremental: true,
    })
    assert.equal(db.select().from(requests).all().length, 0)
    assert.equal(db.select().from(steps).all().length, 0)
    assert.equal(db.select().from(surfaceNodes).all().length, 0)
    opened.client.close()
  })
})
