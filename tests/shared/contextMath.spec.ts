import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Assembled } from '../../src/shared/assemble'
import type { ContextDelta } from '../../src/shared/delta'
import { incrementOfDelta } from '../../src/shared/delta'
import { incrementHas, incrementOf } from '../../src/shared/increment'
import { anchoredParts, billedParts, officialParts, partsOf } from '../../src/shared/categories'
import { isImageFileOp, kindOfTool, linesOf, pathOfArgs } from '../../src/shared/fileOps'
import { bareModelOf, familyVendorOf, labOf, normalizeModelId, orgOf, suffixKeys } from '../../src/shared/priceIdentity'
import { isNewerRelease } from '../../src/shared/version'
import type { HeaderRecord, RequestRecord, Snapshot, SurfaceNode } from '../../src/shared/types'

const node = (seq: number, cat: SurfaceNode['cat'] = 'user', tokens = 1): SurfaceNode => ({ seq, cat, tokens })
const header = (seq: number, tools: HeaderRecord['tools'] = []): HeaderRecord => ({ seq, time: seq, tools })
const current = (values: Partial<Snapshot['current']> = {}): Snapshot['current'] => ({
  system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0, ...values,
})
const assembled = (values: Partial<Assembled> = {}): Assembled => ({
  live: true, header: null, system: null, nodes: [], missingLive: 0, approximate: false, ...values,
})

