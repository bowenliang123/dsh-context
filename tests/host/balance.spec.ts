// The account-balance route (src/host/balance.ts): the nested-inject gating on
// the connection/credentials faces (load-order independent), the gate's live
// flip on unload, and the route's typed outcomes — the normalized wallet, the
// failure envelopes for a missing key, an upstream error and a malformed
// payload, and the boundary sanitizer that drops everything untrusted.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BALANCE_CREDENTIAL_REF, BALANCE_ROUTE, balanceOf, watchBalanceChannel } from '../../src/host/balance'

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  credentials?: unknown
}

interface Captured {
  path?: string
  methods?: readonly string[]
  fetch?: RouteFetch
}

/**
 * A minimal host ctx double with cordis inject semantics: the callback runs
 * once its dependency list completes, and its returned disposer is collected.
 * The connection face's register() is rewired so the route lands in `captured`.
 */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: Captured; disposers: (() => void)[] } {
  const captured: Captured = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('credentials' in spec) services.set('credentials', spec.credentials)
  const ctx = {
    get: (name: string) => services.get(name),
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { fetch?: { register?: unknown } }
    if (typeof conn.fetch?.register === 'function') {
      conn.fetch.register = (route: { path: string; methods: readonly string[]; fetch: RouteFetch }) => {
        captured.path = route.path
        captured.methods = route.methods
        captured.fetch = route.fetch
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

/** A connection face carrying the fetch registry. */
function connection(): object {
  return { fetch: { register: () => () => {} } }
}

/** A credentials face answering one ref with one key. */
function credentials(resolved: { value: string } | undefined): object {
  return { resolve: async () => resolved }
}

/** One upstream payload carrying `total` in `currency`. */
function upstream(total: string, currency = 'CNY'): object {
  return { is_available: true, balance_infos: [{ currency, total_balance: total }] }
}

/** Stub the upstream read with one JSON payload. */
function stubUpstream(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/** One GET against the captured route, parsed. */
async function call(captured: Captured): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${BALANCE_ROUTE}`, { method: 'GET' })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('watchBalanceChannel gating', () => {
  test('the gate stays closed without both faces', () => {
    assert.equal(watchBalanceChannel(ctxOf({}).ctx).live, false)
    assert.equal(watchBalanceChannel(ctxOf({ connection: connection() }).ctx).live, false)
    assert.equal(watchBalanceChannel(ctxOf({ credentials: credentials({ value: 'k' }) }).ctx).live, false)
  })

  test('a connection without the fetch registry stays inert', () => {
    const spec = ctxOf({ connection: { fetch: {} }, credentials: credentials({ value: 'k' }) })
    assert.equal(watchBalanceChannel(spec.ctx).live, false)
    assert.equal(spec.captured.path, undefined)
  })

  test('both faces arm the route and the gate flips off on unload', () => {
    const spec = ctxOf({ connection: connection(), credentials: credentials({ value: 'k' }) })
    const gate = watchBalanceChannel(spec.ctx)
    assert.equal(gate.live, true)
    assert.equal(spec.captured.path, BALANCE_ROUTE)
    assert.deepEqual(spec.captured.methods, ['GET'])
    for (const dispose of spec.disposers.splice(0)) dispose()
    assert.equal(gate.live, false)
  })
})

describe('the balance route', () => {
  test('serves the normalized wallet off the upstream payload', async () => {
    const spec = ctxOf({ connection: connection(), credentials: credentials({ value: 'sk-test' }) })
    watchBalanceChannel(spec.ctx)
    stubUpstream(upstream('12.34'))
    assert.deepEqual(await call(spec.captured), {
      ok: true,
      value: { currency: 'cny', amount: 12.34 },
    })
  })

  test('a missing credential answers the typed failure without touching upstream', async () => {
    const spec = ctxOf({ connection: connection(), credentials: credentials(undefined) })
    watchBalanceChannel(spec.ctx)
    let called = 0
    vi.stubGlobal('fetch', async () => {
      called++
      return new Response('{}')
    })
    const body = await call(spec.captured)
    assert.deepEqual(body, {
      ok: false,
      error: { code: 'dsh-context/no-credential', message: `no ${BALANCE_CREDENTIAL_REF} credential` },
    })
    assert.equal(called, 0)
  })

  test('an upstream error and a malformed payload are typed failures', async () => {
    const spec = ctxOf({ connection: connection(), credentials: credentials({ value: 'sk-test' }) })
    watchBalanceChannel(spec.ctx)
    stubUpstream({ error: 'nope' }, 401)
    assert.deepEqual((await call(spec.captured)).error, {
      code: 'dsh-context/upstream',
      message: 'balance endpoint HTTP 401',
    })
    stubUpstream({ balance_infos: [{}] })
    assert.deepEqual((await call(spec.captured)).error, {
      code: 'dsh-context/malformed',
      message: 'balance payload is malformed',
    })
  })

  test('a thrown read never escapes the transport', async () => {
    const spec = ctxOf({ connection: connection(), credentials: credentials({ value: 'sk-test' }) })
    watchBalanceChannel(spec.ctx)
    vi.stubGlobal('fetch', async () => { throw new Error('socket hang up') })
    assert.deepEqual((await call(spec.captured)).error, {
      code: 'dsh-context/read-failed',
      message: 'socket hang up',
    })
  })
})

describe('balanceOf', () => {
  test('reads the first entry amount and currency', () => {
    assert.deepEqual(balanceOf(upstream('0.00')), { currency: 'cny', amount: 0 })
    assert.deepEqual(balanceOf(upstream('3.5', 'USD')), { currency: 'usd', amount: 3.5 })
    assert.deepEqual(balanceOf({ balance_infos: [{ total_balance: 7 }] }), { currency: 'cny', amount: 7 })
  })

  test('an unknown currency reads as CNY', () => {
    assert.deepEqual(balanceOf(upstream('1.00', 'JPY')), { currency: 'cny', amount: 1 })
  })

  test('non-records, missing fields and untrustworthy amounts drop to undefined', () => {
    assert.equal(balanceOf(null), undefined)
    assert.equal(balanceOf('x'), undefined)
    assert.equal(balanceOf({}), undefined)
    assert.equal(balanceOf({ balance_infos: [] }), undefined)
    assert.equal(balanceOf({ balance_infos: [{}] }), undefined)
    assert.equal(balanceOf({ balance_infos: [{ total_balance: 'junk' }] }), undefined)
    assert.equal(balanceOf({ balance_infos: [{ total_balance: Number.NaN }] }), undefined)
    assert.equal(balanceOf({ balance_infos: [{ total_balance: -1 }] }), undefined)
  })
})