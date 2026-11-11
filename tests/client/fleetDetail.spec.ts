// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { detailBytes, FleetDetailCache, fleetBatchOf, fleetDetailOf, fleetSummaryOf, makeFleetBatchFetcher, makeFleetDetailFetcher, makeFleetSummaryFetcher, mergeComms, mergeDelegations, settledVariantOf, type CommsRow } from '../../src/client/fleetDetail'
import { type FleetDetail, type FleetMemberInfo } from '../../src/shared/types'
import { LEAD_HUE, familyHue, type AgentNode } from '../../src/client/agentTree'
import { agentResolverOf, attestedNamesOf, commsAgentsOf, fallbackAgentOf } from '../../src/client/fleetAgents'
import { NAME_PARTY_PREFIX, NEUTRAL_HUE, UNKNOWN_PARTY } from '../../src/client/commsModel'
import { type FleetTeam, memberIdByName, taskOwnerIdOf, tasksOfOwnerId, teammateNameOf, teamMemberOf, teamOf } from '../../src/client/fleetTeam'
import { makeKit } from './helpers/kit'
import { clearAttachmentPaths, makeAttachmentLocator, makeAttachmentOpener, pathOfValue } from '../../src/client/attachmentSource'
import { type AttachmentRef } from '../../src/shared/attachment'
import { asClientCtx, TestClientCtx } from './helpers/harness'

describe('fleetDetail', () => {

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fleetDetailOf — the sanitizing parse', () => {
  test('a full payload parses; hostile entries drop alone', () => {
    const detail = fleetDetailOf({
      descriptor: { mode: 'continuable', label: 'worker', provider: 'fork', agentModel: 'v4', agentReasoningEffort: 'max', persona: '' },
      initialPrompt: 'do the thing',
      messages: [
        null,
        42,
        { kind: 'pigeon', text: 'coo' },
        { kind: 'relay', text: '' },
        { kind: 'relay', text: 'hi', seq: 3, time: 30, from: 'a', fromName: 9 },
        { kind: 'settled', text: 'done', seq: 1, fromName: 'w' },
        { kind: 'mailbox', text: 'old', seq: 2 },
        {
          kind: 'settled', text: 'summary report', seq: 4, time: 40, from: 'w', clipped: true,
          summary: 'summary', report: 'report', structured: '{"ok":true}', diagnostic: 'diag',
        },
      ],
      messagesTotal: 9,
      truncated: true,
    })
    assert.ok(detail !== null)
    assert.deepEqual(detail.descriptor, { mode: 'continuable', label: 'worker', provider: 'fork', agentModel: 'v4', agentReasoningEffort: 'max' })
    assert.equal(detail.initialPrompt, 'do the thing')
    assert.deepEqual(detail.messages, [
      { kind: 'relay', text: 'hi', seq: 3, time: 30, from: 'a' },
      { kind: 'settled', text: 'done', seq: 1, time: 0, fromName: 'w' },
      { kind: 'mailbox', text: 'old', seq: 2, time: 0 },
      { kind: 'settled', text: 'summary report', seq: 4, time: 40, from: 'w', clipped: true, summary: 'summary', report: 'report', structured: '{"ok":true}', diagnostic: 'diag' },
    ])
    assert.equal(detail.messagesTotal, 9)
    assert.equal(detail.truncated, true)

    assert.equal(fleetDetailOf(undefined), null)
    assert.equal(fleetDetailOf(null), null)
    assert.equal(fleetDetailOf('x'), null)
    assert.deepEqual(fleetDetailOf({}), { messages: [], truncated: false }, 'absent fields degrade, never materialize')
    assert.deepEqual(fleetDetailOf({ messages: 'nope', descriptor: { mode: 'weird' }, truncated: 1 }), { messages: [], truncated: false })
  })

  test('roster, lastReply and delegations sanitize; malformed entries drop alone', () => {
    const detail = fleetDetailOf({
      roster: [
        null,
        { name: '' },
        { name: 'worker', description: 'duty', provider: 'spawn', context: 'fork' },
        { name: 'bare', description: 1, provider: 2, context: 'sideways' },
      ],
      lastReply: { time: 42, text: '报告完毕' },
      delegations: [
        null,
        { seq: 1, time: 10, to: 'one', mode: 'one-shot', label: 'Inspect' },
        { seq: 5, time: 50, to: 'bad', mode: 'mystery' },
        { seq: 6, time: 60, to: '', mode: 'one-shot' },
      ],
    })
    assert.deepEqual(detail?.roster, [
      { name: 'worker', description: 'duty', provider: 'spawn', context: 'fork' },
      { name: 'bare', description: '' },
    ])
    assert.deepEqual(detail?.lastReply, { time: 42, text: '报告完毕' })
    assert.deepEqual(detail?.delegations, [{ seq: 1, time: 10, to: 'one', mode: 'one-shot', label: 'Inspect' }])
    assert.equal(fleetDetailOf({ lastReply: { text: 1 } })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ lastReply: 'nope' })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ roster: 'nope' })?.roster, undefined)
    assert.equal(fleetDetailOf({ delegations: 'nope' })?.delegations, undefined)
    assert.deepEqual(fleetDetailOf({ messages: [], delegations: [] })?.delegations, undefined)
  })
})

