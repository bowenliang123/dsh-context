// The fold-derived file-op log (src/host/fold.ts + shared/fileOps.ts): ops
// book at tool/result off the armed call's arguments and the result's
// presentation meta; Code-Mode sub-dispatches buffer under their run_code
// root and flush at its result with parent/program stamps; the log trims to
// maxFileOps with a coverage floor; and the detail builder serves detached
// copies. Driven through the real projection unit.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import { codeDispatch, toolCall, toolResult } from './helpers/events'
import { assertStatesPlainJson, driveTimeline, timelineDef } from './helpers/projection'

/** The read window meta the read tool persists on its result. */
function readMeta(path: string, offset: number, lines: number): unknown {
  return { path, offset, lines: Array.from({ length: lines }, (_, i) => ({ number: offset + i })), totalLines: 99 }
}

describe('the file-op log — call/result pairing', () => {
  test('a read call+result books the exact window off the result meta', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts', limit: 10 }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }], meta: readMeta('src/a.ts', 5, 3) }),
    ])
    assert.deepEqual(state.fileOps, [{
      seq: 2, time: state.fileOps[0].time, kind: 'read', tool: 'read', err: false,
      added: 0, removed: 0, path: 'src/a.ts', read: { start: 5, count: 3 },
    }])
  })

  test('an edit books the line delta; a grep with the complete matches meta rows per file', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x\ny', new_string: 'z' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
      toolCall(3, { callId: 'c2', name: 'grep', arguments: JSON.stringify({ pattern: 'TODO' }) }),
      toolResult(4, {
        callId: 'c2',
        content: [{ type: 'text', text: 'ok' }],
        meta: { shape: 'matches', truncated: false, total: 2, files: [{ path: 'a.ts', matches: [{}, {}] }] },
      }),
    ])
    assert.deepEqual(state.fileOps.map(o => [o.kind, o.path, o.added, o.removed, o.hits ?? 0]), [
      ['write', 'a.ts', 1, 2, 0],
      // The searched target (the pathless pattern) rows too, then the hit file.
      ['search', 'TODO', 0, 0, 0],
      ['search', 'a.ts', 0, 0, 2],
    ])
  })

  test('an unpaired result and a non-file call book nothing', () => {
    const { state } = driveTimeline([
      toolResult(1, { callId: 'ghost', content: [{ type: 'text', text: 'ok' }] }),
      toolCall(2, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }),
      toolResult(3, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(state.fileOps, [])
  })

  test('a call without raw arguments pairs for the surface label but books no op', () => {
    const { state } = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read' } } as unknown as TimelineEvent,
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(state.fileOps, [], 'no arguments — no target')
    assert.equal(state.callNames.c1, undefined, 'the pending entry consumed at the result')
  })

  test('the error flag reads the envelope error object or the block isError', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'no' }], error: true }),
      toolCall(3, { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'b.ts' }) }),
      // A block-level isError (no envelope error object).
      {
        type: 'tool/result', seq: 4, time: 4,
        data: {
          callId: 'c2',
          message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [] }], source: { kind: 'tool', callId: 'c2' } },
        },
      } as unknown as TimelineEvent,
    ])
    assert.deepEqual(state.fileOps.map(o => o.err), [true, true])
  })

  test('a call whose raw arguments are not a string still pairs by name (ops degrade to nothing)', () => {
    const { state } = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: { file_path: 'a.ts' } } } as unknown as TimelineEvent,
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    // The durable vocabulary strings the arguments; an object form (foreign
    // producer) is normalized through the same JSON.stringify guard.
    assert.deepEqual(state.fileOps.map(o => [o.kind, o.path]), [['read', 'a.ts']])
  })
})

