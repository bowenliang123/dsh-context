// The shape-driven readers (src/host/logShapes.ts): the log spellings the
// fold reconciles — the embedded assistant stream's first token, the
// replacement op's endpoints, and the raw chunk token test. Hostile shapes
// are pinned beside the happy paths: a malformed record must read as
// "nothing here", never throw (the projection registry drives the fold with
// no error boundary of its own).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { decodeKindOfBlock, decodeSpansOfStream, decodeTallyOfStream, firstTokenTimeOfStream, isTokenChunk, replaceRangeOf, usageOfSettlement } from '../../src/host/logShapes'

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

describe('decodeTallyOfStream', () => {
  const chunk = (time: number, blockType: string) => ({ type: 'chunk', time, chunk: { type: 'block-start', blockType } })
  const tally = { reasoning: 0, text: 0, toolarg: 0 }

  test('tiles [first marker, endTime] by block, in marker order, counting each marker', () => {
    // reasoning 1000→1300, text 1300→1500, tool args 1500→2000 (endTime).
    assert.deepEqual(decodeTallyOfStream([
      chunk(1000, 'reasoning'),
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [], texts: ['think'] },
      chunk(1300, 'text'),
      { type: 'text-chunks', time0: 1310, index: 1, dt: [], texts: ['answer'] },
      chunk(1500, 'tool-call'),
      { type: 'tool-call-chunks', time0: 1510, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ], 2000), {
      spans: { reasoning: 300, text: 200, toolarg: 500 },
      blocks: { reasoning: 1, text: 1, toolarg: 1 },
    })
  })

  test('a later block closes the previous one even when its own kind is unknown', () => {
    // The unknown marker still ends the reasoning span; its own interval is
    // lost and it counts nothing.
    assert.deepEqual(decodeTallyOfStream([chunk(1000, 'reasoning'), chunk(1400, 'image')], 1900), {
      spans: { reasoning: 400, text: 0, toolarg: 0 },
      blocks: { reasoning: 1, text: 0, toolarg: 0 },
    })
  })

  test('a single block owns the whole tail to endTime', () => {
    assert.deepEqual(decodeTallyOfStream([chunk(500, 'text')], 900), {
      spans: { ...tally, text: 400 },
      blocks: { ...tally, text: 1 },
    })
  })

  test('a zero-span block still counts (same-instant markers)', () => {
    assert.deepEqual(decodeTallyOfStream([chunk(500, 'reasoning'), chunk(500, 'text')], 900), {
      spans: { ...tally, text: 400 },
      blocks: { reasoning: 1, text: 1, toolarg: 0 },
    })
  })

  test('malformed records, non-finite times, and hostile containers degrade to zero', () => {
    const zero = { spans: tally, blocks: tally }
    assert.deepEqual(decodeTallyOfStream(undefined, 100), zero)
    assert.deepEqual(decodeTallyOfStream('stream', 100), zero)
    assert.deepEqual(decodeTallyOfStream([], 100), zero)
    assert.deepEqual(decodeTallyOfStream([chunk(500, 'text')], Number.NaN), zero)
    assert.deepEqual(decodeTallyOfStream([
      null, 7, 'x',
      { type: 'chunk' },
      { type: 'chunk', time: 1, chunk: null },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } },
      // The unusable time skips the record WHOLE: no span, no count.
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    ], 100), zero)
  })

  test('a backwards marker clamps to a zero span instead of a negative one', () => {
    // The text block's interval is negative → 0; the reasoning block is last,
    // so it owns the tail to endTime.
    assert.deepEqual(decodeTallyOfStream([chunk(1000, 'text'), chunk(900, 'reasoning')], 950), {
      spans: { reasoning: 50, text: 0, toolarg: 0 },
      blocks: { reasoning: 1, text: 1, toolarg: 0 },
    })
  })
})

