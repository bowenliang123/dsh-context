import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CatalogEntry, CatalogService } from '../../src/host/catalog'
import { VERSION_ROUTE, watchVersionChannel } from '../../src/host/versionRoute'

type RouteFetch = (request: Request) => Promise<Response>

interface Captured {
  path?: string
  methods?: readonly string[]
  requestBody?: string
  fetch?: RouteFetch
}

interface Mounted {
  ctx: Context
  route: Captured
  labels: string[]
}

function mountableCtx(options: { connection?: unknown; noConnection?: boolean; throwOnRegister?: boolean } = {}): Mounted {
  const route: Captured = {}
  const labels: string[] = []
  const connection = options.connection !== undefined
    ? options.connection
    : options.noConnection === true
      ? undefined
      : {
        fetch: {
          register: (next: Captured) => {
            if (options.throwOnRegister === true) throw new Error('no seam')
            Object.assign(route, next)
            return () => {}
          },
        },
      }
  const inner = {
    get: (name: string) => (name === 'connection' ? connection : undefined),
    effect: (fn: () => unknown, label?: string) => {
      if (label !== undefined) labels.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  const ctx = { inject: (_deps: string[], cb: (c: unknown) => unknown) => { cb(inner) } }
  return { ctx: ctx as unknown as Context, route, labels }
}

function serviceOf(entry: Partial<CatalogEntry<string>> = {}, current: string | null = '0.82.2'): CatalogService {
  const read: CatalogEntry<string> = { value: null, ready: false, failed: false, checkedAt: 0, ...entry }
  return {
    ensure: () => {},
    book: () => null,
    pricesVersion: () => 0,
    version: async () => read,
    prices: async () => ({ value: null, ready: false, failed: false, checkedAt: 0 }),
    currentVersion: () => current ?? undefined,
    dispose: () => {},
  }
}

describe('version route', () => {
  test('mounts the POST route with its label and answers ready/latest', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.84.0', ready: true, failed: false, checkedAt: 7 }))
    assert.equal(mounted.route.path, VERSION_ROUTE)
    assert.deepEqual(mounted.route.methods, ['POST'])
    assert.equal(mounted.route.requestBody, 'buffered')
    assert.deepEqual(mounted.labels, ['dsh-context: version route'], 'the route carries its effect label')
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      ok: true,
      value: { ready: true, failed: false, checkedAt: 7, current: '0.82.2', updateAvailable: true, latest: '0.84.0' },
    })
  })

  test('the host-side compare marks a same-version registry read as no update', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.82.2', ready: true, failed: false, checkedAt: 7 }))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.equal(body.value.updateAvailable, false)
  })

  test('answers without a latest version when the registry check is not ready', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: null, ready: false, failed: true, checkedAt: 5 }))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.deepEqual(body.value, { ready: false, failed: true, checkedAt: 5, current: '0.82.2', updateAvailable: null })
    assert.ok(!('latest' in body.value))
  })

  test('answers a null current version when the host cannot name itself', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.91.0', ready: true, failed: false, checkedAt: 3 }, null))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.equal(body.value.current, null)
    assert.equal(body.value.latest, '0.91.0')
    assert.equal(body.value.updateAvailable, null, 'no current version means no host-side compare')
  })

  test('isolates a throwing service behind the internal error reply', async () => {
    const mounted = mountableCtx()
    const thrown = {
      ...serviceOf(),
      version: () => Promise.reject(new Error('boom')),
    }
    watchVersionChannel(mounted.ctx, thrown)
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'gateway/internal', message: 'boom' },
    })
    const plain = mountableCtx()
    watchVersionChannel(plain.ctx, { ...serviceOf(), version: () => Promise.reject('plain failure') })
    const plainResponse = await plain.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const plainBody = await plainResponse.json() as { error: Record<string, unknown> }
    assert.equal(plainBody.error.message, 'plain failure')
  })

  test('stays inert without a connection or a working register seam', () => {
    const inert = [
      mountableCtx({ noConnection: true }),
      mountableCtx({ connection: {} }),
      mountableCtx({ connection: { fetch: {} } }),
      mountableCtx({ throwOnRegister: true }),
    ]
    for (const mounted of inert) {
      assert.doesNotThrow(() => watchVersionChannel(mounted.ctx, serviceOf()))
      assert.equal(mounted.route.path, undefined)
      assert.equal(mounted.route.fetch, undefined)
    }
    for (const mounted of inert.slice(0, 3)) assert.deepEqual(mounted.labels, [], 'no effect mounts without a seam')
  })
})
