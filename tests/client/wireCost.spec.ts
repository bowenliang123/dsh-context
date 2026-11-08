import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { timelineOf } from '../../src/client/services'

describe('timelineOf — host cost reads', () => {
  const base = {
    current: { system: 1, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 },
    requests: [],
    events: [],
    nodes: [],
    archive: [],
    droppedNodes: 0,
  }
  const rate = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }

  test('decodes a ready cost read with price faces, canonical ids and misses', () => {
    const out = timelineOf({
      ...base,
      costRead: {
        usd: 1.25,
        ready: true,
        faces: [
          { provider: 'deepseek', model: 'deepseek-v4-flash', rate, via: 'direct', confidence: 'high', canonical: 'deepseek/deepseek-v4-flash' },
          { provider: 'zhipuai', model: 'glm-5.3-flash', rate, via: 'family', confidence: 'medium', canonical: 7 },
          { provider: 7, model: 'bad', rate },
          'junk',
        ],
        misses: [
          { provider: 'mystery', model: 'unknown', reason: 'ambiguous', candidates: 2 },
          { provider: 'ghost', model: 'phantom', reason: 'model-unknown', candidates: -1 },
          { model: 'lonely' },
          { provider: 'bad', model: 'reason', reason: 4 },
        ],
      },
    })
    const read = out?.costRead
    assert.equal(read?.usd, 1.25)
    assert.equal(read?.ready, true)
    assert.equal(read?.faces?.length, 2)
    assert.deepEqual(read?.faces?.[0], {
      provider: 'deepseek', model: 'deepseek-v4-flash', rate, via: 'direct', confidence: 'high', canonical: 'deepseek/deepseek-v4-flash',
    })
    assert.equal(read?.faces?.[1].via, 'family')
    assert.equal(read?.faces?.[1].confidence, 'medium')
    assert.equal(read?.faces?.[1].canonical, undefined, 'a hostile canonical is dropped, the face survives')
    assert.deepEqual(read?.misses?.map(miss => [miss.provider, miss.reason]), [
      ['mystery', 'ambiguous'], ['ghost', 'model-unknown'],
    ], 'entries with a missing provider/model/reason drop')
    assert.equal(read?.misses?.[0].candidates, 2)
    assert.equal(read?.misses?.[1].candidates, undefined, 'a negative candidate count drops while the miss survives')
  })

  test('pending and empty cost reads keep the nullable shape', () => {
    const pending = timelineOf({ ...base, costRead: { usd: null, ready: false } })
    assert.deepEqual(pending?.costRead, { usd: null, ready: false })
    const empty = timelineOf({ ...base, costRead: { usd: null, ready: true, faces: [], misses: [] } })
    assert.deepEqual(empty?.costRead, { usd: null, ready: true })
  })

  test('hostile cost reads degrade to an absent field without dropping the timeline', () => {
    for (const hostile of [
      { usd: 'x', ready: true },
      { usd: 1, ready: 'yes' },
      { usd: 1, ready: true, faces: 'junk' },
      { usd: 1, ready: true, misses: {} },
      { usd: 1, ready: true, faces: [{ provider: 'p', model: 'm', rate: null }] },
      'junk',
      [1, 2],
    ]) {
      const out = timelineOf({ ...base, costRead: hostile })
      assert.equal(out?.current.total, 1, 'the surrounding timeline still decodes')
      if (out?.costRead !== undefined) {
        assert.equal(out.costRead.ready, true)
        assert.equal(out.costRead.faces, undefined, 'a bad face entry cannot survive')
      }
    }
    const nonFinite = timelineOf({ ...base, costRead: { usd: Number.POSITIVE_INFINITY, ready: true } })
    assert.equal(nonFinite?.costRead, undefined)
  })

  test('sanitizes hostile faces and misses, and the fast path only accepts complete shapes', () => {
    const hostileFaces = timelineOf({
      ...base,
      costRead: {
        usd: 1,
        ready: true,
        faces: [
          { provider: 'p', model: 'm', rate: { hit: 1, miss: 1, write: 1, out: 1 }, via: 'direct', confidence: 'nope' },
          null,
          7,
          { provider: 'p', model: 'm', rate: { hit: 'x', miss: 1, write: 1, out: 1 }, via: 'direct', confidence: 'high' },
        ],
        misses: [null, 7, { provider: 'p', model: 'm' }],
      },
    })
    assert.deepEqual(hostileFaces?.costRead, { usd: 1, ready: true })
    const fastMisses = timelineOf({
      ...base,
      costRead: { usd: 2, ready: true, misses: [{ provider: 'a', model: 'b', reason: 'ambiguous', candidates: 2 }] },
    })
    assert.deepEqual(fastMisses?.costRead?.misses, [{ provider: 'a', model: 'b', reason: 'ambiguous', candidates: 2 }])
    const safeMisses = timelineOf({
      ...base,
      costRead: { usd: 3, ready: true, misses: [{ provider: 'a', model: 'b', reason: 'ambiguous', candidates: -1 }] },
    })
    assert.deepEqual(safeMisses?.costRead?.misses, [{ provider: 'a', model: 'b', reason: 'ambiguous' }])
    const viaHostile = timelineOf({
      ...base,
      costRead: { usd: 5, ready: true, faces: [{ provider: 'p', model: 'm', rate, via: 7, confidence: 'high' }] },
    })
    assert.deepEqual(viaHostile?.costRead, { usd: 5, ready: true })
    const missHostile = timelineOf({
      ...base,
      costRead: { usd: 6, ready: true, misses: [null, { provider: 'p', model: 'm' }] },
    })
    assert.deepEqual(missHostile?.costRead, { usd: 6, ready: true })
    const fastBoth = timelineOf({
      ...base,
      costRead: {
        usd: 4,
        ready: true,
        faces: [{ provider: 'p', model: 'm', rate, via: 'direct', confidence: 'high' }],
        misses: [{ provider: 'a', model: 'b', reason: 'no-entry' }],
      },
    })
    assert.equal(fastBoth?.costRead?.faces?.length, 1)
    assert.equal(fastBoth?.costRead?.misses?.length, 1)
  })

  test('the fast path accepts a well-formed cost read and falls back for a malformed one', () => {
    const fast = timelineOf({
      ...base,
      costRead: { usd: 0.5, ready: true, faces: [{ provider: 'deepseek', model: 'deepseek-v4-flash', rate, via: 'direct', confidence: 'high' }] },
    })
    assert.equal(fast?.costRead?.usd, 0.5)
    const safe = timelineOf({ ...base, toolTally: 'junk', costRead: { usd: 0.5, ready: true } })
    assert.equal(safe?.costRead?.usd, 0.5)
  })
})
