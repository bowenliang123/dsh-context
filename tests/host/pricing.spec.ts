// Unit tests for the token-pricing heuristic (src/host/pricing.ts) — a mirror
// of the harness token-meter's fixed-density estimator with the image-block
// refinement. Pure functions: each case constructs a real payload and prices it.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  estimateMessage,
  estimateToolSchema,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from '../../src/host/pricing'
import { estimateSystemTokens } from '../../src/shared/estimate'
import type { ContentBlock } from '../../src/host/pricing'

describe('estimateToolsTotal', () => {
  test('empty tool list prices zero', () => {
    assert.equal(estimateToolsTotal([]), 0)
  })

  test('non-empty list prices the whole-array JSON plus one block', () => {
    const tools = [{ name: 'bash', description: 'run a command' }]
    assert.equal(estimateToolsTotal(tools), Math.ceil(JSON.stringify(tools).length / 4) + 4)
  })
})

describe('estimateMessage', () => {
  test('text blocks price chars/4 plus block and role overhead', () => {
    // 16 chars → 4, +4 block, +4 role
    assert.equal(estimateMessage({ content: [{ type: 'text', text: '0123456789abcdef' }] }), 12)
  })

  test('reasoning blocks price like text', () => {
    assert.equal(estimateMessage({ content: [{ type: 'reasoning', text: '0123456789abcdef' }] }), 12)
  })

  test('tool-call blocks price name plus arguments', () => {
    // 'bash' → 1, '{}' → 1, +4 block, +4 role
    assert.equal(estimateMessage({ content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }] }), 10)
  })

  test('tool-call blocks tolerate missing name/arguments', () => {
    assert.equal(estimateMessage({ content: [{ type: 'tool-call' }] }), 8)
  })

  test('tool-result blocks price their nested content recursively', () => {
    assert.equal(
      estimateMessage({ content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] }),
      // inner text: ceil(2/4)+4 = 5; wrapper: +4; role: +4
      13,
    )
  })

  test('unknown block types fall back to the generic JSON price', () => {
    const block = { type: 'mystery', payload: { a: 1 } }
    assert.equal(
      estimateMessage({ content: [block] }),
      4 + Math.ceil(JSON.stringify(block).length / 4) + 4,
    )
  })

  test('image blocks with known dimensions price through the vision calculator', () => {
    // 800×600 → 341 (docs-verified) +4 block +4 role
    assert.equal(
      estimateMessage({ content: [{ type: 'image', attachment: { width: 800, height: 600 } }] }),
      341 + 8,
    )
  })

  test('image blocks with a null attachment fall back to the JSON price', () => {
    const block = { type: 'image', attachment: null }
    assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8)
  })

  test('image blocks with a non-object attachment fall back to the JSON price', () => {
    const block = { type: 'image', attachment: 'ref' } as unknown as ContentBlock
    assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8)
  })

  test('image blocks missing one dimension fall back to the JSON price', () => {
    const block = { type: 'image', attachment: { width: 800 } }
    assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8)
  })

  test('image blocks with non-finite dimensions price the calculator null through the JSON fallback', () => {
    // typeof NaN === 'number' passes the guard; the calculator rejects non-finite input.
    const block = { type: 'image', attachment: { width: NaN, height: 100 } }
    assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8)
  })

  test('message without an array content pays role framing only', () => {
    assert.equal(estimateMessage({}), 4)
    assert.equal(estimateMessage({ content: 'not-an-array' as never }), 4)
  })

  test('emptyIsZero short-circuits null/undefined/empty messages to zero', () => {
    assert.equal(estimateMessage(null, true), 0)
    assert.equal(estimateMessage(undefined, true), 0)
    assert.equal(estimateMessage({}, true), 0)
    assert.equal(estimateMessage({ content: [] }, true), 0)
    assert.equal(estimateMessage({ content: 'x' as never }, true), 0)
    // …but a non-empty message still prices normally under emptyIsZero.
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcd' }] }, true), 9)
  })

  test('emptyIsZero=false prices a null message as role framing only', () => {
    assert.equal(estimateMessage(null), 4)
    assert.equal(estimateMessage(undefined), 4)
  })
})

describe('estimateSystem', () => {
  test('non-strings and the empty string price zero', () => {
    assert.equal(estimateSystemTokens(undefined), 0)
    assert.equal(estimateSystemTokens(null), 0)
    assert.equal(estimateSystemTokens(42), 0)
    assert.equal(estimateSystemTokens(''), 0)
  })

  test('text prices chars/4 plus role framing', () => {
    assert.equal(estimateSystemTokens('abcd'), 5)
  })
})

