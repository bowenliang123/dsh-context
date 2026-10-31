import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { compactCacheRecord, watchCacheCompaction } from '../../src/host/cacheCompact'
import { resolveBounds } from '../../src/host/config'
import { createTimelineState } from '../../src/host/foldState'

const BOUNDS = resolveBounds({})

function recordOf(rows: Record<string, unknown>): Record<string, unknown> {
  return { identity: { createdAt: 1 }, rows }
}

function tableOf(records: Map<string, unknown>, opts: { failUpdate?: boolean; failEntries?: boolean } = {}): {
  entries(): IterableIterator<[string, unknown]>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
} {
  return {
    entries() {
      if (opts.failEntries === true) throw new Error('entries down')
      return [...records.entries()][Symbol.iterator]()
    },
    async update(key, fn) {
      if (opts.failUpdate === true) throw new Error('write down')
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    },
  }
}

function ctxOf(spec: {
  storage?: unknown
  table?: ReturnType<typeof tableOf>
}): { ctx: Context; disposers: (() => void)[]; logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } } {
  const disposers: (() => void)[] = []
  const logger = { info: vi.fn(), warn: vi.fn() }
  const services = new Map<string, unknown>([
    ['storageDomain', spec.storage ?? { get: () => (spec.table === undefined ? undefined : { table: () => spec.table }) }],
    ['sessionProjectionCache', {}],
  ])
  const ctx = {
    logger,
    inject(_deps: string[], cb: (c: unknown) => unknown) {
      const cleanup = cb({ get: (name: string) => services.get(name) })
      if (typeof cleanup === 'function') disposers.push(cleanup as () => void)
    },
  }
  return { ctx: ctx as unknown as Context, disposers, logger }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150))
}

describe('compactCacheRecord', () => {
  test('compacts a legacy timeline row and preserves every other row and record field', () => {
    const legacy = createTimelineState()
    const record = { identity: { createdAt: 7 }, rows: { title: { ver: 1, seq: 1, val: 't' }, contextTimeline: { ver: 36, seq: 3, val: legacy } } }
    const compacted = compactCacheRecord(record, BOUNDS) as typeof record
    assert.notEqual(compacted, record)
    assert.deepEqual(compacted.identity, record.identity)
    assert.deepEqual(compacted.rows.title, record.rows.title)
    assert.equal(compacted.rows.contextTimeline.ver, 36)
    assert.equal(compacted.rows.contextTimeline.seq, 3)
    const state = compacted.rows.contextTimeline.val as ReturnType<typeof createTimelineState>
    assert.equal(state.compact, true)
    assert.equal(state.head.turns, 0)
    assert.deepEqual(state.events, [])
  })

  test('leaves a compact, absent, or malformed timeline row untouched', () => {
    const compact = createTimelineState(false)
    const compactRecord = recordOf({ contextTimeline: { ver: 36, seq: 1, val: compact } })
    assert.equal(compactCacheRecord(compactRecord, BOUNDS), compactRecord)
    const missing = recordOf({ title: { ver: 1, seq: 1, val: 't' } })
    assert.equal(compactCacheRecord(missing, BOUNDS), missing)
    const malformed = recordOf({ contextTimeline: { ver: 36, seq: 1, val: { bogus: true } } })
    assert.equal(compactCacheRecord(malformed, BOUNDS), malformed)
    const otherVersion = recordOf({ contextTimeline: { ver: 35, seq: 1, val: createTimelineState() } })
    assert.equal(compactCacheRecord(otherVersion, BOUNDS), otherVersion, 'another generation owns its payload')
    const empty = {}
    assert.equal(compactCacheRecord(empty, BOUNDS), empty)
  })

  test('repairs a head-marked row that lost its counters by recompacting it', () => {
    const headless = { ...createTimelineState(false), head: undefined } as unknown as ReturnType<typeof createTimelineState>
    const record = recordOf({ contextTimeline: { ver: 36, seq: 1, val: headless } })
    const compacted = compactCacheRecord(record, BOUNDS) as ReturnType<typeof recordOf>
    assert.notEqual(compacted, record)
    const state = (compacted.rows as Record<string, { val: ReturnType<typeof createTimelineState> }>).contextTimeline.val
    assert.equal(state.compact, true)
    assert.equal(state.head.turns, 0)
  })
})

