import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { postRoute, postRouteEnvelope, postRouteQuietly, RouteError } from '../../src/client/route'

interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

interface Call {
  url: unknown
  init: FetchInit
}

function stubFetch(outcome: (call: Call) => unknown): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: unknown, init: FetchInit) => {
    const call = { url, init }
    calls.push(call)
    return outcome(call)
  })
  return calls
}

function envelope(value: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status === 200, status, json: async () => ({ ok: true, value }) }
}

const decodeNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postRoute', () => {
  test('POSTs the JSON body to the route and resolves the decoded value', async () => {
    const calls = stubFetch(() => envelope(7))
    const decoded = await postRoute('api/route', { sessionId: 's1' }, decodeNumber)
    assert.equal(decoded, 7)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'api/route')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' })
    assert.equal(calls[0].init.body, JSON.stringify({ sessionId: 's1' }))
    assert.equal('signal' in calls[0].init, false, 'no signal is attached unless asked')
  })

  test('forwards the abort signal', async () => {
    const calls = stubFetch(() => envelope(1))
    const controller = new AbortController()
    await postRoute('api/route', {}, decodeNumber, { signal: controller.signal })
    assert.equal(calls[0].init.signal, controller.signal)
  })

  test('an absent envelope value resolves null without decoding', async () => {
    let decoded = 0
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const result = await postRoute('api/route', {}, (value: unknown) => {
      decoded++
      return decodeNumber(value)
    })
    assert.equal(result, null)
    assert.equal(decoded, 0, 'the decoder never runs for an absent value')
  })

  test('a non-ok HTTP status throws a RouteError naming the route and status', async () => {
    stubFetch(() => envelope(null, 404))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), (error: unknown) => {
      assert.ok(error instanceof RouteError)
      assert.match(error.message, /route HTTP 404/)
      return true
    })
  })

  test('an unreadable or non-envelope body throws the read-failed error', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => 42 }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read failed/)
  })

  test('a decoder rejection throws the read-malformed error', async () => {
    stubFetch(() => envelope('not-a-number'))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /read malformed/)
  })

  test('a transport rejection propagates untouched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /offline/)
  })

  test('the label option names the failing read; the route stands in when absent', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: true, value: 1 }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail route HTTP 500/)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail read failed/)
    stubFetch(() => envelope('junk'))
    await assert.rejects(postRoute('api/route', {}, decodeNumber, { label: 'detail' }), /dsh-context: detail read malformed/)
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await assert.rejects(postRoute('api/route', {}, decodeNumber), /dsh-context: api\/route route HTTP 500/)
  })
})

describe('postRouteQuietly', () => {
  test('resolves the decoded value on success and null on absence', async () => {
    stubFetch(() => envelope(3))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), 3)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
  })

  test('degrades every defect, transport failure included, to null', async () => {
    stubFetch(() => envelope(null, 500))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    stubFetch(() => envelope('junk'))
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber), null)
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    assert.equal(await postRouteQuietly('api/route', {}, decodeNumber, { label: 'quiet' }), null)
  })
})

describe('postRouteEnvelope', () => {
  test('carries the revision and the decoded value of a changed reply', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: 4, revision: 'rev-1' }) }))
    const read = await postRouteEnvelope('api/route', { revision: null }, decodeNumber)
    assert.deepEqual(read, { value: 4, unchanged: false, revision: 'rev-1' })
  })

  test('an unchanged reply skips decoding and still reports the revision', async () => {
    let decoded = 0
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { stale: true }, revision: 'rev-2', unchanged: true }) }))
    const read = await postRouteEnvelope('api/route', {}, (value: unknown) => {
      decoded++
      return decodeNumber(value)
    })
    assert.deepEqual(read, { value: null, unchanged: true, revision: 'rev-2' })
    assert.equal(decoded, 0)
  })

  test('an unchanged reply without a revision and a value-less reply with one keep both shapes', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {}, unchanged: true }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: true })
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null, revision: 'rev-3' }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: false, revision: 'rev-3' })
  })

  test('an absent value or a hostile revision degrades to null and no revision', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null, revision: 7 }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: null, unchanged: false })
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true, value: 4, revision: '' }) }))
    assert.deepEqual(await postRouteEnvelope('api/route', {}, decodeNumber), { value: 4, unchanged: false })
  })

  test('a malformed decoded payload throws and transport defects reject', async () => {
    stubFetch(() => envelope('junk'))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber, { label: 'overview' }), /dsh-context: overview read malformed/)
    stubFetch(() => envelope(null, 502))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber), /route HTTP 502/)
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await assert.rejects(postRouteEnvelope('api/route', {}, decodeNumber), RouteError)
  })
})
