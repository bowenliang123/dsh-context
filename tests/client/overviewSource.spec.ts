import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { BackfillCoverage, OverviewRequest, OverviewScope } from '../../src/shared/types'
import { OVERVIEW_POLL_MS, overviewValueOf } from '../../src/client/overviewSource'
import { cleanupMounts, flush, mount, settle, type Mounted } from './helpers/kit'

const OVERVIEW_ROUTE = 'api/dsh-context/overview'

const BACKFILL_ROUTE = 'api/dsh-context/backfill'

const POLL_MS = 30_000

interface Modules {
  source: typeof import('../../src/client/overviewSource')
  invalidation: typeof import('../../src/client/invalidation')
}

async function fresh(): Promise<Modules> {
  vi.resetModules()
  const source = await import('../../src/client/overviewSource')
  const invalidation = await import('../../src/client/invalidation')
  return { source, invalidation }
}

interface Call {
  route: string
  body: Record<string, unknown>
  method: string | undefined
}

type Handler = (call: Call, index: number) => unknown

function stubRoutes(handler: Handler): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string; method?: string }) => {
    const call: Call = {
      route: String(input),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
      method: init?.method,
    }
    calls.push(call)
    const value = await handler(call, calls.length - 1)
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  return calls
}

function stubFailing(failure: 'thrown' | 'http' | 'envelope' | 'malformed'): void {
  if (failure === 'thrown') {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    return
  }
  if (failure === 'http') {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
    return
  }
  if (failure === 'envelope') {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: false }) }))
    return
  }
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ ok: true, value: { revision: 'r1', pricingReady: true, nope: 1 } }),
  }))
}

const BASE_COVERAGE: BackfillCoverage = {
  complete: true,
  running: false,
  remaining: 0,
  failed: 0,
  total: 2,
  covered: 2,
  unsupported: 0,
}

function coverageOf(over: Partial<BackfillCoverage> = {}): BackfillCoverage {
  return { ...BASE_COVERAGE, ...over }
}

function summaryRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 2,
    sessionsTotal: 3,
    sessionsArchived: 1,
    archivedScoped: 1,
    tokens: 1800,
    turns: 5,
    costUsd: 0.5,
    costSessions: 1,
    usageSessions: 1,
    cacheHit: '33.33',
    tokenParts: [{ key: 'system', value: 100 }, { key: 'tools', value: 20 }],
    timing: { wallMs: 1000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
    coverage: coverageOf(),
    ...over,
  }
}

function summaryValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, summary: summaryRaw(), ...over }
}

function daysValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 'r1', pricingReady: true, days: [{ key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 }], ...over }
}

function pageValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: false,
    page: {
      items: [{
        id: 's1',
        title: 'one',
        cwd: '/repo',
        updatedAt: 5,
        running: true,
        archived: false,
        group: 'w',
        tokens: 10,
        turns: 2,
        steps: 3,
        parts: [{ key: 'system', value: 7 }],
        total: 7,
        contextWindow: 100,
        maxOutputTokens: 50,
        model: 'm',
        lastUser: 'hi',
        costUsd: 0.25,
        createdDay: '2026-09-10',
      }],
      index: 0,
      count: 1,
      total: 1,
      scopeTotal: 4,
      groups: [{ key: 'w', count: 1 }],
    },
    ...over,
  }
}

function tallyValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 'r1',
    pricingReady: true,
    tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
    ...over,
  }
}

interface SummaryProbe {
  states: import('../../src/client/overviewSource').OverviewSummaryState[]
  m: Mounted
  update: (next: OverviewScope | null, nextEnabled?: boolean) => Promise<void>
}