describe('fleetSummaryOf and fleetBatchOf — the wire decoders', () => {
  test('a summary carries the root detail, member facts and known counts', () => {
    const summary = fleetSummaryOf({
      rootId: 'root',
      rootCreatedAt: 1234,
      detail: { messages: [], messagesTotal: 4, truncated: true },
      members: [
        null,
        { id: '' },
        { id: 'kid', createdAt: 7, mode: 'continuable', label: 'Inspect', name: 'agent-1', description: 'duty', phase: 'active' },
        { id: 'bare', createdAt: 'soon', mode: 'mystery', label: 9 },
      ],
      familySize: 3,
      counts: {
        root: { readAt: 100, messagesTotal: 4, delegationsCount: 2 },
        kid: { readAt: 90, messagesTotal: 'nope', delegationsCount: 1 },
        bad: { readAt: Number.NaN, messagesTotal: 1, delegationsCount: 1 },
      },
    })
    assert.ok(summary !== null)
    assert.equal(summary.rootId, 'root')
    assert.equal(summary.rootCreatedAt, 1234)
    assert.equal(summary.detail.messagesTotal, 4)
    assert.deepEqual(summary.members, [
      { id: 'kid', createdAt: 7, mode: 'continuable', label: 'Inspect', name: 'agent-1', description: 'duty', phase: 'active' },
      { id: 'bare' },
    ])
    assert.equal(summary.familySize, 3)
    assert.deepEqual(summary.counts, { root: { readAt: 100, messagesTotal: 4, delegationsCount: 2 } })
  })

  test('degraded summaries default the family size and reject absent identities', () => {
    const summary = fleetSummaryOf({ rootId: 'root', detail: { messages: [], truncated: false }, members: [{ id: 'kid' }] })
    assert.equal(summary?.familySize, 2)
    assert.equal(summary?.rootCreatedAt, undefined)
    assert.deepEqual(summary?.counts, {})
    assert.equal(fleetSummaryOf({ detail: { messages: [], truncated: false } }), null)
    assert.equal(fleetSummaryOf({ rootId: 'root' }), null)
    assert.equal(fleetSummaryOf(null), null)
    assert.equal(fleetSummaryOf(42), null)
    assert.equal(fleetSummaryOf({ rootId: 'root', detail: null, members: 'nope', counts: null }), null)
  })

  test('a batch decodes rows, missing and the fallback total', () => {
    const batch = fleetBatchOf({
      rows: {
        a: { messages: [], truncated: false },
        '': { messages: [], truncated: false },
        b: null,
      },
      missing: ['gone', 42],
    })
    assert.ok(batch !== null)
    assert.deepEqual([...batch.rows.keys()], ['a'])
    assert.deepEqual(batch.missing, ['gone'])
    assert.equal(batch.total, 2)
    assert.equal(fleetBatchOf({ rows: 'nope' }), null)
    assert.equal(fleetBatchOf(null), null)
    assert.deepEqual(fleetBatchOf({ rows: {}, missing: 'nope' }), { rows: new Map(), missing: [], total: 0 })
  })
})

function stubRoute(handler: (body: Record<string, unknown>) => unknown): Array<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    bodies.push(body)
    const out = handler(body)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(out) } as Response)
  })
  return bodies
}

