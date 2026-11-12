import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ActivityDay } from '../../src/shared/types'
import { boot, call, summaryOf, pageOf, tallyOf, recordOf, usageOf, currentOf, timelineOf, timingOf, dayOf, costOfUsage } from './helpers/overview'

describe('dsh-context overview route', () => {

  test('page filters, sorts, paginates, and keeps scopeTotal/groups on the pre-group scope', async () => {
    const records: unknown[] = []
    const values: Record<string, Record<string, unknown>> = {}
    for (let index = 0; index < 30; index++) {
      const id = `s${String(index).padStart(2, '0')}`
      records.push(recordOf(id, { createdAt: index + 1 }))
      values[id] = {
        contextTimeline: timelineOf({ total: index + 1, turns: 1, cost: usageOf(index + 1, 0, 0, 0) }),
        contextActivity: { days: { '2026-11-01': dayOf(index + 1, 1, { cost: usageOf(index + 1, 0, 0, 0), tools: index < 10 ? ['bash'] : [] }) } },
        title: `Session ${index}`,
        sessionListMetadata: { blank: false, lastPromptAt: index + 1 },
      }
    }
    records.push(recordOf('blank', { createdAt: 99 }))
    values.blank = { contextTimeline: timelineOf(), sessionListMetadata: { blank: true, lastPromptAt: 0 } }
    const workspace = {
      list: () => [
        { id: 'w1', title: 'Beta', sessionIds: ['s00', 's01', 's02'] },
        { id: 'w2', title: 'Alpha', sessionIds: ['s03', 's04'] },
      ],
      archivedSessionIds: ['s29'],
    }
    const harness = await boot({ records, values, workspace })
    const firstPage = pageOf(await call(harness, { part: 'page', scope: {} }))
    assert.equal(firstPage.total, 30, 'the blank session never enters the corpus rows')
    assert.equal(firstPage.scopeTotal, 30)
    assert.equal(firstPage.count, 3)
    assert.equal(firstPage.index, 0)
    assert.equal(firstPage.items.length, 12)
    assert.deepEqual(firstPage.items.map(row => row.id), Array.from({ length: 12 }, (_, index) => `s${String(29 - index).padStart(2, '0')}`), 'recent order puts the latest prompt first')
    assert.deepEqual(firstPage.groups, [
      { key: 'Beta', count: 3 },
      { key: 'Alpha', count: 2 },
      { key: '__ungrouped__', count: 25 },
    ])
    const lastPage = pageOf(await call(harness, { part: 'page', page: 2 }))
    assert.equal(lastPage.index, 2)
    assert.equal(lastPage.items.length, 6)
    const overflow = pageOf(await call(harness, { part: 'page', page: 99 }))
    assert.equal(overflow.index, 2, 'an out-of-range page clamps to the last page')
    const byTokens = pageOf(await call(harness, { part: 'page', sort: 'tokens' }))
    assert.equal(byTokens.items[0].id, 's29')
    assert.equal(byTokens.items[1].id, 's28')
    const byContext = pageOf(await call(harness, { part: 'page', sort: 'context' }))
    assert.equal(byContext.items[0].id, 's29')
    const archived = pageOf(await call(harness, { part: 'page', scope: { coverage: 'archived' } }))
    assert.deepEqual(archived.items.map(row => row.id), ['s29'])
    assert.equal(archived.total, 1)
    const archivedAll = pageOf(await call(harness, { part: 'page' }))
    assert.equal(archivedAll.total, 30)
    assert.equal(archivedAll.items.find(row => row.id === 's29')?.archived, true)
    const grouped = pageOf(await call(harness, { part: 'page', scope: { group: 'Alpha' } }))
    assert.deepEqual(grouped.items.map(row => row.id).sort(), ['s03', 's04'])
    assert.equal(grouped.scopeTotal, 30, 'scopeTotal ignores the group filter')
    const ungrouped = pageOf(await call(harness, { part: 'page', scope: { group: '__ungrouped__' }, page: 99 }))
    assert.equal(ungrouped.total, 25)
    assert.equal(ungrouped.items.length, 1)
    const queried = pageOf(await call(harness, { part: 'page', scope: { query: 's12' } }))
    assert.deepEqual(queried.items.map(row => row.id), ['s12'])
    assert.equal(queried.scopeTotal, 1)
    const dayScoped = pageOf(await call(harness, { part: 'page', scope: { day: '2026-11-01' } }))
    assert.equal(dayScoped.total, 30)
    const missingDay = pageOf(await call(harness, { part: 'page', scope: { day: '2026-10-01' } }))
    assert.equal(missingDay.total, 0)
    assert.equal(missingDay.count, 1)
  })

  test('page rows carry the host-priced donut split, cost, and metadata; pick filters by tally', async () => {
    const harness = await boot({
      records: [recordOf('a'), recordOf('b')],
      values: {
        a: {
          contextTimeline: timelineOf({ total: 100, turns: 4, steps: 6, contextWindow: 64_000, maxOutputTokens: 8_192, model: 'deepseek-v4-flash', lastUser: 'hello', cost: usageOf(100, 0, 0, 10) }),
          contextActivity: { days: { '2026-11-01': dayOf(110, 1, { cost: usageOf(100, 0, 0, 10), tools: ['bash'] }) } },
          title: 'Alpha',
          sessionListMetadata: { blank: false, lastPromptAt: 1_500 },
        },
        b: {
          contextTimeline: timelineOf({ total: 20, turns: 1 }),
          contextActivity: { days: { '2026-11-01': dayOf(20, 1, { cmds: ['git status'] }) } },
          title: 'Beta',
          sessionListMetadata: { blank: false, lastPromptAt: 500 },
        },
      },
      workspace: { list: () => [{ id: 'w1', title: 'Beta', sessionIds: ['a'] }], archivedSessionIds: ['b'] },
    })
    const page = pageOf(await call(harness, { part: 'page' }))
    const alpha = page.items.find(row => row.id === 'a')
    assert.ok(alpha !== undefined)
    assert.equal(alpha.title, 'Alpha')
    assert.equal(alpha.cwd, '/repo/a')
    assert.equal(alpha.running, false)
    assert.equal(alpha.archived, false)
    assert.equal(alpha.group, 'Beta')
    assert.equal(alpha.tokens, 110)
    assert.equal(alpha.turns, 4)
    assert.equal(alpha.steps, 6)
    assert.equal(alpha.total, 100)
    assert.equal(alpha.contextWindow, 64_000)
    assert.equal(alpha.maxOutputTokens, 8_192)
    assert.equal(alpha.model, 'deepseek-v4-flash')
    assert.equal(alpha.lastUser, 'hello')
    assert.equal(alpha.createdDay, '2026-11-01')
    assert.equal(alpha.costUsd, costOfUsage(usageOf(100, 0, 0, 10)))
    assert.equal(alpha.parts.reduce((sum, part) => sum + part.value, 0), 100, 'the composition parts sum to the context total')
    assert.deepEqual(alpha.parts.map(part => part.key), ['system', 'tools', 'user', 'assistant', 'tool'])
    const beta = page.items.find(row => row.id === 'b')
    assert.ok(beta !== undefined)
    assert.equal(beta.archived, true)
    assert.equal(beta.group, undefined)
    const picked = pageOf(await call(harness, { part: 'page', pick: { field: 'tools', name: 'bash' } }))
    assert.deepEqual(picked.items.map(row => row.id), ['a'])
    assert.equal(picked.total, 1)
    assert.equal(picked.scopeTotal, 2)
    const missed = pageOf(await call(harness, { part: 'page', pick: { field: 'cmds', name: 'missing' } }))
    assert.equal(missed.total, 0)
  })

  test('tally aggregates skills, tools, and commands over the scope and day filters', async () => {
    const harness = await boot({
      records: [recordOf('a'), recordOf('b')],
      values: {
        a: {
          contextActivity: {
            days: {
              '2026-11-01': dayOf(10, 1, { skills: ['load-context', 'scan'], tools: ['bash', 'read'] }),
              '2026-11-02': dayOf(20, 2, { skills: ['load-context'], tools: ['bash'], cmds: ['git status'] }),
            },
          },
        },
        b: {
          contextActivity: {
            days: { '2026-11-01': dayOf(5, 1, { skills: ['scan'], tools: ['bash'], cmds: ['git status'] }) },
          },
        },
      },
    })
    const skills = tallyOf(await call(harness, { part: 'tally', tally: 'skills' }))
    assert.equal(skills.field, 'skills')
    assert.deepEqual(skills.stats, [
      { name: 'load-context', n: 2, sessions: 1, last: 10 },
      { name: 'scan', n: 2, sessions: 2, last: 10 },
    ])
    const tools = tallyOf(await call(harness, { part: 'tally', tally: 'tools' }))
    assert.deepEqual(tools.stats, [
      { name: 'bash', n: 3, sessions: 2, last: 20 },
      { name: 'read', n: 1, sessions: 1, last: 20 },
    ])
    const cmds = tallyOf(await call(harness, { part: 'tally', tally: 'cmds' }))
    assert.deepEqual(cmds.stats, [{ name: 'git status', n: 2, sessions: 2, last: 30 }])
    const dayCmds = tallyOf(await call(harness, { part: 'tally', tally: 'cmds', scope: { day: '2026-11-02' } }))
    assert.deepEqual(dayCmds.stats, [{ name: 'git status', n: 1, sessions: 1, last: 30 }])
    const ranged = tallyOf(await call(harness, { part: 'tally', tally: 'skills', scope: { range: { start: Date.UTC(2026, 10, 2), end: Date.UTC(2026, 10, 2) } } }))
    assert.deepEqual(ranged.stats, [{ name: 'load-context', n: 1, sessions: 1, last: 10 }])
  })

  test('range presets, invalid days, reversed windows, and last-user queries exercise every window branch', async () => {
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const todayStart = today.getTime()
    const localDay = (offset: number): string => {
      const date = new Date(now)
      date.setDate(date.getDate() + offset)
      return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const harness = await boot({
      records: [recordOf('today'), recordOf('old'), recordOf('quiet')],
      values: {
        today: {
          contextTimeline: timelineOf({ total: 10, turns: 1, lastUser: 'please fix the bug' }),
          contextActivity: { days: { [localDay(0)]: dayOf(10, 1, { turns: 1, toolCalls: 0 }) } },
          title: 'Today session',
          sessionListMetadata: { blank: false, lastPromptAt: now },
        },
        old: {
          contextTimeline: timelineOf({ total: 5, turns: 1 }),
          contextActivity: { days: { [localDay(-40)]: dayOf(0, 0, { turns: 2 }), [localDay(-41)]: dayOf(1, 0) } },
          sessionListMetadata: { blank: false, lastPromptAt: todayStart - 40 * 86_400_000 },
        },
        quiet: { contextTimeline: timelineOf({ total: 1, turns: 0 }), sessionListMetadata: { blank: false, lastPromptAt: todayStart - 86_400_000 } },
      },
    })
    for (const range of ['today', '7d', '30d', 'bogus']) {
      const reply = await call(harness, { part: 'summary', scope: { range } })
      assert.equal(reply.reply.ok, true, `range ${range}`)
    }
    const explicitRange = summaryOf(await call(harness, { part: 'summary', scope: { range: '30d' } }))
    assert.deepEqual(summaryOf(await call(harness, { part: 'summary', scope: null })), explicitRange, 'a missing range resolves to the default 30d')
    assert.deepEqual(summaryOf(await call(harness, { part: 'summary', scope: { range: 'bogus' } })), explicitRange, 'an unknown range resolves to the default 30d')
    const todaySummary = summaryOf(await call(harness, { part: 'summary', scope: { range: 'today' } }))
    assert.equal(todaySummary.sessions, 1)
    const reversed = summaryOf(await call(harness, { part: 'summary', scope: { range: { start: now + 1_000, end: now - 1_000 } } }))
    assert.equal(reversed.sessions, 1, 'a reversed window is ordered before filtering')
    const bounded = summaryOf(await call(harness, { part: 'summary', scope: { range: { start: 0, end: now + 1_000 } } }))
    assert.equal(bounded.sessions, 3, 'rows inside the bound match by updatedAt without reading activity')
    const invalidDay = summaryOf(await call(harness, { part: 'summary', scope: { day: 'not-a-day' } }))
    assert.equal(invalidDay.sessions, 0)
    const quietDay = summaryOf(await call(harness, { part: 'summary', scope: { day: localDay(-40) } }))
    assert.equal(quietDay.sessions, 0, 'a zero-metric day never admits its row')
    const byQuery = summaryOf(await call(harness, { part: 'summary', scope: { query: 'bug' } }))
    assert.equal(byQuery.sessions, 1, 'the query matches the last user text')
    const byMiss = summaryOf(await call(harness, { part: 'summary', scope: { query: 'nothing-here' } }))
    assert.equal(byMiss.sessions, 0)
  })

  test('hostile cost, timing, activity, and tally shapes degrade field-by-field', async () => {
    const harness = await boot({
      records: [recordOf('junk'), recordOf('timing'), recordOf('empty')],
      values: {
        junk: {
          contextTimeline: {
            current: { system: 1, assistant: 2, assistantReasoning: 1, assistantAnswerTokens: 1, assistantCallTokens: 0, total: 3 },
            counts: { turns: 1 },
            timing: { wallMs: 10, ttftMs: 1, genMs: 8, calls: 1, toolsMs: 2, toolCalls: 1, tools: { bash: 'junk', read: { calls: 1 }, grep: { calls: 1, ms: 3 } } },
            generatedReasoning: 1,
            generatedAnswerTokens: 2,
            generatedCallTokens: 3,
          },
          contextActivity: {
            days: {
              '2026-11-01': {
                tokens: 4,
                requests: 1,
                turns: 1,
                cost: { deepseek: { model: { off: { uncached: 4, cacheRead: 0, cacheWrite: 0, output: 1 } } } },
                skills: { good: { n: 1, last: 8 }, junk: 'nope', bad: { n: 'x', last: 1 } },
                tools: 'nope',
                cmds: { cmd: { n: 1, last: 2 } },
              },
              '2026-11-02': 'junk',
            },
          },
          sessionListMetadata: { blank: false, lastPromptAt: 8 },
        },
        timing: {
          contextTimeline: {
            current: currentOf(10),
            counts: { turns: 1, steps: 2 },
            timing: { wallMs: 20, ttftMs: 2, genMs: 16, calls: 1, toolsMs: 4, toolCalls: 1, tools: { read: { calls: 1, ms: 4 } }, reasoningMs: 2 },
          },
        },
        empty: {
          contextActivity: { days: { '2026-11-03': { tokens: 0, requests: 0, skills: { x: { n: 1, last: 1 } } } } },
        },
      },
    })
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.sessions, 3)
    assert.equal((summary.costUsd ?? 0) > 0, true, 'only the well-formed buckets price')
    assert.equal(summary.costSessions, 1, 'a session with no usable buckets stays unpriced')
    assert.equal(summary.cacheHit, '0.00')
    assert.equal(summary.timing?.wallMs, 30, 'the incomplete timing still sums')
    assert.equal(summary.timing?.toolBusyMs, undefined, 'an incomplete toolBusy figure is dropped')
    assert.deepEqual(Object.keys(summary.timing?.tools ?? {}).sort(), ['grep', 'read'])
    assert.deepEqual(summary.timing?.tools.read, { calls: 1, ms: 4 }, 'a later tool row merges its first appearance')
    const days = await call(harness, { part: 'days' })
    assert.equal(days.reply.ok, true)
    const tally = tallyOf(await call(harness, { part: 'tally', tally: 'skills' }))
    assert.deepEqual(tally.stats, [{ name: 'good', n: 1, sessions: 1, last: 8 }, { name: 'x', n: 1, sessions: 1, last: 1 }])
  })

  test('family activity merges every day field and an all-empty family keeps no activity', async () => {
    const dayFields = (tokens: number, extra: Record<string, unknown>): ActivityDay => ({
      tokens,
      requests: 1,
      ...extra,
    } as ActivityDay)
    const harness = await boot({
      records: [recordOf('root'), recordOf('child', { parentSession: 'root', origin: 'subagent' })],
      values: {
        root: {
          contextActivity: {
            days: { '2026-11-01': dayFields(10, { cost: usageOf(10, 0, 0, 0), turns: 1, toolCalls: 1, toolsMs: 2, wallMs: 3, skills: { s: { n: 1, last: 1 } }, tools: { t: { n: 1, last: 1 } }, cmds: { c: { n: 1, last: 1 } } }) },
          },
        },
        child: {
          contextActivity: {
            days: {
              '2026-11-01': dayFields(5, { cost: usageOf(5, 0, 0, 0), turns: 2, toolCalls: 0, toolsMs: 1, wallMs: 4, skills: { s: { n: 2, last: 2 }, t: { n: 1, last: 3 } }, tools: { u: { n: 1, last: 1 } }, cmds: { d: { n: 1, last: 1 } } }),
              '2026-11-02': dayFields(1, { turns: 1 }),
            },
          },
        },
      },
    })
    const page = pageOf(await call(harness, { part: 'page' }))
    assert.equal(page.items.length, 1)
    const days = await call(harness, { part: 'days' })
    assert.equal(days.reply.value !== undefined && 'days' in days.reply.value && days.reply.value.days[0].tokens, 15, 'the merged family day carries both members')
    assert.equal(days.reply.value !== undefined && 'days' in days.reply.value && days.reply.value.days[0].sessions, 1)
    const tallies = tallyOf(await call(harness, { part: 'tally', tally: 'skills' }))
    assert.deepEqual(tallies.stats, [{ name: 's', n: 3, sessions: 1, last: 2 }, { name: 't', n: 1, sessions: 1, last: 3 }])
    const empty = await boot({
      records: [recordOf('root'), recordOf('child', { parentSession: 'root', origin: 'subagent' })],
      values: { root: {}, child: {} },
    })
    const emptyPage = pageOf(await call(empty, { part: 'page' }))
    assert.equal(emptyPage.items.length, 1)
    assert.equal(emptyPage.items[0].createdDay, undefined)
    assert.deepEqual(emptyPage.items[0].parts, [])
  })

  test('workspace, header, sort, and live-lookup hostile shapes degrade without throwing', async () => {
    const throwingArchive = {
      list: () => [{ id: 'w', title: 'W', sessionIds: ['a'] }],
      get archivedSessionIds(): readonly string[] { throw new Error('archive broke') },
    }
    const hostileItems = {
      list: () => [
        null,
        'junk',
        { title: '', sessionIds: ['x'] },
        { title: 'NoIds' },
        { title: 'BadIds', sessionIds: 'nope' },
        { title: 'Ok', sessionIds: [7, '', 'b', 'b'] },
      ],
      archivedSessionIds: [7, '', 'a'],
    }
    const harness = await boot({
      records: [
        recordOf('a', { live: true, noCwd: true }),
        recordOf('b'),
        recordOf('b'),
        { header: {} },
        { header: { id: 7, cwd: '/repo/bad' } },
        { header: { id: 'bad-time', cwd: '/repo/t', createdAt: 'soon' } },
      ],
      liveSeq: { a: 1 },
      workspace: hostileItems,
      liveValues: { a: { title: 7 } },
      values: {
        b: {
          title: 'Bee',
          contextTimeline: timelineOf({ cost: usageOf(3, 0, 0, 0) }),
          contextActivity: { days: { '2026-11-01': dayOf(30, 1, { cost: usageOf(30, 0, 0, 0) }) } },
        },
        'bad-time': { title: '/', contextTimeline: timelineOf() },
      },
    })
    const page = pageOf(await call(harness, { part: 'page', sort: 'context' }))
    assert.equal(page.items.length, 3, 'invalid headers collapse while duplicate ids leave one row')
    const badTime = page.items.find(row => row.id === 'bad-time')
    assert.ok(badTime !== undefined)
    assert.equal(badTime.updatedAt, 0)
    const live = page.items.find(row => row.id === 'a')
    assert.ok(live !== undefined)
    assert.equal(live.title, 'a', 'a live session without cwd or title falls back to its id')
    assert.equal(live.cwd, undefined)
    assert.equal(live.createdDay, undefined)
    const days = await call(harness, { part: 'days' })
    assert.equal(days.reply.ok, true)
    const sorted = pageOf(await call(harness, { part: 'page', sort: 'tokens' }))
    assert.equal(sorted.items[0].id, 'b')
    const archiveBroke = await boot({
      records: [recordOf('a'), recordOf('b')],
      values: { a: { title: 'A' }, b: { title: 'B' } },
      workspace: throwingArchive,
    })
    const archivePage = pageOf(await call(archiveBroke, { part: 'page' }))
    assert.deepEqual(archivePage.groups, [{ key: 'W', count: 1 }, { key: '__ungrouped__', count: 1 }], 'a failing archive getter keeps the groups')
    const noGet = await boot({
      records: [recordOf('a'), recordOf('b')],
      values: { a: { title: 'A' }, b: { title: 'B' } },
      sessionsWithoutGet: true,
    })
    const noGetPage = pageOf(await call(noGet, { part: 'page' }))
    assert.equal(noGetPage.items.length, 2, 'a sessions face without get reads every row cold')
    const throwingGet = await boot({
      records: [recordOf('a')],
      values: { a: { title: 'A' } },
      sessionsGetThrows: true,
    })
    const throwingPage = pageOf(await call(throwingGet, { part: 'page' }))
    assert.equal(throwingPage.items.length, 1, 'a throwing live lookup reads the row cold')
    const noList = await boot({
      records: [recordOf('a')],
      values: { a: { title: 'A' } },
      workspace: { notList: true, archivedSessionIds: 'nope' },
    })
    const noListPage = pageOf(await call(noList, { part: 'page' }))
    assert.deepEqual(noListPage.groups, [{ key: '__ungrouped__', count: 1 }])
    const junkList = await boot({
      records: [recordOf('a')],
      values: { a: { title: 'A' } },
      workspace: { list: () => 'junk', archivedSessionIds: 'nope' },
    })
    const junkListPage = pageOf(await call(junkList, { part: 'page' }))
    assert.equal(junkListPage.total, 1)
  })

  test('a bounded window reaches the activity fallback for every activity metric', async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayStart = today.getTime()
    const key = `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const dayEntry = (entry: Record<string, unknown>): Record<string, unknown> => ({ contextActivity: { days: { [key]: { tokens: 0, requests: 0, ...entry } } } })
    const harness = await boot({
      records: ['turns', 'toolCalls', 'wallMs', 'skills', 'quiet', 'tokens'].map(id => recordOf(id)),
      values: {
        turns: dayEntry({ turns: 1 }),
        toolCalls: dayEntry({ toolCalls: 1 }),
        wallMs: dayEntry({ wallMs: 1 }),
        skills: dayEntry({ skills: { s: { n: 1, last: 1 } } }),
        quiet: dayEntry({}),
        tokens: dayEntry({ tokens: 1 }),
      },
    })
    const summary = summaryOf(await call(harness, { part: 'summary', scope: { range: { start: todayStart, end: todayStart + 86_400_000 } } }))
    assert.equal(summary.sessions, 5, 'every non-zero activity metric admits the row; the quiet one stays out')
  })

  test('corpus fallbacks: a missing cache block, a live session without seq, root titles, and null timelines', async () => {
    const harness = await boot({
      cacheUndefined: true,
      records: [
        recordOf('nocache'),
        recordOf('live-noseq', { live: true, noCwd: true }),
        recordOf('root-cwd', { live: true, cwd: '/' }),
        recordOf('notimeline'),
      ],
      liveSeq: { 'live-noseq': 1, 'root-cwd': 1 },
      liveNoSeq: true,
      liveValues: {
        'live-noseq': {},
        'root-cwd': { title: 7 },
        notimeline: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1 } } } },
      },
    })
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.sessions, 4)
    assert.equal(summary.cacheHit, null, 'a corpus without usage keeps the hit rate unknown')
    const page = pageOf(await call(harness, { part: 'page', sort: 'context' }))
    assert.equal(page.items.length, 4)
    assert.equal(page.items.find(row => row.id === 'root-cwd')?.title, 'root-cwd', 'a cwd with no basename falls back to the id')
    assert.equal(page.items.find(row => row.id === 'notimeline')?.total, 0, 'a missing timeline sorts last')
  })

  test('tallies sort ties by name and days honor the coverage filter', async () => {
    const harness = await boot({
      records: [recordOf('a'), recordOf('b'), recordOf('c')],
      values: {
        a: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1, skills: { b: { n: 1, last: 5 }, a: { n: 1, last: 5 } } } } } },
        b: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1, skills: { c: { n: 1, last: 5 } } } } } },
        c: { contextActivity: { days: { '2026-11-02': { tokens: 1, requests: 1 } } } },
      },
      workspace: { list: () => [{ id: 'w', title: 'W', sessionIds: ['a'] }], archivedSessionIds: ['c'] },
    })
    const tally = tallyOf(await call(harness, { part: 'tally', tally: 'skills' }))
    assert.deepEqual(tally.stats.map(stat => stat.name), ['a', 'b', 'c'])
    const active = await call(harness, { part: 'days', scope: { coverage: 'active' } })
    assert.equal(active.reply.ok, true)
    const archived = await call(harness, { part: 'days', scope: { coverage: 'archived' } })
    assert.equal(archived.reply.ok, true)
    assert.equal(archived.reply.value !== undefined && 'days' in archived.reply.value ? archived.reply.value.days[0].key : undefined, '2026-11-02')
  })

  test('family merge fills missing day fields from a later member and keeps earlier ones intact', async () => {
    const harness = await boot({
      records: [recordOf('root'), recordOf('child', { parentSession: 'root', origin: 'subagent' }), recordOf('rich'), recordOf('lean', { parentSession: 'rich', origin: 'subagent' })],
      values: {
        rich: {
          contextActivity: {
            days: { '2026-11-03': { tokens: 3, requests: 1, turns: 2, toolCalls: 2, toolsMs: 2, wallMs: 2, cost: usageOf(3, 0, 0, 0) } },
          },
        },
        lean: { contextActivity: { days: { '2026-11-03': { tokens: 1, requests: 1 } } } },
        root: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1 } } } },
        child: {
          contextActivity: {
            days: {
              '2026-11-01': {
                tokens: 2,
                requests: 1,
                turns: 1,
                toolCalls: 1,
                toolsMs: 1,
                wallMs: 1,
                cost: usageOf(2, 0, 0, 0),
                skills: { s: { n: 1, last: 1 } },
                tools: { t: { n: 1, last: 1 } },
                cmds: { c: { n: 1, last: 1 } },
              },
            },
          },
        },
      },
    })
    const page = pageOf(await call(harness, { part: 'page' }))
    assert.equal(page.total, 2)
    const skills = tallyOf(await call(harness, { part: 'tally', tally: 'skills' }))
    assert.deepEqual(skills.stats, [{ name: 's', n: 1, sessions: 1, last: 1 }])
    const days = await call(harness, { part: 'days' })
    assert.equal(days.reply.value !== undefined && 'days' in days.reply.value && days.reply.value.days.length, 2)
    const invalidCost = await boot({
      records: [recordOf('root'), recordOf('child', { parentSession: 'root', origin: 'subagent' })],
      values: {
        root: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1 } } } },
        child: { contextActivity: { days: { '2026-11-01': { tokens: 1, requests: 1, cost: {} } } } },
      },
    })
    const invalidDays = await call(invalidCost, { part: 'days' })
    assert.equal(invalidDays.reply.ok, true, 'an unusable day cost falls back to its own object')
  })

  test('a later timing member without optional figures keeps the earlier ones', async () => {
    const richTiming = timingOf(100, 1, 10)
    const harness = await boot({
      records: [recordOf('aa-rich'), recordOf('zz-lean')],
      values: {
        'aa-rich': { contextTimeline: timelineOf({ cost: usageOf(1, 0, 0, 0), timing: richTiming }) },
        'zz-lean': {
          contextTimeline: timelineOf({
            cost: usageOf(1, 0, 0, 0),
            timing: { wallMs: 50, ttftMs: 5, genMs: 40, calls: 1, toolsMs: 5, toolCalls: 1, tools: {} },
          }),
        },
      },
    })
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(summary.timing?.speedTokens, 100)
    assert.equal(summary.timing?.toolBusyMs, undefined, 'an incomplete toolBusy set is dropped')
    const outputOnly = await boot({
      records: [recordOf('a')],
      values: {
        a: {
          contextActivity: {
            days: {
              '2026-11-01': dayOf(5, 1, {
                cost: { deepseek: { model: { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 5 } } } },
              }),
            },
          },
        },
      },
    })
    const cacheFree = summaryOf(await call(outputOnly, { part: 'summary' }))
    assert.equal(cacheFree.cacheHit, null, 'an output-only usage has no cache ratio')
    assert.equal(cacheFree.tokens, 5)
  })

  test('invalid request shells and empty pick filters are rejected or ignored', async () => {
    const harness = await boot({
      records: [recordOf('a'), recordOf('b')],
      values: { a: { contextTimeline: timelineOf() }, b: {} },
    })
    for (const body of ['null', '42', '"text"']) {
      const reply = await call(harness, body)
      assert.equal(reply.reply.error?.code, 'dsh-context/bad-request', body)
    }
    for (const pick of [7, { field: 'tools' }, { field: 'tools', name: '' }, { field: 'tools', name: 7 }]) {
      const reply = await call(harness, { part: 'page', pick })
      assert.equal(reply.reply.ok, true)
    }
    const noActivityPick = pageOf(await call(harness, { part: 'page', pick: { field: 'tools', name: 'bash' } }))
    assert.equal(noActivityPick.total, 0, 'a row without activity never matches a tally filter')
    const partial = summaryOf(await call(harness, { part: 'summary', scope: { range: { start: 5 } } }))
    assert.equal(partial.sessions, 0, 'a partial window falls back to the default range')
  })
})