describe('the file-op log — Code Mode (PTC) sub-dispatches', () => {
  test('a dispatch buffers under its run_code root and flushes at its result with parent + program', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ description: 'batch the reads' }) }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'read', arguments: { file_path: 'a.ts' } }),
      codeDispatch(3, { rootCallId: 'rc1', name: 'write', arguments: { file_path: 'b.ts', content: 'x\ny' } }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(state.pendingCodeOps, undefined, 'the buffer flushed and emptied')
    assert.deepEqual(state.fileOps.map(o => [o.kind, o.path, o.parent ?? 0, o.program ?? '', o.added]), [
      ['read', 'a.ts', 4, 'batch the reads', 0],
      ['write', 'b.ts', 4, 'batch the reads', 2],
    ])
  })

  test('a non-file dispatch books nothing; a junk dispatch envelope is dropped whole', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'bash', arguments: { command: 'ls' } }),
      { type: 'tool/code-dispatch', seq: 3, time: 3, data: null } as unknown as TimelineEvent,
      codeDispatch(4, { name: 'read' }), // no rootCallId
      toolResult(5, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.equal(state.pendingCodeOps, undefined)
    assert.deepEqual(state.fileOps, [])
  })

  test('a hostile argument payload (cyclic) yields no ops instead of throwing the fold', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'read', arguments: cyclic }),
    ])
    assert.deepEqual(state.fileOps, [])
    assert.equal(state.pendingCodeOps, undefined, 'no ops booked — nothing buffered')
  })

  test('the buffer stays bounded when the run_code never settles', () => {
    const events: TimelineEvent[] = [toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' })]
    for (let i = 0; i < 210; i++) {
      events.push(codeDispatch(10 + i, { rootCallId: 'rc1', name: 'read', arguments: { file_path: `f${i}.ts` } }))
    }
    const { state } = driveTimeline(events)
    const buffered = state.pendingCodeOps?.rc1 ?? []
    assert.equal(buffered.length, 200, 'the cap holds (the 201st+ batch drops wholesale)')
  })

  test('two interleaved run_code roots flush independently', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: '{}' }),
      codeDispatch(3, { rootCallId: 'rc1', name: 'read', arguments: { file_path: 'a.ts' } }),
      codeDispatch(4, { rootCallId: 'rc2', name: 'read', arguments: { file_path: 'b.ts' } }),
      toolResult(5, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
      toolResult(6, { callId: 'rc2', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(state.fileOps.map(o => [o.path, o.parent ?? 0]), [['a.ts', 5], ['b.ts', 6]])
  })
})

describe('the file-op log — retention, schema, and the served payload', () => {
  test('the log trims to maxFileOps and stamps the coverage floor', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(toolCall(10 + i * 2, { callId: `c${i}`, name: 'read', arguments: JSON.stringify({ file_path: `f${i}.ts` }) }))
      events.push(toolResult(11 + i * 2, { callId: `c${i}`, content: [{ type: 'text', text: 'ok' }] }))
    }
    const { state } = driveTimeline(events, { maxFileOps: 3 })
    assert.deepEqual(state.fileOps.map(o => o.path), ['f2.ts', 'f3.ts', 'f4.ts'])
    assert.equal(state.fileOpsFloor, 13, 'the newest dropped op was seq 13')
  })

  test('every intermediate state is plain JSON with ops booked and buffered', () => {
    const drive = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ description: 'd' }) }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'read', arguments: { file_path: 'a.ts' } }),
      toolCall(3, { callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' }) }),
      toolResult(4, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
      toolResult(5, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assertStatesPlainJson(drive)
    assert.equal(drive.state.fileOps.length, 2)
  })

  test('the state schema accepts a state carrying ops; the detail builder serves detached copies', () => {
    const { def, state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }], meta: readMeta('a.ts', 1, 2) }),
    ])
    def.stateSchema.parse(structuredClone(state)) // throws on drift
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.fileOps?.length, 1)
    assert.notEqual(detail.fileOps?.[0], state.fileOps[0], 'the served op never aliases the state')
    const read = detail.fileOps?.[0].read
    assert.ok(read !== undefined && 'start' in read)
    assert.equal(read.start, 1)
  })

  test('the slim head does NOT carry the op log; the inline value does', () => {
    const events = [
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ]
    const slim = timelineDef({}, true)
    const inline = timelineDef({}, false)
    const { state } = driveTimeline(events)
    assert.equal('fileOps' in slim.wire.view(state), false)
    const full = inline.wire.view(state)
    assert.equal(full.fileOps?.length, 1)
    assert.equal(inline.wire.viewSchema.safeParse(full).success, true)
  })
})
