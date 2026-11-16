import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeCorpus } from './helpers/dbCorpus'
import { dayRangeClause, likePattern, timeRangeClause, scopeOf, windowOfScope } from '../../src/host/db/queries/common'
import { contextParts, familyAggregates, rootRows, selfAggregates } from '../../src/host/db/queries/filters'
import { querySessions } from '../../src/host/db/queries/sessions'
import { dayOfNow, queryDays, querySummary, queryTally } from '../../src/host/db/queries/aggregate'
import {
  queryContext, queryDelta, queryEvents, queryFileOps, queryRequests, querySkillLoads, querySpans,
  querySteps, queryTimeline, queryToolCalls, sessionState,
} from '../../src/host/db/queries/detail'
import { countRows, foldStatusDistribution, queryCost, queryFamily } from '../../src/host/db/queries/family'
import { mergeCostUsage, mergeUsageMap, usageByFamily, usageBySession } from '../../src/host/db/queries/costUsage'
import { requests, sessions, surfaceNodes, timingSpans } from '../../src/host/db/schema'
import type { Coverage } from '../../src/host/db/scheduler'
import type { CostSource } from '../../src/host/cost'
import { sql } from 'drizzle-orm'

const COVERAGE: Coverage = {
  complete: true, remaining: 0, failed: 0, running: false,
  total: 4, covered: 4, unsupported: 0, folding: 0, deleting: 0,
}

const COST: CostSource = {
  ready: () => true,
  version: () => 2,
  usd: usage => usage === null || usage === undefined ? null : 1.5,
  read: usage => usage === null || usage === undefined ? undefined : { usd: 1.5, ready: true },
  complete: () => true,
}

describe('query scope', () => {
  test('parses ranges, days, coverage, pick and filters', () => {
    assert.equal(windowOfScope(scopeOf({ range: 'all' })).all, true)
    assert.equal(windowOfScope(scopeOf({ range: '8w' })).fromDay !== null, true)
    assert.equal(windowOfScope(scopeOf({ range: 'today' })).fromDay !== null, true)
    assert.equal(windowOfScope(scopeOf({ range: { start: 20, end: 10 } })).start, 10)
    assert.equal(windowOfScope(scopeOf({ range: { end: 1 } })).fromDay !== null, true)
    assert.equal(scopeOf({ day: '2026-01-02', coverage: 'active', group: 'g', query: 'q', model: 'm', running: true }).coverage, 'active')
    assert.equal(scopeOf({ pick: { field: 'tools', name: 'read' } }).pick?.name, 'read')
    assert.equal(scopeOf({ pick: { field: 'bogus', name: 'x' } }).pick, undefined)
    assert.equal(scopeOf({ day: 'bad', query: 7 }).day, undefined)
    assert.equal(windowOfScope(scopeOf({ range: { start: 'x', end: 2 } })).start > 0, true)
    assert.equal(windowOfScope(scopeOf({ range: { start: 1, end: 'x' } })).start > 0, true)
    assert.equal(windowOfScope(scopeOf({ day: '9999-99-99' })).start > 0, true)
    assert.equal(windowOfScope(scopeOf({ range: '7d' })).fromDay !== null, true)
    assert.equal(windowOfScope(scopeOf({ range: '30d' })).fromDay !== null, true)
    assert.equal(likePattern('A%_').includes('\\%') && likePattern('A%_').includes('\\_'), true)
    assert.equal(dayRangeClause(sql`x`, { start: 0, end: null, fromDay: null, toDay: null, all: false }) !== undefined, true)
    assert.equal(timeRangeClause(sql`x`, { start: 0, end: null, fromDay: null, toDay: null, all: false }) !== undefined, true)
  })
})