async function mountSummary(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<SummaryProbe> {
  const states: SummaryProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewSummary(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m, update: (next, nextEnabled = enabled) => m.update(h(Probe, { scope: next, enabled: nextEnabled })) }
}

interface DaysProbe {
  states: import('../../src/client/overviewSource').PartState<{ days: import('../../src/shared/types').OverviewDay[]; pricingReady: boolean }>[]
  m: Mounted
}

async function mountDays(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<DaysProbe> {
  const states: DaysProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewDays(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m }
}

interface PageProbe {
  states: import('../../src/client/overviewSource').PartState<{ page: import('../../src/shared/types').OverviewPage; pricingReady: boolean }>[]
  m: Mounted
}

async function mountPage(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<PageProbe> {
  const states: PageProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewPage(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

interface TallyProbe {
  states: import('../../src/client/overviewSource').PartState<{ tally: import('../../src/shared/types').OverviewTally; pricingReady: boolean }>[]
  m: Mounted
}

async function mountTally(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<TallyProbe> {
  const states: TallyProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewTally(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

function lastOf<T>(states: T[]): T {
  const found = states[states.length - 1]
  assert.ok(found !== undefined, 'the probe rendered')
  return found
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('overviewValueOf', () => {
  test('garbage, a missing revision, and a payload without a part reject', () => {
    for (const bad of [null, undefined, 7, 'x', [], {}, { revision: '' }, { revision: 7 }, { revision: 'r1' }]) {
      assert.equal(overviewValueOf(bad), null, `${JSON.stringify(bad)} decodes to null`)
    }
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true }), null, 'no part selects nothing')
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, other: 1 }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: 'yes', days: [] }), null, 'pricingReady must be a boolean')
    assert.equal(overviewValueOf({ revision: 'r1', unchanged: false, days: [] }), null, 'a false unchanged flag still needs pricingReady')
  })

  test('the unchanged reply decodes on its revision alone', () => {
    assert.deepEqual(overviewValueOf({ revision: 'r2', unchanged: true }), { revision: 'r2', unchanged: true })
    assert.deepEqual(
      overviewValueOf({ revision: 'r2', unchanged: true, pricingReady: 'ignored', days: [] }),
      { revision: 'r2', unchanged: true },
      'an unchanged reply needs no part payload',
    )
  })

  test('a valid summary normalizes every field', () => {
    const decoded = overviewValueOf(summaryValue())
    assert.deepEqual(decoded, {
      revision: 'r1',
      pricingReady: true,
      summary: {
        sessions: 2,
        sessionsTotal: 3,
        sessionsArchived: 1,
        archivedScoped: 1,
        tokens: 1800,
        turns: 5,
        costUsd: 0.5,
        costSessions: 1,
        usageSessions: 1,
        cacheHit: '33.33',
        tokenParts: [{ key: 'system', value: 100 }, { key: 'tools', value: 20 }],
        timing: { wallMs: 1000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
        coverage: BASE_COVERAGE,
      },
    })
  })

  test('a summary tolerates absent optional fields and a null cost', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: {
        sessions: 0,
        sessionsTotal: 0,
        tokens: 0,
        turns: 0,
        costUsd: null,
        costSessions: 0,
        usageSessions: 0,
        coverage: BASE_COVERAGE,
      },
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.equal(decoded.summary.sessionsArchived, 0)
    assert.equal(decoded.summary.archivedScoped, 0)
    assert.equal(decoded.summary.cacheHit, null)
    assert.equal(decoded.summary.tokenParts, null)
    assert.equal(decoded.summary.timing, null)
    const loose = overviewValueOf(summaryValue({
      summary: summaryRaw({ cacheHit: 42, sessionsArchived: -1, tokenParts: { not: 'an array' }, timing: null }),
    }))
    assert.ok(loose !== null && 'summary' in loose)
    assert.equal(loose.summary.cacheHit, null, 'a non-string hit rate reads absent')
    assert.equal(loose.summary.sessionsArchived, 0, 'a hostile archived count floors to zero')
    assert.equal(loose.summary.tokenParts, null)
    assert.equal(loose.summary.timing, null)
    const explicitNulls = overviewValueOf(summaryValue({ summary: summaryRaw({ cacheHit: null, tokenParts: null }) }))
    assert.ok(explicitNulls !== null && 'summary' in explicitNulls)
    assert.equal(explicitNulls.summary.cacheHit, null)
    assert.equal(explicitNulls.summary.tokenParts, null)
    const nonListParts = overviewValueOf(summaryValue({ summary: summaryRaw({ tokenParts: 'x' }) }))
    assert.ok(nonListParts !== null && 'summary' in nonListParts)
    assert.equal(nonListParts.summary.tokenParts, null, 'a non-list tokenParts reads absent')
  })

  test('hostile summary fields reject the whole summary part', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['sessions', { sessions: '2' }],
      ['sessions negative', { sessions: -1 }],
      ['sessionsTotal', { sessionsTotal: undefined }],
      ['tokens', { tokens: 'x' }],
      ['turns', { turns: -2 }],
      ['costSessions', { costSessions: null }],
      ['usageSessions', { usageSessions: '1' }],
      ['costUsd', { costUsd: 'free' }],
      ['coverage absent', { coverage: undefined }],
      ['coverage complete', { coverage: { ...BASE_COVERAGE, complete: 'yes' } }],
      ['coverage running', { coverage: { ...BASE_COVERAGE, running: 1 } }],
      ['coverage remaining', { coverage: { ...BASE_COVERAGE, remaining: -1 } }],
      ['coverage failed', { coverage: { ...BASE_COVERAGE, failed: 'x' } }],
      ['coverage total', { coverage: { ...BASE_COVERAGE, total: null } }],
      ['coverage covered', { coverage: { ...BASE_COVERAGE, covered: -1 } }],
      ['coverage unsupported', { coverage: { ...BASE_COVERAGE, unsupported: 'x' } }],
      ['coverage garbage', { coverage: 7 }],
    ]
    for (const [label, over] of cases) {
      assert.equal(overviewValueOf(summaryValue({ summary: summaryRaw(over) })), null, `${label} rejects`)
    }
  })

  test('a summary tokenParts list drops malformed entries and keeps usable keys', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: summaryRaw({
        tokenParts: [
          { key: 'system', value: 5 },
          null,
          { key: '', value: 3 },
          { value: 4 },
          { key: 'tools' },
          { key: 'user', value: Number.NaN },
          { key: 'assistant', value: 0 },
        ],
      }),
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.deepEqual(decoded.summary.tokenParts, [
      { key: 'system', value: 5 },
      { key: 'assistant', value: 0 },
    ])
  })

  test('a valid days part filters malformed entries and keeps null costs', () => {
    const decoded = overviewValueOf(daysValue({
      days: [
        { key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 },
        { key: '2026-09-15', tokens: 0, sessions: 0, costUsd: null },
        null,
        { tokens: 1, sessions: 1 },
        { key: '', tokens: 1, sessions: 1 },
        { key: '2026-09-14', tokens: -1, sessions: 1 },
        { key: '2026-09-13', tokens: 1, sessions: -1 },
        { key: '2026-09-12', tokens: 1, sessions: 1, costUsd: 'x' },
      ],
    }))
    assert.ok(decoded !== null && 'days' in decoded)
    assert.deepEqual(decoded.days, [
      { key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 },
      { key: '2026-09-15', tokens: 0, sessions: 0, costUsd: null },
      { key: '2026-09-12', tokens: 1, sessions: 1, costUsd: null },
    ])
    assert.equal(overviewValueOf(daysValue({ days: {} })), null, 'days must be a list')
  })

  test('a valid page part decodes rows, groups, and the scope total', () => {
    const decoded = overviewValueOf(pageValue())
    assert.ok(decoded !== null && 'page' in decoded)
    assert.equal(decoded.pricingReady, false)
    assert.deepEqual(decoded.page.items, [{
      id: 's1',
      title: 'one',
      cwd: '/repo',
      updatedAt: 5,
      running: true,
      archived: false,
      group: 'w',
      tokens: 10,
      turns: 2,
      steps: 3,
      parts: [{ key: 'system', value: 7 }],
      total: 7,
      contextWindow: 100,
      maxOutputTokens: 50,
      model: 'm',
      lastUser: 'hi',
      costUsd: 0.25,
      createdDay: '2026-09-10',
    }])
    assert.deepEqual(decoded.page.groups, [{ key: 'w', count: 1 }])
    assert.equal(decoded.page.scopeTotal, 4)
  })

  test('a page part defaults optional row fields, drops malformed rows, and falls back to its own total', () => {
    const decoded = overviewValueOf(pageValue({
      page: {
        items: [
          { id: 's2', title: 'two', updatedAt: 1, parts: [], costUsd: null },
          null,
          { title: 'no id', updatedAt: 1, parts: [] },
          { id: 'no title', updatedAt: 1, parts: [] },
          { id: 'no stamp', title: 'x', parts: [] },
          { id: 'no parts', title: 'x', updatedAt: 1 },
          { id: 'bad parts', title: 'x', updatedAt: 1, parts: 'x' },
          { id: 'hostile parts', title: 'x', updatedAt: 1, parts: [null, { key: '' }] },
        ],
        index: 0,
        count: 1,
        total: 7,
      },
    }))
    assert.ok(decoded !== null && 'page' in decoded)
    assert.deepEqual(decoded.page.items, [
      { id: 's2', title: 'two', updatedAt: 1, running: false, archived: false, tokens: 0, turns: 0, parts: [], total: 0, costUsd: null },
      { id: 'hostile parts', title: 'x', updatedAt: 1, running: false, archived: false, tokens: 0, turns: 0, parts: [], total: 0, costUsd: null },
    ])
    assert.deepEqual(decoded.page.groups, [])
    assert.equal(decoded.page.scopeTotal, 7)
  })

  test('hostile page containers reject the page part', () => {
    const bads: [string, Record<string, unknown>][] = [
      ['items', { page: { items: 'x', index: 0, count: 1, total: 1 } }],
      ['index', { page: { items: [], index: -1, count: 1, total: 1 } }],
      ['count', { page: { items: [], index: 0, count: '1', total: 1 } }],
      ['total', { page: { items: [], index: 0, count: 1, total: null } }],
      ['page record', { page: 7 }],
    ]
    for (const [label, over] of bads) {
      assert.equal(overviewValueOf(pageValue(over)), null, `${label} rejects`)
    }
    const hostileGroups = overviewValueOf(pageValue({
      page: { items: [], index: 0, count: 1, total: 0, scopeTotal: 0, groups: [null, { key: '' }, { key: 'w' }, { key: 'w', count: -1 }, { key: 'ok', count: 2 }] },
    }))
    assert.ok(hostileGroups !== null && 'page' in hostileGroups)
    assert.deepEqual(hostileGroups.page.groups, [{ key: 'ok', count: 2 }])
    const nonList = overviewValueOf(pageValue({ page: { items: [], index: 0, count: 1, total: 0, groups: {} } }))
    assert.ok(nonList !== null && 'page' in nonList)
    assert.deepEqual(nonList.page.groups, [])
  })

  test('a valid tally decodes; a hostile tally rejects', () => {
    const decoded = overviewValueOf(tallyValue())
    assert.deepEqual(decoded, {
      revision: 'r1',
      pricingReady: true,
      tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
    })
    const filtered = overviewValueOf(tallyValue({
      tally: {
        field: 'skills',
        stats: [
          { name: 'tdd', n: 1, sessions: 1, last: 1 },
          null,
          { name: '', n: 1, sessions: 1, last: 1 },
          { n: 1, sessions: 1, last: 1 },
          { name: 'a', n: -1, sessions: 1, last: 1 },
          { name: 'b', n: 1, sessions: 'x', last: 1 },
          { name: 'c', n: 1, sessions: 1, last: 'x' },
        ],
      },
    }))
    assert.ok(filtered !== null && 'tally' in filtered)
    assert.deepEqual(filtered.tally.stats, [{ name: 'tdd', n: 1, sessions: 1, last: 1 }])
    const bads: [string, Record<string, unknown>][] = [
      ['tally record', { tally: 7 }],
      ['stats list', { tally: { field: 'tools', stats: {} } }],
      ['field', { tally: { field: 'other', stats: [] } }],
    ]
    for (const [label, over] of bads) {
      assert.equal(overviewValueOf(tallyValue(over)), null, `${label} rejects`)
    }
  })

  test('a malformed selected part rejects instead of falling through to another part', () => {
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, summary: null, days: [] }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, days: null, tally: { field: 'tools', stats: [] } }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, page: null, tally: { field: 'tools', stats: [] } }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, tally: null }), null)
    const firstWins = overviewValueOf({ revision: 'r1', pricingReady: true, tally: null, page: pageValue().page })
    assert.ok(firstWins !== null && 'page' in firstWins, 'the first present part wins')
    assert.deepEqual(firstWins.page, pageValue().page)
  })
})

