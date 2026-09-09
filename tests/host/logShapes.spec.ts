// The shape-driven readers (src/host/logShapes.ts): every supported log
// generation's spelling of the three seams the fold reconciles — the embedded
// assistant stream's first token, the replacement op's endpoints, and the raw
// chunk token test. Hostile shapes are pinned beside the happy paths: a
// malformed record must read as "nothing here", never throw (the projection
// registry drives the fold with no error boundary of its own).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { decodeKindOfBlock, decodeSpansOfStream, firstTokenTimeOfStream, isTokenChunk, replaceRangeOf } from '../../src/host/logShapes'

describe('decodeKindOfBlock', () => {
  test('maps the three block kinds the harness emits', () => {
    assert.equal(decodeKindOfBlock('reasoning'), 'reasoning')
    assert.equal(decodeKindOfBlock('text'), 'text')
    assert.equal(decodeKindOfBlock('tool-call'), 'toolarg')
  })

  test('an unknown or hostile marker stays unattributed', () => {
    for (const value of [undefined, null, '', 'image', 7, {}]) {
      assert.equal(decodeKindOfBlock(value), undefined, JSON.stringify(value))
    }
  })
})

describe('decodeSpansOfStream', () => {
  const chunk = (time: number, blockType: string) => ({ type: 'chunk', time, chunk: { type: 'block-start', blockType } })

  test('tiles [first marker, endTime] by block, in marker order', () => {
    // reasoning 1000→1300, text 1300→1500, tool args 1500→2000 (endTime).
    assert.deepEqual(decodeSpansOfStream([
      chunk(1000, 'reasoning'),
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [], texts: ['think'] },
      chunk(1300, 'text'),
      { type: 'text-chunks', time0: 1310, index: 1, dt: [], texts: ['answer'] },
      chunk(1500, 'tool-call'),
      { type: 'tool-call-chunks', time0: 1510, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ], 2000), { reasoning: 300, text: 200, toolarg: 500 })
  })

  test('a later block closes the previous one even when its own kind is unknown', () => {
    // The unknown marker still ends the reasoning span; its own interval is lost.
    assert.deepEqual(decodeSpansOfStream([chunk(1000, 'reasoning'), chunk(1400, 'image')], 1900), {
      reasoning: 400, text: 0, toolarg: 0,
    })
  })

  test('a single block owns the whole tail to endTime', () => {
    assert.deepEqual(decodeSpansOfStream([chunk(500, 'text')], 900), { reasoning: 0, text: 400, toolarg: 0 })
  })

  test('malformed records, non-finite times, and hostile containers degrade to zero', () => {
    assert.deepEqual(decodeSpansOfStream(undefined, 100), { reasoning: 0, text: 0, toolarg: 0 })
    assert.deepEqual(decodeSpansOfStream('stream', 100), { reasoning: 0, text: 0, toolarg: 0 })
    assert.deepEqual(decodeSpansOfStream([], 100), { reasoning: 0, text: 0, toolarg: 0 })
    assert.deepEqual(decodeSpansOfStream([chunk(500, 'text')], Number.NaN), { reasoning: 0, text: 0, toolarg: 0 })
    assert.deepEqual(decodeSpansOfStream([
      null, 7, 'x',
      { type: 'chunk' },
      { type: 'chunk', time: 1, chunk: null },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    ], 100), { reasoning: 0, text: 0, toolarg: 0 })
  })

  test('a backwards marker clamps to a zero span instead of a negative one', () => {
    // The text block's interval is negative → 0; the reasoning block is last,
    // so it owns the tail to endTime.
    assert.deepEqual(decodeSpansOfStream([chunk(1000, 'text'), chunk(900, 'reasoning')], 950), {
      reasoning: 50, text: 0, toolarg: 0,
    })
  })
})

