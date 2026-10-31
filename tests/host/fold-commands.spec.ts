import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import type { CommandStateRecord } from '../../src/host/foldState'
import { codeDispatch, codeDispatchStart, jobRegistered, jobSettled, toolCall, toolResult } from './helpers/events'
import { driveTimeline, timelineDef, assertStatesPlainJson } from './helpers/projection'

function bashCall(seq: number, callId: string, args: Record<string, unknown>, time?: number): TimelineEvent {
  return toolCall(seq, { callId, name: 'bash', arguments: JSON.stringify(args), turn: 1, step: 1, time })
}

function bashResult(seq: number, callId: string, text: string, opts: { error?: boolean; meta?: unknown; time?: number } = {}): TimelineEvent {
  return toolResult(seq, { callId, content: [{ type: 'text', text }], error: opts.error, meta: opts.meta, time: opts.time })
}

function cmdsOf(state: { commands: CommandStateRecord[] }): CommandStateRecord[] {
  return state.commands
}

describe('the command log — call/result lifecycle', () => {
  test('a call books a running record; the result settles it with the envelope-derived outcome', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'git status', description: 'check the tree', workdir: '/repo', timeoutMs: 5000 }),
      bashResult(2, 'c1', 'clean'),
    ])
    const { time, start, end, ...rec } = cmdsOf(state)[0]
    assert.deepEqual(rec, {
      seq: 1, tool: 'bash', cmd: 'git status', description: 'check the tree', cwd: '/repo',
      timeoutMs: 5000, status: 'completed', exit: 0, exitInferred: true, derived: true,
      resultSeq: 2, err: false, outChars: 5, call: 'c1', turn: 1, step: 1,
    })
    assert.ok(typeof time === 'number' && end !== undefined && end >= start, 'a numeric time and a non-inverted end')
  })

  test('the exit marker fails the run; stderr, truncation, stop, sandbox, and meta.cwd land on the record', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'vitest run', description: 'tests' }),
      bashResult(2, 'c1', '1 failed\n[stderr]\nerror here\n[exit code: 1]', { meta: { cwd: '/repo/sub' } }),
      bashCall(3, 'c2', { command: 'long', description: 'd', sandbox_permissions: 'danger-full-access' }),
      bashResult(4, 'c2', 'partial\n[output truncated; full output: /tmp/x]'),
      bashCall(5, 'c3', { command: 'halt' }),
      bashResult(6, 'c3', 'x\n[stopped: user request]'),
    ])
    const [failed, truncated, stopped] = cmdsOf(state)
    assert.deepEqual([failed.status, failed.exit, failed.exitInferred, failed.stderr, failed.cwd], ['failed', 1, undefined, true, '/repo/sub'])
    assert.deepEqual([truncated.outTruncated, truncated.sandbox, truncated.turn], [true, 'danger-full-access', 1])
    assert.deepEqual([stopped.status, stopped.stopped], ['killed', true])
  })

  test('a kill, a timeout, and a denial each carry their own flag', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'a' }),
      bashResult(2, 'c1', 'x\n[killed by signal: SIGKILL]'),
      bashCall(3, 'c2', { command: 'b' }),
      bashResult(4, 'c2', 'x\n[timed out after 5000ms]\n[exit code: 28]'),
      bashCall(5, 'c3', { command: 'c' }),
      bashResult(6, 'c3', '[sandbox: file access denied under read-only mode]'),
    ])
    assert.deepEqual(cmdsOf(state).map(r => [r.status, r.signal, r.timedOut, r.exit, r.denied]), [
      ['killed', 'SIGKILL', undefined, undefined, undefined],
      ['failed', undefined, true, 28, undefined],
      ['failed', undefined, undefined, undefined, true],
    ])
  })

  test('an infrastructure error (isError) fails the run without inventing an exit code', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'ls' }),
      bashResult(2, 'c1', 'spawn failed', { error: true }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'failed')
    assert.equal(rec.err, true)
    assert.equal(rec.exit, undefined)
  })

  test('a call without a parseable command books nothing; an unpaired result is skipped', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ description: 'no command' }) }),
      toolCall(2, { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      bashResult(3, 'ghost', 'orphan'),
      bashResult(4, 'c2', 'file body'),
    ])
    assert.equal(cmdsOf(state).length, 0)
  })

  test('a result settles a record that is not the newest (the callId scan walks back)', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'first' }),
      bashCall(2, 'c2', { command: 'second' }),
      bashResult(3, 'c1', 'one'),
      bashResult(4, 'c2', 'two'),
    ])
    assert.deepEqual(cmdsOf(state).map(r => [r.cmd, r.status]), [['first', 'completed'], ['second', 'completed']])
  })

  test('a result with a hostile content payload books the envelope facts only', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'x' }),
      toolResult(2, { callId: 'c1', content: [null, { type: 'image' }, { type: 'text', text: 'ok' }] as never }),
      bashCall(3, 'c2', { command: 'y' }),
      toolResult(4, { callId: 'c2', content: 'junk' as never }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'completed')
    assert.equal(rec.outChars, 2, 'only the text block measures')
    const bare = cmdsOf(state)[1]
    assert.equal(bare.status, 'completed')
    assert.equal(bare.outChars, undefined)
  })

  test('the command text caps at maxCommandChars with the truncation flag', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(40), description: 'd' }) }),
    ], { maxCommandChars: 16 })
    const rec = cmdsOf(state)[0]
    assert.equal(rec.cmd, 'x'.repeat(16))
    assert.equal(rec.cmdTruncated, true)
    assert.equal('turn' in rec, false)
    assert.equal('step' in rec, false)
  })

  test('a run_code call books the program source as the command, with no shell exit code', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'await x()', description: 'batch it' }) }),
      toolResult(2, { callId: 'rc1', content: [{ type: 'text', text: 'done' }] }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.tool, 'run_code')
    assert.equal(rec.cmd, 'await x()')
    assert.equal(rec.description, 'batch it')
    assert.equal(rec.status, 'completed')
    assert.equal('exit' in rec, false, 'a code program carries no exit code')
    assert.equal('exitInferred' in rec, false)
  })
})

