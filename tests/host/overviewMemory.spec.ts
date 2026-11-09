import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { boot, call, summaryOf, pageOf, tallyOf, revisionOf, recordOf, timelineOf, usageOf, dayOf, currentOf, type BootOptions } from './helpers/overview'
import type { DurableIdentity, OverviewCache } from '../../src/host/overviewCache'
import type { HostSession } from '../../src/host/overviewCorpus'
import type { ActivityDay } from '../../src/shared/types'

const PERSISTENCE = {
  stat: async (id: string): Promise<unknown> => ({ header: { id }, location: { path: `/logs/${id}` }, sizeBytes: 10 }),
}

function identityOf(id: string, sizeBytes = 10, mtimeMs = 5): DurableIdentity {
  return { path: `/logs/${id}`, sizeBytes, mtimeMs }
}

function hostSessionOf(id: string, options: { turns?: number; tokens?: number } = {}): HostSession {
  const tokens = options.tokens ?? 12
  const day: ActivityDay = { tokens, requests: 1, turns: options.turns ?? 1, cost: usageOf(tokens, 0, 0, 1) }
  return {
    id,
    title: `Cached ${id}`,
    cwd: `/repo/${id}`,
    updatedAt: 1_000 + tokens,
    blank: false,
    signature: 'stale-signature',
    timeline: {
      current: currentOf(tokens * 10),
      total: tokens * 10,
      turns: options.turns ?? 1,
      cost: usageOf(tokens, 0, 0, 1),
    },
    activity: { days: { '2026-11-01': day } },
  }
}

function valuesOf(tokens: number, turns = 1): Record<string, unknown> {
  return {
    contextTimeline: timelineOf({ total: tokens * 10, turns, cost: usageOf(tokens, 0, 0, 1) }),
    contextActivity: { days: { '2026-11-01': dayOf(tokens, 1, { turns, cost: usageOf(tokens, 0, 0, 1) }) } },
    title: `Session ${tokens}`,
    sessionListMetadata: { blank: false, lastPromptAt: 1_000 + tokens },
  }
}

async function identityBoot(options: BootOptions = {}) {
  const harness = await boot({
    persistence: PERSISTENCE,
    records: [recordOf('a'), recordOf('b')],
    values: { a: valuesOf(10), b: valuesOf(20) },
    ...options,
  })
  return harness
}

function seedIdentities(harness: Awaited<ReturnType<typeof boot>>): void {
  harness.state.captureIdentities.set('a', identityOf('a'))
  harness.state.captureIdentities.set('b', identityOf('b'))
}