describe('isTokenChunk', () => {
  test('accepts the three delta kinds the harness counts', () => {
    assert.equal(isTokenChunk({ type: 'text-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'reasoning-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', name: 'bash', argumentsDelta: '' }), true)
  })

  test('rejects empty deltas, non-delta chunks, and hostile shapes', () => {
    assert.equal(isTokenChunk({ type: 'text-delta', text: '' }), false)
    assert.equal(isTokenChunk({ type: 'text-delta' }), false)
    assert.equal(isTokenChunk({ type: 'reasoning-delta', text: 42 }), false)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: '', name: undefined }), false)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: 7 }), false)
    assert.equal(isTokenChunk({ type: 'block-start' }), false)
    assert.equal(isTokenChunk({}), false)
    assert.equal(isTokenChunk(null), false)
    assert.equal(isTokenChunk('text-delta'), false)
  })
})

describe('firstTokenTimeOfStream', () => {
  test('reads a raw chunk record', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 250, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'chunk', time: 300, chunk: { type: 'text-delta', text: 'there' } },
    ]), 250)
  })

  test('reads a packed text run, accumulating the inter-member gaps', () => {
    // time0 anchors member 0; dt[k] is the gap BEFORE member k+1.
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['a', 'b', 'c'] },
    ]), 1000)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['', 'b', 'c'] },
    ]), 1010, 'a leading empty fragment defers the stamp to the next member')
  })

  test('reads a reasoning run and a name-bearing tool-call run', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'reasoning-chunks', time0: 500, index: 0, dt: [5], texts: ['think', 'ing'] },
    ]), 500)
    assert.equal(firstTokenTimeOfStream([
      { type: 'tool-call-chunks', time0: 700, index: 1, dt: [0], id: 'c1', name: 'bash', args: ['{}', '{}'] },
    ]), 700, 'a name-bearing tool run starts at its first member')
    assert.equal(firstTokenTimeOfStream([
      { type: 'tool-call-chunks', time0: 700, index: 1, dt: [3], id: 'c1', args: ['', '{"a":1}'] },
    ]), 703, 'a nameless tool run defers to the first non-empty arguments fragment')
  })

  test('a packed run whose first member is empty and whose gaps are hostile reads as no token', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1, index: 0, dt: [Number.NaN], texts: ['', 'b'] },
    ]), undefined)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: Number.POSITIVE_INFINITY, index: 0, dt: [], texts: ['a'] },
    ]), undefined)
  })

  test('malformed records and containers degrade to undefined', () => {
    assert.equal(firstTokenTimeOfStream(undefined), undefined)
    assert.equal(firstTokenTimeOfStream('stream'), undefined)
    assert.equal(firstTokenTimeOfStream([]), undefined)
    assert.equal(firstTokenTimeOfStream([null, 7, { type: 'chunk', time: 'x', chunk: { type: 'text-delta', text: 'a' } }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 1, index: 0, texts: 'not-an-array' }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [7] }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'chunk', time: 5, chunk: { type: 'finish' } }]), undefined)
  })

  test('a run with a missing dt array still stamps its first member', () => {
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 9, index: 0, texts: ['a'] }]), 9)
  })
})

describe('replaceRangeOf', () => {
  test('reads both endpoint spellings', () => {
    assert.deepEqual(replaceRangeOf({ op: 'replace', startSeq: 3, endSeq: 7 }), { start: 3, end: 7 })
    assert.deepEqual(replaceRangeOf({ op: 'replace', start: 3, end: 7 }), { start: 3, end: 7 })
    assert.deepEqual(replaceRangeOf({ op: 'replace', startSeq: 3, end: 7 }), { start: 3, end: 7 }, 'a mixed op prefers the V3 spelling')
    assert.deepEqual(replaceRangeOf({ op: 'replace', start: 3, endSeq: 7 }), { start: 3, end: 7 }, 'a mixed op falls back per endpoint')
  })

  test('append, unknown, and malformed ops read as no replacement', () => {
    assert.equal(replaceRangeOf('append'), null)
    assert.equal(replaceRangeOf(null), null)
    assert.equal(replaceRangeOf(undefined), null)
    assert.equal(replaceRangeOf({ op: 'insert', startSeq: 1, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: 1 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: Number.NaN, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: '1', endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', endSeq: 2 }), null)
  })
})
