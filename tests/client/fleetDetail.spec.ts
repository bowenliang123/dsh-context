import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  FleetDetailCache,
  fleetDetailOf,
  makeFleetDetailFetcher,
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

  test('roster and lastReply sanitize; malformed entries drop alone', () => {
    const detail = fleetDetailOf({
      roster: [
        null,
        { name: '' },
        { name: 'worker', description: 'duty', provider: 'spawn', context: 'fork' },
        { name: 'bare', description: 1, provider: 2, context: 'sideways' },
      ],
      lastReply: { time: 42, text: '报告完毕' },
    })
    assert.deepEqual(detail?.roster, [
      { name: 'worker', description: 'duty', provider: 'spawn', context: 'fork' },
      { name: 'bare', description: '' },
    ])
    assert.deepEqual(detail?.lastReply, { time: 42, text: '报告完毕' })
    assert.equal(fleetDetailOf({ lastReply: { text: 1 } })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ lastReply: 'nope' })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ roster: 'nope' })?.roster, undefined)
  })

  test('delegations sanitize without becoming messages', () => {
    const detail = fleetDetailOf({
      delegations: [
        null,
        { seq: 1, time: 10, to: 'one', mode: 'one-shot', label: 'Inspect' },
        { seq: 2, time: 20, to: 'continuable', mode: 'continuable' },
        { seq: 3, time: 30, to: 'external', mode: 'external' },
        { seq: 4, time: 40, to: 'unknown', mode: 'unknown' },
        { seq: 5, time: 50, to: 'bad', mode: 'mystery' },
        { seq: 6, time: 60, to: '', mode: 'one-shot' },
      ],
    })
    assert.deepEqual(detail?.delegations, [
      { seq: 1, time: 10, to: 'one', mode: 'one-shot', label: 'Inspect' },
      { seq: 2, time: 20, to: 'continuable', mode: 'continuable' },
      { seq: 3, time: 30, to: 'external', mode: 'external' },
      { seq: 4, time: 40, to: 'unknown', mode: 'unknown' },
    ])
    assert.deepEqual(detail?.messages, [])
    assert.equal(fleetDetailOf({ delegations: 'nope' })?.delegations, undefined)
  })
})

function stubRoute(handler: (body: Record<string, unknown>) => unknown): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const out = handler(JSON.parse(init.body) as Record<string, unknown>)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(out) } as Response)
  })
}

