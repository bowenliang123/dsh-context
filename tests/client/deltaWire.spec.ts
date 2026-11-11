import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { deltaOf, makeDeltaFetcher } from '../../src/client/timelineSource'

const ZERO = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    added: [],
    viewNodes: [],
    viewHeader: null,
    viewSystem: null,
    system: null,
    tools: [],
    header: null,
    counts: { ...ZERO },
    tokens: { ...ZERO },
    removedCounts: { ...ZERO },
    tokenUp: { ...ZERO },
    tokenDown: { ...ZERO },
    items: 0,
    total: 0,
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deltaOf', () => {
  test('parses a complete delta', () => {
    const value = deltaOf(payload())
    assert.ok(value !== null)
    assert.deepEqual(value.added, [])
    assert.equal(value.items, 0)
    assert.equal(value.total, 0)
  })

  test('rejects a non-object and every missing required member', () => {
    assert.equal(deltaOf(null), null)
    assert.equal(deltaOf('delta'), null)
    const required = Object.keys(payload())
    for (const key of required) {
      const body = payload()
      delete body[key]
      assert.equal(deltaOf(body), null, `missing ${key} rejects the delta`)
    }
  })

  test('an empty session id has no delta fetcher', () => {
    assert.equal(makeDeltaFetcher(''), undefined)
    assert.ok(makeDeltaFetcher('s1') !== undefined)
  })

  test('the fetcher posts the session and both boundaries and parses the reply', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value: payload() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    })
    const value = await makeDeltaFetcher('s1')?.(20, 10)
    assert.ok(value !== null && value !== undefined)
    assert.deepEqual(value.added, [])
    assert.equal(calls[0].url, 'api/dsh-context/delta')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { sessionId: 's1', seq: 20, baseSeq: 10 })
  })

  test('rejects malformed arrays, records, and nullable members', () => {
    for (const over of [
      { added: 'x' },
      { viewNodes: 'x' },
      { tools: 'x' },
      { viewHeader: 3 },
      { viewSystem: 3 },
      { system: 3 },
      { header: 3 },
      { counts: 'x' },
      { counts: {} },
      { tokens: { ...ZERO, assistant: 'x' } },
      { removedCounts: {} },
      { items: -1 },
      { total: -1 },
    ]) {
      assert.equal(deltaOf(payload(over)), null, `${JSON.stringify(over)} rejects the delta`)
    }
  })
})