describe('the fleet fetchers', () => {
  test('round-trips a detail; null passes through, and each mode posts its flag', async () => {
    stubRoute(() => ({ ok: true, value: { messages: [{ kind: 'relay', text: 'yo', seq: 1, time: 1 }], truncated: false } }))
    const detail = await makeFleetDetailFetcher('s1')!()
    assert.equal(detail?.messages[0]?.text, 'yo')
    stubRoute(() => ({ ok: true, value: null }))
    assert.equal(await makeFleetDetailFetcher('s1')!(), null)

    const bodies = stubRoute(() => ({ ok: true, value: null }))
    await makeFleetDetailFetcher('s1', true)!()
    await makeFleetDetailFetcher('s1')!()
    await makeFleetDetailFetcher('s1', false, true)!()
    assert.deepEqual(bodies, [{ full: true, sessionId: 's1' }, { sessionId: 's1' }, { history: true, sessionId: 's1' }])
    assert.equal(makeFleetDetailFetcher(''), undefined)

    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 } as Response))
    await assert.rejects(makeFleetDetailFetcher('s1')!(), /HTTP 503/)
    stubRoute(() => ({ ok: false }))
    await assert.rejects(makeFleetDetailFetcher('s1')!(), /failed/)
    stubRoute(() => ({ ok: true, value: 42 }))
    await assert.rejects(makeFleetDetailFetcher('s1')!(), /malformed/)
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    await assert.rejects(makeFleetDetailFetcher('s1')!(), /offline/)
  })

  test('summary and batch post their kinds and decode their values', async () => {
    const bodies = stubRoute((body) => body.summary === true
      ? { ok: true, value: { rootId: 'root', detail: { messages: [], truncated: false }, members: [], familySize: 1, counts: {} } }
      : { ok: true, value: { rows: {}, missing: ['x'], total: 1 } })
    const summary = await makeFleetSummaryFetcher('root')!()
    assert.equal(summary?.rootId, 'root')
    const batch = await makeFleetBatchFetcher(['x'], 'preview', 'root')!()
    assert.deepEqual(batch?.missing, ['x'])
    assert.deepEqual(bodies, [
      { sessionId: 'root', summary: true },
      { batch: { ids: ['x'], mode: 'preview', rootId: 'root' } },
    ])
    assert.equal(makeFleetSummaryFetcher(''), undefined)
    assert.equal(makeFleetBatchFetcher([], 'preview'), undefined)
    const signal = new AbortController().signal
    stubRoute(() => ({ ok: true, value: { rows: {}, missing: [], total: 0 } }))
    const history = await makeFleetBatchFetcher(['a', 'b'], 'history', undefined, signal)!()
    assert.ok(history !== null)
  })
})

describe('FleetDetailCache', () => {
  test('memoizes one in-flight read per mode, stamp and batch key, then forgets it', async () => {
    let reads = 0
    const releases: Array<() => void> = []
    vi.stubGlobal('fetch', () => {
      reads += 1
      return new Promise((resolve) => {
        releases.push(() => { resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response) })
      })
    })
    const cache = new FleetDetailCache()
    const first = cache.fetch('s1', 5)
    const second = cache.fetch('s1', 5)
    assert.equal(reads, 1)
    const full = cache.fetch('s1', 5, true)
    assert.equal(reads, 2)
    releases[0]!()
    releases[1]!()
    assert.equal(await first, null)
    assert.equal(await second, null)
    assert.equal(await full, null)
    const replay = cache.fetch('s1', 5)
    assert.equal(reads, 3, 'a settled read is not replayed from a payload ledger')
    releases[2]!()
    assert.equal(await replay, null)
    const history = cache.fetchHistory('s1', 5)
    releases[3]!()
    assert.equal(await history, null)
    cache.clear()
  })

  test('batch and summary reads share their in-flight promise and surface transport failures', async () => {
    let reads = 0
    const release: Array<() => void> = []
    vi.stubGlobal('fetch', () => {
      reads += 1
      return new Promise((resolve) => {
        release.push(() => { resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { rows: {}, missing: [], total: 0 } }) } as Response) })
      })
    })
    const cache = new FleetDetailCache()
    const batch = cache.fetchBatch(['a'], 'preview')
    const again = cache.fetchBatch(['a'], 'preview')
    assert.equal(reads, 1)
    assert.equal(batch, again)
    assert.equal(await cache.fetchHistory('', 1), null)
    release.splice(0).forEach(open => { open() })
    await Promise.all([batch, again])

    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const history = cache.fetchHistory('s1', 2)
    assert.equal(await history, null, 'a single-session history read fails soft')
    const full = cache.fetch('s1', 2, true)
    assert.equal(await full, null, 'a single-session full read fails soft')
  })

  test('a failed protocol read is reported rather than swallowed', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const cache = new FleetDetailCache()
    await assert.rejects(cache.fetchSummary('root'), /offline/)
    await assert.rejects(cache.fetchBatch(['a'], 'preview'), /offline/)
    assert.equal(await cache.fetchSummary(''), null)
  })
})

describe('detailBytes', () => {
  test('weighs the retained text and tolerates null', () => {
    assert.equal(detailBytes(null), 0)
    const detail: FleetDetail = {
      initialPrompt: 'prompt',
      lastReply: { time: 1, text: 'reply' },
      messages: [
        { seq: 1, time: 1, kind: 'settled', text: 'text', report: 'report', summary: 'summary' },
        { seq: 2, time: 2, kind: 'relay', text: 'x' },
      ],
      delegations: [{ seq: 3, time: 3, to: 'kid', mode: 'continuable', label: 'label' }],
      roster: [{ name: 'member', description: 'duty' }],
      truncated: false,
    }
    const bytes = detailBytes(detail)
    assert.ok(bytes > 0)
    assert.equal(detailBytes({ messages: [], truncated: false }), 0)
  })
})