describe('makeFleetDetailFetcher', () => {
  test('round-trips a detail; null passes through, and a full request posts the full flag', async () => {
    stubRoute(() => ({ ok: true, value: { messages: [{ kind: 'relay', text: 'yo', seq: 1, time: 1 }], truncated: false } }))
    const detail = await makeFleetDetailFetcher('s1')!()
    assert.equal(detail?.messages[0]?.text, 'yo')

    stubRoute(() => ({ ok: true, value: null }))
    assert.equal(await makeFleetDetailFetcher('s1')!(), null)

    const bodies: Record<string, unknown>[] = []
    stubRoute((body) => {
      bodies.push(body)
      return { ok: true, value: null }
    })
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
})

describe('FleetDetailCache', () => {
  test('one in-flight read per (id, stamp); a newer stamp refetches once', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    const [a, b] = await Promise.all([cache.fetch('s1', 5), cache.fetch('s1', 5)])
    assert.equal(a, null)
    assert.equal(b, null)
    assert.equal(reads, 1)

    await cache.fetch('s1', 3)
    assert.equal(reads, 1)
    await cache.fetch('s1', 6)
    assert.equal(reads, 2)
  })

  test('the ledger stays bounded; the least recently read member drops first', async () => {
    const reads: string[] = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      reads.push(String((JSON.parse(init.body) as { sessionId: string }).sessionId))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    for (let i = 0; i < 80; i++) await cache.fetch(`s${i}`, 1)
    assert.equal(reads.length, 80)
    await cache.fetch('s79', 1)
    assert.equal(reads.length, 80, 'the newest member still replays')
    await cache.fetch('s0', 1)
    assert.equal(reads.length, 81, 'the evicted oldest member refetches')
  })

  test('an empty id resolves null without touching the network; a settled failure caches at its stamp and a newer stamp retries', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: false, status: 500 } as Response)
    })
    const cache = new FleetDetailCache()
    assert.equal(await cache.fetch('', 1), null)
    assert.equal(reads, 0)
    assert.equal(await cache.fetch('s1', 1), null)
    await cache.fetch('s1', 1)
    assert.equal(reads, 1, 'the failure stays cached at the same stamp')
    await cache.fetch('s1', 2)
    assert.equal(reads, 2)
  })

  test('the full ledger runs beside the excerpt ledger', async () => {
    const routes: string[] = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      routes.push(init.body)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    await Promise.all([cache.fetch('s1', 5), cache.fetch('s1', 5, true)])
    assert.equal(routes.length, 2, 'separate ledgers, separate reads')
    await cache.fetch('s1', 3)
    await cache.fetch('s1', 3, true)
    assert.equal(routes.length, 2)
    await Promise.all([cache.fetch('s1', 6), cache.fetch('s1', 6, true)])
    assert.equal(routes.length, 4, 'a newer stamp refreshes each ledger on its own')
  })

  test('history has an independent complete-event ledger and empty ids stay offline', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      bodies.push(body)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    assert.equal(await cache.fetchHistory('', 1), null)
    assert.equal(bodies.length, 0)
    await Promise.all([cache.fetchHistory('s1', 2), cache.fetchHistory('s1', 2)])
    assert.equal(bodies.length, 1)
    await cache.fetchHistory('s1', 1)
    assert.equal(bodies.length, 1)
    await cache.fetchHistory('s1', 3)
    assert.equal(bodies.length, 2)
    assert.ok(bodies.every(body => body.history === true))
    await cache.fetch('s1', 3)
    assert.equal(bodies.length, 3)
    assert.equal(bodies[2].full, undefined)
    assert.equal(bodies[2].history, undefined)
  })

  test('a failing history read resolves null and stays cached at its stamp', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: false, status: 503 } as Response)
    })
    const cache = new FleetDetailCache()
    assert.equal(await cache.fetchHistory('s1', 1), null)
    assert.equal(await cache.fetchHistory('s1', 1), null)
    assert.equal(reads, 1, 'the failed read replays from the ledger')
    assert.equal(await cache.fetchHistory('s1', 2), null)
    assert.equal(reads, 2)
  })

  test('clear drops every ledger so a reused instance reads fresh', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    await Promise.all([cache.fetch('s1', 5), cache.fetch('s1', 5, true), cache.fetchHistory('s1', 5)])
    assert.equal(reads, 3)
    cache.clear()
    await Promise.all([cache.fetch('s1', 5), cache.fetch('s1', 5, true), cache.fetchHistory('s1', 5)])
    assert.equal(reads, 6)
  })

  test('the byte budget evicts the oldest oversized entries and keeps the newest read', async () => {
    const reads: string[] = []
    const text = 'x'.repeat(600_000)
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const id = String((JSON.parse(init.body) as { sessionId: string }).sessionId)
      reads.push(id)
      const value = { messages: [{ seq: 1, time: 1, kind: 'relay', text }], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const cache = new FleetDetailCache()
    for (let i = 0; i < 20; i++) await cache.fetch(`s${i}`, 1)
    await cache.fetch('s19', 1)
    assert.equal(reads.length, 20, 'the newest entry replays from the ledger')
    await cache.fetch('s0', 1)
    assert.equal(reads.length, 21, 'an entry evicted by bytes refetches')
  })
})

describe('settledVariantOf', () => {
  test('the runtime vocabulary classifies; unknown phrasings pass through', () => {
    assert.equal(settledVariantOf('Background subagent x finished and will do no further work unless you send it more.'), 'finished')
    assert.equal(settledVariantOf('Background subagent x finished. It cannot receive follow-up messages.'), 'finishedFinal')
    assert.equal(settledVariantOf('Background subagent x was stopped before it finished.'), 'stopped')
    assert.equal(settledVariantOf('Background subagent x ran out of room before it finished.'), 'outOfRoom')
    assert.equal(settledVariantOf('Background subagent x declined the task.'), 'declined')
    assert.equal(settledVariantOf('Background subagent x failed before it finished.'), 'failed')
    assert.equal(settledVariantOf('some future phrasing'), null)
  })
})

describe('mergeDelegations', () => {
  test('keeps the parent log owner as the delegation source', () => {
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
})

describe('mergeComms', () => {
  test('merges per-session messages newest-first with the log owner as recipient, keeping settled fields', () => {
    const details = new Map<string, FleetDetail>([
      ['a', { messages: [
        { seq: 1, time: 100, kind: 'relay', from: 'b', text: 'question' },
        { seq: 3, time: 300, kind: 'settled', text: 'b finished', from: 'b', clipped: true, summary: 'summary', report: 'report', structured: '{"ok":true}', diagnostic: 'diag' },
      ], truncated: false }],
      ['b', { messages: [{ seq: 2, time: 200, kind: 'mailbox', fromName: 'lead', text: 'old school' }], truncated: false }],
      ['empty', { messages: [], truncated: false }],
    ])
    const rows = mergeComms(details)
    assert.deepEqual(rows.map(r => [r.to, r.time, r.kind]), [
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
    assert.deepEqual(mergeComms(tied).map(r => r.key), ['a:1:50:relay', 'a:2:50:relay', 'b:1:50:relay'], 'equal instants tie-break on the key')
  })
})