describe('useOverviewSummary', () => {
  test('the first load posts the scope with a null revision and paints the summary and coverage', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const scope: OverviewScope = { range: '7d', coverage: 'all' }
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountSummary(mod, scope)
    await advance(0)
    const state = lastOf(probe.states)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { part: 'summary', scope, revision: null }, method: 'POST' }])
    assert.equal(state.pending, false)
    assert.equal(state.stale, false)
    assert.equal(state.error, false)
    assert.equal(state.revision, 'r1')
    assert.equal(state.data?.pricingReady, true)
    assert.equal(state.data?.summary.tokens, 1800)
    assert.deepEqual(state.coverage, BASE_COVERAGE)
    await probe.m.unmount()
  })

  test('the tracked revision rides the next fetch; an unchanged reply keeps the painted data', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes((_call, index) => (index === 0 ? summaryValue() : { revision: 'r2', unchanged: true }))
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]?.body, { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    const state = lastOf(probe.states)
    assert.equal(state.data?.summary.sessions, 2, 'the unchanged reply leaves the painted summary in place')
    assert.equal(state.revision, 'r2')
    assert.equal(state.pending, false)
    assert.equal(state.stale, false)
    await probe.m.unmount()
  })

  test('invalidation coalesces into one refresh and only overview-carrying kinds trigger it', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(calls.length, 1)
    mod.invalidation.invalidate('fleet')
    mod.invalidation.invalidate('heads')
    await advance(250)
    assert.equal(calls.length, 1, 'unrelated invalidations never refetch')
    mod.invalidation.invalidate('sessions')
    mod.invalidation.invalidate('pricing')
    mod.invalidation.invalidate('overview')
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(calls.length, 2, 'repeated invalidations inside the coalesce window share one read')
    await advance(250)
    assert.equal(calls.length, 2, 'one invalidation refetches once')
    await probe.m.unmount()
  })

  test('polls while the document is visible and stays quiet while hidden', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(calls.length, 1)
    await advance(POLL_MS)
    assert.equal(calls.length, 2, 'the visible poll refreshes')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      await advance(POLL_MS)
      assert.equal(calls.length, 2, 'a hidden document skips the poll tick')
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
    await advance(POLL_MS)
    assert.equal(calls.length, 3, 'the poll resumes once visible again')
    await probe.m.unmount()
  })

  test('a scope change refetches with the latest revision and swaps the data', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'today' })
    const calls = stubRoutes((call) => summaryValue({
      revision: (call.body.scope as OverviewScope).range === 'today' ? 'r1' : 'r2',
      summary: summaryRaw({ sessions: (call.body.scope as OverviewScope).range === 'today' ? 1 : 3 }),
    }))
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]?.body, { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.m.unmount()
  })

  test('disabled or scope-less hooks never fetch and clear their pending flag', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const disabled = await mountSummary(mod, { range: 'all' }, false)
    await advance(0)
    assert.equal(lastOf(disabled.states).pending, false)
    assert.equal(lastOf(disabled.states).data, null)
    const scopeless = await mountSummary(mod, null)
    await advance(0)
    assert.equal(calls.length, 0, 'neither a disabled hook nor a null scope posts')
    await disabled.m.unmount()
    await scopeless.m.unmount()
  })

  test('an error keeps the painted data and raises the stale flag until the next success', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    mod.invalidation.invalidate('overview')
    await advance(250)
    let state = lastOf(probe.states)
    assert.equal(state.error, true)
    assert.equal(state.stale, true)
    assert.equal(state.pending, false)
    assert.equal(state.data?.summary.sessions, 2, 'the last good summary survives a failed refresh')
    stubRoutes(() => summaryValue({ revision: 'r3' }))
    mod.invalidation.invalidate('overview')
    await advance(250)
    state = lastOf(probe.states)
    assert.equal(state.error, false)
    assert.equal(state.stale, false)
    assert.equal(state.revision, 'r3')
    await probe.m.unmount()
  })

  test('an HTTP failure, a failed envelope, a malformed part, and a value-less reply all read as errors', async () => {
    for (const failure of ['http', 'envelope', 'malformed'] as const) {
      vi.useFakeTimers()
      const mod = await fresh()
      const probe = await mountSummary(mod, { range: 'all' })
      stubFailing(failure)
      await advance(0)
      const state = lastOf(probe.states)
      assert.equal(state.error, true, `${failure} reads as an error`)
      assert.equal(state.stale, true)
      assert.equal(state.data, null)
      await probe.m.unmount()
      vi.useRealTimers()
    }
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }))
    await advance(0)
    assert.equal(lastOf(probe.states).error, true, 'a null value reads as a failed read')
    await probe.m.unmount()
  })

  test('a reply for another part leaves the summary unpainted', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    stubRoutes(() => daysValue())
    await advance(0)
    const state = lastOf(probe.states)
    assert.equal(state.data, null)
    assert.equal(state.error, false, 'a well-formed reply of the wrong part is not an error')
    await probe.m.unmount()
  })

  test('an invalidation during an in-flight read queues one follow-up read instead of racing', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const bodies: Record<string, unknown>[] = []
    const releases: ((value: unknown) => void)[] = []
    vi.stubGlobal('fetch', async (_input: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      const value = await new Promise<unknown>((resolve) => { releases.push(resolve) })
      return { ok: true, json: async () => ({ ok: true, value }) }
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(bodies.length, 1)
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(bodies.length, 1, 'the queued refresh waits for the in-flight read')
    assert.equal(lastOf(probe.states).pending, true)
    await act(async () => { releases[0]?.(summaryValue({ revision: 'r1' })) })
    await flush()
    assert.equal(bodies.length, 2, 'the queued read fires right after the first settles')
    assert.deepEqual(bodies[1], { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    await act(async () => { releases[1]?.(summaryValue({ revision: 'r2' })) })
    await flush()
    assert.equal(lastOf(probe.states).revision, 'r2')
    await probe.m.unmount()
  })

  test('an unmount drops the late reply and clears the armed refresh', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let release: ((value: unknown) => void) | null = null
    const calls = stubRoutes(() => new Promise<unknown>((resolve) => { release = resolve }))
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(calls.length, 1)
    mod.invalidation.invalidate('overview')
    await probe.m.unmount()
    await advance(250)
    assert.equal(calls.length, 1, 'the pending coalesced refresh is cleared with the hook')
    await act(async () => { release?.(summaryValue()) })
    await flush()
    assert.equal(lastOf(probe.states).data, null, 'the late reply never paints')
  })

  test('a rejection that lands after unmount never touches state', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let rejectLate: ((err: Error) => void) | null = null
    vi.stubGlobal('fetch', () => new Promise<never>((_resolve, reject) => { rejectLate = reject }))
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await probe.m.unmount()
    await act(async () => {
      rejectLate?.(new Error('late'))
      await Promise.resolve()
    })
    await flush()
    assert.equal(lastOf(probe.states).error, false, 'the late rejection is dropped with the unmounted hook')
    assert.equal(lastOf(probe.states).stale, false)
  })

  test('an unmount during dispatch makes the removed listener inert', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const states: ReturnType<typeof mod.source.useOverviewSummary>[] = []
    function Probe(): null {
      states.push(mod.source.useOverviewSummary({ range: 'all' }, true))
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    stubRoutes(() => summaryValue())
    mod.invalidation.subscribeInvalidations(() => { root.unmount() })
    await act(async () => { root.render(h(Probe, {})) })
    await advance(0)
    assert.equal(states[states.length - 1]?.data?.summary.sessions, 2)
    const calls = stubRoutes(() => summaryValue({ revision: 'r2' }))
    await act(async () => { mod.invalidation.invalidate('overview') })
    container.remove()
    await advance(250)
    assert.equal(calls.length, 0, 'the listener removed mid-dispatch never refetches')
  })

  test('resetOverviewRevision clears the module-level tracking', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await first.m.unmount()
    mod.source.resetOverviewRevision()
    const second = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(calls.length, 2)
    assert.equal((calls[1]?.body as { revision: unknown }).revision, null, 'the reset hook posts a cold revision')
    await second.m.unmount()
    assert.equal(OVERVIEW_POLL_MS, POLL_MS)
  })
})

