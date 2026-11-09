import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { describe, test, vi } from 'vitest'
import { watchOverviewRoute, OVERVIEW_ROUTE } from '../../src/host/overview'
import type { ContextTimeline, SessionCostUsage } from '../../src/shared/types'
import { boot, call, summaryOf, pageOf, revisionOf, recordOf, unwrap, usageOf, timelineOf, timingOf, dayOf, costOfUsage, fakeCost, fakeBackfill, fakeState, tokenPartsOf, usageTotalsOf, sortedParts, type RouteBox } from './helpers/overview'

describe('dsh-context overview route', () => {

  test('without the connection face the route never registers', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {} as never)
    ctx.provide('sessionQuery', { listSessions: async () => [] })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionProjections', { snapshot: () => undefined })
    watchOverviewRoute(ctx, fakeCost(true), fakeBackfill(fakeState()))
    await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(routes.has(OVERVIEW_ROUTE), false)
  })

  test('summary aggregates the full corpus and equals the pure aggregation of the same session values', async () => {
    const firstUsage = usageOf(100, 50, 10, 20)
    const secondUsage = usageOf(30, 5, 0, 7)
    const firstCost = usageOf(60, 20, 5, 10)
    const secondCost = usageOf(10, 2, 0, 3)
    const values = {
      a: {
        contextTimeline: timelineOf({ total: 100, turns: 2, cost: firstUsage, timing: timingOf(1_000, 3, 400), lastUser: 'first' }),
        contextActivity: { days: { '2026-11-01': dayOf(120, 2, { cost: firstCost, turns: 2, skills: ['s1'] }) } },
        title: 'Alpha',
        sessionListMetadata: { blank: false, lastPromptAt: 1_000 },
      },
      b: {
        contextTimeline: timelineOf({ total: 200, turns: 3, cost: secondUsage, timing: timingOf(500, 1, 100) }),
        contextActivity: { days: { '2026-11-02': dayOf(80, 1, { cost: secondCost, turns: 3 }) } },
        title: 'Beta',
        sessionListMetadata: { blank: false, lastPromptAt: 2_000 },
      },
    }
    const harness = await boot({
      records: [recordOf('a'), recordOf('b')],
      values,
      coverage: { complete: true, remaining: 0, failed: 0, running: false, total: 2, covered: 2, unsupported: 0 },
    })
    const reply = await call(harness, { part: 'summary' })
    const summary = summaryOf(reply)
    const merged = { deepseek: { 'deepseek-v4-flash': { off: { uncached: 130, cacheRead: 55, cacheWrite: 10, output: 27 } } } }
    const expectedParts: { key: string; value: number }[] = []
    for (const valuesOfSession of [values.a, values.b]) {
      const timeline = valuesOfSession.contextTimeline as unknown as ContextTimeline
      const parts = tokenPartsOf(timeline, timeline.cost as SessionCostUsage)
      for (const part of parts) {
        const prev = expectedParts.find(entry => entry.key === part.key)
        if (prev === undefined) expectedParts.push({ ...part })
        else prev.value += part.value
      }
    }
    const expectedTokens = usageTotalsOf(merged).uncachedInputTokens + usageTotalsOf(merged).cacheReadTokens
      + usageTotalsOf(merged).cacheWriteTokens + usageTotalsOf(merged).outputTokens
    assert.equal(summary.sessions, 2)
    assert.equal(summary.sessionsTotal, 2)
    assert.equal(summary.sessionsArchived, 0)
    assert.equal(summary.archivedScoped, 0)
    assert.equal(summary.tokens, summary.tokenParts?.reduce((sum, part) => sum + part.value, 0), 'tokens equal the pure billed split total')
    assert.ok(Math.abs(summary.tokens - expectedTokens) <= 2, 'the split stays within rounding of the billed total')
    assert.equal(summary.turns, 5)
    assert.equal(summary.costUsd, costOfUsage(merged))
    assert.equal(summary.costSessions, 2)
    assert.equal(summary.usageSessions, 2)
    assert.equal(summary.cacheHit, '28.20')
    assert.deepEqual(summary.tokenParts?.map(part => part.key), sortedParts(expectedParts).map(part => part.key))
    for (const part of summary.tokenParts ?? []) {
      const expected = expectedParts.find(entry => entry.key === part.key)
      assert.ok(expected !== undefined)
      assert.equal(part.value, expected.value)
    }
    assert.equal(summary.timing?.wallMs, 1_500)
    assert.equal(summary.timing?.toolCalls, 4)
    assert.equal(summary.timing?.tools.bash.calls, 4)
    assert.equal(summary.coverage.complete, true)
    assert.equal(summary.coverage.total, 2)
  })

  test('summary keeps family members together: tokens, turns, timing, and cost merge subagent children into the root row', async () => {
    const rootUsage = usageOf(10, 0, 0, 1)
    const childUsage = usageOf(20, 0, 0, 2)
    const harness = await boot({
      records: [
        recordOf('root', { createdAt: 5 }),
        recordOf('child', { parentSession: 'root', origin: 'subagent' }),
        recordOf('other'),
      ],
      values: {
        root: {
          contextTimeline: timelineOf({ total: 10, turns: 1, cost: rootUsage, timing: timingOf(100, 1, 10) }),
          contextActivity: { days: { '2026-11-01': dayOf(11, 1, { turns: 1, cost: rootUsage }) } },
          sessionListMetadata: { blank: false, lastPromptAt: 10 },
        },
        child: {
          contextTimeline: timelineOf({ total: 20, turns: 2, cost: childUsage, timing: timingOf(200, 2, 20) }),
          contextActivity: { days: { '2026-11-01': dayOf(22, 2, { turns: 2, cost: childUsage }) } },
          sessionListMetadata: { blank: false, lastPromptAt: 20 },
        },
        other: {
          contextTimeline: timelineOf({ total: 5, turns: 0 }),
          sessionListMetadata: { blank: false, lastPromptAt: 30 },
        },
      },
    })
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.sessions, 2, 'the subagent child is not a top-level session')
    assert.equal(summary.tokens, 33, 'billed tokens merge root and child')
    assert.equal(summary.turns, 1 + 2 + 0)
    assert.equal(summary.timing?.wallMs, 300)
    assert.equal(summary.timing?.toolCalls, 3)
    assert.equal(summary.costUsd, costOfUsage({ deepseek: { 'deepseek-v4-flash': { off: { uncached: 30, cacheRead: 0, cacheWrite: 0, output: 3 } } } }))
    const page = pageOf(await call(harness, { part: 'page' }))
    const rootRow = page.items.find(row => row.id === 'root')
    assert.ok(rootRow !== undefined)
    assert.equal(rootRow.tokens, 33)
    assert.equal(rootRow.turns, 1, 'the page card keeps the root session turns')
  })

  test('summary windows usage and turns from the activity ledger, and a day window scopes it', async () => {
    const harness = await boot({
      records: [recordOf('a')],
      values: {
        a: {
          contextTimeline: timelineOf({ total: 50, turns: 9, cost: usageOf(999, 0, 0, 999) }),
          contextActivity: {
            days: {
              '2026-10-01': dayOf(10, 1, { turns: 1, cost: usageOf(10, 0, 0, 1) }),
              '2026-11-01': dayOf(20, 2, { turns: 2, cost: usageOf(20, 0, 0, 2) }),
            },
          },
          sessionListMetadata: { blank: false, lastPromptAt: 2_000 },
        },
      },
    })
    const all = summaryOf(await call(harness, { part: 'summary' }))
    assert.ok(Math.abs(all.tokens - 1998) <= 2, 'the open scope bills the whole timeline cost')
    assert.equal(all.turns, 9)
    const ranged = summaryOf(await call(harness, { part: 'summary', scope: { range: { start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 5) } } }))
    assert.equal(ranged.tokens, 22, 'a bounded scope bills only its window days')
    assert.equal(ranged.turns, 2)
    const day = summaryOf(await call(harness, { part: 'summary', scope: { day: '2026-11-01' } }))
    assert.equal(day.tokens, 22)
    assert.equal(day.turns, 2)
  })

  test('days returns host-priced day totals in key order and skips empty days', async () => {
    const harness = await boot({
      records: [recordOf('a'), recordOf('b'), recordOf('c')],
      values: {
        a: {
          contextActivity: {
            days: {
              '2026-11-02': dayOf(20, 2, { cost: usageOf(20, 0, 0, 2) }),
              '2026-11-01': dayOf(10, 1, { cost: usageOf(10, 0, 0, 1) }),
            },
          },
          title: 'Alpha',
        },
        b: {
          contextActivity: { days: { '2026-11-01': dayOf(5, 1, { cost: usageOf(5, 0, 0, 0) }), '2026-11-03': dayOf(0, 0) } },
        },
        c: { contextActivity: { days: {} } },
      },
    })
    const result = await call(harness, { part: 'days' })
    const reply = result.reply
    assert.equal(reply.ok, true)
    assert.ok(reply.value !== undefined && 'days' in reply.value)
    assert.deepEqual(reply.value.days.map(day => day.key), ['2026-11-01', '2026-11-02'])
    assert.equal(reply.value.days[0].tokens, 15)
    assert.equal(reply.value.days[0].sessions, 2)
    assert.equal(reply.value.days[0].costUsd, costOfUsage({ deepseek: { 'deepseek-v4-flash': { off: { uncached: 15, cacheRead: 0, cacheWrite: 0, output: 1 } } } }))
    assert.equal(reply.value.days[1].tokens, 20)
    assert.equal(reply.value.pricingReady, true)
  })

  test('revision is stable for the same corpus and unchanged polls reply tiny; a data change makes a new revision', async () => {
    const harness = await boot({
      records: [recordOf('a')],
      values: { a: { contextTimeline: timelineOf(), title: 'Alpha' } },
    })
    const first = await call(harness, { part: 'summary' })
    const revision = revisionOf(first)
    const repeated = await call(harness, { part: 'summary' })
    assert.equal(revisionOf(repeated), revision, 'the same corpus keeps the same revision')
    const unchanged = await call(harness, { part: 'summary', revision })
    assert.deepEqual(unchanged.reply, { ok: true, value: { revision, unchanged: true } })
    assert.ok(unchanged.bytes < 400, `the unchanged poll stays tiny (${unchanged.bytes} B)`)
    const summaryBytes = first.bytes
    assert.ok(summaryBytes < 4_096, `the summary reply stays small (${summaryBytes} B)`)
    const otherPart = await call(harness, { part: 'page', revision })
    assert.equal(otherPart.reply.ok, true)
    assert.ok(otherPart.reply.value !== undefined && !('unchanged' in otherPart.reply.value), 'a part never served at this revision still gets its data')
    const stale = await call(harness, { part: 'summary', revision: 'r1-bogus' })
    assert.ok(stale.reply.value !== undefined && !('unchanged' in stale.reply.value), 'an unknown revision gets a full reply')
    harness.state.backfillVersion = 3
    const changed = await call(harness, { part: 'summary', revision })
    assert.notEqual(revisionOf(changed), revision, 'a backfill write moves the revision')
    assert.ok(changed.reply.value !== undefined && !('unchanged' in changed.reply.value))
  })

  test('a live session moves the revision with its event seq, and the live snapshot path serves its values', async () => {
    const harness = await boot({
      records: [recordOf('live', { live: true })],
      liveSeq: { live: 1 },
      liveValues: {
        live: {
          contextTimeline: timelineOf({ total: 42, turns: 3, cost: usageOf(10, 0, 0, 2) }),
          contextActivity: { days: { '2026-11-01': dayOf(12, 1, { turns: 3 }) } },
          title: 'Live',
          sessionListMetadata: { blank: false, lastPromptAt: 5_000 },
        },
      },
    })
    const first = await call(harness, { part: 'summary' })
    assert.equal(summaryOf(first).sessions, 1)
    assert.equal(summaryOf(first).tokens, 12)
    assert.deepEqual(harness.calls.snapshot, ['live'], 'a live session reads the registry snapshot')
    assert.deepEqual(harness.calls.cached, [], 'a live session never reads the cold cache')
    const revision = revisionOf(first)
    harness.state.liveSeq.live = 2
    const next = await call(harness, { part: 'summary', revision })
    assert.notEqual(revisionOf(next), revision, 'a live event seq change moves the revision')
    assert.equal(summaryOf(next).sessions, 1)
  })

  test('a fresh route instance still replies fully when a known revision arrives before any rows were built', async () => {
    const values = { a: { contextTimeline: timelineOf({ turns: 1 }), title: 'Alpha' } }
    const firstHarness = await boot({ records: [recordOf('a')], values })
    const revision = revisionOf(await call(firstHarness, { part: 'summary' }))
    const secondHarness = await boot({ records: [recordOf('a')], values })
    const reply = await call(secondHarness, { part: 'summary', revision })
    assert.equal(reply.reply.ok, true)
    assert.ok(reply.reply.value !== undefined && !('unchanged' in reply.reply.value), 'a route with no built rows cannot confirm unchanged')
    assert.equal(revisionOf(reply), revision, 'the deterministic revision matches across route instances')
  })

  test('workspace claims: archived coverage excludes archived sessions, groups follow the claims and titles', async () => {
    const workspace = {
      list: () => [
        { id: 'w1', title: 'Alpha', sessionIds: ['a'] },
        { id: 'w2', title: 'Beta', sessionIds: ['b', 'c'] },
      ],
      archivedSessionIds: ['c'],
    }
    const harness = await boot({
      records: [recordOf('a'), recordOf('b'), recordOf('c')],
      values: {
        a: { contextTimeline: timelineOf({ turns: 1 }), title: 'A' },
        b: { contextTimeline: timelineOf({ turns: 1 }), title: 'B' },
        c: { contextTimeline: timelineOf({ turns: 1 }), title: 'C' },
      },
      workspace,
    })
    const summary = summaryOf(await call(harness, { part: 'summary', scope: { coverage: 'active' } }))
    assert.equal(summary.sessions, 2)
    assert.equal(summary.sessionsTotal, 3)
    assert.equal(summary.archivedScoped, 0)
    const kept = summaryOf(await call(harness, { part: 'summary', scope: { coverage: 'archived' } }))
    assert.equal(kept.sessions, 1)
    assert.equal(kept.archivedScoped, 1)
    const page = pageOf(await call(harness, { part: 'page', scope: { group: 'Alpha' } }))
    assert.deepEqual(page.items.map(row => row.id), ['a'])
    assert.deepEqual(page.groups, [{ key: 'Alpha', count: 1 }, { key: 'Beta', count: 2 }])
  })

  test('pricing not ready keeps money null and marks the reply', async () => {
    const harness = await boot({
      records: [recordOf('a')],
      values: { a: { contextTimeline: timelineOf({ cost: usageOf(10, 0, 0, 1) }) } },
      costReady: false,
    })
    const result = await call(harness, { part: 'summary' })
    const summary = summaryOf(result)
    assert.equal(summary.costUsd, null)
    assert.equal(summary.costSessions, 0)
    assert.equal(result.reply.value !== undefined && 'pricingReady' in result.reply.value && result.reply.value.pricingReady, false)
  })

  test('hostile values degrade field-by-field and a throwing row read never drops the session', async () => {
    const harness = await boot({
      records: [
        recordOf('junk'),
        recordOf('throwing'),
        recordOf('badtitle'),
        { header: { id: 'ok', cwd: '/repo/ok' } },
        { header: null },
        null,
        { nope: true },
        recordOf('no-cwd-cold', { cwd: '' }),
      ],
      values: {
        junk: {
          contextTimeline: { current: 'bad', counts: { turns: 'many' }, cost: 'nope', timing: { wallMs: 'x' } },
          contextActivity: { days: { '2026-11-01': { tokens: 'x', requests: null } } },
          title: 7,
          sessionListMetadata: { blank: 'no', lastPromptAt: 'soon' },
        },
        badtitle: { title: '', contextTimeline: { current: { total: 5 } }, sessionListMetadata: null },
      },
    })
    harness.cacheMode.throwCached = true
    const reply = await call(harness, { part: 'summary' })
    assert.equal(reply.reply.ok, true)
    const summary = summaryOf(reply.reply)
    assert.equal(summary.sessions, 4, 'junk, bad-title, throwing, and bare-header rows stay visible')
    assert.equal(summary.tokens, 0)
    assert.equal(summary.costUsd, null)
    const pageReply = await call(harness, { part: 'page' })
    const page = pageOf(pageReply.reply)
    assert.equal(page.total, 4)
    for (const row of page.items) {
      assert.deepEqual(row.parts, [])
      assert.equal(row.total, 0)
      assert.equal(row.costUsd, null)
      assert.equal(row.turns, 0)
    }
    harness.cacheMode.throwCached = false
    const recovered = pageOf(await call(harness, { part: 'page' }))
    assert.equal(recovered.total >= 3, true, 'a transient row failure is not cached forever')
    harness.cacheMode.throwSnapshot = true
    harness.state.liveSeq = { live: 1 }
    harness.state.records = [recordOf('live', { live: true })]
    const liveFailed = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(liveFailed.sessions, 1, 'a throwing live snapshot keeps the row without values')
  })

  test('hostile workspace and agents faces degrade to no groups and no running state', async () => {
    const harness = await boot({
      records: [recordOf('a')],
      values: { a: { contextTimeline: timelineOf() } },
      workspace: {
        list: () => { throw new Error('no registry') },
        get archivedSessionIds(): readonly string[] { throw new Error('no archive') },
      },
      agents: { get: () => { throw new Error('no agent') } },
    })
    const page = pageOf(await call(harness, { part: 'page' }))
    assert.equal(page.items[0].running, false)
    assert.deepEqual(page.groups, [{ key: '__ungrouped__', count: 1 }])
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.sessions, 1)
  })

  test('hostile bodies, non-array listings, and listing failures keep the route lifecycle intact', async () => {
    const harness = await boot({ records: [recordOf('a')], values: { a: { contextTimeline: timelineOf() } } })
    const malformed = await call(harness, 'not json')
    assert.equal(malformed.reply.error?.code, 'dsh-context/bad-request')
    const missingPart = await call(harness, {})
    assert.equal(missingPart.reply.error?.code, 'dsh-context/bad-request')
    const unknownPart = await call(harness, { part: 'nope' })
    assert.equal(unknownPart.reply.error?.code, 'dsh-context/bad-request')
    const hostileRevision = await call(harness, { part: 'summary', revision: 7, scope: 'nope', sort: 'bogus', page: -5, tally: 'nope', pick: { field: 'bogus', name: 7 } })
    assert.equal(hostileRevision.reply.ok, true)
    const flatHarness = await boot({ records: 'not-a-listing' })
    const flat = await call(flatHarness, { part: 'summary' })
    assert.equal(flat.reply.ok, true)
    assert.equal(summaryOf(flat.reply).sessions, 0)
    assert.equal(flat.reply.ok && (flat.reply.value as { pricingReady?: boolean }).pricingReady, true)
    const failedHarness = await boot({ listSessions: () => Promise.reject(new Error('listing down')) })
    const failed = await call(failedHarness, { part: 'summary' })
    assert.equal(failed.reply.error?.code, 'gateway/internal')
    const plainHarness = await boot({ listSessions: () => Promise.reject('plain failure') })
    const failedPlain = await call(plainHarness, { part: 'summary' })
    assert.equal(failedPlain.reply.error?.message, 'plain failure')
  })

  test('a live session with no registry snapshot and a cold session with a throwing cached read both stay listed', async () => {
    const harness = await boot({
      records: [recordOf('cold'), recordOf('live', { live: true })],
      liveSeq: { live: 1 },
    })
    harness.cacheMode.throwCached = true
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.sessions, 2)
    assert.equal(summary.sessionsTotal, 2)
  })

  test('a short scan TTL shares one listSessions across parts and concurrent requests, and a backfill write invalidates it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = () => resolve() })
    let listed = 0
    const gateAt = 2
    const harness = await boot({
      scanTtlMs: 10_000,
      listSessions: async () => {
        listed++
        if (listed === gateAt) await gate
        return [recordOf('a')]
      },
      values: { a: { contextTimeline: timelineOf({ turns: 1 }), contextActivity: { days: {} }, title: 'Alpha' } },
    })
    const first = call(harness, { part: 'summary' })
    const second = call(harness, { part: 'days' })
    await new Promise(resolve => setTimeout(resolve, 5))
    release()
    await Promise.all([first, second])
    assert.equal(listed, 1, 'concurrent parts share one in-flight corpus scan')
    await call(harness, { part: 'page' })
    await call(harness, { part: 'tally' })
    assert.equal(listed, 1, 'later parts within the TTL reuse the scan')
    harness.state.backfillVersion = 1
    await call(harness, { part: 'summary' })
    assert.equal(listed, 2, 'a backfill version change forces a fresh scan')
  })

  test('the served-key set is bounded so paging and filtering cannot grow it without limit', async () => {
    const harness = await boot({
      scanTtlMs: 10_000,
      servedKeysMax: 2,
      records: [recordOf('a'), recordOf('b')],
      values: {
        a: { contextTimeline: timelineOf({ turns: 1 }), title: 'A' },
        b: { contextTimeline: timelineOf({ turns: 1 }), title: 'B' },
      },
    })
    const summary = await call(harness, { part: 'summary' })
    const revision = revisionOf(summary)
    await call(harness, { part: 'page', page: 0 })
    await call(harness, { part: 'page', page: 1 })
    const evicted = await call(harness, { part: 'summary', revision })
    assert.ok(evicted.reply.value !== undefined && !('unchanged' in evicted.reply.value), 'the oldest served key was evicted')
    const remembered = await call(harness, { part: 'page', page: 1, revision })
    assert.ok(remembered.reply.value !== undefined && 'unchanged' in remembered.reply.value, 'a recent key stays remembered')
    test('a held Today revision re-serves the new day at local midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 8, 23, 59, 50))
      const harness = await boot({
        records: [recordOf('a', { createdAt: new Date(2026, 10, 8, 20, 0, 0).getTime() })],
        values: {
          a: {
            contextTimeline: timelineOf({ total: 900, turns: 1, cost: usageOf(900) }),
            contextActivity: { days: { '2026-11-08': dayOf(900, 1) } },
            title: 'Overnight',
            sessionListMetadata: { blank: false, lastPromptAt: new Date(2026, 10, 8, 23, 0, 0).getTime() },
          },
        },
      })
      const before = await call(harness, { part: 'summary', scope: { range: 'today' } })
      assert.equal(summaryOf(before).sessions, 1)
      const revision = revisionOf(before)
      vi.setSystemTime(new Date(2026, 10, 9, 0, 0, 20))
      const held = unwrap(await call(harness, { part: 'summary', scope: { range: 'today' }, revision }))
      assert.ok(held.value !== undefined && 'summary' in held.value, 'the midnight poll re-serves the new day')
      assert.equal(held.value.summary.sessions, 0)
      const steady = unwrap(await call(harness, { part: 'summary', scope: { range: 'today' }, revision: held.value.revision }))
      assert.ok(steady.value !== undefined && 'unchanged' in steady.value, 'the same-day poll stays unchanged')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a held All-time revision stays unchanged across local midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 8, 23, 59, 50))
      const harness = await boot({
        records: [recordOf('a', { createdAt: new Date(2026, 10, 8, 20, 0, 0).getTime() })],
        values: {
          a: {
            contextTimeline: timelineOf({ total: 900, turns: 1, cost: usageOf(900) }),
            contextActivity: { days: { '2026-11-08': dayOf(900, 1) } },
          },
        },
      })
      const before = await call(harness, { part: 'summary', scope: { range: 'all' } })
      const revision = revisionOf(before)
      vi.setSystemTime(new Date(2026, 10, 9, 0, 0, 20))
      const after = await call(harness, { part: 'summary', scope: { range: 'all' }, revision })
      assert.ok(after.reply.value !== undefined && 'unchanged' in after.reply.value, 'All time is day-independent')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a clock beyond the day-key range answers with an open relative window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(10_000, 0, 1))
      const harness = await boot({ records: [], values: {} })
      const reply = await call(harness, { part: 'summary', scope: { range: 'today' } })
      assert.ok(reply.reply.value !== undefined && 'summary' in reply.reply.value)
    } finally {
      vi.useRealTimers()
    }
  })
})
