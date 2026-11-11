import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { type TimelineEvent, buildTimelineDetail, applyTimeline, type TimelineState } from '../../src/host/fold'
import { resolveBounds, type FoldBounds } from '../../src/host/config'
import { type CommandStateRecord, createTimelineState, deriveHeadState } from '../../src/host/foldState'
import { codeDispatch, codeDispatchStart, jobRegistered, jobSettled, toolCall, toolResult, assistantAttempt, assistantMessage, compaction, endSeed, header, planMode, requestContext, stepEnd, stepStart, systemMessage, userMessage } from './helpers/events'
import { assertStable, driveTimeline, fullDef, timelineDef, assertStatesPlainJson } from './helpers/projection'
import { buildTimelineHead } from '../../src/host/foldWire'

describe('fold-commands', () => {

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

  test('a killed job reports its signal; job events for unknown calls return the same state', () => {
    const def = fullDef()
    let state = def.init()
    assertStable(state, jobRegistered(1, { callId: 'ghost', startedAt: 1 }), def)
    assertStable(state, jobSettled(2, { callId: 'ghost', finishedAt: 2, status: 'completed' }), def)
    state = def.apply(state, bashCall(3, 'c1', { command: 'x' }, 1000))
    state = def.apply(state, jobSettled(4, { callId: 'c1', finishedAt: 2000, status: 'killed', detail: 'signal: SIGTERM' }))
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'killed')
    assert.equal(rec.signal, 'SIGTERM')
    assert.equal(rec.end, 2000)
  })

  test('a malformed job envelope drops whole', () => {
    const def = fullDef()
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
    const def = fullDef()
    const noBuffer = def.apply(def.init(), toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }))
    assert.equal(def.apply(noBuffer, jobSettled(2, { callId: 'rc1:ptc:9', finishedAt: 5, status: 'completed', detail: 'exit code: 0' })), noBuffer, 'no buffer at all')
    assert.equal(def.apply(noBuffer, jobRegistered(3, { callId: 'rc1:ptc:9', startedAt: 5 })), noBuffer)
    const buffered = def.apply(noBuffer, codeDispatchStart(4, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }))
    assert.equal(def.apply(buffered, jobRegistered(5, { callId: 'rc1:ptc:ghost', startedAt: 5 })), buffered)
    assert.equal(def.apply(buffered, jobSettled(6, { callId: 'rc1:ptc:ghost', finishedAt: 9, status: 'completed' })), buffered)
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
})

