// Category parts (src/client/categories.ts): the six-bucket parts builder,
// the official contextBreakdown split (rounding residue on the largest
// category, clamped), and the provider-anchored reproportioning.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { anchoredParts, officialParts, partsOf, type PartsPart } from '../../src/client/categories'
import type { ContextBreakdown, Snapshot } from '../../src/shared/types'

function current(over: Partial<Snapshot['current']> = {}): Snapshot['current'] {
  return { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function values(parts: PartsPart[]): Record<string, number> {
  return Object.fromEntries(parts.map(p => [p.key, p.value]))
}

function part(value: number, raw?: number): PartsPart {
  return raw === undefined ? { key: 'k', color: '#000', value } : { key: 'k', color: '#000', value, raw }
}

describe('partsOf', () => {
  test('reads all six categories in CATS order with their colors', () => {
    const parts = partsOf(current({ system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6 }))
    assert.deepEqual(parts.map(p => [p.key, p.color, p.value]), [
      ['system', '#6366f1', 1],
      ['tools', '#f59e0b', 2],
      ['user', '#22c55e', 3],
      ['inject', '#a855f7', 4],
      ['assistant', '#3b82f6', 5],
      ['tool', '#14b8a6', 6],
    ])
  })

  test('missing keys fall back to zero', () => {
    const parts = partsOf({ system: 5, user: 10 } as unknown as Snapshot['current'])
    assert.deepEqual(values(parts), { system: 5, tools: 0, user: 10, inject: 0, assistant: 0, tool: 0 })
  })
})

describe('officialParts', () => {
  test('without a breakdown the fold sums serve as-is', () => {
    const cur = current({ system: 5, tools: 7, user: 10, assistant: 30, tool: 60, total: 112 })
    const parts = officialParts(cur, null)
    assert.deepEqual(values(parts), { system: 5, tools: 7, user: 10, inject: 0, assistant: 30, tool: 60 })
  })

  test('a delivered breakdown supplies system/tools/messages figures', () => {
    const cur = current({ system: 1, tools: 2, user: 50, assistant: 50, total: 102 })
    const bd: ContextBreakdown = { systemTokens: 100, toolsTokens: 200, messageTokens: 20 }
    const parts = officialParts(cur, bd)
    assert.deepEqual(values(parts), { system: 100, tools: 200, user: 10, inject: 0, assistant: 10, tool: 0 })
  })

  test('rounding residue lands on the largest category', () => {
    const cur = current({ system: 1, tools: 2, user: 33, assistant: 33, tool: 34, total: 103 })
    const bd: ContextBreakdown = { systemTokens: 0, toolsTokens: 0, messageTokens: 10 }
    // Shares round to 3/3/3 (assigned 9); the residue of 1 lands on `tool`.
    const parts = officialParts(cur, bd)
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 3, inject: 0, assistant: 3, tool: 4 })
  })

  test('a negative rounding residue is clamped to zero', () => {
    const cur = current({ user: 25, inject: 25, assistant: 25, tool: 25, total: 100 })
    const bd: ContextBreakdown = { systemTokens: 0, toolsTokens: 0, messageTokens: 2 }
    // Each share rounds 0.5 up to 1 (assigned 4); the residue of -2 on the
    // largest (first-seen, `user`) would go negative without the clamp.
    const parts = officialParts(cur, bd)
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 0, inject: 1, assistant: 1, tool: 1 })
  })

  test('an empty surface yields zero message shares even with official messages', () => {
    const bd: ContextBreakdown = { systemTokens: 1, toolsTokens: 2, messageTokens: 100 }
    const parts = officialParts(current(), bd)
    assert.deepEqual(values(parts), { system: 1, tools: 2, user: 0, inject: 0, assistant: 0, tool: 0 })
  })

  test('partial breakdown fields fall back to the fold figures', () => {
    const cur = current({ system: 1, tools: 2, user: 10, total: 13 })
    const bd = { systemTokens: 9 } as unknown as ContextBreakdown
    const parts = officialParts(cur, bd)
    assert.deepEqual(values(parts), { system: 9, tools: 2, user: 10, inject: 0, assistant: 0, tool: 0 })
  })
})

describe('anchoredParts', () => {
  test('a null target returns the parts unchanged with raw defaulted to value', () => {
    const out = anchoredParts([part(100), part(50, 20)], null)
    assert.deepEqual(out, [
      { key: 'k', color: '#000', value: 100, raw: 100 },
      { key: 'k', color: '#000', value: 50, raw: 20 },
    ])
  })

  test('a non-positive target returns the parts unchanged', () => {
    const out = anchoredParts([part(100)], 0)
    assert.deepEqual(out, [{ key: 'k', color: '#000', value: 100, raw: 100 }])
  })

  test('a zero raw total returns the parts unchanged', () => {
    const out = anchoredParts([part(0), part(0)], 100)
    assert.deepEqual(out, [
      { key: 'k', color: '#000', value: 0, raw: 0 },
      { key: 'k', color: '#000', value: 0, raw: 0 },
    ])
  })

  test('a target equal to the raw total rewrites value to raw', () => {
    const out = anchoredParts([part(10, 60), part(90, 40)], 100)
    assert.deepEqual(out.map(p => [p.value, p.raw]), [[60, 60], [40, 40]])
  })

  test('otherwise values scale to the target by the raw ratios', () => {
    const out = anchoredParts([part(0, 30), part(0, 10)], 100)
    assert.deepEqual(out.map(p => [p.value, p.raw]), [[75, 30], [25, 10]])
  })

  test('scaling rounds each part to the nearest integer', () => {
    const out = anchoredParts([part(0, 20), part(0, 50)], 40)
    assert.deepEqual(out.map(p => p.value), [11, 29])
  })
})
