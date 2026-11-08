import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { grammarOfTool, highlightRuns } from '../../src/client/commandHighlight'
import { disposeRetention } from '../../src/client/retention'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'

const RUNS: HighlightSpan[][] = [[{ text: 'git', style: { color: 'var(--shiki-token-function)' } }]]

describe('grammarOfTool', () => {
  test('maps the shell dialects and leaves every other tool plain', () => {
    assert.equal(grammarOfTool('bash'), 'bash')
    assert.equal(grammarOfTool('pwsh'), 'powershell')
    assert.equal(grammarOfTool('run_code'), undefined)
    assert.equal(grammarOfTool('read_file'), undefined)
  })
})

describe('highlightRuns', () => {
  test('tokenizes once per grammar and text', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    const text = 'git status --short && ls'
    assert.equal(highlightRuns(highlight, 'bash', text), RUNS)
    assert.equal(highlightRuns(highlight, 'bash', text), RUNS)
    assert.equal(calls, 1)
    assert.equal(highlightRuns(highlight, 'powershell', text), RUNS)
    assert.equal(calls, 2)
  })

  test('re-attempts a text the loading grammar could not tokenize, and refuses an over-long line', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return undefined }
    assert.equal(highlightRuns(highlight, 'powershell', 'Get-ChildItem -Recurse'), undefined)
    assert.equal(highlightRuns(highlight, 'powershell', 'Get-ChildItem -Recurse'), undefined)
    assert.equal(calls, 2)
    const long = 'x'.repeat(1001)
    assert.equal(highlightRuns(highlight, 'bash', long), undefined)
    assert.equal(calls, 2)
    assert.equal(highlightRuns(highlight, 'bash', 'ls\n' + long), undefined)
    assert.equal(calls, 2)
  })

  test('a cached run expires after the retention ttl', () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
      highlightRuns(highlight, 'bash', 'expire me gently')
      vi.advanceTimersByTime(10 * 60_000)
      highlightRuns(highlight, 'bash', 'expire me gently')
      assert.equal(calls, 2, 'the expired highlight was recomputed')
    } finally {
      vi.useRealTimers()
    }
  })

  test('drops the least recently used text past the cap', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    const texts = Array.from({ length: 601 }, (_, i) => 'lru probe ' + i)
    for (const text of texts) highlightRuns(highlight, 'bash', text)
    assert.equal(calls, 601)
    highlightRuns(highlight, 'bash', texts[0])
    assert.equal(calls, 602)
  })
})

describe('highlight disposal', () => {
  test('dispose drops the run ledger so the plugin leaves nothing behind', () => {
    let calls = 0
    const highlight: CodeHighlighter = () => { calls += 1; return RUNS }
    highlightRuns(highlight, 'bash', 'dispose probe')
    assert.equal(calls, 1)
    disposeRetention()
    highlightRuns(highlight, 'bash', 'dispose probe')
    assert.equal(calls, 2, 'the disposed ledger no longer replays')
  })
})