describe('fold-head', () => {

const FULL: FoldBounds = resolveBounds({})
const HEAD: FoldBounds = { ...FULL, headOnly: true }

function text(content: string): ContentBlocks {
  return [{ type: 'text', text: content }]
}

type ContentBlocks = { type: 'text'; text: string }[]

function developerMessage(seq: number, source: Record<string, unknown>, content = text('injected context')): TimelineEvent {
  return {
    type: 'developer/message',
    seq,
    time: Date.now(),
    data: { message: { role: 'developer', source, content } },
    surfaceOp: 'append',
  }
}

function richLog(): TimelineEvent[] {
  return [
    header(1, {
      tools: [
        { name: 'bash', description: 'run a command' },
        { name: 'read_file', description: 'read a file' },
      ],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    }),
    systemMessage(2),
    requestContext(3, { contextWindow: 128000 }),
    stepStart(4, { time: 10_000 }),
    userMessage(5, [{ type: 'image', content: [{ type: 'text', text: 'px' }] }, ...text('hello there')], { kind: 'user' }),
    developerMessage(6, { kind: 'plugin', plugin: 'dsh-context', form: 'notice', summary: 'watching' }),
    assistantMessage(7, { turn: 1, step: 0, usage: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 5 } }),
    toolCall(8, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls', description: 'list' }), turn: 1, step: 0 }),
    jobRegistered(9, { callId: 'c1', startedAt: 11_000 }),
    toolResult(10, { callId: 'c1', content: text('done'), time: 12_000 }),
    jobSettled(11, { callId: 'c1', finishedAt: 12_500, status: 'completed', detail: 'exit code: 0' }),
    toolCall(12, { callId: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }), turn: 1, step: 0 }),
    toolResult(13, { callId: 'c2', content: text('file body'), meta: { file: { path: 'a.ts', lineCount: 12 } } }),
    stepEnd(14, { time: 15_000 }),
    assistantAttempt(15, { turn: 2, step: 0, stream: [{ type: 'chunk', time: 16_000, chunk: { type: 'text', text: 'x' } }] }),
    stepStart(16, { time: 15_500 }),
    assistantMessage(17, {
      turn: 2,
      step: 0,
      content: [{ type: 'text', text: 'hi' }, { type: 'reasoning', text: 'think' }, { type: 'tool-call', name: 'bash', arguments: '{}' }],
      usage: { inputTokens: 20, outputTokens: 8 },
      stream: { steps: [{ type: 'chunk', time: 16_000, chunk: { type: 'text', text: 'hi' } }] },
    }),
    toolCall(18, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x', description: 'prog' }), turn: 2, step: 0 }),
    codeDispatchStart(19, { rootCallId: 'rc1', subCallId: 'rc1:code:0', name: 'bash', arguments: { command: 'one' } }),
    codeDispatch(20, { rootCallId: 'rc1', subCallId: 'rc1:code:0', name: 'read_file', arguments: { path: 'b.ts' }, content: [text('b body')] }),
    toolResult(21, { callId: 'rc1', content: text('prog done'), time: 18_000 }),
    toolCall(22, { callId: 'c3', name: 'ask_user_question', arguments: '{}' }),
    toolResult(23, { callId: 'c3', content: text('an answer') }),
    developerMessage(24, { kind: 'skill-invocation', name: 'pdf' }, text('<skill_content name="pdf">steps</skill_content>')),
    toolCall(25, { callId: 'c4', name: 'read_file', arguments: '{}' }),
    toolResult(26, { callId: 'c4', content: text('<skill_content name="excel">x</skill_content>') }),
    toolResult(33, { callId: 'ghost', content: text('<skill_content name="ppt">y</skill_content>') }),
    userMessage(34, text('replaced'), { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 7, endSeq: 8 } }),
    compaction(27, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5, 6] }),
    userMessage(28, text('again'), { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 } }),
    compaction(29, 'prune', { shadowedTokenCount: 3 }),
    planMode(30, { active: true }),
    planMode(31, { active: false }),
    endSeed(32, { inherited: false }),
  ]
}

function fold(events: TimelineEvent[], bounds: FoldBounds): TimelineState[] {
  const states = [createTimelineState()]
  for (const ev of events) states.push(applyTimeline(states[states.length - 1], ev, bounds))
  return states
}

