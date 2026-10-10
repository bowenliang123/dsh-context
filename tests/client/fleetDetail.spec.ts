// fleetDetail.ts — the fleet route's client half: the sanitizing parse, the freshness-stamped
// promise ledger, and the cross-session comms merge.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  FleetDetailCache,
  fleetDetailOf,
  makeFleetDetailFetcher,
  mergeComms,
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
      descriptor: { mode: 'continuable', label: 'worker', provider: 'fork', agentModel: 'v4', persona: '' },
      initialPrompt: 'do the thing',
      messages: [
        null,
        42,
        { kind: 'pigeon', text: 'coo' },
        { kind: 'relay', text: '' },
        { kind: 'relay', text: 'hi', seq: 3, time: 30, from: 'a', fromName: 9 },
        { kind: 'settled', text: 'done', seq: 1, fromName: 'w' },
        { kind: 'mailbox', text: 'old', seq: 2 },
      ],
      truncated: true,
    })
    assert.ok(detail !== null)
    assert.deepEqual(detail.descriptor, { mode: 'continuable', label: 'worker', provider: 'fork', agentModel: 'v4' })
    assert.equal(detail.initialPrompt, 'do the thing')
    assert.deepEqual(detail.messages, [
      { kind: 'relay', text: 'hi', seq: 3, time: 30, from: 'a' },
      { kind: 'settled', text: 'done', seq: 1, time: 0, fromName: 'w' },
      { kind: 'mailbox', text: 'old', seq: 2, time: 0 },
    ])
    assert.equal(detail.truncated, true)
  })

  test('absent and shapeless payloads degrade', () => {
    assert.equal(fleetDetailOf(undefined), null)
    assert.equal(fleetDetailOf(null), null)
    assert.equal(fleetDetailOf('x'), null)
    const bare = fleetDetailOf({})
    assert.deepEqual(bare, { messages: [], truncated: false })
    // A non-array messages field and a junk descriptor both drop whole.
    const junk = fleetDetailOf({ messages: 'nope', descriptor: { mode: 'weird' }, truncated: 1 })
    assert.deepEqual(junk, { messages: [], truncated: false })
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
    // Junk reply shapes stay absent.
    assert.equal(fleetDetailOf({ lastReply: { text: 1 } })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ lastReply: 'nope' })?.lastReply, undefined)
    assert.equal(fleetDetailOf({ roster: 'nope' })?.roster, undefined)
  })
})

function stubRoute(handler: (body: string) => unknown): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const out = handler(init.body)
    return Promise.resolve({ ok: true, json: () => Promise.resolve(out) } as Response)
  })
}

describe('makeFleetDetailFetcher', () => {
  test('an empty session id yields no fetcher', () => {
    assert.equal(makeFleetDetailFetcher(''), undefined)
  })

  test('round-trips a detail; null value passes through', async () => {
    stubRoute(() => ({ ok: true, value: { messages: [{ kind: 'relay', text: 'yo', seq: 1, time: 1 }], truncated: false } }))
    const detail = await makeFleetDetailFetcher('s1')!()
    assert.equal(detail?.messages[0]?.text, 'yo')

    stubRoute(() => ({ ok: true, value: null }))
    assert.equal(await makeFleetDetailFetcher('s1')!(), null)
  })

  test('transport failures and malformed payloads reject', async () => {
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

    // An older stamp keeps the settled read; a newer one refetches.
    await cache.fetch('s1', 3)
    assert.equal(reads, 1)
    await cache.fetch('s1', 6)
    assert.equal(reads, 2)
  })

  test('a settled failure caches as null, and invalidate forces a fresh read', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: false, status: 500 } as Response)
    })
    const cache = new FleetDetailCache()
    assert.equal(await cache.fetch('s1', 1), null)
    await cache.fetch('s1', 1)
    assert.equal(reads, 1, 'the failure stays cached at the same stamp')
    cache.invalidate('s1')
    await cache.fetch('s1', 1)
    assert.equal(reads, 2)
  })

  test('an empty id resolves null without touching the network', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: null }) } as Response)
    })
    const cache = new FleetDetailCache()
    assert.equal(await cache.fetch('', 1), null)
    assert.equal(reads, 0)
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

describe('mergeComms', () => {
  test('merges per-session messages newest-first with the log owner as recipient', () => {
    const details = new Map<string, FleetDetail>([
      ['a', { messages: [
        { seq: 1, time: 100, kind: 'relay', from: 'b', text: 'question' },
        { seq: 3, time: 300, kind: 'settled', text: 'b finished' },
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
    assert.equal(rows[0].key, 'a:3')
    assert.equal(rows[2].from, 'b')
    assert.equal(rows[1].fromName, 'lead')
  })

  test('equal instants tie-break on the key', () => {
    const details = new Map<string, FleetDetail>([
      ['b', { messages: [{ seq: 1, time: 50, kind: 'relay', text: 'x' }], truncated: false }],
      ['a', { messages: [
        { seq: 1, time: 50, kind: 'relay', text: 'y' },
        { seq: 2, time: 50, kind: 'relay', text: 'z' },
      ], truncated: false }],
    ])
    assert.deepEqual(mergeComms(details).map(r => r.key), ['a:1', 'a:2', 'b:1'])
  })
})
