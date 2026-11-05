import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { decodeKindOfBlock, firstTokenTimeOfStream, isTokenChunk, replaceRangeOf, streamTimingOf } from '../../src/host/logShapes'

describe('decodeKindOfBlock', () => {
  test('maps the three block kinds the harness emits; an unknown or hostile marker stays unattributed', () => {
    assert.equal(decodeKindOfBlock('reasoning'), 'reasoning')
    assert.equal(decodeKindOfBlock('text'), 'text')
    assert.equal(decodeKindOfBlock('tool-call'), 'toolarg')
    for (const value of [undefined, null, '', 'image', 7, {}]) {
      assert.equal(decodeKindOfBlock(value), undefined, JSON.stringify(value))
    }
  })
})

describe('streamTimingOf', () => {
  const chunk = (time: number, blockType: string) => ({ type: 'chunk', time, chunk: { type: 'block-start', blockType } })

  test('tiles [first marker, endTime] in stream order; a lone block owns the tail and a repeated kind stays two spans', () => {
    const timing = streamTimingOf([
      chunk(1000, 'reasoning'),
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [], texts: ['think'] },
      chunk(1300, 'text'),
      { type: 'text-chunks', time0: 1310, index: 1, dt: [], texts: ['answer'] },
      chunk(1500, 'tool-call'),
      { type: 'tool-call-chunks', time0: 1510, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ], 2000)
    assert.deepEqual(timing.spans, [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'toolarg', start: 1500, end: 2000 },
    ])
    assert.equal(timing.firstToken, 1010, 'the packed run supplies the token instant')
    assert.deepEqual(streamTimingOf([chunk(500, 'text')], 900).spans, [
      { kind: 'text', start: 500, end: 900 },
    ], 'a single block owns the whole tail to endTime')
    assert.deepEqual(streamTimingOf([
      chunk(1000, 'reasoning'), chunk(1300, 'text'), chunk(1500, 'reasoning'),
    ], 2000).spans, [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'reasoning', start: 1500, end: 2000 },
    ])
  })

  test('a later block closes the previous one even when its own kind is unknown', () => {
    const timing = streamTimingOf([chunk(1000, 'reasoning'), chunk(1400, 'image')], 1900)
    assert.deepEqual(timing.spans, [{ kind: 'reasoning', start: 1000, end: 1400 }])
  })

  test('a zero-width block paints nothing; a backwards marker clamps to a zero span instead of a negative one', () => {
    const sameInstant = streamTimingOf([chunk(500, 'reasoning'), chunk(500, 'text')], 900)
    assert.deepEqual(sameInstant.spans, [{ kind: 'text', start: 500, end: 900 }])
    const backwards = streamTimingOf([chunk(1000, 'text'), chunk(900, 'reasoning')], 950)
    assert.deepEqual(backwards.spans, [{ kind: 'reasoning', start: 900, end: 950 }])
  })

  test('a marker with an unusable time is skipped WHOLE; the previous block keeps its interval', () => {
    const timing = streamTimingOf([
      chunk(1000, 'reasoning'),
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      chunk(1500, 'text'),
    ], 2000)
    assert.deepEqual(timing.spans, [
      { kind: 'reasoning', start: 1000, end: 1500 },
      { kind: 'text', start: 1500, end: 2000 },
    ])
  })

  test('malformed records, hostile containers, no markers, and a non-finite endTime yield zero', () => {
    assert.deepEqual(streamTimingOf(undefined, 100), { spans: [] })
    assert.deepEqual(streamTimingOf('stream', 100), { spans: [] })
    assert.deepEqual(streamTimingOf([], 100), { spans: [] })
    assert.deepEqual(streamTimingOf([chunk(500, 'text')], Number.NaN), { spans: [] })
    assert.deepEqual(streamTimingOf([{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }], 100).spans, [])
    assert.equal(streamTimingOf([{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } }], Number.NaN).firstToken, 2,
      'the token scan survives a non-finite endTime')
    const hostile = streamTimingOf([
      null, 7, 'x',
      { type: 'chunk' },
      { type: 'chunk', time: 1, chunk: null },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    ], 100)
    assert.deepEqual(hostile.spans, [])
    assert.equal(hostile.firstToken, 2, 'the delta chunk still anchors the first token')
  })

  test('a token-only read stops at the first token (a packed run answer ends the walk)', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a'] },
      { type: 'chunk', time: 500, chunk: { type: 'text-delta', text: 'later' } },
    ]), 100, 'the packed run answers before the later raw chunk is read')
    assert.equal(firstTokenTimeOfStream([
      { type: 'chunk', time: 200, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a'] },
    ]), 200)
  })

  test('the first token wins in stream order across raw chunks and packed runs', () => {
    assert.equal(streamTimingOf([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 200, index: 0, dt: [], texts: ['a'] },
    ], 300).firstToken, 200)
    assert.equal(streamTimingOf([
      { type: 'chunk', time: 250, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'text-chunks', time0: 200, index: 0, dt: [], texts: ['a'] },
    ], 300).firstToken, 250)
    assert.equal(streamTimingOf([chunk(100, 'text')], 300).firstToken, undefined)
  })
})

describe('isTokenChunk', () => {
  test('accepts the three delta kinds the harness counts and rejects empty, non-delta, and hostile shapes', () => {
    assert.equal(isTokenChunk({ type: 'text-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'reasoning-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', name: 'bash', argumentsDelta: '' }), true)
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
  test('reads raw chunks and packed runs, including a leading empty fragment and a missing dt array', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 250, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'chunk', time: 300, chunk: { type: 'text-delta', text: 'there' } },
    ]), 250)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['a', 'b', 'c'] },
    ]), 1000)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['', 'b', 'c'] },
    ]), 1010, 'a leading empty fragment defers the stamp to the next member')
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 9, index: 0, texts: ['a'] }]), 9)
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
    assert.equal(replaceRangeOf({ op: 'replace', start: 3, end: 7 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: 1 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: Number.NaN, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: '1', endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', endSeq: 2 }), null)
  })
})