describe('settledVariantOf, mergeDelegations and mergeComms', () => {
  test('the runtime vocabulary classifies; unknown phrasings pass through', () => {
    assert.equal(settledVariantOf('Background subagent x finished and will do no further work unless you send it more.'), 'finished')
    assert.equal(settledVariantOf('Background subagent x finished. It cannot receive follow-up messages.'), 'finishedFinal')
    assert.equal(settledVariantOf('Background subagent x was stopped before it finished.'), 'stopped')
    assert.equal(settledVariantOf('Background subagent x ran out of room before it finished.'), 'outOfRoom')
    assert.equal(settledVariantOf('Background subagent x declined the task.'), 'declined')
    assert.equal(settledVariantOf('Background subagent x failed before it finished.'), 'failed')
    assert.equal(settledVariantOf('some future phrasing'), null)
  })

  test('delegations keep the parent log owner as their source', () => {
    const rows = mergeDelegations(new Map<string, FleetDetail>([
      ['root', {
        delegations: [{ seq: 4, time: 100, to: 'child', mode: 'continuable', label: 'Inspect' }],
        messages: [],
        truncated: false,
      }],
      ['child', { messages: [], truncated: false }],
    ]))
    assert.deepEqual(rows, [{ key: 'root:4:child', seq: 4, time: 100, from: 'root', to: 'child', mode: 'continuable', label: 'Inspect' }])
  })

  test('comms merge per-session messages newest-first with the log owner as recipient', () => {
    const details = new Map<string, FleetDetail>([
      ['a', { messages: [
        { seq: 1, time: 100, kind: 'relay', from: 'b', text: 'question' },
        { seq: 3, time: 300, kind: 'settled', text: 'b finished', from: 'b', clipped: true, summary: 'summary', report: 'report', structured: '{"ok":true}', diagnostic: 'diag' },
      ], truncated: false }],
      ['b', { messages: [{ seq: 2, time: 200, kind: 'mailbox', fromName: 'lead', text: 'old school' }], truncated: false }],
      ['empty', { messages: [], truncated: false }],
    ])
    const rows = mergeComms(details)
    assert.deepEqual(rows.map(row => [row.to, row.time, row.kind]), [
      ['a', 300, 'settled'],
      ['b', 200, 'mailbox'],
      ['a', 100, 'relay'],
    ])
    assert.deepEqual(rows[0], {
      key: 'a:3:300:settled',
      to: 'a',
      seq: 3,
      time: 300,
      kind: 'settled',
      from: 'b',
      text: 'b finished',
      clipped: true,
      summary: 'summary',
      report: 'report',
      structured: '{"ok":true}',
      diagnostic: 'diag',
    })
    assert.equal(rows[2].from, 'b')
    assert.equal(rows[1].fromName, 'lead')
    const tied = new Map<string, FleetDetail>([
      ['b', { messages: [{ seq: 1, time: 50, kind: 'relay', text: 'x' }], truncated: false }],
      ['a', { messages: [
        { seq: 1, time: 50, kind: 'relay', text: 'y' },
        { seq: 2, time: 50, kind: 'relay', text: 'z' },
      ], truncated: false }],
    ])
    assert.deepEqual(mergeComms(tied).map(row => row.key), ['a:1:50:relay', 'a:2:50:relay', 'b:1:50:relay'], 'equal instants tie-break on the key')
  })
})

describe('fleetDetail decoders — hostile edges', () => {
  test('counts, members, and batch rows reject malformed shapes alone', () => {
    assert.deepEqual(fleetSummaryOf({
      rootId: 'root',
      detail: { messages: [], truncated: false },
      members: 'nope',
      counts: {
        nullEntry: null,
        noReadAt: { messagesTotal: 1, delegationsCount: 1 },
        badTotal: { readAt: 1, messagesTotal: 'x', delegationsCount: 1 },
        negative: { readAt: 1, messagesTotal: -1, delegationsCount: 1 },
        badDelegations: { readAt: 1, messagesTotal: 1, delegationsCount: 'x' },
        negativeDelegations: { readAt: 1, messagesTotal: 1, delegationsCount: -1 },
      },
    })?.counts, {})
    assert.deepEqual(fleetBatchOf({ rows: { a: null, b: 42 }, missing: [null, 7] }), {
      rows: new Map(),
      missing: [],
      total: 0,
    })
  })

  test('a delegation without a label stays label-free', () => {
    const detail = fleetDetailOf({ delegations: [{ seq: 1, time: 1, to: 'kid', mode: 'one-shot' }] })
    assert.deepEqual(detail?.delegations, [{ seq: 1, time: 1, to: 'kid', mode: 'one-shot' }])
  })
})