describe('watchCacheCompaction', () => {
  test('rewrites legacy records, skips compact and malformed ones, and logs the tally', async () => {
    const records = new Map<string, unknown>([
      ['legacy', recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState() } })],
      ['compact', recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState(false) } })],
      ['broken', recordOf({ contextTimeline: { ver: 36, seq: 1, val: null } })],
      ['other', recordOf({ title: { ver: 1, seq: 1, val: 't' } })],
    ])
    const table = tableOf(records)
    const { ctx, logger } = ctxOf({ table })
    watchCacheCompaction(ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    const legacy = (records.get('legacy') as { rows: { contextTimeline: { val: { compact?: unknown } } } }).rows.contextTimeline.val
    assert.equal(legacy.compact, true)
        assert.equal(logger.info.mock.calls.length, 1)
    assert.match(String(logger.info.mock.calls[0][0]), /compacted 1 legacy/)
    assert.equal(logger.warn.mock.calls.length, 0)
  })

  test('a sparse yield cadence still completes the sweep', async () => {
    const records = new Map<string, unknown>([
      ['legacy', recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState() } })],
    ])
    const { ctx, logger } = ctxOf({ table: tableOf(records) })
    watchCacheCompaction(ctx, BOUNDS, { delayMs: 0, yieldEvery: 10 })
    await settle()
    const legacy = (records.get('legacy') as { rows: { contextTimeline: { val: { compact?: unknown } } } }).rows.contextTimeline.val
    assert.equal(legacy.compact, true)
    assert.equal(logger.info.mock.calls.length, 1)
  })

  test('a concurrent replacement is recompacted only when it is still legacy', async () => {
    const legacy = recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState() } })
    const compact = recordOf({ contextTimeline: { ver: 36, seq: 2, val: createTimelineState(false) } })
    const records = new Map<string, unknown>([['legacy', legacy]])
    let swapped = false
    const table = {
      entries: () => [...records.entries()][Symbol.iterator](),
      async update(key: string, fn: (current: unknown) => unknown) {
        if (!swapped) { swapped = true; records.set(key, compact) }
        const next = fn(records.get(key))
        records.set(key, next)
        return next
      },
    }
    const { ctx, logger } = ctxOf({ table })
    watchCacheCompaction(ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(records.get('legacy'), compact)
    assert.equal(logger.info.mock.calls.length, 0, 'a compact replacement never counts as a rewrite')
  })

  test('a missing domain, a throwing storage lookup, or a throwing table stays silent', async () => {
    const missing = ctxOf({ storage: { get: () => undefined } })
    watchCacheCompaction(missing.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(missing.logger.info.mock.calls.length, 0)
    assert.equal(missing.logger.warn.mock.calls.length, 0)
    const throwingGet = ctxOf({ storage: { get: () => { throw new Error('lookup down') } } })
    watchCacheCompaction(throwingGet.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(throwingGet.logger.warn.mock.calls.length, 0)
    const throwingTable = ctxOf({ storage: { get: () => ({ table: () => { throw new Error('table down') } }) } })
    watchCacheCompaction(throwingTable.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(throwingTable.logger.warn.mock.calls.length, 0)
    const noFace = ctxOf({ storage: {} })
    watchCacheCompaction(noFace.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(noFace.logger.info.mock.calls.length, 0)
    const noUpdate = ctxOf({ storage: { get: () => ({ table: () => ({ entries: () => [][Symbol.iterator]() }) }) } })
    watchCacheCompaction(noUpdate.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(noUpdate.logger.info.mock.calls.length, 0)
  })

  test('write failures are contained per record; an iteration failure logs a warning', async () => {
    const records = new Map<string, unknown>([
      ['legacy', recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState() } })],
    ])
    const failingWrite = ctxOf({ table: tableOf(records, { failUpdate: true }) })
    watchCacheCompaction(failingWrite.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(failingWrite.logger.warn.mock.calls.length, 0, 'a failed write stays fail-soft without a warning')
    const failingEntries = ctxOf({ table: tableOf(records, { failEntries: true }) })
    watchCacheCompaction(failingEntries.ctx, BOUNDS, { delayMs: 0, yieldEvery: 1 })
    await settle()
    assert.equal(failingEntries.logger.warn.mock.calls.length, 1)
    assert.match(String(failingEntries.logger.warn.mock.calls[0][0]), /compaction stopped/)
  })

  test('disposing the plugin fiber before the delay cancels the sweep', async () => {
    const records = new Map<string, unknown>([
      ['legacy', recordOf({ contextTimeline: { ver: 36, seq: 1, val: createTimelineState() } })],
    ])
    const table = tableOf(records)
    const { ctx, disposers, logger } = ctxOf({ table })
    watchCacheCompaction(ctx, BOUNDS, { delayMs: 5, yieldEvery: 1 })
    for (const dispose of disposers) dispose()
    await settle()
    assert.equal(logger.info.mock.calls.length, 0)
    const legacy = (records.get('legacy') as { rows: { contextTimeline: { val: { compact?: unknown } } } }).rows.contextTimeline.val
    assert.equal(legacy.compact, undefined)
  })
})