describe('head-only retention (issue #217)', () => {
  test('every prefix of a rich log folds to the identical head under both retentions', () => {
    const events = richLog()
    const slim = fold(events, HEAD)
    const full = fold(events, FULL)
    assert.equal(slim.length, full.length)
    for (let i = 0; i < slim.length; i++) {
      const head = buildTimelineHead(slim[i])
      assert.deepStrictEqual(head, buildTimelineHead(full[i]), `head drift at prefix ${i} (seq ${events[i - 1]?.seq})`)
    }
  })

  test('the slim state drops the detail collections and slims the records', () => {
    const [state] = fold(richLog(), HEAD).slice(-1)
    assert.equal(state.spans.length, 0)
    assert.equal(state.fileOps.length, 0)
    assert.equal(state.archived.length, 0)
    assert.equal(state.events.length, 0, 'events are refolded on demand, not persisted head-side')
    assert.ok(state.requests.length <= 2, 'only the last request survives for the head last-value')
    for (const rec of state.commands) {
      assert.equal('cmd' in rec, false)
      assert.equal('description' in rec, false)
      assert.equal('cwd' in rec, false)
    }
    for (const node of state.surface) {
      assert.equal('text' in node, false)
      assert.equal('time' in node, false)
      assert.equal('form' in node, false)
      assert.equal('skill' in node, false)
      assert.equal('calls' in node, false)
    }
    for (const rec of state.requests) {
      assert.equal('system' in rec, false)
      assert.equal('cacheRead' in rec, false)
    }
  })

  test('a derived state keeps the optional node and request fields and skips junk commands', () => {
    const legacy = {
      surface: [
        { seq: 1, cat: 'assistant', tokens: 10, reasoning: 4, answerTokens: 5, callTokens: 1, imgs: 2, tool: 'bash' },
        { seq: 2, cat: 'user', tokens: 3 },
      ],
      requests: [
        { time: 1, seq: 1, total: 10, turn: 1, step: 0, prompt: 8, activeMs: 20 },
        { time: 2, seq: 2, total: 12 },
      ],
      commands: [
        { seq: 1, time: 1, tool: 'bash', call: 'c1', start: 1, status: 'completed', err: false },
        null,
        'junk',
      ],
      events: [],
      sums: { user: 1, inject: 0, skill: 0, assistant: 2, tool: 1 },
      spans: [{ kind: 'ttft', start: 0, end: 1 }],
      fileOps: [{ seq: 1, path: 'a', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      archived: [{ seq: 9, cat: 'user', tokens: 1, gone: 5 }],
      pendingCodeCmds: { rc1: [{ seq: 2, time: 2, tool: 'bash', call: 'rc1:code:0', cmd: 'long buffered command', start: 2, status: 'running', err: false }, 'junk'], rc2: 'not-an-array', rc3: ['junk'] },
    }
    const derived = deriveHeadState(legacy)
    assert.ok(derived !== undefined)
    const pending = derived.pendingCodeCmds?.rc1 ?? []
    assert.equal(pending.length, 1, 'junk pending entries drop')
    assert.equal('cmd' in pending[0], false, 'buffered commands slim too')
    assert.equal(derived.pendingCodeCmds?.rc2, undefined, 'a non-array root drops')
    assert.equal(derived.pendingCodeCmds?.rc3, undefined, 'a root of only junk drops')
    const emptyPending = deriveHeadState({ ...legacy, pendingCodeCmds: { only: ['junk'] } })
    assert.equal(emptyPending?.pendingCodeCmds, undefined, 'all-junk pending maps stay absent')
    assert.deepEqual(derived.surface[0], { seq: 1, cat: 'assistant', tokens: 10, reasoning: 4, answerTokens: 5, callTokens: 1, imgs: 2, tool: 'bash' })
    assert.deepEqual(derived.surface[1], { seq: 2, cat: 'user', tokens: 3 })
    assert.deepEqual(derived.requests[0], { time: 1, seq: 1, total: 10, turn: 1, step: 0, prompt: 8, activeMs: 20 })
    assert.deepEqual(derived.requests[1], { time: 2, seq: 2, total: 12 })
    assert.equal(derived.commands.length, 0, 'completed commands stay refold-only head-side')
    assert.equal(derived.events.length, 0)
    assert.deepEqual(derived.commandCalls, ['c1', 'rc1:code:0'], 'trimmed command call ids stay for the detail revision parity')
    assert.equal(derived.spans.length, 0)
    assert.equal(derived.fileOps.length, 0)
    assert.equal(derived.archived.length, 0)
  })

  test('the state schema accepts every slim state of the rich log', () => {
    const def = timelineDef({})
    for (const state of fold(richLog(), HEAD)) {
      const parsed = def.stateSchema.safeParse(structuredClone(state))
      assert.equal(parsed.success, true, `schema rejects a slim state: ${JSON.stringify(parsed.success ? null : (parsed as { error: { issues: unknown[] } }).error.issues.slice(0, 2))}`)
    }
  })

  test('the derived head state keeps the head exact and the persisted shape', () => {
    const full = fold(richLog(), FULL).at(-1)
    assert.ok(full !== undefined)
    const derived = deriveHeadState(structuredClone(full))
    assert.ok(derived !== undefined)
    assert.deepStrictEqual(buildTimelineHead(derived), buildTimelineHead(full))
    assert.equal(derived.spans.length, 0)
    assert.equal(derived.fileOps.length, 0)
    assert.equal(derived.archived.length, 0)
    assert.equal(derived.events.length, 0)
    assert.ok(derived.commands.every(rec => !('cmd' in rec) && !('description' in rec) && !('cwd' in rec)))
    assert.ok(derived.surface.every(node => !('text' in node)))
    const def = timelineDef({})
    def.stateSchema.parse(structuredClone(derived))
  })

  test('a derived mid-log state continues folding to the identical head', () => {
    const events = richLog()
    for (const cut of [1, 8, 21, events.length]) {
      const prefix = events.slice(0, cut)
      const tail = events.slice(cut)
      const last = fold(prefix, FULL).at(-1)
      assert.ok(last !== undefined)
      const derived = deriveHeadState(structuredClone(last))
      assert.ok(derived !== undefined)
      let state: TimelineState = derived
      for (const ev of tail) state = applyTimeline(state, ev, HEAD)
      const whole = fold(events, FULL).at(-1)
      assert.ok(whole !== undefined)
      assert.deepStrictEqual(
        buildTimelineHead(state),
        buildTimelineHead(whole),
        `derive+continue drift at cut ${cut}`,
      )
    }
  })

  test('a derived mid-log state continues folding to the head a slim fold from scratch reaches', () => {
    const events = richLog()
    const fromScratch = fold(events, HEAD).at(-1)
    assert.ok(fromScratch !== undefined)
    const derived = deriveHeadState(structuredClone(fold(events.slice(0, 12), FULL).at(-1)))
    assert.ok(derived !== undefined)
    let state: TimelineState = derived
    for (const ev of events.slice(12)) state = applyTimeline(state, ev, HEAD)
    assert.deepStrictEqual(buildTimelineHead(state), buildTimelineHead(fromScratch))
  })

  test('malformed legacy values refuse the derivation and stay on the refold path', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      { surface: 'nope', requests: [], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [], requests: [], commands: [], events: [], sums: { user: 'x' } },
      { surface: [null], requests: [], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [{ seq: 'x', cat: 'user', tokens: 1 }], requests: [], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [{ seq: 1, cat: 'weird', tokens: 1 }], requests: [], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [], requests: [{ seq: 'x' }], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [], requests: ['junk'], commands: [], events: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 } },
      { surface: [], requests: [], commands: [], events: [], sums: null },
    ]) {
      assert.equal(deriveHeadState(bad), undefined, JSON.stringify(bad) ?? String(bad))
    }
  })

  test('the head fold keeps the command tallies and surfaces but never parses or retains file-op arguments', () => {
    const events = [
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x', description: 'batch' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:code:0', name: 'bash', arguments: { command: 'git status' } }),
      codeDispatch(3, { rootCallId: 'rc1', subCallId: 'rc1:code:0', name: 'bash', arguments: { command: 'git status' }, content: [text('ok')] }),
      toolResult(4, { callId: 'rc1', content: text('done') }),
      toolCall(5, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'b.ts' }) }),
      toolResult(6, { callId: 'c1', content: text('b body') }),
      toolCall(7, { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'c.ts' }) }),
    ]
    const [slim] = fold(events, HEAD).slice(-1)
    assert.equal('pendingCodeOps' in slim, false)
    assert.equal(slim.fileOps.length, 0)
    assert.equal(slim.commands.length, 0, 'settled commands are refold-only')
    assert.equal(slim.commandCalls?.includes('rc1'), true)
    assert.equal(slim.commandCalls?.includes('rc1:code:0'), true)
    assert.equal(slim.commandStats?.runs, 2)
    for (const entry of Object.values(slim.callNames)) assert.equal('argsRaw' in entry, false)
    const [full] = fold(events, FULL).slice(-1)
    assert.equal(full.fileOps.length > 0, true)
    assert.equal(Object.values(full.callNames).some(entry => 'argsRaw' in entry), true)
  })

  test('a completed command keeps its tally and call id; a late patch moves both detail revisions', () => {
    const events = [
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }),
      toolResult(2, { callId: 'c1', content: text('done') }),
    ]
    const [slim] = fold(events, HEAD).slice(-1)
    const [full] = fold(events, FULL).slice(-1)
    assert.equal(slim.commands.length, 0)
    assert.deepEqual(slim.commandCalls, ['c1'])
    assert.equal(full.commands[0]?.cmd, 'ls')
    assert.equal(slim.commandStats?.runs, 1)
    assert.equal(full.commandStats?.runs, 1)
    const settled = jobSettled(3, { callId: 'c1', finishedAt: 9_000, status: 'killed', detail: 'signal: SIGKILL' })
    const patchedSlim = applyTimeline(slim, settled, HEAD)
    const patchedFull = applyTimeline(full, settled, FULL)
    assert.equal(patchedFull.commands[0]?.status, 'killed')
    assert.equal(patchedSlim.detailRev, patchedFull.detailRev, 'the detail revision moves together')
  })
})
})