describe('FleetDetailCache — clearing in-flight reads', () => {
  test('a cleared scope lets the in-flight finally skip the map touch', async () => {
    let release: () => void = () => {}
    vi.stubGlobal('fetch', () => new Promise((resolve) => {
      release = () => { resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response) }
    }))
    const cache = new FleetDetailCache()
    const pending = cache.fetch('s1', 1)
    cache.clear()
    release()
    assert.equal(await pending, null)
  })
})
})

describe('fleetAgents', () => {

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

function commsRow(over: Partial<CommsRow> & { key: string; to: string; time: number; text: string }): CommsRow {
  return { seq: 1, kind: 'relay', ...over }
}

describe('attestedNamesOf', () => {
  test('the newest name per sender wins; a row needs both an id and a name', () => {
    const names = attestedNamesOf([
      commsRow({ key: '1', to: 'a', time: 4, text: 'x', from: 'w1', fromName: 'host-cleaner' }),
      commsRow({ key: '2', to: 'a', time: 3, text: 'x', from: 'w1', fromName: 'renamed' }),
      commsRow({ key: '3', to: 'a', time: 2, text: 'x', fromName: 'legacy' }),
      commsRow({ key: '4', to: 'a', time: 1, text: 'x', from: 'w2' }),
      commsRow({ key: '5', to: 'a', time: 0, text: 'x' }),
    ])
    assert.deepEqual([...names.entries()], [['w1', 'host-cleaner']])
  })
})

const TEAM: FleetTeam = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    { id: 'w3', name: 'tests-a', role: 'teammate', phase: 'active' },
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
    { id: 'w10', name: 'ghost-plain', role: 'teammate', phase: 'active' },
    { id: 'w6', name: 'w6', role: 'teammate', phase: 'active' },
    { id: 'remote-lead', name: 'lead', role: 'lead', phase: 'active' },
  ],
  tasks: [],
}

const ROSTER: FleetMemberInfo[] = [
  { name: 'worker-bee', description: 'schema duty' },
  { name: 'tests-a', description: 'tests-a' },
  { name: 'ghost-nine', description: 'ghost duty' },
  { name: 'ghost-plain', description: '' },
  { name: 'w6', description: '' },
]

describe('commsAgentsOf — team branch', () => {
  test('roster names, duties, and the lead hue resolve over attested names and node labels', () => {
    const agents = commsAgentsOf(
      [
        nodeOf('root', { label: 'Main Agent', isCurrent: true }),
        nodeOf('w1', { label: 'worker-duty', family: 1 }),
        nodeOf('w2', { label: 'side-quest', family: 2 }),
        nodeOf('w3', { label: 'tests-a', family: 3 }),
        nodeOf('w4', { label: 'cold-scout', family: 4 }),
        nodeOf('w6', { label: 'w6', family: 6 }),
      ],
      TEAM,
      ROSTER,
      new Map([
        ['root', 'lead'],
        ['w1', 'bee'],
        ['w2', 'side-quest'],
        ['w3', 'tests-a'],
        ['w9', 'ghost-attested'],
      ]),
      kit.t,
    )
    assert.deepEqual(agents.get('root'), {
      id: 'root', name: 'Lead', role: 'lead', self: true, hue: LEAD_HUE, initials: 'LE2', description: 'Main Agent',
    })
    assert.deepEqual(agents.get('w1'), {
      id: 'w1', name: 'worker-bee', role: 'teammate', self: false, hue: familyHue(1), initials: 'WB', description: 'schema duty',
    })
    assert.deepEqual(agents.get('w2'), {
      id: 'w2', name: 'side-quest', role: 'teammate', self: false, hue: familyHue(2), initials: 'SQ',
    })
    assert.deepEqual(agents.get('w3'), {
      id: 'w3', name: 'tests-a', role: 'teammate', self: false, hue: familyHue(2), initials: 'TA',
    })
    assert.deepEqual(agents.get('w4'), {
      id: 'w4', name: 'cold-scout', role: 'subagent', self: false, hue: familyHue(4), initials: 'CS',
    })
    assert.deepEqual(agents.get('w6'), {
      id: 'w6', name: 'w6', role: 'teammate', self: false, hue: familyHue(5), initials: 'W6',
    })
    assert.deepEqual(agents.get('w9'), {
      id: 'w9', name: 'ghost-nine', role: 'teammate', self: false, hue: familyHue(3), initials: 'GN', description: 'ghost duty',
    })
    assert.deepEqual(agents.get('w10'), {
      id: 'w10', name: 'ghost-plain', role: 'teammate', self: false, hue: familyHue(4), initials: 'GP',
    })
    assert.deepEqual(agents.get('remote-lead'), {
      id: 'remote-lead', name: 'Lead', role: 'lead', self: false, hue: LEAD_HUE, initials: 'LE1',
    })
  })
})

