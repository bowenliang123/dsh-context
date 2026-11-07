import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { describe, test, vi } from 'vitest'
import { PRICING_SNAPSHOT_ROUTE, watchPricingSnapshotRoute } from '../../src/host/pricingSnapshotRoute'
import type { PricingSnapshot } from '../../src/host/pricingSnapshotRoute'

type Handler = (request: Request) => Promise<Response>

function storage() {
  const records = new Map<string, unknown>()
  const state = { failOpen: false, failRead: false, failWrite: false, closes: 0, updates: 0, puts: 0 }
  let chain: Promise<unknown> = Promise.resolve()
  const table = {
    get(key: string) {
      if (state.failRead) throw new Error('read failed')
      return records.get(key)
    },
    async put(key: string, value: unknown) {
      state.puts++
      records.set(key, structuredClone(value))
    },
    update(key: string, change: (current: unknown) => unknown) {
      const next = chain.then(() => {
        state.updates++
        if (state.failWrite) throw new Error('write failed')
        assert.ok(records.has(key))
        const value = change(records.get(key))
        records.set(key, structuredClone(value))
        return value
      })
      chain = next.catch(() => {})
      return next
    },
  }
  let opened = false
  const domain = {
    table(name: string) { assert.equal(name, 'snapshots'); return table },
    async close() { state.closes++; opened = false },
  }
  const facility = {
    get(name: string) { assert.equal(name, 'dsh_context_pricing'); return opened ? domain : undefined },
    async open(spec: { name: string; version: number; layout: string; tables: { snapshots: { valueSchema: { parse(value: unknown): unknown } } } }) {
      assert.equal(spec.name, 'dsh_context_pricing')
      assert.equal(spec.version, 1)
      assert.equal(spec.layout, 'per-record')
      if (state.failOpen) throw new Error('open failed')
      opened = true
      for (const [key, value] of records) records.set(key, spec.tables.snapshots.valueSchema.parse(value))
      return domain
    },
  }
  return { records, state, table, facility }
}

function boot(facility: unknown, connection: unknown = true) {
  const routes = new Map<string, Handler>()
  const cleanups: (() => unknown)[] = []
  const face = connection === true ? {
    fetch: {
      register(route: { path: string; methods: string[]; requestBody: string; fetch: Handler }) {
        assert.deepEqual(route.methods, ['POST'])
        assert.equal(route.requestBody, 'buffered')
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      },
    },
  } : connection
  const context = {
    inject(names: string[], callback: (ctx: unknown) => unknown) {
      assert.deepEqual(names, ['connection'])
      callback(context)
      return { dispose: () => { for (const cleanup of cleanups.splice(0).reverse()) void cleanup() } }
    },
    get(name: string) { return name === 'connection' ? face : facility },
    effect(effect: () => () => unknown) { cleanups.push(effect()) },
  }
  const stop = watchPricingSnapshotRoute(context as unknown as Context)
  return {
    routes,
    stop,
    async dispose() { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() },
    async call(body: unknown, raw = false) {
      const handler = routes.get(PRICING_SNAPSHOT_ROUTE)
      assert.ok(handler)
      const response = await handler(new Request(`http://dsh.test${PRICING_SNAPSHOT_ROUTE}`, {
        method: 'POST', body: raw ? body as string : JSON.stringify(body),
      }))
      const result = await response.json() as { ok: boolean; value?: PricingSnapshot; error?: { code: string } }
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { status: response.status, ...result }
    },
  }
}

function snapshot(revision = 'one', entries: [string, number | null][] = [['a', 1]], at = 1): PricingSnapshot {
  return { version: 1, revision, book: { at, data: { provider: { model: { cost: 1 } } } }, entries }
}

