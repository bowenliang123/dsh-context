// The shape-driven readers (src/host/logShapes.ts): every supported log
// generation's spelling of the three seams the fold reconciles — the embedded
// assistant stream's first token, the replacement op's endpoints, and the raw
// chunk token test. Hostile shapes are pinned beside the happy paths: a
// malformed record must read as "nothing here", never throw (the projection
// registry drives the fold with no error boundary of its own).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { firstTokenTimeOfStream, isTokenChunk, replaceRangeOf } from '../../src/host/logShapes'

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