describe('commsAgentsOf — no team', () => {
  test('attested leads and teammates, current agents, and plain subagents all resolve', () => {
    const agents = commsAgentsOf(
      [
        nodeOf('root', { label: 'Main Agent', isCurrent: true, family: 0 }),
        nodeOf('w2', { label: 'side-quest', family: 2 }),
        nodeOf('w3', { label: 'side-quest', family: 3 }),
        nodeOf('w4', { label: 'cold-scout', family: 4 }),
        nodeOf('solo', { label: 'Solo session', isCurrent: true, family: 0 }),
      ],
      null,
      undefined,
      new Map([
        ['root', 'lead'],
        ['w2', 'scout'],
        ['w3', 'side-quest'],
      ]),
      kit.t,
    )
    assert.deepEqual(agents.get('root'), {
      id: 'root', name: 'Lead', role: 'lead', self: true, hue: LEAD_HUE, initials: 'LE', description: 'Main Agent',
    })
    assert.deepEqual(agents.get('w2'), {
      id: 'w2', name: 'scout', role: 'teammate', self: false, hue: familyHue(2), initials: 'SC', description: 'side-quest',
    })
    assert.deepEqual(agents.get('w3'), {
      id: 'w3', name: 'side-quest', role: 'teammate', self: false, hue: familyHue(3), initials: 'SQ',
    })
    assert.deepEqual(agents.get('w4'), {
      id: 'w4', name: 'cold-scout', role: 'subagent', self: false, hue: familyHue(4), initials: 'CS',
    })
    assert.deepEqual(agents.get('solo'), {
      id: 'solo', name: 'Solo session', role: 'agent', self: true, hue: LEAD_HUE, initials: 'SS',
    })
  })
})

