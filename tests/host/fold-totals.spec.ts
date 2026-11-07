import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { resolveBounds } from '../../src/host/config'
import { driveTimeline } from './helpers/projection'
import { buildTimelineHead } from '../../src/host/foldWire'
import { assistantMessage, codeDispatch, codeDispatchStart, header, stepEnd, stepStart, toolCall, toolResult, userMessage } from './helpers/events'

function baseLog(): ReturnType<typeof header>[] {
  return [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }), userMessage(2, [{ type: 'text', text: 'go' }], { kind: 'user' }), stepStart(3)]
}

function toolPair(seq: number, callId: string, name: string, args: Record<string, unknown>, content: string, callOpts: Record<string, unknown> = {}) {
  return [
    toolCall(seq, { callId, name, arguments: JSON.stringify(args), ...callOpts }),
    toolResult(seq + 1, { callId, content: [{ type: 'text', text: content }] }),
  ]
}

describe('cumulative tallies in the fold', () => {
  test('counts tools, file totals and command programs in one pass (full and head-only)', () => {
    const log = [
      ...baseLog(),
      ...toolPair(4, 'c1', 'bash', { command: 'ls -la | grep foo' }, 'total 0'),
      ...toolPair(6, 'c2', 'read', { path: '/tmp/x.ts' }, 'file body'),
      ...toolPair(8, 'c3', 'read_image', { path: '/tmp/pic.png' }, 'image'),
      ...toolPair(10, 'c4', 'read', { path: '/tmp/y.png' }, 'image body'),
      stepEnd(12),
      assistantMessage(13, { turn: 1, step: 0 }),
    ]
    for (const headOnly of [false, true]) {
      const drive = driveTimeline(log, {}, headOnly)
      const state = drive.state
      assert.deepEqual(state.toolTally, { bash: 1, read: 2, read_image: 1 })
      assert.deepEqual(state.programTally, { ls: 1, grep: 1 })
      assert.deepEqual(drive.view.toolTally, state.toolTally)
      assert.deepEqual(drive.view.programTally, state.programTally)
      assert.equal(drive.view.commandStats?.runs, 1)
      assert.equal(buildTimelineHead(state).commandStats?.runs, 1, 'the head wire carries the cumulative command stats')
      assert.equal(drive.view.commandStats?.failed, 0)
    }
  })

  test('tallies survive request trimming because they are cumulative', () => {
    const log = [
      ...baseLog(),
      ...toolPair(4, 'c1', 'bash', { command: 'cat a' }, 'a'),
      stepEnd(6),
      assistantMessage(7, { turn: 1, step: 0 }),
      ...toolPair(8, 'c2', 'bash', { command: 'cat b' }, 'b'),
      stepEnd(10),
      assistantMessage(11, { turn: 2, step: 0 }),
    ]
    const drive = driveTimeline(log, { maxRequestSteps: 1, maxKeptTurns: 1 })
    assert.equal(drive.state.requests.length, 1)
    assert.deepEqual(drive.state.toolTally, { bash: 2 })
    assert.deepEqual(drive.state.programTally, { cat: 2 })
    assert.deepEqual(drive.view.toolTally, { bash: 2 })
  })

  test('caps distinct tally names and ignores hostile names', () => {
    const log: ReturnType<typeof toolCall>[] = [...baseLog()] as never[]
    for (let i = 0; i < 130; i++) {
      const seq = 4 + i * 2
      log.push(toolCall(seq, { callId: 'c' + i, name: 'tool_' + i, arguments: '{}' }))
      log.push(toolResult(seq + 1, { callId: 'c' + i, content: [{ type: 'text', text: 'ok' }] }))
    }
    const proto = log.length
    log.push(toolCall(proto, { callId: 'p', name: '__proto__', arguments: '{}' }))
    log.push(toolResult(proto + 1, { callId: 'p', content: [{ type: 'text', text: 'ok' }] }))
    const drive = driveTimeline(log)
    assert.equal(Object.keys(drive.state.toolTally ?? {}).length, 128)
    assert.equal(Object.hasOwn(drive.state.toolTally ?? {}, '__proto__'), false)
    assert.equal(Object.keys(drive.state.toolTally ?? {}).length, 128)
  })

  test('counts run_code PTC subcommands and their file operations in head-only folds', () => {
    const log = [
      ...baseLog(),
      toolCall(4, { callId: 'root', name: 'run_code', arguments: JSON.stringify({ code: '1+1' }) }),
      codeDispatchStart(5, { rootCallId: 'root', subCallId: 'root:0', name: 'bash', arguments: { command: 'echo hi' } }),
      codeDispatch(6, { rootCallId: 'root', subCallId: 'root:0', name: 'bash', content: [{ type: 'text', text: 'hi' }] }),
      codeDispatchStart(7, { rootCallId: 'root', subCallId: 'root:1', name: 'read', arguments: { path: 'src/p.ts' } }),
      codeDispatch(8, { rootCallId: 'root', subCallId: 'root:1', name: 'read', content: [{ type: 'text', text: 'body' }] }),
      toolResult(9, { callId: 'root', content: [{ type: 'text', text: 'done' }] }),
      stepEnd(10),
      assistantMessage(11, { turn: 1, step: 0 }),
    ]
    for (const headOnly of [false, true]) {
      const drive = driveTimeline(log, {}, headOnly)
      assert.equal(drive.state.commands.length, headOnly ? 0 : 2, 'settled command rows stay refold-only head-side')
      assert.equal(headOnly ? drive.state.commandCalls?.length : undefined, headOnly ? 2 : undefined)
      assert.deepEqual(drive.state.programTally, { run_code: 1, echo: 1 })
      assert.deepEqual(drive.view.programTally, drive.state.programTally)
      assert.equal(drive.view.commandStats?.runs, 2)
    }
  })

  test('clamps long tally names to the persisted key budget', () => {
    const longName = 'x'.repeat(130)
    const drive = driveTimeline([
      ...baseLog(),
      ...toolPair(4, 'long', longName, {}, 'ok'),
      stepEnd(6),
      assistantMessage(7, { turn: 1, step: 0 }),
    ], {}, true)
    assert.equal(drive.state.toolTally?.['x'.repeat(120)], 1)
    assert.equal(Object.keys(drive.state.toolTally ?? {})[0]?.length, 120)
    assert.equal(drive.view.toolTally?.['x'.repeat(120)], 1)
  })

  test('omits the tally fields until the first counted event', () => {
    const drive = driveTimeline(baseLog(), {}, true)
    assert.equal(drive.view.toolTally, undefined)
    assert.equal(drive.view.programTally, undefined)
    assert.equal(drive.view.commandStats, undefined)
    assert.equal(resolveBounds({}).maxRequestSteps, 1500)
  })
})