describe('estimateToolSchema', () => {
  test('prices the tool JSON plus one block', () => {
    const tool = { name: 'bash' }
    assert.equal(estimateToolSchema(tool), Math.ceil(JSON.stringify(tool).length / 4) + 4)
  })
})

describe('imageCountOf', () => {
  test('counts image blocks, recursing into nested content', () => {
    assert.equal(imageCountOf([
      { type: 'image' },
      { type: 'tool-result', content: [{ type: 'image' }, { type: 'text', text: 'x' }] },
      { type: 'text', text: 'y' },
    ]), 2)
  })

  test('non-array input counts zero', () => {
    assert.equal(imageCountOf(undefined), 0)
    assert.equal(imageCountOf('x' as never), 0)
  })
})

describe('firstText', () => {
  test('returns the first non-blank text block, whitespace-normalized and truncated to 80', () => {
    const long = 'word '.repeat(30) // 150 chars
    const out = firstText([{ type: 'text', text: long }])
    assert.equal(out.length, 80)
    assert.ok(!out.includes('  '))
  })

  test('skips non-text blocks, non-string text, and whitespace-only text', () => {
    assert.equal(firstText([
      { type: 'image' },
      { type: 'text' },
      { type: 'text', text: '   \n\t ' },
      { type: 'text', text: '  real   text ' },
    ]), 'real text')
  })

  test('non-array input yields the empty string', () => {
    assert.equal(firstText(undefined), '')
    assert.equal(firstText(null as never), '')
  })
})

describe('toolCallNames', () => {
  test('collects tool-call block names in order', () => {
    assert.deepEqual(toolCallNames([
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: 'x' },
      { type: 'tool-call', name: 'read' },
      { type: 'tool-call' }, // no name: skipped
    ]), ['bash', 'read'])
  })

  test('non-array input yields an empty list', () => {
    assert.deepEqual(toolCallNames(undefined), [])
  })
})

describe('injectionSourceName', () => {
  test('agent-instructions sources name their deduped change paths', () => {
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }, { path: 'docs/TEAM.md' }],
    }), 'AGENTS.md, docs/TEAM.md')
  })

  test('agent-instructions skips null entries and empty paths', () => {
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [null, { path: '' }, { path: 'A.md' }],
    }), 'A.md')
  })

  test('agent-instructions with no usable path falls through to kind', () => {
    assert.equal(injectionSourceName({ kind: 'agent-instructions', changes: [null] }), 'agent-instructions')
    assert.equal(injectionSourceName({ kind: 'agent-instructions', changes: [] }), 'agent-instructions')
  })

  test('agent-instructions without a changes array falls through to kind', () => {
    assert.equal(injectionSourceName({ kind: 'agent-instructions' }), 'agent-instructions')
  })

  test('plugin sources name the plugin id', () => {
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: 'dsh-agent-presets' }), 'dsh-agent-presets')
  })

  test('an empty plugin id falls through to kind', () => {
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: '' }), 'plugin')
  })

  test('any other producer names its own kind; an unreadable source yields empty', () => {
    assert.equal(injectionSourceName({ kind: 'goal' }), 'goal')
    assert.equal(injectionSourceName({ kind: '' }), '')
    assert.equal(injectionSourceName({}), '')
  })
})

describe('isInjection', () => {
  test('null and undefined sources are not injections', () => {
    assert.equal(isInjection(null), false)
    assert.equal(isInjection(undefined), false)
  })

  test('a plain user source is not an injection', () => {
    assert.equal(isInjection({ kind: 'user' }), false)
    assert.equal(isInjection({}), false)
  })

  test('any non-user kind is an injection, even with a form', () => {
    assert.equal(isInjection({ kind: 'plugin', form: 'notice' }), true)
    // 'user-rpc' keeps kind "user" in the log but a transport form must not flip the class…
    assert.equal(isInjection({ kind: 'user', form: 'rpc' }), true) // form fallback, per the fold comment
  })

  test('a foreign source declaring only a form classifies as an injection', () => {
    assert.equal(isInjection({ form: 'notice' }), true)
  })
})

describe('hostile block shapes', () => {
  test('null and primitive elements degrade to overhead instead of throwing', () => {
    const junk = [null, 7, 'x'] as never
    assert.ok(estimateMessage({ content: junk }) > 0)
    assert.equal(imageCountOf(junk), 0)
    assert.equal(firstText(junk), '')
    assert.deepEqual(toolCallNames(junk), [])
    // A null element nested inside a tool-result block is tolerated too.
    const nested = [{ type: 'tool-result', content: [null, { type: 'image' }] }] as never
    assert.equal(imageCountOf(nested), 1)
    assert.ok(estimateMessage({ content: nested }) > 0)
  })
})
