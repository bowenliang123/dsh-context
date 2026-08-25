// Tool-call summaries (src/client/callSummary.ts): argument JSON parsing,
// the description/file_path/path/filePath key priority, and the
// conversation-block scanners.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { blockSummaryOf, callNamesOf, callSummaryOf, parseCallArgs, summaryInArgs } from '../../src/client/callSummary'
import type { ConversationNodeLike } from '../../src/client/services'

function conv(over: Partial<ConversationNodeLike> = {}): ConversationNodeLike {
  return { kind: 'assistant', seq: 1, ...over }
}

describe('parseCallArgs', () => {
  test('non-string and empty input parses to null', () => {
    assert.equal(parseCallArgs(42), null)
    assert.equal(parseCallArgs(undefined), null)
    assert.equal(parseCallArgs(''), null)
  })

  test('invalid JSON parses to null', () => {
    assert.equal(parseCallArgs('{oops'), null)
  })

  test('non-object JSON parses to null', () => {
    assert.equal(parseCallArgs('[1,2]'), null)
    assert.equal(parseCallArgs('null'), null)
    assert.equal(parseCallArgs('"text"'), null)
  })

  test('a JSON object parses to a record', () => {
    assert.deepEqual(parseCallArgs('{"description":"d"}'), { description: 'd' })
  })
})

describe('summaryInArgs', () => {
  test('null args yield null', () => {
    assert.equal(summaryInArgs(null), null)
  })

  test('the keys win in description, file_path, path, filePath order', () => {
    assert.equal(summaryInArgs({ description: 'd', file_path: 'f', path: 'p', filePath: 'fp' }), 'd')
    assert.equal(summaryInArgs({ file_path: 'f', path: 'p', filePath: 'fp' }), 'f')
    assert.equal(summaryInArgs({ path: 'p', filePath: 'fp' }), 'p')
    assert.equal(summaryInArgs({ filePath: 'fp' }), 'fp')
  })

  test('empty strings are skipped', () => {
    assert.equal(summaryInArgs({ description: '', file_path: 'f' }), 'f')
  })

  test('non-string values are skipped', () => {
    assert.equal(summaryInArgs({ description: 42, path: 'p' }), 'p')
  })

  test('no usable key yields null', () => {
    assert.equal(summaryInArgs({ foo: 'bar' }), null)
  })
})

describe('callSummaryOf', () => {
  test('an undefined conversation yields null', () => {
    assert.equal(callSummaryOf(undefined), null)
  })

  test('a missing or null call yields null', () => {
    assert.equal(callSummaryOf(conv()), null)
    assert.equal(callSummaryOf(conv({ call: null })), null)
  })

  test('an unusable call payload yields null', () => {
    assert.equal(callSummaryOf(conv({ call: { name: 'bash', argsRaw: '{oops' } })), null)
  })

  test('the call’s args supply the summary', () => {
    assert.equal(callSummaryOf(conv({ call: { name: 'edit', argsRaw: '{"file_path":"a.ts"}' } })), 'a.ts')
  })
})

describe('blockSummaryOf', () => {
  test('an undefined conversation or non-array blocks yield null', () => {
    assert.equal(blockSummaryOf(undefined), null)
    assert.equal(blockSummaryOf(conv({ blocks: 'junk' as unknown as unknown[] })), null)
  })

  test('null, non-object, and non-tool-call entries are skipped', () => {
    const blocks = [null, 42, { kind: 'text' }, { kind: 'tool-call', argsRaw: '{"description":"d"}' }]
    assert.equal(blockSummaryOf(conv({ blocks })), 'd')
  })

  test('the first tool-call with a usable summary wins', () => {
    const blocks = [
      { kind: 'tool-call', argsRaw: '{oops' },
      { kind: 'tool-call', argsRaw: '{"foo":1}' },
      { kind: 'tool-call', argsRaw: '{"description":"first"}' },
      { kind: 'tool-call', argsRaw: '{"description":"second"}' },
    ]
    assert.equal(blockSummaryOf(conv({ blocks })), 'first')
  })

  test('no usable tool-call summary yields null', () => {
    const blocks = [{ kind: 'tool-call', argsRaw: '{oops' }, null]
    assert.equal(blockSummaryOf(conv({ blocks })), null)
  })
})

describe('callNamesOf', () => {
  test('an undefined conversation or non-array blocks yield an empty list', () => {
    assert.deepEqual(callNamesOf(undefined), [])
    assert.deepEqual(callNamesOf(conv({ blocks: 'junk' as unknown as unknown[] })), [])
  })

  test('mixed entries are filtered down to tool-call names in order', () => {
    const blocks = [
      null,
      42,
      { kind: 'text', name: 'not-a-call' },
      { kind: 'tool-call' },
      { kind: 'tool-call', name: 42 },
      { kind: 'tool-call', name: 'bash' },
      { kind: 'tool-call', name: 'read' },
    ]
    assert.deepEqual(callNamesOf(conv({ blocks })), ['bash', 'read'])
  })
})
