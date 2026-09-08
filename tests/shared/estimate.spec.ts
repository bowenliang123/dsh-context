// The shared token heuristics (src/shared/estimate.ts): the fixed-density
// figures the host fold and the client boundary must agree on. The system
// prompt is priced from EITHER generation's payload — the V0/V2 envelope's
// rendered string or a V3 `system/message`'s content blocks — with the
// harness token-meter's own no-per-block-overhead rule.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystemContent, estimateSystemTokens } from '../../src/shared/estimate'

describe('estimateSystemTokens', () => {
  test('prices text density plus role framing', () => {
    assert.equal(estimateSystemTokens('abcdefgh'), 2 + 4)
    assert.equal(estimateSystemTokens('abcde'), 2 + 4, 'partial tokens round up')
  })

  test('absent, empty, and non-string input prices 0', () => {
    assert.equal(estimateSystemTokens(undefined), 0)
    assert.equal(estimateSystemTokens(null), 0)
    assert.equal(estimateSystemTokens(''), 0)
    assert.equal(estimateSystemTokens(42), 0)
    assert.equal(estimateSystemTokens({ text: 'x' }), 0)
  })
})

describe('estimateSystemContent', () => {
  test('prices every text block with no per-block overhead', () => {
    assert.equal(estimateSystemContent([{ type: 'text', text: 'abcdefgh' }]), 2 + 4)
    assert.equal(
      estimateSystemContent([{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efgh' }]),
      2 + 4,
      'blocks are summed before the density divide, exactly like the harness estimator',
    )
  })

  test('empty content and non-array input price 0 (the harness reads "no system prompt")', () => {
    assert.equal(estimateSystemContent([]), 0)
    assert.equal(estimateSystemContent(undefined), 0)
    assert.equal(estimateSystemContent('text'), 0)
  })

  test('a non-text block falls back to its JSON length', () => {
    const block = { type: 'image', attachment: { width: 1, height: 1 } }
    assert.equal(estimateSystemContent([block]), Math.ceil(JSON.stringify(block).length / 4) + 4)
  })

  test('hostile elements degrade instead of throwing', () => {
    // A primitive element has no `text`; its JSON length is priced.
    assert.equal(estimateSystemContent([7]), Math.ceil('7'.length / 4) + 4)
    // `undefined` stringifies to undefined (not a string) and contributes nothing.
    assert.equal(estimateSystemContent([undefined]), 0 + 4)
    // A text-typed block whose text is not a string is priced by JSON, not trusted.
    assert.equal(estimateSystemContent([{ type: 'text', text: 42 }]), Math.ceil('{"type":"text","text":42}'.length / 4) + 4)
    // A cyclic block cannot be stringified: it contributes no characters.
    const cyclic: Record<string, unknown> = { type: 'weird' }
    cyclic.self = cyclic
    assert.equal(estimateSystemContent([cyclic]), 4, 'role framing survives, content prices 0')
  })
})