describe('pricing snapshot persistence', () => {
  test('hydrates after restart, atomically merges concurrent writes, and disposes its route and domain', async () => {
    const store = storage()
    const first = boot(store.facility)
    assert.deepEqual((await first.call({})).value, { version: 1, revision: '', entries: [] })
    await first.call({ write: snapshot() })
    await Promise.all([
      first.call({ write: snapshot('one', [['b', 2]]) }),
      first.call({ write: snapshot('one', [['c', null]]) }),
    ])
    assert.equal(store.state.puts, 1)
    assert.equal(store.state.updates, 3)
    await first.dispose()
    assert.equal(first.routes.size, 0)
    assert.equal(store.state.closes, 1)
    const second = boot(store.facility)
    assert.deepEqual((await second.call({})).value?.entries, [['a', 1], ['b', 2], ['c', null]])
    second.stop()
    await Promise.resolve()
    assert.equal(second.routes.size, 0)
  })

  test('invalidates a changed revision only with a newer book and preserves a newer book for equal revisions', async () => {
    const route = boot(storage().facility)
    await route.call({ write: snapshot('one', [['a', 1]], 10) })
    const old = await route.call({ write: snapshot('old', [['old', 2]], 9) })
    assert.equal(old.value?.revision, 'one')
    const absent = await route.call({ write: { version: 1, revision: 'no-book', entries: [['none', 1]] } })
    assert.equal(absent.value?.revision, 'one')
    const same = await route.call({ write: snapshot('one', [['b', 2]], 2) })
    assert.equal(same.value?.book?.at, 10)
    assert.deepEqual(same.value?.entries, [['a', 1], ['b', 2]])
    const changed = await route.call({ write: snapshot('two', [['new', 3]], 10) })
    assert.equal(changed.value?.revision, 'two')
    assert.deepEqual(changed.value?.entries, [['new', 3]])
    await route.dispose()
  })

  test('drops corrupted stored values, ignores extra fields, and never mutates stored objects on a read', async () => {
    const store = storage()
    store.records.set('current', { version: 100, entries: [] })
    const route = boot(store.facility)
    assert.deepEqual((await route.call({})).value, { version: 1, revision: '', entries: [] })
    const value = snapshot()
    const response = await route.call({ write: { ...value, injected: 1, book: { ...value.book, injected: 2 } }, injected: 3 })
    assert.deepEqual(response.value, value)
    const stored = store.records.get('current')
    await route.call({})
    assert.equal(store.records.get('current'), stored)
    await route.dispose()
  })

  test('bounds retained entries by last write order and total UTF16 key length', async () => {
    const route = boot(storage().facility)
    const entries: [string, number][] = Array.from({ length: 20_001 }, (_, i) => [`k${i}`, i])
    const count = await route.call({ write: snapshot('one', [...entries, ['k1', 7]]) })
    assert.equal(count.value?.entries.length, 20_000)
    assert.deepEqual(count.value?.entries.at(-1), ['k1', 7])
    assert.equal(count.value?.entries[0][0], 'k2')
    const large: [string, number][] = Array.from({ length: 201 }, (_, i) => [String(i).padStart(20_000, 'x'), i])
    const chars = await route.call({ write: snapshot('two', large, 2) })
    assert.equal(chars.value?.entries.length, 200)
    assert.deepEqual(chars.value?.entries[0], large[1])
    await route.dispose()
  })

  test('bounds persisted merges as well as incoming entries and preserves the most recent value', async () => {
    const store = storage()
    const route = boot(store.facility)
    const first: [string, number][] = Array.from({ length: 10_001 }, (_, i) => [`a${i}`, i])
    const second: [string, number][] = Array.from({ length: 10_001 }, (_, i) => [`b${i}`, i])
    await route.call({ write: snapshot('one', first) })
    const merged = await route.call({ write: snapshot('one', [...second, ['a2', 9]]) })
    assert.equal(merged.value?.entries.length, 20_000)
    assert.deepEqual(merged.value?.entries[0], ['a3', 3])
    assert.deepEqual(merged.value?.entries.at(-1), ['a2', 9])
    assert.deepEqual(store.records.get('current'), merged.value)
    const large: [string, number][] = Array.from({ length: 200 }, (_, i) => [String(i).padStart(20_000, 'x'), i])
    await route.call({ write: snapshot('two', large, 2) })
    const bounded = await route.call({ write: snapshot('two', [['last', null]], 2) })
    assert.equal(bounded.value?.entries.length, 200)
    assert.deepEqual(bounded.value?.entries[0], large[1])
    assert.deepEqual(bounded.value?.entries.at(-1), ['last', null])
    assert.deepEqual(store.records.get('current'), bounded.value)
    await route.dispose()
  })

  test('accepts catalogs and revisions up to the two-million-character limit', async () => {
    const route = boot(storage().facility)
    const value = snapshot('r'.repeat(2_000_000))
    value.book = { at: 1, data: 'x'.repeat(1_999_998) }
    const response = await route.call({ write: value })
    assert.equal(response.status, 200)
    assert.equal(response.value?.revision, value.revision)
    assert.equal(response.value?.book?.data, value.book.data)
    await route.dispose()
  })

  test('rejects invalid JSON, protocol fields, invalid entries and oversized bodies without modifying the snapshot', async () => {
    const route = boot(storage().facility)
    const invalid = [
      null, [], 1, { write: null }, { write: {} },
      { write: { ...snapshot(), version: 2 } },
      { write: { ...snapshot(), revision: 2 } },
      { write: { ...snapshot(), revision: 'x'.repeat(2_000_001) } },
      { write: { ...snapshot(), entries: {} } },
      ...[null, ['a'], [1, 1], ['a', -1], ['a', '1'], ['x'.repeat(20_001), 1]].map(entry => ({ write: { ...snapshot(), entries: [entry] } })),
      ...[null, {}, { at: -1, data: {} }, { at: '1', data: {} }, { at: 0 }, { at: 0, data: 'x'.repeat(2_000_000) }].map(book => ({ write: { ...snapshot(), book } })),
    ]
    for (const body of invalid) assert.equal((await route.call(body)).status, 400)
    assert.equal((await route.call('not-json', true)).status, 400)
    assert.equal((await route.call('{"write":{"version":1,"revision":"one","entries":[["a",1e400]]}}', true)).status, 400)
    assert.equal((await route.call('{"write":{"version":1,"revision":"one","entries":[],"book":{"at":1e400,"data":{}}}}', true)).status, 400)
    assert.equal((await route.call(JSON.stringify({ padding: 'x'.repeat(12 * 1024 * 1024) }), true)).status, 400)
    assert.equal((await route.call(JSON.stringify({ padding: '界'.repeat(4_200_000) }), true)).status, 400)
    assert.deepEqual((await route.call({})).value?.entries, [])
    await route.dispose()
  })

  test('degrades to bounded memory on unsupported or failing persistence and does not close a borrowed domain', async () => {
    for (const facility of [
      undefined, null, {}, { get: () => null, open: async () => null },
      { get: () => ({}), open: async () => null },
      ...[null, {}, { get() {} }, { get() {}, put() {} }].map(table => ({ get: () => ({ table: () => table }), open: async () => null })),
      { get: () => null, open: async () => ({ table: () => storage().table }) },
    ]) {
      const route = boot(facility)
      assert.equal((await route.call({ write: snapshot() })).ok, true)
      assert.deepEqual((await route.call({})).value?.entries, [['a', 1]])
      await route.dispose()
    }
    const store = storage()
    store.state.failOpen = true
    const failed = boot(store.facility)
    await failed.call({ write: snapshot() })
    assert.deepEqual((await failed.call({})).value?.entries, [['a', 1]])
    await failed.dispose()
    store.state.failOpen = false
    const owner = boot(store.facility)
    await owner.call({ write: snapshot() })
    const borrower = boot(store.facility)
    await borrower.call({})
    await borrower.dispose()
    assert.equal(store.state.closes, 0)
    store.state.failWrite = true
    assert.deepEqual((await owner.call({ write: snapshot('one', [['b', 2]]) })).value?.entries, [['a', 1], ['b', 2]])
    assert.deepEqual((await owner.call({})).value?.entries, [['a', 1], ['b', 2]])
    store.state.failRead = true
    assert.deepEqual((await owner.call({})).value?.entries, [['a', 1], ['b', 2]])
    await owner.dispose()
  })

  test('discards unserializable durable books and survives corruption after opening the domain', async () => {
    const store = storage()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const route = boot(store.facility)
    await route.call({})
    store.records.set('current', { ...snapshot(), book: { at: 0, data: circular } })
    assert.deepEqual((await route.call({})).value, { version: 1, revision: '', entries: [] })
    assert.equal((await route.call({ write: snapshot() })).value?.revision, 'one')
    store.records.set('current', { ...snapshot(), book: { at: 0, data: undefined } })
    assert.deepEqual((await route.call({})).value?.entries, [])
    await route.dispose()
  })

  test('merges the initial unpriced revision and tolerates an unsupported update result', async () => {
    const store = storage()
    const route = boot(store.facility)
    const unpriced = { version: 1, revision: '', entries: [['a', null]] }
    assert.deepEqual((await route.call({ write: unpriced })).value, unpriced)
    assert.equal((await route.call({ write: snapshot('', [['b', 1]]) })).value?.book?.at, 1)
    store.table.update = async () => undefined
    assert.deepEqual((await route.call({ write: snapshot('', [['c', 2]]) })).value?.entries, [['a', null], ['b', 1]])
    await route.dispose()
  })

  test('drains accepted requests before closing the durable domain during disposal', async () => {
    const store = storage()
    const route = boot(store.facility)
    let release: (body: string) => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = (value) => { controller.enqueue(new TextEncoder().encode(value)); controller.close() }
      },
    })
    const request = new Request('http://dsh.test/', { method: 'POST', body, duplex: 'half' } as RequestInit)
    const handler = route.routes.get(PRICING_SNAPSHOT_ROUTE)
    assert.ok(handler)
    const response = handler(request)
    const disposing = route.dispose()
    await Promise.resolve()
    assert.equal(store.state.closes, 0)
    assert.equal(route.routes.size, 0)
    release(JSON.stringify({ write: snapshot() }))
    assert.equal((await response).status, 200)
    await disposing
    assert.equal(store.state.closes, 1)
    const next = boot(store.facility)
    assert.deepEqual((await next.call({})).value?.entries, [['a', 1]])
    await next.dispose()
  })

  test('rejects absent and broken bodies, preserves split UTF8 characters, and cancels oversized streams', async () => {
    const route = boot(undefined)
    const handler = route.routes.get(PRICING_SNAPSHOT_ROUTE)
    assert.ok(handler)
    assert.equal((await handler(new Request('http://dsh.test/', { method: 'POST' }))).status, 400)
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('body failed')) } })
    assert.equal((await handler(new Request('http://dsh.test/', { method: 'POST', body: broken, duplex: 'half' } as RequestInit))).status, 400)
    const encoded = new TextEncoder().encode(JSON.stringify({ write: snapshot('one', [['界', 2]]) }))
    const split = encoded.indexOf(0xe7) + 1
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split))
        controller.enqueue(encoded.slice(split))
        controller.close()
      },
    })
    const response = await handler(new Request('http://dsh.test/', { method: 'POST', body: chunks, duplex: 'half' } as RequestInit))
    assert.deepEqual((await response.json() as { value: PricingSnapshot }).value.entries, [['界', 2]])
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)) },
      cancel() { cancelled = true },
    })
    assert.equal((await handler(new Request('http://dsh.test/', { method: 'POST', body: oversized, duplex: 'half' } as RequestInit))).status, 400)
    assert.equal(cancelled, true)
    assert.deepEqual((await route.call({})).value?.entries, [['界', 2]])
    await route.dispose()
  })

  test('waits for pending storage initialization before closing a newly owned domain', async () => {
    const store = storage()
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => { release = resolve })
    const facility = {
      get: store.facility.get,
      async open(spec: Parameters<typeof store.facility.open>[0]) {
        await opened
        return store.facility.open(spec)
      },
    }
    const route = boot(facility)
    const request = route.call({ write: snapshot() })
    const disposing = route.dispose()
    assert.equal(route.routes.size, 0)
    assert.equal(store.state.closes, 0)
    release()
    assert.equal((await request).ok, true)
    await disposing
    assert.equal(store.state.closes, 1)
    assert.deepEqual(store.records.get('current'), snapshot())
  })

  test('bounds requests during stalled initialization and skips an aborted active request before writing', async () => {
    const store = storage()
    let release: () => void = () => {}
    const opened = new Promise<void>((resolve) => { release = resolve })
    const route = boot({
      get: store.facility.get,
      async open(spec: Parameters<typeof store.facility.open>[0]) {
        await opened
        return store.facility.open(spec)
      },
    })
    const handler = route.routes.get(PRICING_SNAPSHOT_ROUTE)
    assert.ok(handler)
    const controller = new AbortController()
    const request = new Request('http://dsh.test/', { method: 'POST', body: JSON.stringify({ write: snapshot('aborted') }), signal: controller.signal })
    const first = handler(request)
    const queued = Array.from({ length: 3 }, (_, i) => route.call({ write: snapshot('one', [[String(i), i]]) }))
    await vi.waitFor(() => assert.equal(request.bodyUsed, true))
    controller.abort()
    for (let i = 0; i < 8; i++) {
      assert.deepEqual(await route.call({ write: snapshot('overflow') }), { status: 503, ok: false, error: { code: 'dsh-context/busy', message: 'pricing snapshot request queue full' } })
    }
    const disposing = route.dispose()
    assert.equal(store.state.closes, 0)
    release()
    const cancelled = await first
    assert.equal(cancelled.status, 499)
    assert.equal(cancelled.headers.get('cache-control'), 'no-store')
    assert.equal((await cancelled.json() as { error: { code: string } }).error.code, 'dsh-context/aborted')
    assert.ok((await Promise.all(queued)).every(response => response.status === 200))
    await disposing
    assert.equal(store.state.updates, 3)
    assert.equal(store.state.closes, 1)
    assert.deepEqual((store.records.get('current') as PricingSnapshot).entries, [['0', 0], ['1', 1], ['2', 2]])
  })

  test('bounds requests behind a stalled update and never parses or writes an aborted queued request', async () => {
    const store = storage()
    const update = store.table.update
    let release: () => void = () => {}
    let started: () => void = () => {}
    const stalled = new Promise<void>((resolve) => { release = resolve })
    const updating = new Promise<void>((resolve) => { started = resolve })
    store.table.update = async (key, change) => {
      started()
      await stalled
      return update(key, change)
    }
    const route = boot(store.facility)
    const first = route.call({ write: snapshot() })
    await updating
    const controller = new AbortController()
    const request = new Request('http://dsh.test/', { method: 'POST', body: JSON.stringify({ write: snapshot('one', [['aborted', 2]]) }), signal: controller.signal })
    const handler = route.routes.get(PRICING_SNAPSHOT_ROUTE)
    assert.ok(handler)
    const cancelled = handler(request)
    const queued = [route.call({ write: snapshot('one', [['b', 2]]) }), route.call({ write: snapshot('one', [['c', 3]]) })]
    controller.abort()
    assert.equal((await route.call({})).status, 503)
    release()
    assert.equal((await first).status, 200)
    assert.equal((await cancelled).status, 499)
    assert.equal(request.bodyUsed, false)
    assert.ok((await Promise.all(queued)).every(response => response.status === 200))
    assert.equal(store.state.updates, 3)
    assert.deepEqual((await route.call({})).value?.entries, [['a', 1], ['b', 2], ['c', 3]])
    await route.dispose()
  })

  test('releases admission slots after successful responses and unexpected failures', async () => {
    const route = boot(undefined)
    for (let i = 0; i < 8; i++) assert.equal((await route.call({})).status, 200)
    const json = vi.spyOn(Response, 'json')
    try {
      for (let i = 0; i < 8; i++) {
        json.mockImplementationOnce(() => { throw new Error('response failed') })
        await assert.rejects(route.call({}), /response failed/)
      }
    } finally {
      json.mockRestore()
    }
    assert.deepEqual((await route.call({ write: snapshot() })).value, snapshot())
    await route.dispose()
  })

  test('unsupported route registrars and registration failures dispose cleanly', async () => {
    for (const connection of [{}, { fetch: { register: () => { throw new Error('no route') } } }]) {
      const route = boot(storage().facility, connection)
      assert.equal(route.routes.size, 0)
      await route.dispose()
    }
    const inert = watchPricingSnapshotRoute({ inject: () => undefined } as unknown as Context)
    inert()
  })
})