describe('fold-ops', () => {

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

  test('a non-file call saves no raw arguments; str_replace_editor keeps and kinds them', () => {
    const def = fullDef()
    let state = def.apply(def.init(), toolCall(1, { callId: 'b1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }))
    state = def.apply(state, toolCall(2, {
      callId: 's1', name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: 'a.ts', view_range: [1, 3] }),
    }))
    assert.equal(state.callNames.b1?.name, 'bash')
    assert.ok(!('argsRaw' in (state.callNames.b1 ?? {})), 'a non-file call saves no raw arguments')
    assert.equal(state.callNames.s1?.argsRaw, JSON.stringify({ command: 'view', path: 'a.ts', view_range: [1, 3] }))
    state = def.apply(state, toolResult(3, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }))
    state = def.apply(state, toolResult(4, { callId: 's1', content: [{ type: 'text', text: 'ok' }] }))
    assert.deepEqual(state.fileOps.map(o => [o.kind, o.path, o.tool]), [['read', 'a.ts', 'str_replace_editor']])
  })

  test('call-argument shapes degrade: no arguments books no op, an object form normalizes', () => {
    const { state } = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read' } } as unknown as TimelineEvent,
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(state.fileOps, [], 'no arguments — no target')
    assert.equal(state.callNames.c1, undefined, 'the pending entry consumed at the result')
    const objectArgs = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: { file_path: 'a.ts' } } } as unknown as TimelineEvent,
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(objectArgs.state.fileOps.map(o => [o.kind, o.path]), [['read', 'a.ts']])
  })

  test('the error flag reads the message isError mark', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'no' }], error: true }),
      toolCall(3, { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'b.ts' }) }),
      {
        type: 'tool/result', seq: 4, time: 4,
        data: {
          error: true,
          message: { role: 'tool', toolCallId: 'c2', source: { kind: 'tool', callId: 'c2' }, content: [] },
        },
      } as unknown as TimelineEvent,
    ])
    assert.deepEqual(state.fileOps.map(o => o.err), [true, false])
  })
})

