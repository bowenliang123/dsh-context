// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { DetailStore, historyOf } from '../../src/client/timelineSource'
import type { ContextEventRecord, RequestRecord } from '../../src/shared/types'
import { head, T0 } from './helpers/factsFixtures'
import { request } from './helpers/historyFixtures'
import { until } from './helpers/kit'

describe('history pages', () => {
  test('decodes valid pages and rejects unusable metadata', () => {
    const empty = historyOf({ rev: 1, live: false, part: 'requests', rows: [], first: 0, last: -1, total: 0, atStart: true, atEnd: true })
    assert.equal(empty?.last, -1)
    assert.equal(historyOf(null), null)
    assert.equal(historyOf({ rev: 1, live: false, part: 'nope', rows: [], first: 0, last: -1, total: 0, atStart: true, atEnd: true }), null)
    assert.equal(historyOf({ rev: 1, part: 'events', rows: [], first: 0, last: 0, total: 1, atStart: true }), null)
    assert.equal(historyOf({ rev: 1, part: 'events', rows: [], first: -1, last: 0, total: 1, atStart: true, atEnd: true }), null)
    const indexed = historyOf({ rev: 1, live: false, part: 'nodes', rows: [], first: 2, last: 1, total: 3, atStart: false, atEnd: false, beforeIndex: 2 })
    assert.equal(indexed?.beforeIndex, 2)
  })

  test('loads every request and event page into the detail payload and appends a tail refresh', async () => {
    const event = (seq: number): ContextEventRecord => ({ seq, time: T0 + seq, kind: 'inject', form: 'context' })
    const page = <T,>(rows: T[], first: number, total: number, atStart: boolean, beforeSeq: number | undefined, revision: number) =>
      ({ rev: revision, live: true, part: 'requests' as const, rows, first, last: first + rows.length - 1, total, atStart, atEnd: !beforeSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    const calls: string[] = []
    let rev = 1
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(3), request(4)] } }),
      part: async () => null,
      history: async (part, cursor) => {
        const beforeSeq = cursor?.beforeSeq
        calls.push(part + ':' + String(beforeSeq))
        if (part === 'requests') {
          return beforeSeq === undefined
            ? page(rev === 1 ? [request(3), request(4)] : [request(4), request(5)], 2, rev === 1 ? 4 : 5, false, 3, rev)
            : page([request(1), request(2)], 0, 4, true, undefined, rev)
        }
        return beforeSeq === undefined
          ? { ...page([event(3)], 2, 3, false, 3, rev), part }
          : { ...page([event(1)], 0, 3, true, undefined, rev), part }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.requests.length === 4, 'the full requests never landed')
    assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [1, 2, 3, 4])
    assert.deepEqual(store.getSnapshot().detail?.events.map(row => row.seq), [1, 3])
    assert.ok(calls.includes('requests:3'))
    assert.ok(calls.includes('events:3'))

    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.requests.length === 5, 'the tail refresh never merged')
    assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [1, 2, 3, 4, 5])
    store.release()
  })

  test('keeps loaded history against a late events part refetch', async () => {
    let partCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => { partCalls++; return null },
      history: async (part) => ({
        rev: 1, live: true, part, rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject', form: 'context' }],
        first: 0, last: 0, total: 1, atStart: true, atEnd: true,
      }),
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    store.ensurePart('events')
    store.ensurePart('requests')
    assert.equal(partCalls, 0)
    store.release()
  })

  test('a history failure leaves the tail payload in place', async () => {
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async () => { throw new Error('offline') },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [1])
    store.release()
  })

  test('a null request or event page leaves the tail untouched', async () => {
    for (const nullPart of ['requests', 'events']) {
      const store = new DetailStore({
        core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
        part: async () => null,
        history: async (part) => part === nullPart ? null : ({
          rev: 1, live: true, part, rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject', form: 'context' }],
          first: 0, last: 0, total: 1, atStart: true, atEnd: true,
        }),
      }, 0)
      store.subscribe(() => {})
      store.request(1)
      await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
      store.ensureHistory()
      await new Promise(resolve => setTimeout(resolve, 5))
      assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [1])
      store.release()
    }
  })

  test('a revision advancing during the event load restarts the history fetch', async () => {
    let rev = 1
    let triggered = false
    const holder: { store: DetailStore | null } = { store: null }
    const page = (part: 'requests' | 'events', revision = rev): never => ({
      rev: revision,
      live: true,
      part,
      rows: part === 'requests' ? [request(revision === 1 ? 1 : 2)] : [{ seq: revision, time: T0, kind: 'inject', form: 'context' }],
      first: 0,
      last: 0,
      total: 1,
      atStart: true,
      atEnd: true,
    }) as never
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'events' && !triggered) {
          triggered = true
          rev = 2
          holder.store?.request(2)
          await new Promise(resolve => setTimeout(resolve, 5))
          return page('events', 1)
        }
        return page(part === 'events' ? 'events' : 'requests')
      },
    }, 0)
    holder.store = store
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.rev === 2, 'the retry never landed')
    store.release()
  })

  test('ensureHistory is inert without history, before detail, while loading and once ready', async () => {
    const noHistory = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
    }, 0)
    noHistory.ensureHistory()
    noHistory.subscribe(() => {})
    noHistory.request(1)
    await until(() => noHistory.getSnapshot().detail !== null, 'the core payload never landed')
    noHistory.ensureHistory()
    noHistory.release()

    let resolvePage: ((value: unknown) => void) | undefined
    const blocked = new Promise(resolve => { resolvePage = resolve })
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        await blocked
        return {
          rev: 1, live: true, part, rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject', form: 'context' }],
          first: 0, last: 0, total: 1, atStart: true, atEnd: true,
        }
      },
    }, 0)
    store.ensureHistory()
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    store.ensureHistory()
    resolvePage?.(undefined)
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    store.ensureHistory()
    store.release()
  })

  test('a failed tail refresh keeps the loaded full history', async () => {    let rev = 1
    const page = (part: 'requests' | 'events', rows: unknown[]): never => ({
      rev, live: true, part, rows, first: 0, last: rows.length - 1, total: rows.length, atStart: true, atEnd: true,
    }) as never
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => rev === 2 ? null : page(part === 'requests' ? 'requests' : 'events', part === 'requests' ? [request(1)] : [{ seq: 1, time: T0, kind: 'inject', form: 'context' }]),
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(store.getSnapshot().detail?.requests.length, 1)
    store.release()
  })

  test('merges a first page into an empty history and keeps the fast append path', async () => {
    let rev = 1
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: rev === 1 ? [] : [request(2)] } }),
      part: async () => null,
      history: async (part) => ({
        rev, live: true, part,
        rows: rev === 1 || rev === 3 ? [] : part === 'requests' ? [request(2)] : [{ seq: 2, time: T0, kind: 'inject', form: 'context' }],
        first: 0,
        last: rev === 1 || rev === 3 ? -1 : 0,
        total: rev === 1 || rev === 3 ? 0 : 1,
        atStart: true,
        atEnd: true,
      }),
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(store.getSnapshot().detail?.requests.length, 0)
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [2])
    assert.deepEqual(store.getSnapshot().detail?.events.map(row => row.seq), [2])
    rev = 3
    store.request(3)
    await until(() => store.getSnapshot().detail?.rev === 3, 'the empty refresh never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(store.getSnapshot().detail?.requests.map(row => row.seq), [2])
    store.release()
  })

  test('a tail refresh released mid-flight leaves no half-merged history', async () => {
    let rev = 1
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (rev === 2) await new Promise(resolve => setTimeout(resolve, 5))
        return {
          rev, live: true, part,
          rows: part === 'requests' ? [request(1)] : [{ seq: 1, time: T0, kind: 'inject', form: 'context' }],
          first: 0, last: 0, total: 1, atStart: true, atEnd: true,
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    store.release()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail, null)
  })

  test('a refresh keeps same-seq events distinct', async () => {
    let rev = 1
    let eventCalls = 0
    const events: ContextEventRecord[] = [
      { seq: 9, ord: 0, time: T0, kind: 'todo-add', count: 1 },
      { seq: 9, ord: 1, time: T0, kind: 'todo-done', count: 1, items: ['a'] },
    ]
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(9)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'events') eventCalls++
        return {
          rev,
          live: true,
          part,
          rows: part === 'events' ? events : [request(9)],
          first: 0,
          last: part === 'events' ? 1 : 0,
          total: part === 'events' ? 2 : 1,
          atStart: true,
          atEnd: true,
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 2, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => eventCalls >= 2, 'the tail refresh never ran')
    assert.deepEqual(store.getSnapshot().detail?.events.map(row => row.kind), ['todo-add', 'todo-done'])
    store.release()
  })

  test('a tail refresh closes a gap larger than one page', async () => {
    const all = Array.from({ length: 2_505 }, (_, index) => request(index + 1))
    let rev = 1
    let requestCalls = 0
    const pageOf = (beforeSeq: number | undefined): {
      rows: RequestRecord[]
      first: number
      last: number
      total: number
      atStart: boolean
      atEnd: boolean
      beforeSeq?: number
    } => {
      if (rev === 1) {
        return { rows: all.slice(0, 2), first: 0, last: 1, total: 2, atStart: true, atEnd: true }
      }
      const end = beforeSeq === undefined ? all.length : all.findIndex(row => row.seq >= beforeSeq)
      const start = Math.max(0, end - 1_000)
      return {
        rows: all.slice(start, end),
        first: start,
        last: end - 1,
        total: all.length,
        atStart: start === 0,
        atEnd: end === all.length,
        ...(start > 0 ? { beforeSeq: all[start].seq } : {}),
      }
    }
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: rev === 1 ? [request(1)] : [request(2)] } }),
      part: async () => null,
      history: async (part, cursor) => {
        if (part === 'requests') requestCalls++
        return {
          rev,
          live: true,
          part,
          ...(part === 'requests'
            ? pageOf(cursor?.beforeSeq)
            : { rows: [{ seq: 1, time: T0, kind: 'inject' as const }], first: 0, last: 0, total: 1, atStart: true, atEnd: true }),
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.requests.length === 2, 'the short history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.requests.length === 2_505, 'the gap never closed')
    assert.equal(store.getSnapshot().detail?.requests.at(-1)?.seq, 2_505)
    assert.ok(requestCalls >= 4)
    store.release()
  })

  test('parking during the core load leaves it retriable', async () => {
    for (const cancelPart of ['requests', 'events'] as const) {
      let releasePage: (() => void) | undefined
      const gate = new Promise<void>(resolve => { releasePage = resolve })
      let calls = 0
      const store = new DetailStore({
        core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
        part: async () => null,
        history: async (part) => {
          calls++
          if (part === cancelPart) {
            await gate
          }
          return {
            rev: 1,
            live: true,
            part,
            rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject' }],
            first: 0,
            last: 0,
            total: 1,
            atStart: true,
            atEnd: true,
          }
        },
      }, 0)
      const off = store.subscribe(() => {})
      store.request(1)
      await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
      store.ensureHistory()
      await until(() => calls === (cancelPart === 'requests' ? 1 : 2), 'the cancelling page never started')
      off()
      releasePage?.()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(store.getSnapshot().detail?.events.length, 0)
      store.subscribe(() => {})
      await until(() => store.getSnapshot().detail?.events.length === 1, 'the core history never resumed')
      store.release()
    }
  })

  test('a stalled cursor fails the walk instead of looping', async () => {
    let calls = 0
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        calls++
        return {
          rev: 1,
          live: true,
          part,
          rows: [request(1)],
          first: 0,
          last: 0,
          total: 1,
          atStart: false,
          atEnd: false,
          beforeSeq: 1,
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => calls >= 2, 'the stalled cursor was not followed')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail?.requests.length, 1)
    store.release()
  })

  test('a stalled refresh cursor keeps the loaded history', async () => {
    let rev = 1
    let calls = 0
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        calls++
        return {
          rev,
          live: true,
          part,
          rows: [part === 'requests' ? request(rev) : { seq: rev, time: T0, kind: 'inject' }],
          first: 0,
          last: 0,
          total: rev === 1 ? 1 : 100,
          atStart: rev === 1,
          atEnd: rev === 1,
          ...(rev === 1 ? {} : { beforeSeq: rev }),
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    const before = calls
    store.ensureHistory()
    await until(() => calls >= before + 2, 'the stalled refresh never ran')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail?.events.length, 1)
    store.release()
  })

  test('a null page retries automatically and then lands', async () => {
    const calls = new Map<string, number>()
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        const count = (calls.get(part) ?? 0) + 1
        calls.set(part, count)
        if (count === 1) return null
        return {
          rev: 1,
          live: true,
          part,
          rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject' }],
          first: 0,
          last: 0,
          total: 1,
          atStart: true,
          atEnd: true,
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the retry never landed', 500)
    assert.equal(store.getSnapshot().detail?.requests.length, 1)
    store.release()
  })

  test('a refresh restarts when the revision advances mid-flight', async () => {
    let rev = 1
    let blocked = false
    let releaseRefresh: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseRefresh = resolve })
    const page = (part: 'requests' | 'events', revision = rev): never => ({
      rev: revision,
      live: true,
      part,
      rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject', form: 'context' }],
      first: 0,
      last: 0,
      total: 1,
      atStart: true,
      atEnd: true,
    }) as never
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(rev)] } }),
      part: async () => null,
      history: async (part) => {
        if (rev === 2 && !blocked) {
          blocked = true
          await gate
          return page(part === 'requests' ? 'requests' : 'events', 2)
        }
        return page(part === 'requests' ? 'requests' : 'events')
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await until(() => blocked, 'the refresh never blocked')
    rev = 3
    store.request(3)
    await until(() => store.getSnapshot().detail?.rev === 3, 'the newer revision never landed')
    releaseRefresh?.()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the restarted refresh never landed')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail?.events.length, 1)
    store.release()
  })

  test('a part landing after full history cannot overwrite it', async () => {
    let releasePart: (() => void) | undefined
    const partGate = new Promise<void>(resolve => { releasePart = resolve })
    let partCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
      part: async (part) => {
        partCalls++
        await partGate
        return {
          rev: 1,
          live: true,
          parts: part === 'requests'
            ? { requests: [request(1)] }
            : { events: [{ seq: 1, time: T0, kind: 'inject', form: 'context' }] },
        }
      },
      history: async (part) => ({
        rev: 1,
        live: true,
        part,
        rows: part === 'requests'
          ? [request(1)]
          : [{ seq: 1, time: T0, kind: 'inject', form: 'context' }, { seq: 2, time: T0, kind: 'prune' }],
        first: 0,
        last: part === 'requests' ? 0 : 1,
        total: part === 'requests' ? 1 : 2,
        atStart: true,
        atEnd: true,
      }),
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensurePart('events')
    store.ensurePart('requests')
    await until(() => partCalls === 2, 'the part requests never started')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 2, 'the full history never landed')
    releasePart?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(store.getSnapshot().detail?.events.map(row => row.seq), [1, 2])
    store.release()
  })

  test('releasing during an initial page read cancels either part without a failure', async () => {
    for (const cancelPart of ['requests', 'events'] as const) {
      let releasePage: (() => void) | undefined
      const gate = new Promise<void>(resolve => { releasePage = resolve })
      let calls = 0
      const store = new DetailStore({
        core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
        part: async () => null,
        history: async (part) => {
          calls++
          if (part === cancelPart) {
            await gate
            return null
          }
          return { rev: 1, live: true, part, rows: [request(1)], first: 0, last: 0, total: 1, atStart: true, atEnd: true }
        },
      }, 0)
      store.subscribe(() => {})
      store.request(1)
      await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
      store.ensureHistory()
      await until(() => calls === (cancelPart === 'requests' ? 1 : 2), 'the cancelling page never started')
      store.release()
      releasePage?.()
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(store.getSnapshot().detail, null)
    }
  })

  test('a throwing refresh keeps the loaded history and retries', async () => {
    let rev = 1
    let failing = false
    let eventCalls = 0
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (part === 'events') eventCalls++
        if (failing && part === 'events') throw new Error('refresh failed')
        return {
          rev,
          live: true,
          part,
          rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject' }],
          first: 0,
          last: 0,
          total: 1,
          atStart: true,
          atEnd: true,
        }
      },
    }, 0)
    store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    failing = true
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail?.events.length, 1)
    assert.ok(eventCalls >= 2)
    store.release()
  })

  test('a failing refresh after release schedules nothing', async () => {
    let rev = 1
    let releaseRefresh: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseRefresh = resolve })
    const store = new DetailStore({
      core: async () => ({ rev, live: true, parts: { head: head(rev), series: [request(1)] } }),
      part: async () => null,
      history: async (part) => {
        if (rev === 2 && part === 'events') {
          await gate
          throw new Error('released refresh')
        }
        return {
          rev,
          live: true,
          part,
          rows: [part === 'requests' ? request(1) : { seq: 1, time: T0, kind: 'inject' }],
          first: 0,
          last: 0,
          total: 1,
          atStart: true,
          atEnd: true,
        }
      },
    }, 0)
    const off = store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail !== null, 'the core payload never landed')
    store.ensureHistory()
    await until(() => store.getSnapshot().detail?.events.length === 1, 'the full history never landed')
    rev = 2
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the next revision never landed')
    store.ensureHistory()
    await new Promise(resolve => setTimeout(resolve, 5))
    off()
    store.release()
    releaseRefresh?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.getSnapshot().detail, null)
  })

  test('stops automatic history retries after the limit', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const store = new DetailStore({
        core: async () => ({ rev: 1, live: true, parts: { head: head(1), series: [request(1)] } }),
        part: async () => null,
        history: async () => { calls++; return null },
      }, 0)
      store.subscribe(() => {})
      store.request(1)
      await vi.advanceTimersByTimeAsync(0)
      store.ensureHistory()
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(4_000)
      assert.equal(calls, 4)
      await vi.advanceTimersByTimeAsync(8_000)
      assert.equal(calls, 4)
      store.release()
    } finally {
      vi.useRealTimers()
    }
  })
})