describe('context math', () => {
  test('partsOf covers every category and treats missing counts as zero', () => {
    const parts = partsOf({ ...current({ system: 1, tools: 2, user: 3 }), tool: 4 } as Snapshot['current'])
    assert.deepEqual(parts.map(part => part.value), [1, 2, 3, 0, 0, 0, 4])
    const record = partsOf({ time: 1, seq: 1, total: 9 } as RequestRecord)
    assert.deepEqual(record.map(part => part.value), [0, 0, 0, 0, 0, 0, 0])
  })

  test('official parts distribute a message total into the largest category', () => {
    const parts = officialParts(current({ system: 10, tools: 5, user: 1, assistant: 3 }), {
      systemTokens: 20, toolsTokens: 7, messageTokens: 11,
    })
    assert.deepEqual(parts.map(part => part.key), ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'])
    assert.deepEqual(parts.map(part => part.value), [20, 7, 3, 0, 0, 8, 0])
    const empty = officialParts(current(), null)
    assert.deepEqual(empty.map(part => part.value), [0, 0, 0, 0, 0, 0, 0])
  })

  test('anchored parts preserve raw values and scale to the target', () => {
    const parts = [{ key: 'a', color: 'x', value: 2 }]
    assert.deepEqual(anchoredParts(parts, null), [{ key: 'a', color: 'x', value: 2, raw: 2 }])
    assert.deepEqual(anchoredParts(parts, 0)[0].raw, 2)
    assert.deepEqual(anchoredParts([{ ...parts[0], raw: 4 }], 4), [{ key: 'a', color: 'x', value: 4, raw: 4 }])
    assert.deepEqual(anchoredParts([{ key: 'a', color: 'x', value: 0 }], 5), [{ key: 'a', color: 'x', value: 0, raw: 0 }])
    assert.deepEqual(anchoredParts([{ key: 'a', color: 'x', value: 2 }, { key: 'b', color: 'y', value: 2 }], 5)
      .map(part => part.value), [3, 3])
  })

  test('billed parts split live and generated output across thinking, answers and calls', () => {
    const usage = { uncachedInputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 10 }
    const gen = billedParts(current({ assistant: 4, assistantReasoning: 1, assistantAnswerTokens: 2, assistantCallTokens: 1 }), null, usage, { reasoning: 2, answers: 3, calls: 1 })
    assert.equal(gen.find(part => part.key === 'thinking')?.value, 5)
    assert.equal(gen.find(part => part.key === 'answers')?.value, 12)
    const zero = billedParts(current(), null, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    assert.equal(zero.find(part => part.key === 'thinking')?.value, 0)
    assert.equal(zero.find(part => part.key === 'answers')?.value, 0)
    const thinkingOnly = billedParts(current(), null, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7 }, { reasoning: 3 })
    assert.equal(thinkingOnly.find(part => part.key === 'thinking')?.value, 7)
    const toolOnly = billedParts(current({ tool: 4 }), null, { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 }, {})
    assert.equal(toolOnly.find(part => part.key === 'toolCalls')?.value, 3)
  })

  test('increments report removed systems, tool changes, and key membership', () => {
    const base = assembled({ system: { seq: 1, time: 1, tokens: 5 }, header: header(1, [{ name: 'bash', tokens: 3 }]) })
    const view = assembled({ header: header(2, [{ name: 'bash', tokens: 6 }, { name: 'read', tokens: 2 }]) })
    const inc = incrementOf(view, base)
    assert.equal(inc.removed.system, 1)
    assert.equal(inc.tokenDown.system, 5)
    assert.deepEqual(inc.tools.map(tool => tool.name), ['read'])
    assert.deepEqual(inc.counts.tools, 1)
    assert.equal(incrementHas(inc, 'sys'), false)
    assert.equal(incrementHas(inc, 'tools'), true)
    assert.equal(incrementHas(inc, 'tool:read'), true)
    assert.equal(incrementHas(inc, 'tool:bash'), false)
    assert.equal(incrementHas(inc, 'n1'), false)
    assert.equal(incrementHas(inc, 'bogus'), false)
    assert.equal(incrementHas(incrementOf(assembled({ nodes: [node(3)] }), null), 'n3'), true)
    assert.equal(incrementHas(incrementOf(assembled({ system: { seq: 1, time: 1, tokens: 1 } }), null), 'sys'), true)
  })

  test('incrementOfDelta rebuilds node groups, tool names and parts', () => {
    const delta = {
      added: [node(1), node(2, 'assistant')], viewNodes: [], viewHeader: null, viewSystem: null,
      system: null, tools: [{ name: 'bash', tokens: 2 }], header: null,
      counts: {} as ContextDelta['counts'], tokens: {} as ContextDelta['tokens'],
      removedCounts: {} as ContextDelta['removedCounts'], tokenUp: {} as ContextDelta['tokenUp'],
      tokenDown: {} as ContextDelta['tokenDown'], items: 2, total: 3,
    }
    const inc = incrementOfDelta(delta)
    assert.deepEqual(inc.byCat.user?.map(item => item.seq), [1])
    assert.deepEqual([...inc.seqs], [1, 2])
    assert.deepEqual([...inc.toolNames], ['bash'])
    assert.equal(inc.parts.length, 7)
  })

  test('file op helpers degrade hostile arguments and detect image reads', () => {
    assert.equal(kindOfTool(undefined), null)
    assert.equal(kindOfTool('unknown'), null)
    assert.equal(kindOfTool('grep'), 'search')
    assert.equal(pathOfArgs('read', null), null)
    assert.equal(pathOfArgs('grep', { path: '/a' }), '/a')
    assert.equal(pathOfArgs('grep', { pattern: 'needle' }), 'needle')
    assert.equal(pathOfArgs('grep', { pattern: 3 }), null)
    assert.equal(linesOf(''), 0)
    assert.equal(linesOf('a\nb'), 2)
    assert.equal(linesOf('a\n'), 1)
    assert.equal(isImageFileOp('read_image', 'a.txt'), true)
    assert.equal(isImageFileOp('read', 'a.png'), true)
    assert.equal(isImageFileOp('read', 'a.txt'), false)
  })

  test('model identity helpers handle bare, prefixed and normalised ids', () => {
    assert.equal(bareModelOf('deepseek-v4'), 'deepseek-v4')
    assert.equal(bareModelOf('deepseek/deepseek-v4'), 'deepseek-v4')
    assert.equal(orgOf('deepseek-v4'), undefined)
    assert.equal(orgOf('/leading'), undefined)
    assert.equal(orgOf('DeepSeek/V4'), 'deepseek')
    assert.equal(labOf('v4'), undefined)
    assert.equal(labOf('/v4'), undefined)
    assert.equal(labOf('DeepSeek/V4'), 'deepseek')
    assert.deepEqual(suffixKeys('a/b-c'), ['b-c', 'c'])
    assert.equal(normalizeModelId('accounts/fireworks/models/DeepSeek_V3'), 'deepseek-v3')
    assert.equal(normalizeModelId('workers-ai/global.deepseek-chat'), 'deepseek-chat')
    assert.equal(normalizeModelId('deepseek-chat@default'), 'deepseek-chat')
    assert.equal(normalizeModelId('deepseek-chat-latest'), 'deepseek-chat')
    assert.equal(normalizeModelId('deepseek-chat:20250101'), 'deepseek-chat')
    assert.equal(normalizeModelId('deepseek--v3'), 'deepseek')
    assert.equal(familyVendorOf('deepseek-chat'), 'deepseek')
    assert.equal(familyVendorOf('unknown'), undefined)
    assert.equal(isNewerRelease('nope', '0.1.0'), false)
    assert.equal(isNewerRelease('0.2.0', 'nope'), false)
    assert.equal(isNewerRelease('0.2.0', '0.1.0'), true)
  })
})