describe('the command log — job events', () => {
  test('registered refines the start; settled lands the precise end and clears the derived flag', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'build', description: 'make' }, 1000),
      jobRegistered(2, { callId: 'c1', startedAt: 1100 }),
      jobSettled(3, { callId: 'c1', finishedAt: 5200, status: 'completed', detail: 'exit code: 2' }),
      bashResult(4, 'c1', 'wrote dist', { time: 5300 }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.start, 1100)
    assert.equal(rec.end, 5200)
    assert.equal(rec.status, 'failed', 'a nonzero command exit rides the completed job status with the detail code')
    assert.equal(rec.exit, 2)
    assert.equal(rec.derived, undefined)
    assert.equal(rec.resultSeq, 4, 'the result node stays the locate target even when the job settles first')
    assert.equal(state.commandStats?.runs, 1)
    assert.equal(state.commandStats?.failed, 1)
    assert.equal(state.commandStats?.ms, 4100)
  })

  test('a killed job reports its signal; job events for unknown calls only signal a refetch', () => {
    const def = timelineDef()
    let state = def.init()
    const before = state.detailRev ?? 0
    const registered = def.apply(state, jobRegistered(1, { callId: 'ghost', startedAt: 1 }))
    assert.equal(registered.detailRev, before + 1)
    assert.deepEqual(cmdsOf(registered), [])
    const settled = def.apply(registered, jobSettled(2, { callId: 'ghost', finishedAt: 2, status: 'completed' }))
    assert.equal(settled.detailRev, before + 2)
    assert.deepEqual(cmdsOf(settled), [])
    state = def.apply(state, bashCall(3, 'c1', { command: 'x' }, 1000))
    state = def.apply(state, jobSettled(4, { callId: 'c1', finishedAt: 2000, status: 'killed', detail: 'signal: SIGTERM' }))
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'killed')
    assert.equal(rec.signal, 'SIGTERM')
    assert.equal(rec.end, 2000)
  })

  test('a malformed job envelope drops whole', () => {
    const def = timelineDef()
    let state = def.init()
    state = def.apply(state, bashCall(1, 'c1', { command: 'x' }))
    const before = state
    state = def.apply(state, jobSettled(2, { callId: 'c1', finishedAt: 'later', status: 'completed' }))
    assert.equal(state, before)
    state = def.apply(state, jobSettled(3, { callId: 'c1', finishedAt: 5, status: 'exploded' }))
    assert.equal(state, before)
    state = def.apply(state, { type: 'job/registered', seq: 4, time: 4, data: null } as unknown as TimelineEvent)
    assert.equal(state, before)
    state = def.apply(state, jobSettled(5, { finishedAt: 9, status: 'completed' }))
    assert.equal(state, before, 'no toolCall pairing at all')
    state = def.apply(state, jobRegistered(6, { callId: 42, startedAt: 9 }))
    assert.equal(state, before, 'a non-string callId pairs nothing')
  })
})

