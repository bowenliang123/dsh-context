import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  detailBytes,
  FleetDetailCache,
  fleetBatchOf,
  fleetDetailOf,
  fleetSummaryOf,
  makeFleetBatchFetcher,
  makeFleetDetailFetcher,
  makeFleetSummaryFetcher,
  mergeComms,
  mergeDelegations,
  settledVariantOf,
} from '../../src/client/fleetDetail'
import type { FleetDetail } from '../../src/shared/types'

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