function seedDisk(harness: Awaited<ReturnType<typeof boot>>): void {
  for (const record of harness.state.savedRecords) {
    harness.state.cachedSessions.set(record.session.id, record.session)
    harness.state.cachedIdentities.set(record.session.id, record.identity)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('overview memory: disk cache, idle release, incremental updates', () => {
  test('the first paint captures durable identities, persists cold rows, and keeps unchanged polls tiny', async () => {
    const harness = await identityBoot()
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.deepEqual(harness.calls.cached.sort(), ['a', 'b'], 'both cold rows are read from the projection cache')
    assert.equal(harness.cache.loadCalls, 1)
    assert.equal(harness.cache.captureCalls.length, 1)
    assert.deepEqual(harness.cache.captureCalls[0].ids.sort(), ['a', 'b'])
    assert.equal(typeof harness.cache.captureCalls[0].host.stat, 'function')
    assert.equal(harness.cache.saveCalls, 1, 'the full paint schedules one cache save')
    assert.equal(harness.state.savedRecords.length, 2)
    assert.deepEqual(harness.state.savedRecords.map(record => record.session.id).sort(), ['a', 'b'])
    assert.ok(harness.state.savedRecords.every(record => record.identity !== null))
    const revision = revisionOf(first)
    assert.ok(first.bytes < 2_048)
    const unchanged = await call(harness, { part: 'summary', revision })
    assert.deepEqual(unchanged.reply.value, { revision, unchanged: true })
    assert.ok(unchanged.bytes < 400, `the unchanged poll stays tiny (${unchanged.bytes} B)`)
    harness.dispose()
  })

  test('a large cold corpus captures durable identities in the background so the first paint is not blocked', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `s${index}`)
    const records = ids.map(id => recordOf(id))
    const values = Object.fromEntries(ids.map(id => [id, valuesOf(10)]))
    const harness = await boot({ persistence: PERSISTENCE, records, values })
    for (const id of ids) harness.state.captureIdentities.set(id, identityOf(id))
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 130)
    const second = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(second).sessions, 130)
    await sleep(800)
    assert.equal(harness.cache.captureCalls.length, 1, 'one background pass captured every new id')
    assert.deepEqual(harness.cache.captureCalls[0].ids.sort(), [...ids].sort())
    assert.ok(harness.cache.saveCalls >= 1, 'the captured identities reach the disk cache')
    assert.equal(harness.state.savedRecords.length, 130)
    assert.ok(harness.state.savedRecords.every(record => record.identity !== null))
    harness.dispose()
  })

  test('a background capture waits for a running backfill pass before the durable stat sweep', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `w${index}`)
    const harness = await boot({
      persistence: PERSISTENCE,
      records: ids.map(id => recordOf(id)),
      values: Object.fromEntries(ids.map(id => [id, valuesOf(10)])),
    })
    for (const id of ids) harness.state.captureIdentities.set(id, identityOf(id))
    harness.state.coverage.running = true
    await call(harness, { part: 'summary' })
    await sleep(800)
    assert.equal(harness.cache.captureCalls.length, 0, 'the capture waits while the backfill pass runs')
    harness.state.coverage.running = false
    await sleep(1_500)
    assert.equal(harness.cache.captureCalls.length, 1, 'the capture starts once the backfill pass finishes')
    harness.dispose()
  })

  test('a capture waiting on an unverified backfill starts once coverage completes, and a disposed route starts nothing', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `c${index}`)
    const harness = await boot({
      persistence: PERSISTENCE,
      records: ids.map(id => recordOf(id)),
      values: Object.fromEntries(ids.map(id => [id, valuesOf(10)])),
    })
    for (const id of ids) harness.state.captureIdentities.set(id, identityOf(id))
    harness.state.coverage = { ...harness.state.coverage, complete: false, running: false }
    await call(harness, { part: 'summary' })
    await sleep(800)
    assert.equal(harness.cache.captureCalls.length, 0, 'an unverified backfill holds the capture back')
    harness.state.coverage = { ...harness.state.coverage, complete: true }
    await sleep(1_500)
    assert.equal(harness.cache.captureCalls.length, 1)
    harness.dispose()

    const disposed = await boot({
      persistence: PERSISTENCE,
      records: ids.map(id => recordOf(id)),
      values: Object.fromEntries(ids.map(id => [id, valuesOf(10)])),
    })
    for (const id of ids) disposed.state.captureIdentities.set(id, identityOf(id))
    disposed.state.coverage = { ...disposed.state.coverage, complete: false, running: true }
    await call(disposed, { part: 'summary' })
    disposed.dispose()
    await sleep(1_200)
    assert.equal(disposed.cache.captureCalls.length, 0, 'a disposed route never captures')
  })

  test('a failing background capture degrades to unvalidated rows instead of failing the paint', async () => {
    const ids = Array.from({ length: 130 }, (_, index) => `f${index}`)
    const harness = await boot({
      persistence: PERSISTENCE,
      records: ids.map(id => recordOf(id)),
      values: Object.fromEntries(ids.map(id => [id, valuesOf(10)])),
    })
    harness.state.captureThrows = true
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 130)
    await sleep(800)
    assert.equal(harness.cache.captureCalls.length, 1)
    const second = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(second).sessions, 130, 'the route keeps serving after a capture failure')
    harness.dispose()
  })

  test('an idle release flushes the cache; the warm reload reuses persisted rows without projection reads', async () => {
    const harness = await identityBoot({ idleMs: 5 })
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    const readsAfterFirst = harness.calls.cached.length
    seedDisk(harness)
    const ghost = hostSessionOf('ghost')
    harness.state.cachedSessions.set('ghost', ghost)
    harness.state.cachedIdentities.set('ghost', identityOf('ghost'))
    await sleep(20)
    assert.ok(harness.cache.flushCalls >= 1, 'the idle release flushes the debounced write')
    const idlePoll = await call(harness, { part: 'summary', revision })
    assert.deepEqual(idlePoll.reply.value, { revision, unchanged: true }, 'a released feed still answers unchanged')
    assert.ok(idlePoll.bytes < 400)
    assert.equal(harness.calls.cached.length, readsAfterFirst, 'an unchanged poll rebuilds nothing')
    harness.state.foldedVersion = 1
    harness.state.foldedIds = ['a']
    const refreshed = await call(harness, { part: 'summary', revision })
    assert.equal(summaryOf(refreshed).sessions, 2, 'a data change reloads the warm rows')
    assert.equal(harness.calls.cached.length, readsAfterFirst + 1, 'only the folded session refolds on the warm reload')
    assert.equal(harness.cache.loadCalls, 2, 'the warm reload consults the disk cache')
    const refreshedRevision = revisionOf(refreshed)
    assert.notEqual(refreshedRevision, revision)
    const unchanged = await call(harness, { part: 'summary', revision: refreshedRevision })
    assert.deepEqual(unchanged.reply.value, { revision: refreshedRevision, unchanged: true })
    harness.dispose()
  })

  test('an idle release resets the scan window', async () => {
    const harness = await identityBoot({ idleMs: 5, scanTtlMs: 10_000 })
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    const reads = harness.calls.list
    await sleep(20)
    await call(harness, { part: 'summary', revision: revisionOf(first) })
    assert.ok(harness.calls.list > reads, 'the released scan was not reused')
    harness.dispose()
  })

  test('a pre-populated disk cache serves the first paint without any projection read', async () => {
    const harness = await identityBoot()
    harness.state.cachedSessions.set('a', hostSessionOf('a', { tokens: 10 }))
    harness.state.cachedSessions.set('b', hostSessionOf('b', { tokens: 20 }))
    harness.state.cachedIdentities.set('a', identityOf('a'))
    harness.state.cachedIdentities.set('b', identityOf('b'))
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.deepEqual(harness.calls.cached, [], 'validated persisted rows skip the projection cache')
    assert.equal(harness.cache.saveCalls, 0, 'nothing changed, so nothing is rewritten')
    harness.dispose()
  })

  test('load rebuild ids force a projection read only for those sessions', async () => {
    const harness = await identityBoot()
    harness.state.cachedSessions.set('a', hostSessionOf('a'))
    harness.state.cachedSessions.set('b', hostSessionOf('b'))
    harness.state.cachedIdentities.set('a', identityOf('a'))
    harness.state.cachedIdentities.set('b', identityOf('b'))
    harness.state.diskRebuild = ['a']
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.deepEqual(harness.calls.cached, ['a'], 'only the invalidated record is refolded')
    assert.equal(harness.cache.saveCalls, 1)
    harness.dispose()
  })

  test('backfill folds drain incrementally, overflow marks every cold session dirty, and unknown ids are ignored', async () => {
    const harness = await identityBoot()
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    const firstRevision = revisionOf(first)
    const readsAfterFirst = harness.calls.cached.length
    harness.state.foldedVersion = 1
    harness.state.foldedIds = ['a', 'missing', 'live']
    const folded = await call(harness, { part: 'summary', revision: firstRevision })
    assert.equal(summaryOf(folded).sessions, 2)
    assert.equal(harness.calls.cached.length, readsAfterFirst + 1, 'only the folded session refolds')
    const foldedRevision = revisionOf(folded)
    assert.notEqual(foldedRevision, firstRevision, 'a fold moves the revision so clients converge')
    assert.equal(harness.cache.saveCalls, 2)
    const afterFold = await call(harness, { part: 'summary', revision: foldedRevision })
    assert.deepEqual(afterFold.reply.value, { revision: foldedRevision, unchanged: true })
    harness.state.foldedVersion = 2
    harness.state.foldedIds = null
    const overflow = await call(harness, { part: 'summary', revision: foldedRevision })
    assert.equal(harness.calls.cached.length, readsAfterFirst + 1 + 2, 'an overflow refolds every cold session')
    const overflowRevision = revisionOf(overflow)
    assert.notEqual(overflowRevision, foldedRevision)
    harness.dispose()
  })

  test('a host without foldedSince never drains fold markers', async () => {
    const harness = await identityBoot({ foldedAvailable: false })
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    harness.state.foldedVersion = 1
    harness.state.foldedIds = ['a']
    const second = await call(harness, { part: 'summary', revision })
    assert.deepEqual(second.reply.value, { revision, unchanged: true }, 'no fold drain, no revision move')
    assert.deepEqual(harness.state.foldCalls, [])
    harness.dispose()
  })

  test('refresh detects changed durable identities, captures new sessions, and keeps identities when a refresh skips them', async () => {
    const harness = await identityBoot()
    seedIdentities(harness)
    const first = await call(harness, { part: 'summary' })
    const firstRevision = revisionOf(first)
    const readsAfterFirst = harness.calls.cached.length
    harness.state.refreshChanged = ['a']
    harness.state.captureIdentities.set('a', identityOf('a', 11, 6))
    harness.state.records = [recordOf('a'), recordOf('b'), recordOf('c')]
    harness.state.captureIdentities.set('c', identityOf('c'))
    harness.cacheMode.values.c = valuesOf(30)
    const second = await call(harness, { part: 'summary', revision: firstRevision })
    assert.equal(summaryOf(second).sessions, 3, 'a new cold session joins the corpus')
    assert.equal(harness.calls.cached.length, readsAfterFirst + 2, 'the changed and the new session refold')
    const secondRevision = revisionOf(second)
    assert.notEqual(secondRevision, firstRevision)
    assert.deepEqual(harness.cache.captureCalls.at(-1)?.ids, ['c'])
    harness.state.refreshChanged = []
    harness.state.refreshSkip = ['b']
    const skipped = await call(harness, { part: 'summary', revision: secondRevision })
    assert.equal(revisionOf(skipped), secondRevision, 'a skipped refresh keeps the previous identity, so the revision holds')
    harness.state.refreshSkip = []
    harness.state.refreshChanged = ['a']
    harness.state.captureIdentities.delete('a')
    const unvalidatable = await call(harness, { part: 'summary', revision: secondRevision })
    const thirdRevision = revisionOf(unvalidatable)
    assert.notEqual(thirdRevision, secondRevision, 'a vanished identity invalidates the session')
    harness.state.refreshChanged = []
    const settled = await call(harness, { part: 'summary', revision: thirdRevision })
    assert.deepEqual(settled.reply.value, { revision: thirdRevision, unchanged: true }, 'an unvalidatable identity is not re-captured every poll')
    assert.equal(harness.cache.captureCalls.length, 2, 'only the first capture of a session happens once')
    harness.dispose()
  })

  test('an unvalidatable capture keeps its sessions visible and is not retried every poll', async () => {
    const harness = await identityBoot()
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.equal(harness.cache.captureCalls.length, 1)
    assert.equal(harness.state.savedRecords.length, 2)
    assert.ok(harness.state.savedRecords.every(record => record.identity === null))
    const revision = revisionOf(first)
    const second = await call(harness, { part: 'summary', revision })
    assert.deepEqual(second.reply.value, { revision, unchanged: true })
    assert.equal(harness.cache.captureCalls.length, 1, 'a retained null identity counts as known')
    harness.dispose()
  })

  test('capture answers missing from the cache fall back to an unvalidatable identity', async () => {
    const harness = await identityBoot()
    harness.state.captureMissing = ['a', 'b']
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.equal(summaryOf(first).tokens, 32)
    harness.dispose()
  })

  test('a large rebuild yields to the event loop every yieldEvery sessions', async () => {
    const records = Array.from({ length: 5 }, (_, index) => recordOf(`s${index}`))
    const values: Record<string, Record<string, unknown>> = {}
    for (let index = 0; index < 5; index++) values[`s${index}`] = valuesOf(index + 1)
    const harness = await boot({ persistence: PERSISTENCE, records, values })
    for (let index = 0; index < 5; index++) harness.state.captureIdentities.set(`s${index}`, identityOf(`s${index}`))
    let yields = 0
    const first = await call(harness, { part: 'summary' })
    harness.dispose()
    const yielding = await boot({
      persistence: PERSISTENCE,
      records,
      values,
      yieldEvery: 2,
      yieldTo: async () => {
        yields += 1
      },
    })
    for (let index = 0; index < 5; index++) yielding.state.captureIdentities.set(`s${index}`, identityOf(`s${index}`))
    await call(yielding, { part: 'summary' })
    assert.equal(yields, 2, 'five rebuilt sessions cross two yield boundaries')
    assert.equal(summaryOf(first).sessions, 5)
    yielding.dispose()
  })

  test('legacy mode (no persistence face) keeps working and rebuilds after an idle release', async () => {
    const harness = await boot({ records: [recordOf('a'), recordOf('b')], values: { a: valuesOf(10), b: valuesOf(20) }, idleMs: 5 })
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.equal(harness.cache.loadCalls, 0, 'legacy mode never uses the disk cache')
    await sleep(20)
    assert.ok(harness.cache.flushCalls >= 1, 'the idle release still flushes the injected cache')
    const second = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(second).sessions, 2)
    assert.equal(harness.calls.cached.length, 4, 'legacy mode refolds both rows after the release')
    harness.dispose()
  })

  test('a persistence face without stat or a non-record face keeps legacy mode', async () => {
    for (const persistence of [{}, 7, { stat: 'nope' }]) {
      const harness = await boot({ persistence, records: [recordOf('a')], values: { a: valuesOf(10) } })
      const reply = await call(harness, { part: 'summary' })
      assert.equal(reply.reply.ok, true)
      assert.equal(summaryOf(reply).sessions, 1)
      assert.equal(harness.cache.loadCalls, 0)
      harness.dispose()
    }
  })

  test('a scan inside the TTL skips the durable identity refresh, and a fresh scan performs it', async () => {
    const harness = await identityBoot({ scanTtlMs: 10_000 })
    seedIdentities(harness)
    await call(harness, { part: 'summary' })
    await call(harness, { part: 'days' })
    assert.equal(harness.cache.refreshCalls, 0, 'no refresh inside the scan TTL')
    harness.dispose()
    const refreshed = await identityBoot({ scanTtlMs: 1 })
    seedIdentities(refreshed)
    await call(refreshed, { part: 'summary' })
    await sleep(10)
    await call(refreshed, { part: 'days' })
    assert.equal(refreshed.cache.refreshCalls, 1, 'a fresh scan refreshes every known identity')
    refreshed.dispose()
  })

  test('concurrent parts sharing one fresh scan refresh the durable identities once', async () => {
    const harness = await identityBoot({ scanTtlMs: 1 })
    seedIdentities(harness)
    await call(harness, { part: 'summary' })
    await sleep(10)
    await Promise.all([call(harness, { part: 'days' }), call(harness, { part: 'page' }), call(harness, { part: 'tally' })])
    assert.equal(harness.cache.refreshCalls, 1, 'the shared scan refreshes once, not once per part')
    harness.dispose()
  })

  test('cache failures, disposes, disabled idle timers, and post-dispose requests stay contained', async () => {
    const failing: OverviewCache = {
      load: async () => { throw new Error('cache broken') },
      refresh: async () => ({ identities: new Map(), changed: new Set() }),
      capture: async () => new Map(),
      save: () => {},
      flush: async () => {},
      dispose: () => {},
    }
    const failed = await boot({ persistence: PERSISTENCE, cache: failing, records: [recordOf('a')], values: { a: valuesOf(10) } })
    const reply = await call(failed, { part: 'summary' })
    assert.equal(reply.reply.error?.code, 'gateway/internal')
    assert.ok((reply.reply.error?.message ?? '').includes('cache broken'))
    failed.dispose()

    const harness = await identityBoot({ idleMs: 0 })
    seedIdentities(harness)
    await call(harness, { part: 'summary' })
    const flushes = harness.cache.flushCalls
    await sleep(10)
    assert.equal(harness.cache.flushCalls, flushes, 'an idle timeout of zero never schedules a release')
    harness.dispose()
    assert.equal(harness.cache.disposeCalls, 1)
    const afterDispose = await call(harness, { part: 'summary' })
    assert.equal(afterDispose.reply.ok, true, 'a request after the disposer is still answered')
    harness.dispose()
    assert.equal(harness.cache.disposeCalls, 1, 'the disposer is idempotent')
  })

  test('the default disk cache path honors DSH_HOME and warms the next route instance', async () => {
    const { mkdtemp, mkdir, rm, stat, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'dsh-overview-memory-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const records = [recordOf('a'), recordOf('b')]
      const values = { a: valuesOf(10), b: valuesOf(20) }
      await mkdir(join(root, 'logs'), { recursive: true })
      const identities = new Map<string, DurableIdentity>()
      for (const id of ['a', 'b']) {
        const logPath = join(root, 'logs', id)
        await writeFile(logPath, `log of ${id}`)
        const logInfo = await stat(logPath)
        identities.set(id, { path: logPath, sizeBytes: logInfo.size, mtimeMs: logInfo.mtimeMs })
      }
      const realPersistence = {
        stat: async (id: string): Promise<unknown> => {
          const logPath = join(root, 'logs', id)
          const logInfo = await stat(logPath)
          return { header: { id }, location: { path: logPath }, sizeBytes: logInfo.size }
        },
      }
      const first = await boot({ persistence: realPersistence, records, values, noCache: true })
      first.state.captureIdentities.set('a', identities.get('a') ?? null)
      first.state.captureIdentities.set('b', identities.get('b') ?? null)
      await call(first, { part: 'summary' })
      first.dispose()
      await sleep(20)
      const cachePath = join(root, 'storages', 'dsh-context', 'overview-cache.v1.json')
      const info = await stat(cachePath)
      assert.ok(info.size > 0, 'the default cache path received the flushed records')
      const second = await boot({ persistence: realPersistence, records, values, noCache: true })
      second.state.captureIdentities.set('a', identities.get('a') ?? null)
      second.state.captureIdentities.set('b', identities.get('b') ?? null)
      const warm = await call(second, { part: 'summary' })
      assert.equal(summaryOf(warm).sessions, 2)
      assert.deepEqual(second.calls.cached, [], 'the restarted route reuses the persisted cold rows')
      second.dispose()
      const third = await boot({ persistence: PERSISTENCE, records, values, cachePath, noCache: true })
      third.state.captureIdentities.set('a', identityOf('a'))
      const explicit = await call(third, { part: 'summary' })
      assert.equal(summaryOf(explicit).sessions, 2)
      third.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a route without an injected cache (legacy mode) has no idle cache to flush or dispose', async () => {
    const harness = await boot({ records: [recordOf('a')], values: { a: valuesOf(10) }, idleMs: 5, noCache: true })
    await call(harness, { part: 'summary' })
    await sleep(20)
    const second = await call(harness, { part: 'summary' })
    assert.equal(second.reply.ok, true)
    harness.dispose()
  })

  test('a dirty session whose projection read fails stays out of the saved cache', async () => {
    const harness = await identityBoot()
    seedIdentities(harness)
    harness.cacheMode.throwCached = true
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 2)
    assert.equal(harness.state.savedRecords.length, 0, 'nothing cacheable was built')
    harness.cacheMode.throwCached = false
    const recovered = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(recovered).sessions, 2)
    assert.equal(harness.state.savedRecords.length, 2)
    harness.dispose()
  })

  test('the default yield cadence and a yieldTo-only build option are honored', async () => {
    const records = Array.from({ length: 65 }, (_, index) => recordOf(`s${index}`))
    const values: Record<string, Record<string, unknown>> = {}
    for (let index = 0; index < 65; index++) values[`s${index}`] = valuesOf(index + 1)
    const harness = await boot({ persistence: PERSISTENCE, records, values })
    for (let index = 0; index < 65; index++) harness.state.captureIdentities.set(`s${index}`, identityOf(`s${index}`))
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 65)
    assert.equal(harness.calls.cached.length, 65)
    harness.dispose()
    let yields = 0
    const custom = await boot({
      persistence: PERSISTENCE,
      records: Array.from({ length: 3 }, (_, index) => recordOf(`c${index}`)),
      values: { c0: valuesOf(1), c1: valuesOf(2), c2: valuesOf(3) },
      yieldTo: async () => {
        yields += 1
      },
    })
    for (let index = 0; index < 3; index++) custom.state.captureIdentities.set(`c${index}`, identityOf(`c${index}`))
    await call(custom, { part: 'summary' })
    assert.equal(yields, 0, 'below the default cadence no yield happens')
    custom.dispose()
  })

  test('yieldEvery alone still uses the default event-loop yield', async () => {
    const records = Array.from({ length: 3 }, (_, index) => recordOf(`y${index}`))
    const values: Record<string, Record<string, unknown>> = {}
    for (let index = 0; index < 3; index++) values[`y${index}`] = valuesOf(index + 1)
    const harness = await boot({ persistence: PERSISTENCE, records, values, yieldEvery: 1 })
    for (let index = 0; index < 3; index++) harness.state.captureIdentities.set(`y${index}`, identityOf(`y${index}`))
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 3)
    harness.dispose()
  })

  test('a refresh that skips a null-identity session keeps the null fallback', async () => {
    const harness = await identityBoot()
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    harness.state.refreshChanged = ['a']
    harness.state.captureIdentities.delete('a')
    const invalidated = await call(harness, { part: 'summary', revision })
    const invalidatedRevision = revisionOf(invalidated)
    harness.state.refreshChanged = []
    harness.state.refreshSkip = ['a']
    const settled = await call(harness, { part: 'summary', revision: invalidatedRevision })
    assert.deepEqual(settled.reply.value, { revision: invalidatedRevision, unchanged: true })
    harness.dispose()
  })

  test('six concurrent overview parts on a cold corpus trigger exactly one session rebuild pass', async () => {
    let yields = 0
    const harness = await boot({
      persistence: PERSISTENCE,
      records: [recordOf('a'), recordOf('b'), recordOf('c')],
      values: { a: valuesOf(10), b: valuesOf(20), c: valuesOf(30) },
      yieldEvery: 1,
      yieldTo: async () => { yields += 1 },
    })
    for (const id of ['a', 'b', 'c']) harness.state.captureIdentities.set(id, identityOf(id))
    const [summary, days, page, skills, tools, cmds] = await Promise.all([
      call(harness, { part: 'summary' }),
      call(harness, { part: 'days' }),
      call(harness, { part: 'page' }),
      call(harness, { part: 'tally', tally: 'skills' }),
      call(harness, { part: 'tally', tally: 'tools' }),
      call(harness, { part: 'tally', tally: 'cmds' }),
    ])
    assert.equal(summaryOf(summary).sessions, 3)
    assert.equal(days.reply.ok, true)
    assert.equal(pageOf(page).items.length, 3)
    assert.equal(tallyOf(skills).stats.length, 0)
    assert.equal(tallyOf(tools).field, 'tools')
    assert.equal(tallyOf(cmds).field, 'cmds')
    assert.deepEqual(harness.calls.cached.sort(), ['a', 'b', 'c'], 'every cold id is read exactly once')
    assert.equal(yields, 3, 'only one build pass crossed the yield boundaries')
    assert.equal(harness.cache.captureCalls.length, 1, 'identities are captured once for the burst')
    assert.equal(harness.cache.saveCalls, 1, 'the materialized rows are persisted once')
    assert.equal(harness.cache.loadCalls, 1)
    harness.dispose()
  })

  test('parts at the same revision reuse the materialized rows without a second build', async () => {
    let yields = 0
    const harness = await boot({
      persistence: PERSISTENCE,
      records: [recordOf('a'), recordOf('b')],
      values: { a: valuesOf(10), b: valuesOf(20) },
      yieldEvery: 1,
      yieldTo: async () => { yields += 1 },
    })
    for (const id of ['a', 'b']) harness.state.captureIdentities.set(id, identityOf(id))
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    const reads = harness.calls.cached.length
    const saved = harness.cache.saveCalls
    const days = await call(harness, { part: 'days', revision })
    const page = await call(harness, { part: 'page', revision })
    assert.equal(days.reply.ok, true)
    assert.equal(pageOf(page).items.length, 2)
    assert.equal(harness.calls.cached.length, reads, 'a same-revision part reads no projection rows')
    assert.equal(yields, 2)
    assert.equal(harness.cache.saveCalls, saved, 'a reused row set is not re-persisted')
    const unchanged = await call(harness, { part: 'summary', revision })
    assert.deepEqual(unchanged.reply.value, { revision, unchanged: true })
    harness.dispose()
  })

  test('a request arriving mid-build waits for the critical section and never interleaves a second build', async () => {
    let yields = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = () => resolve() })
    const harness = await boot({
      persistence: PERSISTENCE,
      records: [recordOf('a'), recordOf('b')],
      values: { a: valuesOf(10), b: valuesOf(20) },
      yieldEvery: 1,
      yieldTo: async () => {
        yields += 1
        await gate
      },
    })
    for (const id of ['a', 'b']) harness.state.captureIdentities.set(id, identityOf(id))
    const first = call(harness, { part: 'summary' })
    while (yields < 1) await sleep(1)
    const readsWhileBuilding = harness.calls.cached.length
    let secondSettled = false
    const second = call(harness, { part: 'days' })
    void second.then(() => { secondSettled = true })
    await sleep(10)
    assert.equal(secondSettled, false, 'the second request waits for the in-flight critical section')
    assert.equal(harness.calls.cached.length, readsWhileBuilding, 'the second request adds no cold read while waiting')
    release()
    const [one, two] = await Promise.all([first, second])
    assert.equal(summaryOf(one).sessions, 2)
    assert.equal(two.reply.ok, true)
    assert.equal(yields, 2, 'only the first build yielded')
    assert.deepEqual(harness.calls.cached.sort(), ['a', 'b'])
    harness.dispose()
  })

  test('a folded revision rebuilds once for a concurrent part burst and the next revision is served from rows', async () => {
    let yields = 0
    const harness = await boot({
      persistence: PERSISTENCE,
      records: [recordOf('a'), recordOf('b')],
      values: { a: valuesOf(10), b: valuesOf(20) },
      yieldEvery: 1,
      yieldTo: async () => { yields += 1 },
    })
    for (const id of ['a', 'b']) harness.state.captureIdentities.set(id, identityOf(id))
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    yields = 0
    harness.state.foldedVersion = 1
    harness.state.foldedIds = ['a']
    const [one, two, three] = await Promise.all([
      call(harness, { part: 'summary', revision }),
      call(harness, { part: 'days', revision }),
      call(harness, { part: 'page', revision }),
    ])
    assert.equal(summaryOf(one).sessions, 2)
    assert.equal(two.reply.ok, true)
    assert.equal(pageOf(three).items.length, 2)
    assert.equal(harness.calls.cached.length, 3, 'only the folded session refolds')
    assert.equal(yields, 1, 'the folded session is rebuilt once')
    const nextRevision = revisionOf(one)
    assert.notEqual(nextRevision, revision)
    const days = await call(harness, { part: 'days', revision: nextRevision })
    assert.equal(days.reply.ok, true)
    assert.equal(yields, 1, 'the new revision reuses its rows')
    harness.dispose()
  })

  test('a failed critical section does not poison the serialization chain', async () => {
    const harness = await identityBoot()
    seedIdentities(harness)
    const original = harness.cache.load.bind(harness.cache)
    let failures = 1
    harness.cache.load = async (...args) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('load broke once')
      }
      return original(...args)
    }
    const failed = await call(harness, { part: 'summary' })
    assert.equal(failed.reply.error?.code, 'gateway/internal')
    const recovered = await call(harness, { part: 'summary' })
    assert.equal(recovered.reply.ok, true)
    assert.equal(summaryOf(recovered).sessions, 2)
    harness.dispose()
  })
})