describe('useOverviewDays', () => {
  test('posts the days part and paints the day totals', async () => {
    const mod = await fresh()
    const scope: OverviewScope = { coverage: 'active' }
    const calls = stubRoutes(() => daysValue())
    const probe = await mountDays(mod, scope)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { part: 'days', scope, revision: null }, method: 'POST' }])
    const state = lastOf(probe.states)
    assert.deepEqual(state.data, {
      days: [{ key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 }],
      pricingReady: true,
    })
    assert.equal(state.pending, false)
    await probe.m.unmount()
  })

  test('a reply for another part leaves the days unpainted; a disabled hook never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => tallyValue())
    const probe = await mountDays(mod, { coverage: 'all' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const disabled = await mountDays(mod, { coverage: 'all' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled days hook posts nothing')
    assert.equal(lastOf(disabled.states).pending, false)
    await probe.m.unmount()
    await disabled.m.unmount()
  })
})

describe('useOverviewPage', () => {
  test('posts the page request with sort, page, and revision; paints the page', async () => {
    const mod = await fresh()
    const request: Omit<OverviewRequest, 'revision'> = { part: 'page', scope: { range: '7d' }, sort: 'tokens', page: 2 }
    const calls = stubRoutes(() => pageValue())
    const probe = await mountPage(mod, request)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { ...request, revision: null }, method: 'POST' }])
    const state = lastOf(probe.states)
    assert.equal(state.data?.page.total, 1)
    assert.equal(state.data?.pricingReady, false)
    await probe.m.unmount()
  })

  test('a request for another part leaves the page unpainted; a null request never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountPage(mod, { part: 'page' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const empty = await mountPage(mod, null)
    await settle(5)
    assert.equal(calls.length, 1, 'a null request posts nothing')
    const disabled = await mountPage(mod, { part: 'page' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled page hook posts nothing')
    await probe.m.unmount()
    await empty.m.unmount()
    await disabled.m.unmount()
  })
})

