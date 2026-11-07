import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { resolveBounds, type FoldBounds } from '../../src/host/config'
import { applyTimeline, type TimelineEvent } from '../../src/host/fold'
import { createTimelineState, deriveHeadState, noteCommandCall, trimState, trimHeadState, type TimelineState } from '../../src/host/foldState'
import { jobRegistered, jobSettled, planMode } from './helpers/events'

const FULL: FoldBounds = resolveBounds({})
const HEAD: FoldBounds = { ...FULL, headOnly: true }

function rec(call?: string, over: Record<string, unknown> = {}) {
  return { seq: 1, time: 1, tool: 'bash' as const, start: 1, status: 'completed' as const, err: false, ...(call === undefined ? {} : { call }), ...over }
}

describe('head state slimming', () => {
  test('trimHeadState keeps only the head needs', () => {
    const st = createTimelineState()
    st.requests.push(...Array.from({ length: 5 }, (_, i) => ({ seq: i, time: i, total: i })))
    st.events.push({ seq: 1, time: 1, kind: 'inject', form: 'context' })
    st.commands.push(rec('done'), rec('running', { status: 'running' }), ...Array.from({ length: 20 }, (_, i) => rec('r' + i, { status: 'running' })))
    st.fileOps.push({ seq: 1, path: 'a', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 })
    st.spans.push({ kind: 'text', start: 1, end: 2 })
    st.archived.push({ seq: 1, cat: 'user', tokens: 1 })
    trimHeadState(st)
    assert.deepEqual(st.requests.map(r => r.seq), [3, 4])
    assert.deepEqual(st.events, [])
    assert.equal(st.commands.length, 16)
    assert.ok(st.commands.every(command => command.status === 'running'))
    assert.deepEqual(st.fileOps, [])
    assert.deepEqual(st.spans, [])
    assert.deepEqual(st.archived, [])
  })

  test('noteCommandCall ignores empty ids, dedupes, and caps the ledger', () => {
    const st = createTimelineState()
    noteCommandCall(st, '')
    assert.equal(st.commandCalls === undefined, true)
    noteCommandCall(st, 'a')
    noteCommandCall(st, 'a')
    noteCommandCall(st, 'b')
    assert.deepEqual(st.commandCalls, ['a', 'b'])
    for (let i = 0; i < 1030; i++) noteCommandCall(st, 'x' + i)
    assert.equal(st.commandCalls?.length, 1024)
    assert.equal(st.commandCalls?.[0], 'x' + (1030 - 1024))
    assert.equal(st.commandCallsOverflow, true, 'evicting call ids turns on the overflow fallback')
    const overflowed = applyTimeline({ ...createTimelineState(), detailRev: 1, commandCalls: ['old'], commandCallsOverflow: true }, jobSettled(9, { callId: 'evicted', finishedAt: 9, status: 'completed' }), HEAD)
    assert.equal(overflowed.detailRev, 2, 'late settlements of evicted ids still refresh the detail revision')
  })

  test('a derived state skips call-less records and caps the carried ids', () => {
    const commands = Array.from({ length: 1030 }, (_, i) => rec('call-' + i))
    commands.push(rec())
    const derived = deriveHeadState({
      surface: [],
      requests: [],
      commands,
      pendingCodeCmds: { root: [rec(), rec('sub-call')] },
      events: [],
      sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    })
    assert.ok(derived !== undefined)
    assert.equal(derived.commandCalls?.length, 1024)
    assert.equal(derived.commandCalls?.at(-1), 'sub-call')
  })

  test('non-head trim still ages the archive window and records the floor', () => {
    const st = createTimelineState()
    st.requests.push({ seq: 10, time: 1, total: 1 })
    st.archived.push(
      { seq: 1, cat: 'user', tokens: 1, gone: 5 },
      { seq: 2, cat: 'user', tokens: 1, gone: 6 },
      { seq: 3, cat: 'user', tokens: 1, gone: 12 },
    )
    trimState(st, { ...FULL, maxArchiveNodes: 1 })
    assert.deepEqual(st.archived.map(n => n.seq), [3])
    assert.equal(st.archiveFloor, 6)
    const capped = createTimelineState()
    capped.requests.push({ seq: 0, time: 1, total: 1 })
    capped.archived.push(
      { seq: 1, cat: 'user', tokens: 1, gone: 5 },
      { seq: 2, cat: 'user', tokens: 1, gone: 6 },
      { seq: 3, cat: 'user', tokens: 1, gone: 7 },
    )
    trimState(capped, { ...FULL, maxArchiveNodes: 2 })
    assert.deepEqual(capped.archived.map(n => n.seq), [2, 3])
    assert.equal(capped.archiveFloor, 5)
    const floorless = createTimelineState()
    floorless.archived.push({ seq: 1, cat: 'user', tokens: 1 }, { seq: 2, cat: 'user', tokens: 1 })
    trimState(floorless, { ...FULL, maxArchiveNodes: 1 })
    assert.deepEqual(floorless.archived.map(n => n.seq), [2])
    assert.equal(floorless.archiveFloor, undefined)
    const unaged = createTimelineState()
    unaged.requests.push({ seq: 10, time: 1, total: 1 })
    unaged.archived.push({ seq: 1, cat: 'user', tokens: 1 })
    trimState(unaged, { ...FULL, maxArchiveNodes: 2 })
    assert.deepEqual(unaged.archived.map(n => n.seq), [1], 'a `gone`-less entry never ages out by request seq')
  })

  test('job events bump the detail revision when the head command row was trimmed', () => {
    const state = { ...createTimelineState(), detailRev: 4, commandCalls: ['c1'] }
    const patched = applyTimeline(state, jobRegistered(5, { callId: 'c1', startedAt: 10 }), HEAD)
    assert.equal(patched.detailRev, 5)
    const settled = applyTimeline(patched, jobSettled(6, { callId: 'c1', finishedAt: 20, status: 'completed' }), HEAD)
    assert.equal(settled.detailRev, 6)
    const unknown = applyTimeline(settled, jobSettled(7, { callId: 'ghost', finishedAt: 30, status: 'completed' }), HEAD)
    assert.equal(unknown, settled)
    const unknownRegistered = applyTimeline(settled, jobRegistered(8, { callId: 'ghost', startedAt: 30 }), HEAD)
    assert.equal(unknownRegistered, settled)
  })

  test('a failed buffered patch still bumps when the call id is known head-side', () => {
    const state: TimelineState = {
      ...createTimelineState(),
      detailRev: 2,
      commandCalls: ['c9'],
      pendingCodeCmds: { root: [rec('other', { status: 'running' })] },
    }
    const patched = applyTimeline(state, jobRegistered(5, { callId: 'c9', startedAt: 10 }), HEAD)
    assert.equal(patched.detailRev, 3)
    const miss = applyTimeline(state, jobRegistered(5, { callId: 'zz', startedAt: 10 }), HEAD)
    assert.equal(miss, state)
    const settledState: TimelineState = {
      ...createTimelineState(),
      detailRev: 2,
      commandCalls: ['c9'],
      pendingCodeCmds: { root: [rec('other', { status: 'running' })] },
    }
    const settled = applyTimeline(settledState, jobSettled(6, { callId: 'c9', finishedAt: 20, status: 'completed' }), HEAD)
    assert.equal(settled.detailRev, 3)
    const settledMiss = applyTimeline(settledState, jobSettled(6, { callId: 'zz', finishedAt: 20, status: 'completed' }), HEAD)
    assert.equal(settledMiss, settledState)
  })

  test('the head plan-mode and compaction events still drop detail rows', () => {
    const st = { ...createTimelineState(), detailRev: 1 }
    const next = applyTimeline(st, planMode(2, { active: true }) as TimelineEvent, HEAD)
    assert.equal(next.detailRev, 2)
    assert.deepEqual(next.events, [])
  })
})