describe('fallback identity', () => {
  const titles = new Map([['session-titled', 'Titled Session']])
  const attested = new Map([['session-attested', 'legacy-worker']])

  test('a mailbox name, an attested id, a session title, an unknown party, and a short id each resolve', () => {
    assert.deepEqual(fallbackAgentOf(NAME_PARTY_PREFIX + 'Bee', titles, attested, kit.t), {
      id: NAME_PARTY_PREFIX + 'Bee', name: 'Bee', role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('session-attested', titles, attested, kit.t), {
      id: 'session-attested', name: 'legacy-worker', role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('session-titled', titles, attested, kit.t), {
      id: 'session-titled', name: 'Titled Session', role: 'other', self: false, hue: NEUTRAL_HUE,
      description: 'session-titled',
    })
    assert.deepEqual(fallbackAgentOf(UNKNOWN_PARTY, titles, attested, kit.t), {
      id: UNKNOWN_PARTY, name: kit.t('fleet.comms.unknown'), role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('deadbeef-0000-1111-2222-333333333333', titles, attested, kit.t), {
      id: 'deadbeef-0000-1111-2222-333333333333', name: kit.t('fleet.comms.agentId', { id: 'deadbeef…' }), role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    const known = new Map([['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: LEAD_HUE }]])
    const resolve = agentResolverOf(known, titles, attested, kit.t)
    assert.equal(resolve('root').name, 'Lead')
    assert.equal(resolve('session-attested').name, 'legacy-worker')
  })
})
})

describe('fleetTeam', () => {

function teamValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      { id: 'w2', name: 'flaky-one', role: 'teammate', phase: 'failed', error: 'provider blew up' },
    ],
    tasks: [
      { id: 'task-1', subject: 'schema parsing', description: 'parse the spec', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/api/'], ready: false, writeScopeWarnings: [] },
      { id: 'task-2', subject: 'wire the view', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: ['task-1'], writeScopes: [], ready: false, writeScopeWarnings: ['overlap with task-3'] },
      { id: 'task-3', subject: 'polish', description: '', status: 'pending', blockedBy: ['task-2'], writeScopes: [], ready: false },
      { id: 'task-4', subject: 'docs', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true },
    ],
    ...over,
  }
}

describe('teamOf — the sanitizing parse', () => {
  test('a well-formed projection parses whole; optional fields stay absent rather than materializing empty', () => {
    const team = teamOf(teamValue({ failure: 'bad record' }))
    assert.ok(team !== null)
    assert.equal(team.members.length, 3)
    assert.equal(team.tasks.length, 4)
    assert.equal(team.failure, 'bad record')
    assert.deepEqual(team.tasks[1].warnings, ['overlap with task-3'])

    const bare = teamOf({ members: [{ id: 'r', name: 'lead', role: 'lead', phase: 'active' }] })
    assert.ok(bare !== null)
    assert.equal(bare.members[0].error, undefined)
    assert.equal(bare.failure, undefined)
    assert.deepEqual(bare.tasks, [])

    const modern = teamOf({
      enabled: true,
      tasks: [{ id: 'task-7', subject: 'modern', description: '', status: 'pending', ownerId: 'w1', blockedBy: [], writeScopes: [], ready: true }],
    })
    assert.ok(modern !== null)
    assert.deepEqual(modern.members, [])
    assert.equal(modern.tasks[0].ownerId, 'w1')
    assert.equal(modern.tasks[0].subject, 'modern')
    assert.deepEqual(teamOf({ tasks: [] })?.tasks, [])
    assert.equal(teamOf({ enabled: false, tasks: [] }), null)

    assert.equal(teamOf(undefined), null)
    assert.equal(teamOf(null), null)
    assert.equal(teamOf('team'), null)
    assert.equal(teamOf({}), null)
    assert.equal(teamOf({ members: 'nope' }), null)
  })

  test('malformed members and tasks drop alone', () => {
    const team = teamOf({
      members: [
        null,
        42,
        { id: '', name: 'x', role: 'teammate', phase: 'active' },
        { id: 'x', name: '', role: 'teammate', phase: 'active' },
        { id: 'x', name: 'x', role: 'captain', phase: 'active' },
        { id: 'x', name: 'x', role: 'teammate', phase: 'zombie' },
        { id: 'w9', name: 'nine', role: 'teammate', phase: 'provisioning', error: '' },
      ],
      tasks: [
        null,
        'task',
        { id: '', subject: 's', status: 'pending' },
        { id: 'task-9', subject: '', status: 'pending' },
        { id: 'task-9', subject: 's', status: 'deleted' },
        { id: 'task-10', subject: 'kept', description: 7, status: 'pending', blockedBy: ['a', 1, ''], writeScopes: 'nope', ready: 'yes', revision: 'r' },
      ],
      failure: 42,
    })
    assert.ok(team !== null)
    assert.deepEqual(team.members, [{ id: 'w9', name: 'nine', role: 'teammate', phase: 'provisioning' }])
    assert.equal(team.tasks.length, 1)
    assert.deepEqual(team.tasks[0], {
      id: 'task-10', subject: 'kept', description: '', status: 'pending',
      blockedBy: ['a'], writeScopes: [], ready: false, warnings: [],
    })
    assert.equal(team.failure, undefined)
  })

})

describe('fleetTeam helpers', () => {
  const team = teamOf(teamValue()) as FleetTeam

  test('the helpers join by id and by name, name teammates only, and keep board order', () => {
    assert.equal(teamMemberOf(team, 'w1')?.name, 'worker-bee')
    assert.equal(teamMemberOf(team, 'nobody'), null)
    assert.equal(teamMemberOf(null, 'w1'), null)
    const current = { isCurrent: true, id: 'w1' } as never
    const teammate = { isCurrent: false, id: 'w1' } as never
    const lead = { isCurrent: false, id: 'root' } as never
    const outsider = { isCurrent: false, id: 's9' } as never
    assert.equal(teammateNameOf(team, teammate), 'worker-bee')
    assert.equal(teammateNameOf(team, current), undefined)
    assert.equal(teammateNameOf(team, lead), undefined, 'the lead card keeps the session title')
    assert.equal(teammateNameOf(team, outsider), undefined)
    assert.equal(teammateNameOf(null, teammate), undefined)
    assert.equal(memberIdByName(team, 'worker-bee'), 'w1')
    assert.equal(memberIdByName(team, 'ghost'), undefined)
    assert.equal(memberIdByName(team, undefined), undefined)
    assert.equal(memberIdByName(null, 'worker-bee'), undefined)
    assert.equal(taskOwnerIdOf(team, team.tasks[0]), 'w1')
    assert.deepEqual(tasksOfOwnerId(team, 'w1').map(task => task.id), ['task-1', 'task-2'])
    assert.deepEqual(tasksOfOwnerId(team, 'nobody'), [])
    assert.deepEqual(tasksOfOwnerId(null, 'w1'), [])
  })
})
})

describe('attachmentSource', () => {

const FILE: AttachmentRef = { kind: 'file', attachmentId: 'sha256:f1', name: 'report.md', bytes: 47320 }
const ALIAS = '/home/me/.dsh/attachments/v1/files/a3/a3f0/report.md'

interface Call {
  url: string
  body: unknown
}

function stubFetch(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    const call: Call = { url, body: init.body === undefined ? undefined : JSON.parse(init.body) }
    calls.push(call)
    return answer(call)
  })
  return calls
}

function json(value: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(value) }
}

afterEach(() => {
  clearAttachmentPaths()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pathOfValue', () => {
  test('proves the envelope down to a non-empty string path', () => {
    assert.equal(pathOfValue({ path: ALIAS }), ALIAS)
    assert.equal(pathOfValue({ path: '' }), null)
    assert.equal(pathOfValue({ path: 42 }), null)
    assert.equal(pathOfValue({}), null)
    assert.equal(pathOfValue(null), null)
    assert.equal(pathOfValue('path'), null)
  })
})

describe('makeAttachmentLocator', () => {
  test('no session means no locator; otherwise one read resolves the path and the next click reuses it', async () => {
    assert.equal(makeAttachmentLocator(undefined), undefined)
    assert.equal(makeAttachmentLocator(''), undefined)
    const calls = stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const locate = makeAttachmentLocator('s1')!
    assert.equal(await locate(FILE), ALIAS)
    assert.equal(await locate(FILE), ALIAS)
    assert.equal(calls.length, 1, 'the second read is served from the cache')
    assert.equal(calls[0].url, 'api/dsh-context/attachment')
    assert.deepEqual(calls[0].body, { sessionId: 's1', attachmentId: 'sha256:f1' })
  })

  test('every refusal resolves null, and none of them is cached', async () => {
    const answers: ((call: Call) => unknown)[] = [
      () => json({ ok: true, value: null }),
      () => json({ ok: false, error: { code: 'x' } }),
      () => json({ ok: true, value: { path: '' } }),
      () => ({ ok: false, json: () => Promise.resolve({}) }),
      () => ({ ok: true, json: () => Promise.reject(new Error('bad json')) }),
      () => {
        throw new Error('offline')
      },
      () => json('not-an-envelope'),
    ]
    for (const answer of answers) {
      clearAttachmentPaths()
      const calls = stubFetch(answer)
      const locate = makeAttachmentLocator('s1')!
      assert.equal(await locate(FILE), null)
      assert.equal(await locate(FILE), null)
      assert.equal(calls.length, 2, 'a failed resolution is retried, never cached')
      vi.unstubAllGlobals()
    }
  })

  test('the cache is bounded: the oldest path is dropped first', async () => {
    const calls = stubFetch(call => json({ ok: true, value: { path: `${ALIAS}#${String((call.body as { attachmentId: string }).attachmentId)}` } }))
    const locate = makeAttachmentLocator('s1')!
    for (let i = 0; i < 33; i++) {
      await locate({ kind: 'file', attachmentId: `sha256:f${String(i)}`, name: 'x.md' })
    }
    assert.equal(calls.length, 33)
    await locate({ kind: 'file', attachmentId: 'sha256:f0', name: 'x.md' })
    assert.equal(calls.length, 34)
    await locate({ kind: 'file', attachmentId: 'sha256:f32', name: 'x.md' })
    assert.equal(calls.length, 34)
  })
})

describe('makeAttachmentOpener', () => {
  test('without a session or a preview column there is no opener; otherwise a resolved path opens the session file address', async () => {
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const bare = new TestClientCtx()
    assert.equal(makeAttachmentOpener(asClientCtx(bare), undefined, undefined), undefined)
    assert.equal(makeAttachmentOpener(asClientCtx(bare), '', undefined), undefined)
    assert.equal(makeAttachmentOpener(asClientCtx(bare), 's1', undefined), undefined)
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openResource: (address: string) => { opened.push(address) } } } })
    const open = makeAttachmentOpener(asClientCtx(ctx), 's1', '/work/repo')!
    assert.equal(await open(FILE), true)
    assert.equal(opened.length, 1)
    assert.ok(opened[0].startsWith('dsh-resource://file/session/s1/'), opened[0])
    assert.ok(opened[0].endsWith('report.md'), opened[0])
    assert.ok(opened[0].includes('/home/me/.dsh/attachments/v1/files/a3/a3f0/'), 'an absolute path outside the workspace stays absolute')
  })

  test('an unresolved path and a refused address both report false', async () => {
    stubFetch(() => json({ ok: true, value: null }))
    const refused: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openResource: (address: string) => { refused.push(address) } } } })
    const open = makeAttachmentOpener(asClientCtx(ctx), 's1', undefined)!
    assert.equal(await open(FILE), false)
    assert.deepEqual(refused, [], 'nothing to open, the column is never called')

    clearAttachmentPaths()
    vi.unstubAllGlobals()
    stubFetch(() => json({ ok: true, value: { path: ALIAS } }))
    const throwing = new TestClientCtx({
      services: {
        sidebarRight: {
          openResource: () => {
            throw new Error('no viewer claims it')
          },
        },
      },
    })
    const openThrowing = makeAttachmentOpener(asClientCtx(throwing), 's1', undefined)!
    assert.equal(await openThrowing(FILE), false)
  })
})
})