describe('useOverviewTally', () => {
  test('posts the tally request with its field and pick; paints the tally', async () => {
    const mod = await fresh()
    const request: Omit<OverviewRequest, 'revision'> = {
      part: 'tally',
      scope: { query: 'x', group: 'w' },
      tally: 'tools',
      pick: { field: 'tools', name: 'read' },
    }
    const calls = stubRoutes(() => tallyValue())
    const probe = await mountTally(mod, request)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { ...request, revision: null }, method: 'POST' }])
    assert.deepEqual(lastOf(probe.states).data, {
      tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
      pricingReady: true,
    })
    await probe.m.unmount()
  })

  test('a reply for another part leaves the tally unpainted; a disabled hook never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountTally(mod, { part: 'tally' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const disabled = await mountTally(mod, { part: 'tally' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled tally hook posts nothing')
    await probe.m.unmount()
    await disabled.m.unmount()
  })
})

describe('summary coverage auto-backfill', () => {
  test('an incomplete coverage posts the backfill route after the bounded retry delay', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const backfills: Call[] = []
    const calls = stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills.push(call)
        return undefined
      }
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 2, covered: 1 }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(backfills.length, 0, 'the first paint arms no backfill before the read lands')
    await advance(2_000)
    assert.deepEqual(backfills.map(c => [c.route, c.method]), [[BACKFILL_ROUTE, 'POST']])
    assert.equal(calls.filter(c => c.route === OVERVIEW_ROUTE).length, 1)
    await probe.m.unmount()
  })

  test('a failing backfill POST is swallowed and a complete coverage stops the loop', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let coverage = coverageOf({ complete: false, remaining: 1, covered: 1 })
    let backfillAttempts = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfillAttempts++
        throw new Error('route absent')
      }
      return summaryValue({ summary: summaryRaw({ coverage }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await advance(2_000)
    assert.equal(backfillAttempts, 1, 'the rejected POST is swallowed')
    await flush()
    coverage = coverageOf()
    mod.invalidation.invalidate('overview')
    await advance(250)
    await advance(60_000)
    assert.equal(backfillAttempts, 1, 'a complete coverage never posts the backfill route again')
    assert.equal(vi.getTimerCount(), 1, 'only the poll interval stays armed')
    await probe.m.unmount()
    assert.equal(vi.getTimerCount(), 0)
  })

  test('each coverage change arms the next backfill attempt, capped after ten', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const overviewCalls: Call[] = []
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) return undefined
      const callIndex = overviewCalls.length
      overviewCalls.push(call)
      return summaryValue({
        summary: summaryRaw({
          coverage: coverageOf({ complete: false, remaining: 20 - callIndex, covered: callIndex }),
        }),
      })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 9; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
    }
    assert.equal(overviewCalls.length, 10, 'ten summary reads armed ten attempts')
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(overviewCalls.length, 11)
    await advance(60_000)
    await probe.m.unmount()
  })

  test('non-progress coverage churn still caps the backfill budget', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let calls = 0
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      calls++
      const running = calls % 2 === 0
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 5, covered: 2, running }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 40; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.ok(backfills > 0 && backfills <= 10, 'the attempt budget bounds the loader')
    const settled = backfills
    for (let i = 0; i < 10; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.equal(backfills, settled, 'a stagnant corpus stops at the attempt budget')
    await probe.m.unmount()
  })

  test('coverage progress refills the attempt budget so a slow corpus can finish', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let calls = 0
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      calls++
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 30 - calls, covered: calls }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 15; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.ok(backfills >= 14, `progress keeps the loader going (${backfills} backfills)`)
    await probe.m.unmount()
  })

  test('a complete coverage resets the attempt counter so a later incomplete run starts over', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let coverage = coverageOf({ complete: false, remaining: 1, covered: 1 })
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      return summaryValue({ summary: summaryRaw({ coverage }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await advance(2_000)
    assert.equal(backfills, 1)
    coverage = coverageOf()
    mod.invalidation.invalidate('overview')
    await advance(250)
    coverage = coverageOf({ complete: false, remaining: 3, covered: 0 })
    mod.invalidation.invalidate('overview')
    await advance(250)
    await advance(2_000)
    assert.equal(backfills, 2, 'the reopened coverage posts again with a fresh attempt counter')
    await probe.m.unmount()
  })
})
