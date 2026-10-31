import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveBounds } from '../../src/host/config'
import { TIMELINE_STATE_VERSION } from '../../src/host/timeline'
import { watchTimelineRowSweep } from '../../src/host/sweep'
import { buildTimelineHead } from '../../src/host/foldWire'
import { applyTimeline, createTimelineState } from '../../src/host/fold'
import type { TimelineEvent } from '../../src/host/fold'
import type { TimelineState } from '../../src/host/foldState'
import { assistantMessage, header, toolCall, toolResult, userMessage } from './helpers/events'

const ROW_KEY = 'contextTimeline'
const LEGACY_VERSION = 36

interface Row {
  ver: number
  seq: number
  val: unknown
}

interface RecordShape {
  identity: Record<string, unknown>
  rows: Record<string, Row>
}

interface TableHarness {
  records: Map<string, RecordShape>
  updates: number
  failNext: boolean
}

function fullVal(): TimelineState {
  const events: TimelineEvent[] = [
    header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
    toolCall(3, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la plus a long command payload'.repeat(40) }) }),
    toolResult(4, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    assistantMessage(5, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
  ]
  let state = createTimelineState()
  for (const ev of events) state = applyTimeline(state, ev, resolveBounds({}))
  return state
}

function ctxOf(table: TableHarness | undefined, onFirstUpdate?: () => void): { ctx: Context; ran: () => Promise<void> } {
  let launch: (() => void) | undefined
  const facility = table === undefined
    ? undefined
    : {
      get: (name: string) => name === 'session_projcache'
        ? { table: (name2: string) => name2 === 'sessions' ? tableFace(table, onFirstUpdate) : undefined }
        : undefined,
    }
  const ctx = {
    get: (name: string) => name === 'storageDomain' ? facility : undefined,
    logger: {
      info: () => {},
      warn: () => {},
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (deps.every(d => d === 'sessionProjectionCache' || d === 'storageDomain')) launch = () => {
        const result = cb(ctx)
        if (typeof result === 'function') result()
      }
    },
  }
  return {
    ctx: ctx as unknown as Context,
    ran: async () => {
      assert.ok(launch !== undefined, 'the sweep armed')
      launch!()
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

function tableFace(harness: TableHarness, onFirstUpdate?: () => void) {
  let hooked = false
  return {
    entries: () => harness.records.entries(),
    update: async (id: string, fn: (current: RecordShape) => RecordShape) => {
      harness.updates++
      if (onFirstUpdate !== undefined && !hooked) {
        hooked = true
        onFirstUpdate()
      }
      if (harness.failNext) {
        harness.failNext = false
        throw new Error('write failed')
      }
      const next = fn(harness.records.get(id)!)
      harness.records.set(id, next)
      return next
    },
  }
}

function legacyRecord(val: unknown, ver = LEGACY_VERSION): RecordShape {
  return {
    identity: { formatVersion: 4, createdAt: 1, cwd: '/w', isSeeded: false, inheritedEventCount: 0 },
    rows: {
      [ROW_KEY]: { ver, seq: 5, val },
      contextHeaders: { ver: 1, seq: 5, val: { headers: [] } },
    },
  }
}

describe('the timeline row sweep (issue #217)', () => {
  test('a legacy full row rewrites to the head-only shape, exact head, other rows and identity intact', async () => {
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(structuredClone(fullVal()))]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 1)
    const row = harness.records.get('s1')!.rows[ROW_KEY]
    assert.equal(row.ver, TIMELINE_STATE_VERSION)
    assert.equal(row.seq, 5)
    const val = row.val as TimelineState
    assert.equal(val.spans.length, 0)
    assert.equal(val.fileOps.length, 0)
    assert.equal(val.archived.length, 0)
    assert.ok(val.surface.every((node: { text?: unknown }) => !('text' in node)))
    assert.equal('contextHeaders' in harness.records.get('s1')!.rows, true, 'sibling rows survive')
    assert.deepEqual(harness.records.get('s1')!.identity.createdAt, 1)
  })

  test('the migrated row serves the same head the legacy row served', async () => {
    const val = fullVal()
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(structuredClone(val))]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    const migrated = harness.records.get('s1')!.rows[ROW_KEY].val as TimelineState
    assert.deepStrictEqual(buildTimelineHead(migrated), buildTimelineHead(val))
  })

  test('current-version rows, foreign versions, and malformed values are skipped', async () => {
    const harness: TableHarness = {
      records: new Map([
        ['current', legacyRecord(fullVal(), TIMELINE_STATE_VERSION)],
        ['older', legacyRecord(fullVal(), 30)],
        ['malformed', legacyRecord({ surface: 'junk' })],
        ['norow', { identity: {}, rows: {} }],
      ]),
      updates: 0,
      failNext: false,
    }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 0)
  })

  test('a concurrent current-version write at the update slot leaves the row untouched', async () => {
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(fullVal())]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness, () => {
      harness.records.set('s1', legacyRecord(fullVal(), TIMELINE_STATE_VERSION))
    })
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 1)
    const row = harness.records.get('s1')!.rows[ROW_KEY]
    assert.equal(row.ver, TIMELINE_STATE_VERSION, 'the row keeps whichever current version won')
    assert.notEqual(row.val, undefined)
  })

  test('a failed write skips the record fail-soft and the sweep continues', async () => {
    const harness: TableHarness = {
      records: new Map([
        ['bad', legacyRecord(fullVal())],
        ['good', legacyRecord(fullVal())],
      ]),
      updates: 0,
      failNext: true,
    }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.records.get('bad')!.rows[ROW_KEY].ver, LEGACY_VERSION, 'the failed row stays on the refold path')
    assert.equal(harness.records.get('good')!.rows[ROW_KEY].ver, TIMELINE_STATE_VERSION, 'the sweep moved on')
  })

  test('a missing domain or table arms nothing', async () => {
    const { ctx, ran } = ctxOf(undefined)
    watchTimelineRowSweep(ctx)
    await ran()
  })

  test('a junk domain or table face arms nothing', async () => {
    for (const domain of ['junk', {}, { table: () => 'junk' }, { table: () => ({}) }]) {
      const facility = { get: (name: string) => name === 'session_projcache' ? domain : undefined }
      const ctx = {
        get: (name: string) => name === 'storageDomain' ? facility : undefined,
        logger: { info: () => {}, warn: () => {} },
        inject(deps: string[], cb: (c: unknown) => unknown) {
          if (deps.every(d => d === 'sessionProjectionCache' || d === 'storageDomain')) cb(ctx)
        },
      }
      watchTimelineRowSweep(ctx as unknown as Context)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  test('a hostile table rejects the sweep through the outer guard', async () => {
    const facility = {
      get: (name: string) => name === 'session_projcache'
        ? { table: () => ({ entries: () => { throw new Error('quarantined') }, update: () => Promise.resolve(undefined) }) }
        : undefined,
    }
    const warnings: string[] = []
    const ctx = {
      get: (name: string) => name === 'storageDomain' ? facility : undefined,
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => d === 'sessionProjectionCache' || d === 'storageDomain')) cb(ctx)
      },
    }
    watchTimelineRowSweep(ctx as unknown as Context)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(warnings.some(message => message.includes('quarantined')), 'the outer guard reports the rejection')
  })
})