describe('the command log — background runs', () => {
  test('a background run stays past its ack and tallies exactly once — at its terminal job record', () => {
    const launched = driveTimeline([
      bashCall(1, 'c1', { command: 'pnpm dev', description: 'serve', run_in_background: true }, 1000),
      bashResult(2, 'c1', 'started background job j1', { time: 1200 }),
      jobSettled(3, { callId: 'c1', finishedAt: 999000, status: 'completed', detail: 'exit code: 0' }),
    ]).state
    const rec = cmdsOf(launched)[0]
    assert.equal(rec.background, true)
    assert.equal(rec.status, 'completed')
    assert.equal(rec.exit, 0)
    assert.equal(rec.end, 999000)
    assert.equal(launched.commandStats?.bg, 1)
    assert.equal(launched.commandStats?.runs, 1, 'the tally fired once, at the terminal transition')
    const promoted = driveTimeline([
      bashCall(1, 'c1', { command: 'slow', description: 's' }, 1000),
      jobRegistered(2, { callId: 'c1', startedAt: 1100 }),
      bashResult(3, 'c1', '[still running after 10000ms; moved to background job j9]\n'
        + 'The command keeps running in the background. You will be notified when it finishes; '
        + 'read newer output with job_output, stop it with job_kill.', { time: 11000 }),
      jobSettled(4, { callId: 'c1', finishedAt: 999000, status: 'killed', detail: 'signal: SIGTERM' }),
    ]).state
    const killed = cmdsOf(promoted)[0]
    assert.equal(killed.status, 'killed', 'promoted: the job outcome wins')
    assert.equal(killed.signal, 'SIGTERM', 'promoted: the termination signal survives')
    assert.equal(killed.background, true, 'promoted: the ack marked it background')
    assert.equal(killed.exitInferred, undefined, 'no phantom inferred exit survives the job outcome')
    assert.deepEqual(promoted.commandStats, { runs: 1, failed: 1, ms: 997900, bg: 1 }, 'promoted: one run tallied at its terminal job record')
  })

  test('a promoted foreground call (wait timeout) marks the run background at its ack, still running', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'slow', description: 's' }),
      bashResult(2, 'c1', 'partial\n[still running after 10000ms; moved to background job j9]\n'
        + 'The command keeps running in the background. You will be notified when it finishes; '
        + 'read newer output with job_output, stop it with job_kill.'),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.background, true)
    assert.equal(rec.status, 'running', 'the ack is no outcome')
    assert.equal(rec.end, undefined)
    assert.deepEqual(state.commandStats, { runs: 0, failed: 0, ms: 0, bg: 1 }, 'the dispatch tallies at the ack; nothing terminal yet')
  })

  test('the persistent-shell failure family fails the run honestly', () => {
    const reset = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.'
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'sleep 999' }),
      bashResult(2, 'c1', `out\n[Command timed out or OOM]\n${reset}`),
      bashCall(3, 'c2', { command: 'exit' }),
      bashResult(4, 'c2', `bye\n[shell exited: code 3]\n${reset}`),
      bashCall(5, 'c3', { command: 'kill -9 $$' }),
      bashResult(6, 'c3', `x\n[shell killed by signal: SIGKILL]\n${reset}`),
    ])
    const [timedOut, exited, killed] = cmdsOf(state)
    assert.equal(timedOut.status, 'failed')
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.exit, undefined)
    assert.equal(exited.status, 'failed')
    assert.equal(exited.exit, 3)
    assert.equal(killed.status, 'killed')
    assert.equal(killed.signal, 'SIGKILL')
  })

  test('on a job-less log a background run stays dispatched, never tallied as failed', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'server', run_in_background: true }),
      bashResult(2, 'c1', 'started background job j2'),
    ])
    assert.equal(cmdsOf(state)[0].status, 'running')
    assert.deepEqual(state.commandStats, { runs: 0, failed: 0, ms: 0, bg: 1 }, 'the dispatch counts at creation')
  })
})

