import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { resolveBounds } from '../../src/host/config'
import { applyTimeline, type TimelineEvent, type TimelineState } from '../../src/host/fold'
import { buildTimelineHead } from '../../src/host/foldWire'
import { createTimelineState, deriveHeadState } from '../../src/host/foldState'
import type { FoldBounds } from '../../src/host/config'
import { timelineDef } from './helpers/projection'
import {
  assistantAttempt,
  assistantMessage,
  codeDispatch,
  codeDispatchStart,
  compaction,
  endSeed,
  header,
  jobRegistered,
  jobSettled,
  planMode,
  requestContext,
  stepEnd,
  stepStart,
  systemMessage,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events'

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
    assert.equal(derived.commands.length, 1, 'junk command entries drop')
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

  test('a completed command keeps its fold pairing record without the heavy text; a late patch lands on both', () => {
    const events = [
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }),
      toolResult(2, { callId: 'c1', content: text('done') }),
    ]
    const [slim] = fold(events, HEAD).slice(-1)
    const [full] = fold(events, FULL).slice(-1)
    assert.equal(slim.commands.length, 1)
    assert.equal(slim.commands[0]?.status, 'completed')
    assert.equal('cmd' in slim.commands[0], false)
    assert.equal(full.commands[0]?.cmd, 'ls')
    assert.equal(slim.commandStats?.runs, 1)
    assert.equal(full.commandStats?.runs, 1)
    const settled = jobSettled(3, { callId: 'c1', finishedAt: 9_000, status: 'killed', detail: 'signal: SIGKILL' })
    const patchedSlim = applyTimeline(slim, settled, HEAD)
    const patchedFull = applyTimeline(full, settled, FULL)
    assert.equal(patchedSlim.commands[0]?.status, 'killed', 'the slim record still patches')
    assert.equal(patchedFull.commands[0]?.status, 'killed')
    assert.equal(patchedSlim.detailRev, patchedFull.detailRev, 'the detail revision moves together')
  })
})