describe('decodeSpansOfStream', () => {
  const chunk = (time: number, blockType: string) => ({ type: 'chunk', time, chunk: { type: 'block-start', blockType } })

  test('keeps the block sequence: each marker owns the interval to the next, the last one to endTime', () => {
    assert.deepEqual(decodeSpansOfStream([
      chunk(1000, 'reasoning'),
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [], texts: ['think'] },
      chunk(1300, 'text'),
      { type: 'text-chunks', time0: 1310, index: 1, dt: [], texts: ['answer'] },
      chunk(1500, 'tool-call'),
      { type: 'tool-call-chunks', time0: 1510, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ], 2000), [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'toolarg', start: 1500, end: 2000 },
    ])
  })

  test('a repeated kind stays two spans — the strip paints stream order, not a tally', () => {
    assert.deepEqual(decodeSpansOfStream([
      chunk(1000, 'reasoning'), chunk(1300, 'text'), chunk(1500, 'reasoning'),
    ], 2000), [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'reasoning', start: 1500, end: 2000 },
    ])
  })

  test('an unknown blockType closes the previous span but leaves its own interval unspanned', () => {
    assert.deepEqual(decodeSpansOfStream([chunk(1000, 'reasoning'), chunk(1400, 'image')], 1900), [
      { kind: 'reasoning', start: 1000, end: 1400 },
    ])
  })

  test('a zero-length or backwards interval drops out', () => {
    assert.deepEqual(decodeSpansOfStream([chunk(500, 'reasoning'), chunk(500, 'text')], 900), [
      { kind: 'text', start: 500, end: 900 },
    ])
    assert.deepEqual(decodeSpansOfStream([chunk(1000, 'text'), chunk(900, 'reasoning')], 950), [
      { kind: 'reasoning', start: 900, end: 950 },
    ])
  })

  test('a marker with an unusable time is skipped WHOLE — the previous block keeps its interval', () => {
    assert.deepEqual(decodeSpansOfStream([
      chunk(1000, 'reasoning'),
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      chunk(1500, 'text'),
    ], 2000), [
      { kind: 'reasoning', start: 1000, end: 1500 },
      { kind: 'text', start: 1500, end: 2000 },
    ])
  })

  test('malformed records, hostile containers, no markers, and a non-finite endTime yield none', () => {
    assert.deepEqual(decodeSpansOfStream(undefined, 100), [])
    assert.deepEqual(decodeSpansOfStream('stream', 100), [])
    assert.deepEqual(decodeSpansOfStream([], 100), [])
    assert.deepEqual(decodeSpansOfStream([{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }], 100), [])
    assert.deepEqual(decodeSpansOfStream([chunk(500, 'text')], Number.NaN), [])
    assert.deepEqual(decodeSpansOfStream([
      null, 7, 'x',
      { type: 'chunk' },
      { type: 'chunk', time: 1, chunk: null },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } },
    ], 100), [])
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
  test('reads the startSeq/endSeq endpoints', () => {
    assert.deepEqual(replaceRangeOf({ op: 'replace', startSeq: 3, endSeq: 7 }), { start: 3, end: 7 })
  })

  test('append, unknown, and malformed ops read as no replacement', () => {
    assert.equal(replaceRangeOf('append'), null)
    assert.equal(replaceRangeOf(null), null)
    assert.equal(replaceRangeOf(undefined), null)
    assert.equal(replaceRangeOf({ op: 'insert', startSeq: 1, endSeq: 2 }), null)
    // A pre-V3 spelling (`start`/`end`) is not an endpoint this dialect
    // carries: an op offering only those reads as malformed → append.
    assert.equal(replaceRangeOf({ op: 'replace', start: 3, end: 7 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: 1 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: Number.NaN, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: '1', endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', endSeq: 2 }), null)
  })
})

describe('usageOfSettlement', () => {
  test('malformed streams and non-usage chunks read as absent', () => {
    assert.equal(usageOfSettlement('assistant/attempt', undefined), undefined)
    assert.equal(usageOfSettlement('assistant/message', { stream: {} }), undefined)
    assert.equal(usageOfSettlement('assistant/attempt', { stream: [
      null, undefined, 7, {}, { type: 'other' }, { type: 'chunk', chunk: null },
      { type: 'chunk' }, { type: 'chunk', chunk: 9 }, { type: 'chunk', chunk: { type: 'text' } },
    ] }), undefined)
  })
  test('the last usage record survives trailing stream metadata', () => {
    const first = { inputTokens: 1 }
    const last = { inputTokens: 2 }
    assert.equal(usageOfSettlement('assistant/attempt', { stream: [
      { type: 'chunk', chunk: { type: 'usage', usage: first } },
      { type: 'chunk', chunk: { type: 'usage', usage: last } },
      { type: 'chunk', chunk: { type: 'end' } },
    ] }), last)
  })
})