describe('the command log — Code Mode (PTC) sub-dispatches', () => {
  test('a nested dispatch buffers at start, caps its command, settles at its dispatch event, and flushes on the root result', () => {
    const drive = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'program', description: 'batch' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'git status --porcelain', description: 'check' } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'git status --porcelain' },
        isError: false,
        content: [{ type: 'text', text: 'clean\n[exit code: 0]' }],
      }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'program done' }] }),
    ], { maxCommandChars: 16 })
    assertStatesPlainJson(drive)
    assert.equal(drive.state.pendingCodeCmds, undefined, 'the buffer flushed and emptied')
    const [root, nested] = cmdsOf(drive.state)
    assert.deepEqual(
      [nested.cmd, nested.cmdTruncated, nested.codeMode, nested.parent, nested.status, nested.exit],
      ['git status --por', true, true, 4, 'completed', 0],
      'the locate target is the root result row',
    )
    assert.deepEqual([root.tool, root.status, drive.state.commandStats?.runs], ['run_code', 'completed', 2], 'both the root and the nested run tallied')
    const armed = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: {
          command: 'deploy',
          description: 'ship it',
          workdir: '/srv',
          timeoutMs: 3000,
          run_in_background: true,
          sandbox_permissions: 'danger-full-access',
        },
      }),
      codeDispatch(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'deploy' }, isError: true }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ]).state
    const errored = cmdsOf(armed).find(r => r.codeMode === true)
    assert.ok(errored !== undefined)
    assert.deepEqual(
      [errored.cwd, errored.timeoutMs, errored.sandbox, errored.background, errored.status, errored.exit, errored.exitInferred],
      ['/srv', 3000, 'danger-full-access', true, 'failed', undefined, undefined],
    )
  })

  test('a non-command dispatch buffers nothing; the buffer stays bounded when the root never settles', () => {
    const events: TimelineEvent[] = [toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' })]
    events.push(codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:r', name: 'read', arguments: { file_path: 'a' } }))
    events.push(codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:b', name: 'bash', arguments: '{}' }))
    for (let i = 0; i < 210; i++) {
      events.push(codeDispatchStart(10 + i, { rootCallId: 'rc1', subCallId: `rc1:ptc:${i}`, name: 'bash', arguments: { command: `c${i}` } }))
    }
    const { state } = driveTimeline(events)
    assert.equal((state.pendingCodeCmds?.rc1 ?? []).length, 200, 'the cap holds')
  })

  test('a dispatch settle without a buffered start is skipped; a junk envelope drops whole', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatch(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:9', name: 'bash', arguments: { command: 'x' } }),
      { type: 'tool/ptc-dispatch-start', seq: 3, time: 3, data: null } as unknown as TimelineEvent,
      { type: 'tool/ptc-dispatch', seq: 5, time: 5, data: { rootCallId: 'rc1', name: 'bash', isError: false, content: [] } } as unknown as TimelineEvent,
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.equal(cmdsOf(state).length, 1, 'only the run_code root')
  })

  test('a nested background run takes its job events while still buffered behind the root', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'serve', run_in_background: true } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'serve' },
        content: [{ type: 'text', text: 'started background job j8' }],
      }),
      jobRegistered(4, { callId: 'rc1:ptc:0', startedAt: 2000 }),
      jobSettled(5, { callId: 'rc1:ptc:0', finishedAt: 62000, status: 'completed', detail: 'exit code: 0' }),
      toolResult(6, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.deepEqual(
      [nested.status, nested.start, nested.end, nested.derived],
      ['completed', 2000, 62000, undefined],
      'the buffered record took its job settlement and the registered spawn instant',
    )
    assert.deepEqual([state.commandStats?.runs, state.commandStats?.bg], [2, 1], 'root + nested each tallied once')
  })

  test('job events skip buffers that do not hold the call (no buffer, a stale buffer, a multi-root scan)', () => {
    const def = timelineDef()
    const noBuffer = def.apply(def.init(), toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }))
    const settled = def.apply(noBuffer, jobSettled(2, { callId: 'rc1:ptc:9', finishedAt: 5, status: 'completed', detail: 'exit code: 0' }))
    assert.equal(settled.detailRev, (noBuffer.detailRev ?? 0) + 1, 'no buffer: only the refetch signal')
    assert.deepEqual(settled.commands, noBuffer.commands)
    const registered = def.apply(noBuffer, jobRegistered(3, { callId: 'rc1:ptc:9', startedAt: 5 }))
    assert.equal(registered.detailRev, (noBuffer.detailRev ?? 0) + 1)
    assert.deepEqual(registered.commands, noBuffer.commands)
    const buffered = def.apply(noBuffer, codeDispatchStart(4, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }))
    const staleRegistered = def.apply(buffered, jobRegistered(5, { callId: 'rc1:ptc:ghost', startedAt: 5 }))
    assert.equal(staleRegistered.detailRev, (buffered.detailRev ?? 0) + 1)
    assert.deepEqual(staleRegistered.pendingCodeCmds, buffered.pendingCodeCmds, 'a stale buffer stays untouched')
    const staleSettled = def.apply(buffered, jobSettled(6, { callId: 'rc1:ptc:ghost', finishedAt: 9, status: 'completed' }))
    assert.equal(staleSettled.detailRev, (buffered.detailRev ?? 0) + 1)
    assert.deepEqual(staleSettled.pendingCodeCmds, buffered.pendingCodeCmds)
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'a' }) }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: JSON.stringify({ code: 'b' }) }),
      codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }),
      codeDispatchStart(4, { rootCallId: 'rc2', subCallId: 'rc2:ptc:0', name: 'bash', arguments: { command: 'two' } }),
      jobRegistered(5, { callId: 'rc2:ptc:0', startedAt: 777 }),
    ])
    assert.equal(state.pendingCodeCmds?.rc2[0].start, 777, 'the second root’s record took the stamp')
    assert.notEqual(state.pendingCodeCmds?.rc1[0].start, 777)
  })

  test('a nested background ack stays open past its settle and flushes running', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'serve' } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'serve' },
        content: [{ type: 'text', text: 'started background job j7' }],
      }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.equal(nested.status, 'running', 'the ack is no outcome, even at flush')
    assert.equal(nested.background, true)
    assert.equal(state.commandStats?.runs, 1, 'only the root tallied')
  })

  test('two interleaved roots keep independent buffers; one settling keeps the other pending', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'a' }) }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: JSON.stringify({ code: 'b' }) }),
      codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }),
      codeDispatchStart(4, { rootCallId: 'rc2', subCallId: 'rc2:ptc:0', name: 'bash', arguments: { command: 'two' } }),
      codeDispatch(5, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' }, content: [{ type: 'text', text: 'ok' }] }),
      toolResult(6, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(cmdsOf(state).filter(r => r.codeMode === true).map(r => r.cmd), ['one'])
    assert.equal((state.pendingCodeCmds?.rc2 ?? []).length, 1, 'the other root stays buffered')
  })
})