describe('the file-op log — Code Mode (PTC) sub-dispatches', () => {
  test('dispatches buffer under their run_code root and flush at its result with parent + program; an editor dispatch kinds by its command', () => {
    const drive = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ description: 'batch the reads' }) }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'read', arguments: { file_path: 'a.ts' } }),
      codeDispatch(3, { rootCallId: 'rc1', name: 'write', arguments: { file_path: 'b.ts', content: 'x\ny' } }),
      codeDispatch(4, { rootCallId: 'rc1', name: 'str_replace_editor', arguments: { command: 'view', path: 'c.ts' } }),
      toolResult(5, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(drive.state.pendingCodeOps, undefined, 'the buffer flushed and emptied')
    assert.deepEqual(drive.state.fileOps.map(o => [o.kind, o.path, o.parent ?? 0, o.program ?? '', o.added]), [
      ['read', 'a.ts', 5, 'batch the reads', 0],
      ['write', 'b.ts', 5, 'batch the reads', 2],
      ['read', 'c.ts', 5, 'batch the reads', 0],
    ])
    assertStatesPlainJson(drive)
    const interleaved = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: '{}' }),
      codeDispatch(3, { rootCallId: 'rc1', name: 'read', arguments: { file_path: 'a.ts' } }),
      codeDispatch(4, { rootCallId: 'rc2', name: 'read', arguments: { file_path: 'b.ts' } }),
      toolResult(5, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
      toolResult(6, { callId: 'rc2', content: [{ type: 'text', text: 'ok' }] }),
    ]).state
    assert.deepEqual(interleaved.fileOps.map(o => [o.path, o.parent ?? 0]), [['a.ts', 5], ['b.ts', 6]])
  })

  test('a non-file dispatch books nothing; a junk dispatch envelope is dropped whole', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' }),
      codeDispatch(2, { rootCallId: 'rc1', name: 'bash', arguments: { command: 'ls' } }),
      { type: 'tool/ptc-dispatch', seq: 3, time: 3, data: null } as unknown as TimelineEvent,
      codeDispatch(4, { name: 'read' }),
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

  test('the schema accepts an op-bearing state; the detail serves detached copies and the slim head omits the log', () => {
    const { def, state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }], meta: readMeta('a.ts', 1, 2) }),
    ])
    def.stateSchema.parse(structuredClone(state))
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.fileOps?.length, 1)
    assert.notEqual(detail.fileOps?.[0], state.fileOps[0], 'the served op never aliases the state')
    const read = detail.fileOps?.[0].read
    assert.ok(read !== undefined && 'start' in read)
    assert.equal(read.start, 1)
    const slim = timelineDef({}, true)
    const inline = timelineDef({}, false)
    assert.equal('fileOps' in slim.wire.view(state), false)
    const full = inline.wire.view(state)
    assert.equal(full.fileOps?.length, 1)
    assert.equal(inline.wire.viewSchema.safeParse(full).success, true)
  })
})
})
