// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { type FactPart } from '../../src/client/timelineSource'
import type { ContextTimelineDetail } from '../../src/shared/types'
import { core, head, series, storeOf, T0 } from './helpers/factsFixtures'
import { until } from './helpers/kit'

describe('DetailStore carries the accepted parts across a core refresh', () => {
  test('a core refresh keeps the landed parts until their replacement lands', async () => {
    let rev = 1
    let holdEvents = false
    let releaseEvents: (value: unknown) => void = () => {}
    const store = storeOf(async () => core(rev), async (part) => {
      if (part !== 'events') return { rev, parts: {} }
      if (holdEvents) return new Promise(resolve => { releaseEvents = resolve })
      return { rev, parts: { events: [{ seq: rev, time: T0, kind: 'inject', form: 'context' }] } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('events')
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the events part never landed')
    holdEvents = true
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    assert.deepEqual(store.getSnapshot().detail?.events.map(event => event.seq), [1], 'the landed rows survive the core pass')
    releaseEvents({ rev: 2, parts: { events: [{ seq: 2, time: T0, kind: 'inject', form: 'context' }, { seq: 3, time: T0, kind: 'inject', form: 'context' }] } })
    await until(() => store.getSnapshot().detail?.events.length === 2, 'the replacement part never landed')
    assert.deepEqual(store.getSnapshot().detail?.events.map(event => event.seq), [2, 3], 'the replacement replaces the carried rows')
    store.release()
  })

  test('a part reply that omits the requested part drops the carried rows', async () => {
    let rev = 1
    let omit = false
    const store = storeOf(async () => core(rev), async (part) => {
      if (part !== 'events') return { rev, parts: {} }
      return omit ? { rev, parts: {} } : { rev, parts: { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('events')
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the events part never landed')
    omit = true
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    await until(() => store.getSnapshot().detail?.events.length === 0, 'an omitted part reply is not a replacement')
    store.release()
  })

  test('the accept resets the pending part retry budget', async () => {
    vi.useFakeTimers()
    try {
      let rev = 1
      let attempts = 0
      const store = storeOf(async () => core(rev), async (part) => {
        if (part !== 'nodes') return { rev, parts: {} }
        attempts++
        throw new Error('offline')
      })
      store.subscribe(() => {})
      store.request(1)
      await vi.advanceTimersByTimeAsync(0)
      store.ensurePart('nodes')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(4_000)
      assert.equal(attempts, 4, 'the first revision spent its whole retry budget')
      rev = 2
      store.request(2)
      await vi.advanceTimersByTimeAsync(0)
      assert.equal(attempts, 5, 'the accept re-read the part at once')
      assert.equal(store.getSnapshot().pending, true, 'the fresh revision re-arms a retry instead of dropping at once')
      await vi.advanceTimersByTimeAsync(1_000)
      assert.equal(attempts, 6)
      store.release()
    } finally {
      vi.useRealTimers()
    }
  })

  test('the byte ledger follows the carried and dropped collection', async () => {
    let rev = 1
    let drop = false
    let holdPart = false
    let releasePart: (value: unknown) => void = () => {}
    const store = storeOf(async () => core(rev), async (part) => {
      if (part !== 'events') return { rev, parts: {} }
      if (holdPart) return new Promise(resolve => { releasePart = resolve })
      return drop
        ? { rev, parts: {}, missing: ['events'] }
        : { rev, parts: { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('events')
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the events part never landed')
    const landed = store.byteSize
    drop = true
    holdPart = true
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    assert.equal(store.byteSize, landed, 'the carried collection keeps its retention weight')
    releasePart({ rev: 2, parts: {}, missing: ['events'] })
    await until(() => store.getSnapshot().detail?.events.length === 0, 'the dropped collection left the ledger')
    assert.ok(store.byteSize < landed)
    store.release()
  })

  test('a settled empty spans collection survives a core refresh', async () => {
    let rev = 1
    let holdSpans = false
    let releaseSpans: (value: unknown) => void = () => {}
    const store = storeOf(async () => core(rev), async (part) => {
      if (part !== 'spans') return { rev, parts: {} }
      if (holdSpans) return new Promise(resolve => { releaseSpans = resolve })
      return { rev, parts: { spans: [] } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('spans')
    await until(() => store.getSnapshot().detail?.spans !== undefined, 'the empty spans part never landed')
    holdSpans = true
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    assert.deepEqual(store.getSnapshot().detail?.spans, [], 'the settled empty collection survives the core pass')
    releaseSpans({ rev: 2, parts: { spans: [{ kind: 'text', start: 1, end: 2 }] } })
    await until(() => store.getSnapshot().detail?.spans?.length === 1, 'the replacement spans never landed')
    store.release()
  })

  test('a part read in flight at the core accept is re-read for the accepted revision', async () => {
    let rev = 1
    let calls = 0
    let release: (value: unknown) => void = () => {}
    const store = storeOf(async () => core(rev), async (part) => {
      if (part !== 'events') return { rev, parts: {} }
      calls++
      if (calls === 1) return new Promise(resolve => { release = resolve })
      return { rev, parts: { events: [{ seq: rev, time: T0, kind: 'inject', form: 'context' }] } }
    })
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    store.ensurePart('events')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    assert.equal(calls, 1, 'the first read is still in flight when the core lands')
    release({ rev: 1, parts: { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] } })
    await until(() => store.getSnapshot().detail?.events[0]?.seq === 2, 'the superseded read was never re-issued')
    assert.equal(calls, 2, 'the accepted revision re-read the part')
    store.release()
  })

  test('an unavailable replacement drops every carried collection', async () => {
    let rev = 1
    let dropAll = false
    const landed: Record<FactPart, Record<string, unknown>> = {
      requests: { requests: [{ seq: 1, time: T0, system: 1, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1 }] },
      nodes: { nodes: { nodes: [{ seq: 1, cat: 'user', tokens: 1 }], archive: [{ seq: 1, cat: 'tool', tokens: 1, gone: 2 }], droppedNodes: 1, surfaceFloor: 1, archiveFloor: 1 } },
      events: { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] },
      files: { files: { fileOps: [{ seq: 1, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }], fileOpsFloor: 1 } },
      commands: { commands: { commands: [{ seq: 1, time: T0, tool: 'bash', cmd: 'ls', start: T0, status: 'completed', err: false }], commandsFloor: 1, commandStats: { runs: 1, failed: 0, ms: 1, bg: 0 } } },
      spans: { spans: [{ kind: 'text', start: 1, end: 2 }] },
    }
    const store = storeOf(async () => core(rev), async (part) => (dropAll
      ? { rev, parts: {}, missing: [part] }
      : { rev, parts: landed[part] }))
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.hasPayload, 'the core never landed')
    for (const part of Object.keys(landed) as FactPart[]) store.ensurePart(part)
    await until(() => store.getSnapshot().detail?.spans !== undefined, 'the landed parts never merged')
    const before = store.getSnapshot().detail as ContextTimelineDetail
    assert.equal(before.nodes.length, 1)
    assert.equal(before.archive.length, 1)
    assert.equal(before.fileOps?.length, 1)
    assert.equal(before.commands?.length, 1)
    dropAll = true
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer core never landed')
    await until(() => {
      const detail = store.getSnapshot().detail as ContextTimelineDetail
      return detail.events.length === 0 && detail.nodes.length === 0 && detail.spans === undefined && detail.fileOps === undefined && detail.commands === undefined
    }, 'the carried collections were not dropped')
    const after = store.getSnapshot().detail as ContextTimelineDetail
    assert.deepEqual(after.requests.map(request => request.seq), [2], 'the core series keeps the requests rows when the full part is unavailable')
    assert.equal(after.droppedNodes, 0)
    assert.deepEqual(after.archive, [])
    assert.equal(after.surfaceFloor, undefined, 'the carried window watermarks drop with the nodes part')
    assert.equal(after.archiveFloor, undefined)
    assert.equal(after.fileOpsFloor, undefined)
    assert.equal(after.commandsFloor, undefined)
    assert.equal(after.commandStats, undefined)
    store.release()
  })

  test('an exhausted part retry drops the carried part', async () => {
    vi.useFakeTimers()
    try {
      let rev = 1
      let attempts = 0
      const store = storeOf(async () => core(rev), async (part) => {
        if (part !== 'nodes') return { rev, parts: {} }
        attempts++
        if (rev === 1) return { rev, parts: { nodes: { nodes: [{ seq: 1, cat: 'user', tokens: 1 }], archive: [], droppedNodes: 0 } } }
        throw new Error('offline')
      })
      store.subscribe(() => {})
      store.request(1)
      await vi.advanceTimersByTimeAsync(0)
      store.ensurePart('nodes')
      await vi.advanceTimersByTimeAsync(0)
      assert.equal(store.getSnapshot().detail?.nodes.length, 1, 'the first nodes part landed')
      rev = 2
      store.request(2)
      await vi.advanceTimersByTimeAsync(0)
      assert.equal(store.getSnapshot().detail?.rev, 2)
      assert.equal(store.getSnapshot().detail?.nodes.length, 1, 'the carried rows survive while the retries are armed')
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(2_000)
      assert.equal(store.getSnapshot().detail?.nodes.length, 1, 'the carried rows stay through the retries')
      await vi.advanceTimersByTimeAsync(4_000)
      assert.equal(attempts, 5, 'three backed-off retries ran on top of the two launches')
      assert.equal(store.getSnapshot().detail?.nodes.length, 0, 'the abandoned part drops instead of showing the old revision')
      store.release()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a degraded core read keeps the carried head and series', async () => {
    const reads = [core(1), { rev: 2, live: true, parts: { series: series(2) as never } }, { rev: 3, live: true, parts: { head: head(3) as never } }]
    const store = storeOf(async () => reads.shift() as never)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail?.rev === 1, 'the first core never landed')
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the headless core never landed')
    assert.equal(store.getSnapshot().detail?.head?.detailRev, 1, 'the carried head survives a core read without head')
    store.request(3)
    await until(() => store.getSnapshot().detail?.rev === 3, 'the series-less core never landed')
    assert.deepEqual(store.getSnapshot().detail?.requests.map(request => request.seq), [2], 'the carried series survives a core read without series')
    store.release()
  })
})
