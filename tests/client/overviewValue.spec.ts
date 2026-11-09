import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { overviewValueOf } from '../../src/client/overviewSource'
import { BASE_COVERAGE, daysValue, pageValue, summaryRaw, summaryValue, tallyValue } from './helpers/overviewWire'

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