describe('the command log — retention, stats, and the served payload', () => {
  test('the log drops the oldest SETTLED records first, stamps the coverage floor, and still bounds never-settling calls', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(bashCall(10 + i * 2, `c${i}`, { command: `cmd${i}` }))
      events.push(bashResult(11 + i * 2, `c${i}`, 'ok'))
    }
    events.push(bashCall(20, 'keep', { command: 'running' }))
    const { state } = driveTimeline(events, { maxCommands: 3 })
    assert.deepEqual(cmdsOf(state).map(r => r.cmd), ['cmd3', 'cmd4', 'running'])
    assert.equal(state.commandsFloor, 14, 'the newest dropped record was the cmd2 call (a record’s seq is its call’s)')
    const neverSettling: TimelineEvent[] = []
    for (let i = 0; i < 10; i++) neverSettling.push(bashCall(10 + i, `c${i}`, { command: `cmd${i}` }))
    const bounded = driveTimeline(neverSettling, { maxCommands: 4 })
    assert.equal(cmdsOf(bounded.state).length, 4)
    assert.equal(bounded.state.commandsFloor, 15)
  })

  test('the whole-log stats survive list trimming', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 6; i++) {
      events.push(bashCall(10 + i * 2, `c${i}`, { command: `cmd${i}` }))
      events.push(bashResult(11 + i * 2, `c${i}`, i % 2 === 0 ? 'ok' : 'x\n[exit code: 1]'))
    }
    const { state } = driveTimeline(events, { maxCommands: 2 })
    assert.equal(cmdsOf(state).length, 2)
    assert.equal(state.commandStats?.runs, 6, 'the tally covers the complete log')
    assert.equal(state.commandStats?.failed, 3)
  })

  test('the schema accepts a command-bearing state; the detail serves detached records and the slim head omits the log', () => {
    const events = [
      bashCall(1, 'c1', { command: 'ls', description: 'list' }),
      bashResult(2, 'c1', 'ok'),
    ]
    const { def, state } = driveTimeline(events)
    def.stateSchema.parse(structuredClone(state))
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.commands?.length, 1)
    assert.notEqual(detail.commands?.[0], state.commands[0], 'the served record never aliases the state')
    assert.equal('call' in (detail.commands?.[0] ?? {}), false, 'the fold pairing key stays off the wire')
    assert.equal(detail.commandStats?.runs, 1)
    const slim = timelineDef({}, true)
    const inline = timelineDef({}, false)
    assert.equal('commands' in slim.wire.view(state), false)
    const full = inline.wire.view(state)
    assert.equal(full.commands?.length, 1)
    assert.equal(inline.wire.viewSchema.safeParse(full).success, true)
  })
})