describe('query corpus', () => {
  test('filters roots by coverage, group, text, running, model and picks', () => {
    const { opened, db } = makeCorpus()
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all' })).map(row => row.id).sort(), ['fork', 'other', 'root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', coverage: 'archived' })).map(row => row.id), ['fork'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', coverage: 'active' })).map(row => row.id).sort(), ['other', 'root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', group: 'workspace-one' })).map(row => row.id).sort(), ['fork', 'root'])
    assert.equal(rootRows(db, scopeOf({ range: 'all', group: '__ungrouped__' })).length, 1)
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', query: 'TITLE-ROOT' })).map(row => row.id), ['root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', model: 'deepseek-v4-pro' })).map(row => row.id), ['root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', running: true })).map(row => row.id), ['root'])
    assert.equal(rootRows(db, scopeOf({ range: 'all', running: false })).length, 2)
    assert.equal(rootRows(db, scopeOf({ range: { start: 0, end: 4102444800000 }, pick: { field: 'models', name: 'deepseek-v4-pro' } })).length, 1)
    assert.equal(rootRows(db, scopeOf({ range: '30d', pick: { field: 'skills', name: 'nope' } })).length, 0)
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', pick: { field: 'skills', name: 'nope' } })), [])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', pick: { field: 'tools', name: 'bash' } })).map(row => row.id), ['root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', pick: { field: 'cmds', name: 'ls' } })).map(row => row.id), ['root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', pick: { field: 'models', name: 'deepseek-v4-pro' } })).map(row => row.id), ['root'])
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', pick: { field: 'providers', name: 'deepseek' } })).length, 2)
    assert.deepEqual(rootRows(db, scopeOf({ range: 'all', day: '1970-01-01' })).length, 2)
    opened.client.close()
  })

  test('aggregates families, self counters and live context parts', () => {
    const { opened, db } = makeCorpus()
    const family = familyAggregates(db, ['root', 'fork'])
    assert.equal(family.get('root')?.members, 2)
    assert.equal(family.get('fork')?.tokens, 6)
    const self = selfAggregates(db, ['root'])
    assert.equal(self.get('root')?.calls, 2)
    assert.equal(self.get('root')?.steps, 2)
    const parts = contextParts(db, ['root', 'missing'])
    assert.ok((parts.get('root')?.system ?? 0) > 0)
    assert.equal(parts.get('missing'), undefined)
    opened.client.close()
  })

  test('lists sessions with family values, ids self values and sorts', () => {
    const { opened, db } = makeCorpus()
    const value = querySessions(db, COST, {
      scope: scopeOf({ range: 'all' }), sort: 'tokens', page: 0, pageSize: 12,
    }, COVERAGE)
    assert.equal(value.total, 3)
    assert.equal(value.items[0]?.id, 'root')
    assert.equal(value.items[0]?.family_billed_tokens, 30)
    assert.equal(value.items.find(row => row.id === 'fork')?.family_billed_tokens, 6)
    assert.equal(value.items.find(row => row.id === 'root')?.turns, 2)
    assert.equal(value.items.find(row => row.id === 'root')?.cost_usd, 1.5)
    assert.equal(value.groups.length, 2)
    assert.equal(value.scope_total, 3)
    const ids = querySessions(db, COST, {
      scope: scopeOf({ range: 'all' }), sort: 'tokens', page: 0, pageSize: 12, ids: ['fork', 'missing', 'root'],
    }, COVERAGE)
    assert.deepEqual(querySessions(db, COST, { scope: scopeOf({ range: 'all' }), sort: 'recent', page: 0, pageSize: 12, ids: [] }, COVERAGE).items, [])
    assert.deepEqual(ids.items.map(row => row.id), ['fork', 'root'])
    assert.equal(ids.items[1]?.family_billed_tokens, 20)
    assert.equal(querySessions(db, COST, {
      scope: scopeOf({ range: 'all' }), sort: 'context', page: 1, pageSize: 2,
    }, COVERAGE).total, 3)
    assert.equal(querySessions(db, COST, {
      scope: scopeOf({ range: 'all' }), sort: 'recent', page: 99, pageSize: 12,
    }, COVERAGE).items.length, 3)
    opened.client.close()
  })

  test('summarizes, lists days and tallies', () => {
    const { opened, db } = makeCorpus()
    db.insert(timingSpans).values([
      { sessionId: 'root', spanSeq: 99, seq: 1, startTime: 1, endTime: 2, kind: 'reasoning' },
      { sessionId: 'root', spanSeq: 100, seq: 1, startTime: 1, endTime: 2, kind: 'text' },
      { sessionId: 'root', spanSeq: 101, seq: 1, startTime: 1, endTime: 2, kind: 'toolarg' },
    ]).run()
    db.insert(requests).values({ sessionId: 'other', seq: 1, time: 1, day: '2026-01-02' }).run()
    db.update(requests).set({ period: 'peak', provider: null, model: null }).where(eq(requests.seq, 4)).run()
    const summary = querySummary(db, COST, scopeOf({ range: 'all' }), { sessionsTotal: 4, coverage: COVERAGE })
    assert.equal(summary.sessions, 3)
    assert.equal(summary.sessionsArchived, 1)
    assert.equal(summary.tokens, 36)
    assert.equal(summary.turns, 4)
    assert.ok(summary.cacheHit !== null)
    assert.ok(summary.tokenParts !== null)
    assert.ok(summary.timing !== null)
    assert.equal(summary.coverage.complete, true)
    assert.equal(summary.windowTiming.wallMs > 0, true)
    assert.equal(querySummary(db, COST, scopeOf({ range: 'all', coverage: 'archived' }), {
      sessionsTotal: 4, coverage: COVERAGE,
    }).sessions, 1)
    const days = queryDays(db, COST, scopeOf({ range: 'all' }))
    assert.equal(days.length, 2)
    const day = days.find(entry => entry.key === '1970-01-01')
    assert.equal(day?.tokens, 36)
    assert.equal(day?.tool_calls, 1)
    assert.equal(day?.sessions, 2)
    assert.equal(queryDays(db, COST, scopeOf({ range: 'today' })).length, 0)
    assert.equal(queryDays(db, COST, scopeOf({ range: 'all', coverage: 'active' })).length, 2)
    assert.equal(queryDays(db, COST, scopeOf({ range: 'all', coverage: 'archived' })).length, 1)
    const otherSummary = querySummary(db, COST, scopeOf({ range: 'all', query: 'title-other' }), { sessionsTotal: 1, coverage: COVERAGE })
    assert.equal(otherSummary.cacheHit, null)
    assert.equal(otherSummary.timing, null)
    assert.equal(dayOfNow(0) !== null, true)
    assert.equal(dayOfNow() !== null, true)
    const tools = queryTally(db, scopeOf({ range: 'all' }), 'tools', 10, 0, 'n')
    assert.deepEqual(tools.stats.map(row => row.name), ['bash'])
    assert.equal(tools.total, 1)
    assert.equal(queryTally(db, scopeOf({ range: 'all' }), 'tools', 10, 0, 'last').stats.length, 1)
    assert.deepEqual(queryTally(db, scopeOf({ range: 'all' }), 'cmds', 10, 0, 'n').stats.map(row => row.name), ['ls'])
    assert.deepEqual(queryTally(db, scopeOf({ range: 'all' }), 'models', 10, 0, 'n').stats.length, 2)
    assert.deepEqual(queryTally(db, scopeOf({ range: 'all' }), 'providers', 10, 0, 'n').stats[0]?.name, 'deepseek')
    assert.equal(queryTally(db, scopeOf({ range: 'all' }), 'skills', 10, 0, 'n').total, 0)
    assert.equal(queryTally(db, scopeOf({ range: '30d' }), 'tools', 10, 0, 'n').stats.length, 0)
    assert.equal(queryTally(db, scopeOf({ range: '30d' }), 'skills', 10, 0, 'n').stats.length, 0)
    assert.equal(queryTally(db, scopeOf({ range: '30d' }), 'cmds', 10, 0, 'n').stats.length, 0)
    assert.equal(queryTally(db, scopeOf({ range: '30d' }), 'providers', 10, 0, 'n').stats.length, 0)
    opened.client.close()
  })

  test('serves context, timeline, requests, steps, tools, files, events and spans', () => {
    const { opened, db } = makeCorpus()
    const context = queryContext(db, COST, 'root')
    assert.ok('ok' in context && context.ok === true)
    assert.equal(context.counts?.turns, 2)
    assert.equal(context.counts?.steps, 2)
    assert.equal(context.last?.seq, 13)
    assert.equal(context.systems?.length, 1)
    assert.ok(context.costRead !== undefined)
    assert.deepEqual(queryContext(db, COST, 'missing'), { ok: false, fold_status: 'missing', detail_rev: 0 })

    const timeline = queryTimeline(db, 'root', null, { limit: 2, archiveLimit: 1 })
    assert.ok(!('ok' in timeline))
    assert.equal(timeline.live, true)
    assert.equal(timeline.nodes.length, 2)
    assert.equal(timeline.droppedNodes > 0, true)
    assert.equal(timeline.archive.length, 1)
    assert.equal(timeline.system?.seq, 1)
    assert.equal(timeline.header?.seq, 10)
    const past = queryTimeline(db, 'root', 5, { limit: 50, archiveLimit: 50 })
    assert.ok(!('ok' in past) && past.live === false)
    assert.equal(past.nodes.some(node => node.seq === 4), true)
    assert.equal(queryTimeline(db, 'missing', null) && 'ok' in queryTimeline(db, 'missing', null)!, true)

    const requests = queryRequests(db, { sessionId: 'root', limit: 10 })
    assert.equal(requests.length, 2)
    assert.deepEqual(queryRequests(db, { sessionId: 'root', turn: 2 }).map(row => row.seq), [13])
    assert.deepEqual(queryRequests(db, { sessionId: 'root', after: 10 }).map(row => row.seq), [13])
    assert.equal(queryRequests(db, { sessionId: 'root', offsetFromEnd: 1, limit: 1 })[0]?.seq, 13)
    assert.equal(queryRequests(db, { scope: scopeOf({ range: 'all' }), limit: 100 }).length > 0, true)
    assert.deepEqual(queryRequests(db, {}), [])

    const steps = querySteps(db, 'root', undefined, 10)
    assert.equal(steps.length, 2)
    assert.deepEqual(querySteps(db, 'root', steps[0]?.seq, 10).map(row => row.seq), [12])

    const tools = queryToolCalls(db, { sessionId: 'root', limit: 10 })
    assert.equal(tools.total, 1)
    assert.equal(tools.items[0]?.cmd, 'ls')
    assert.equal(queryToolCalls(db, { sessionId: 'root', commandsOnly: true, limit: 10 }).items.length, 1)
    assert.equal(queryToolCalls(db, { sessionId: 'root', status: 'slow', slowMs: 0 }).items.length, 1)
    assert.equal(queryToolCalls(db, { sessionId: 'root', status: 'failed' }).items.length, 0)
    assert.equal(queryToolCalls(db, { sessionId: 'root', query: 'ls' }).items.length, 1)
    assert.equal(queryToolCalls(db, { sessionId: 'root', program: 'ls' }).items.length, 1)
    const slow = queryToolCalls(db, { sessionId: 'root', sort: 'slowest' })
    assert.equal(queryToolCalls(db, {
      sessionId: 'root', sort: 'latest', cursor: { time: slow.items[0]?.start, seq: slow.items[0]?.seq ?? 0 },
    }).items.length, 0)
    assert.equal(queryToolCalls(db, {
      sessionId: 'root', sort: 'slowest', cursor: { duration: Number(slow.items[0]?.duration_ms ?? 0), seq: slow.items[0]?.seq ?? 0 },
    }).items.length, 0)
    assert.equal(queryToolCalls(db, { scope: scopeOf({ range: 'all' }) }).items.length, 1)

    const files = queryFileOps(db, 'root', 'list', {})
    assert.ok('items' in files && files.items.length === 0)
    const paths = queryFileOps(db, 'root', 'paths', { kind: 'read' })
    assert.ok('paths' in paths)
    assert.equal(queryFileOps(db, 'root', 'list', { after: 99 }).total, 0)

    const events = queryEvents(db, 'root', {})
    assert.equal(events.length, 3)
    assert.equal(events.some(event => event.kind === 'model'), true)
    assert.equal(queryEvents(db, 'root', { kinds: ['mode'] }).length, 1)
    assert.equal(queryEvents(db, 'root', { after: 9 }).length, 1)
    assert.equal(querySpans(db, 'root', {}).length > 0, true)
    assert.equal(querySpans(db, 'root', { before: 0 }).length, 0)
    assert.equal(querySkillLoads(db, { sessionId: 'root' }).length, 0)
    assert.equal(querySkillLoads(db, { scope: scopeOf({ range: 'all' }) }).length, 0)
    assert.deepEqual(querySkillLoads(db, {}), [])
    opened.client.close()
  })

  test('serves family, cost and status shapes', () => {
    const { opened, db } = makeCorpus()
    const family = queryFamily(db, COST, 'root')
    assert.equal(family.members.length, 2)
    assert.equal(family.members[0]?.id, 'root')
    assert.equal(family.members[0]?.subtree_billed_tokens, 30)
    assert.equal(family.partial, false)
    assert.equal(queryFamily(db, COST, 'missing').members.length, 0)
    assert.equal(queryFamily(db, COST, 'child').members.length, 1)
    assert.equal(queryCost(db, COST, { sessionId: 'root' }).usd, 1.5)
    assert.equal(queryCost(db, COST, { sessionId: 'root', family: true }).usd, 1.5)
    assert.equal(queryCost(db, COST, { scope: scopeOf({ range: 'all' }) }).usd, 1.5)
    assert.equal(queryCost(db, COST, {}).usd, null)
    assert.equal(queryCost(db, COST, { sessionId: 'missing' }).usd, null)
    assert.equal(queryCost(db, COST, { sessionId: 'missing', family: true }).usd, null)
    const faces: CostSource = { ...COST, read: () => ({ usd: 1, ready: true, faces: [], misses: [] }) }
    assert.equal(queryCost(db, faces, { sessionId: 'root' }).ready, true)
    assert.equal(usageBySession(db, ['root'], true).size, 1)
    assert.equal(usageBySession(db, [], true).size, 0)
    assert.equal(usageByFamily(db, []).size, 0)
    db.update(requests).set({ period: 'peak', provider: null, model: null }).where(eq(requests.seq, 4)).run()
    assert.equal(usageBySession(db, ['root'], true).size, 1)
    assert.equal(usageByFamily(db, ['root']).size, 1)
    assert.equal(countRows(db).sessions, 4)
    assert.equal(foldStatusDistribution(db).ok, 4)
    assert.equal(sessionState(db, 'root')?.id, 'root')
    assert.equal(sessionState(db, 'missing'), undefined)
    opened.client.close()
  })

  test('delta compares two views and reports added, removed and token changes', () => {
    const { opened, db } = makeCorpus()
    const delta = queryDelta(db, 'root', 14, 3)
    assert.ok(delta !== null)
    assert.ok(delta.added.length > 0)
    assert.ok(delta.removedCounts.assistant + delta.removedCounts.user + delta.removedCounts.inject >= 0)
    assert.equal(queryDelta(db, 'root', null, 3)?.viewNodes.length, 0)
    assert.equal(queryDelta(db, 'root', 5, 999) !== null, true)
    assert.equal(queryDelta(db, 'missing', 5, 3), null)
    opened.client.close()
  })

  test('handles empty and corrupt rows', () => {
    const { opened, db } = makeCorpus()
    db.update(sessions).set({ foldStatus: 'pending' }).where(eq(sessions.id, 'root')).run()
    const notReady = queryContext(db, COST, 'root')
    assert.ok('ok' in notReady && notReady.ok === false)
    assert.ok('ok' in queryTimeline(db, 'root', null))
    db.update(sessions).set({ foldStatus: 'ok' }).where(eq(sessions.id, 'root')).run()
    db.update(surfaceNodes).set({ calls: '{bad', time: null }).where(eq(surfaceNodes.sessionId, 'root')).run()
    const timeline = queryTimeline(db, 'root', null)
    assert.ok(!('ok' in timeline), 'timeline is served')
    assert.ok(timeline.nodes.length > 0, 'nodes are served')
    db.update(requests).set({ provider: null, model: null, period: null }).run()
    assert.equal(queryCost(db, COST, { sessionId: 'root' }).usd, 1.5)
    opened.client.close()
  })

  test('merges usage buckets across providers, models and periods', () => {
    const bucket = (value: number) => ({ uncached: value, cacheRead: value, cacheWrite: value, output: value })
    const first = mergeCostUsage(null, { alpha: { m1: { peak: bucket(1) } } })
    const merged = mergeCostUsage(first, {
      alpha: { m1: { peak: bucket(2), off: bucket(3) }, m2: { peak: bucket(4) } },
      beta: { m3: { off: bucket(5) } },
    })
    assert.deepEqual(merged, {
      alpha: {
        m1: { peak: { uncached: 3, cacheRead: 3, cacheWrite: 3, output: 3 }, off: bucket(3) },
        m2: { peak: bucket(4) },
      },
      beta: { m3: { off: bucket(5) } },
    })
    const map = mergeUsageMap(new Map([
      ['one', { alpha: { m1: { peak: bucket(1) } } }],
      ['two', { alpha: { m1: { peak: bucket(2) } } }],
    ]))
    assert.deepEqual(map, { alpha: { m1: { peak: { uncached: 3, cacheRead: 3, cacheWrite: 3, output: 3 } } } })
    assert.equal(mergeUsageMap(new Map()), null)
  })

  test('aggregates family costs with missing usage on either side', () => {
    const rootOnly = makeCorpus()
    rootOnly.db.delete(requests).where(eq(requests.sessionId, 'child')).run()
    const rootCost = queryFamily(rootOnly.db, COST, 'root')
    assert.equal(rootCost.cost_usd, 1.5)
    assert.equal(rootCost.members.find(member => member.id === 'child')?.subtree_cost_usd, null)
    rootOnly.opened.client.close()

    const childOnly = makeCorpus()
    childOnly.db.delete(requests).where(eq(requests.sessionId, 'root')).run()
    const childCost = queryFamily(childOnly.db, COST, 'root')
    assert.equal(childCost.cost_usd, 1.5)
    assert.equal(childCost.members.find(member => member.id === 'child')?.subtree_cost_usd, 1.5)
    childOnly.opened.client.close()

    const empty = makeCorpus()
    const noCost: CostSource = { ...COST, usd: () => null }
    assert.equal(queryFamily(empty.db, noCost, 'root').cost_usd, null)
    empty.db.update(sessions).set({ createdDay: null }).where(eq(sessions.familyRoot, 'root')).run()
    assert.equal(familyAggregates(empty.db, ['root']).get('root')?.createdDay, null)
    empty.opened.client.close()
  })

  test('counts only cost-complete families in a summary', () => {
    const { opened, db } = makeCorpus()
    const partial: CostSource = { ...COST, complete: () => false }
    const summary = querySummary(db, partial, scopeOf({ range: 'all' }), { sessionsTotal: 4, coverage: COVERAGE })
    assert.equal(summary.costSessions, 0)
    assert.equal(queryCost(db, COST, { sessionId: 'other', family: true }).usd, null)
    opened.client.close()
  })
})
