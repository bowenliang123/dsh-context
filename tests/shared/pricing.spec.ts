import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  billedTokensOf, calculateSessionCost, estimateSessionCost, mergeCostUsage, priceFaceOf, priceLookupsOf,
  priceOf, priceResolutionOf, pricesBookOf, toCurrency,
} from '../../src/shared/pricing'
import type { SessionCostUsage } from '../../src/shared/types'

const cost = (input: number, output: number, cacheRead?: number, cacheWrite?: number) => ({
  input, output, ...(cacheRead === undefined ? {} : { cache_read: cacheRead }), ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
})

const BOOK = {
  deepseek: {
    models: {
      'deepseek-v3': { cost: cost(1, 2, 0.5, 1.5), canonical_model_id: 'deepseek/deepseek-v3' },
      'shared-model': { cost: cost(2, 3), canonical_model_id: 'deepseek/shared' },
      'model-v2': { cost: cost(4, 5) },
      'deepseek-model-v2': { cost: cost(8, 8) },
      'deepseek-shared-model': { cost: cost(6, 7), canonical_model_id: 'deepseek/x' },
    },
  },
  anthropic: {
    models: {
      'claude-opus': { cost: cost(3, 4), canonical_model_id: 'anthropic/claude-opus' },
      'shared-model': { cost: cost(5, 6), canonical_model_id: 'anthropic/shared' },
    },
  },
  openai: {
    models: {
      'gpt-4o': { cost: cost(1, 1), canonical_model_id: 'openai/gpt-4o' },
      'model-v2': { cost: cost(2, 2) },
      'openai-model-v2': { cost: cost(9, 9) },
      'deepseek-shared-model': { cost: cost(2, 2), canonical_model_id: 'openai/y' },
    },
  },
  ambig: {
    models: {
      'a-v9': { cost: cost(1, 1), canonical_model_id: 'deepseek/a' },
      'b-v9': { cost: cost(2, 2), canonical_model_id: 'openai/b' },
    },
  },
  gateway: {
    models: {
      alpha: { cost: cost(1, 1), canonical_model_id: 'deepseek/alpha' },
      beta: { cost: cost(2, 2), canonical_model_id: 'openai/beta' },
    },
  },
  plain: {
    models: {
      mystery: { cost: cost(7, 8) },
    },
  },
  p1: { models: { 'deepseek-orphan': { cost: cost(1, 1), canonical_model_id: 'deepseek/orphan' } } },
  p2: { models: { 'deepseek-orphan': { cost: cost(2, 2), canonical_model_id: 'openai/orphan' } } },
  'coding-plan': { models: { ignored: { cost: cost(1, 1) } } },
}

function bookOf() {
  const book = pricesBookOf(BOOK)
  assert.ok(book !== null)
  return book
}

function usageOf(values: Partial<Record<'uncached' | 'cacheRead' | 'cacheWrite' | 'output', number>>, period: 'peak' | 'off' = 'peak'): SessionCostUsage {
  return { deepseek: { 'deepseek-v3': { [period]: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...values } } } }
}

describe('shared pricing', () => {
  test('pricesBookOf rejects malformed payloads and unsafe keys', () => {
    for (const value of [null, undefined, 7, 'x', [], ['x']]) assert.equal(pricesBookOf(value), null)
    const book = pricesBookOf({
      empty: { models: {} },
      noModels: {},
      nullProvider: null,
      arrProvider: [],
      modelsNull: { models: null },
      okay: { models: {
        badCost: { cost: { input: -1, output: 2 } },
        noOutput: { cost: { input: 1 } },
        noCost: {},
        nullModel: null,
        '__proto__': { cost: cost(1, 1) },
        'constructor': { cost: cost(1, 1) },
        'prototype': { cost: cost(1, 1) },
        good: { cost: cost(2, 3, 1, 4), canonical_model_id: '' },
        canon: { cost: cost(2, 3), canonical_model_id: 'lab/model' },
      } },
      '__proto__': { models: { x: { cost: cost(1, 1) } } },
      'constructor': { models: { x: { cost: cost(1, 1) } } },
      'prototype': { models: { x: { cost: cost(1, 1) } } },
    })
    assert.ok(book !== null)
    assert.deepEqual(Object.keys(book.prices), ['okay'])
    assert.deepEqual(book.prices.okay, {
      good: { hit: 1, miss: 2, write: 4, out: 3 },
      canon: { hit: 2, miss: 2, write: 2, out: 3 },
    })
  })

  test('resolves direct, suffix, normalized and aliased branch prices', () => {
    const book = bookOf()
    const direct = priceResolutionOf(book, 'deepseek', 'deepseek-v3')
    assert.equal(direct.kind, 'priced')
    if (direct.kind === 'priced') {
      assert.deepEqual([direct.face.via, direct.face.confidence, direct.face.canonical], ['direct', 'high', 'deepseek/deepseek-v3'])
    }
    const suffix = priceResolutionOf(book, 'deepseek', 'v3')
    assert.equal(suffix.kind === 'priced' ? suffix.face.via : null, 'branch-suffix')
    const normalized = priceResolutionOf(book, 'deepseek', 'DeepSeek')
    assert.equal(normalized.kind === 'priced' ? normalized.face.via : null, 'branch-normalized')
    const alias = priceResolutionOf(book, 'deepseek-official', 'deepseek-v3')
    assert.equal(alias.kind === 'priced' ? alias.face.via : null, 'provider-alias')
    const exact = priceResolutionOf(book, 'deepseek', 'deepseek-v3')
    assert.equal(exact, direct, 'the resolution memo returns the first object')
  })

  test('resolves org branches, canonical makers, families and index fallbacks', () => {
    const book = bookOf()
    const org = priceResolutionOf(book, 'zzz', 'anthropic/claude-opus')
    assert.equal(org.kind === 'priced' ? org.face.via : null, 'org-branch')
    const maker = priceResolutionOf(book, 'zzz', 'claude-opus')
    assert.equal(maker.kind === 'priced' ? maker.face.via : null, 'canonical-maker')
    const family = priceResolutionOf(book, 'zzz', 'deepseek-model-v2')
    assert.equal(family.kind === 'priced' ? family.face.via : null, 'family')
    const index = priceResolutionOf(book, 'zzz', 'mystery')
    assert.equal(index.kind === 'priced' ? index.face.via : null, 'index')
    const plain = priceResolutionOf(null, 'deepseek', 'deepseek-v3')
    assert.equal(plain.kind === 'unpriced' ? plain.miss.reason : null, 'book-unavailable')
    const noEntry = priceResolutionOf(book, 'zzz', 'nothing-anywhere')
    assert.equal(noEntry.kind === 'unpriced' ? noEntry.miss.reason : null, 'no-entry')
    const unknown = priceResolutionOf(book, 'deepseek', 'not-in-branch')
    assert.equal(unknown.kind === 'unpriced' ? unknown.miss.reason : null, 'model-unknown')
  })

  test('reports ambiguity from branches, orgs, hints and the index', () => {
    const book = bookOf()
    const branch = priceResolutionOf(book, 'ambig', 'v9')
    assert.deepEqual(branch.kind === 'unpriced' ? branch.miss : null, { reason: 'ambiguous', candidates: 2 })
    const org = priceResolutionOf(book, 'zzz', 'ambig/v9')
    assert.deepEqual(org.kind === 'unpriced' ? org.miss : null, { reason: 'ambiguous', candidates: 2 })
    const hint = priceResolutionOf(book, 'zzz', 'deepseek-shared-model')
    assert.equal(hint.kind === 'priced' ? hint.face.via : null, 'canonical-maker')
    const missedHint = priceResolutionOf(book, 'zzz', 'deepseek-orphan')
    assert.deepEqual(missedHint.kind === 'unpriced' ? missedHint.miss : null, { reason: 'ambiguous', candidates: 2 })
    const noLab = priceResolutionOf(book, 'zzz', 'mystery')
    assert.equal(noLab.kind, 'priced')
  })

  test('exposes faces and rates and lists lookups for every usage row', () => {
    const book = bookOf()
    assert.equal(priceFaceOf(book, 'deepseek', 'deepseek-v3')?.via, 'direct')
    assert.equal(priceFaceOf(book, 'zzz', 'nothing-anywhere'), null)
    assert.deepEqual(priceOf(book, 'deepseek', 'deepseek-v3'), { hit: 0.5, miss: 1, write: 1.5, out: 2 })
    assert.equal(priceOf(book, 'zzz', 'nothing-anywhere'), null)
    assert.deepEqual(priceLookupsOf(null, book), [])
    assert.deepEqual(priceLookupsOf({}, null), [])
    const lookups = priceLookupsOf({
      deepseek: { 'deepseek-v3': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 1 } } },
      ghost: { phantom: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      broken: 7 as never,
    }, book)
    assert.deepEqual(lookups.map(lookup => [lookup.provider, lookup.face !== null]), [['deepseek', true], ['ghost', false]])
    assert.equal(lookups[1].face === null ? lookups[1].miss.reason : null, 'no-entry')
  })

  test('sums billed tokens and merges usage buckets', () => {
    assert.equal(billedTokensOf(null), 0)
    assert.equal(billedTokensOf(undefined), 0)
    assert.equal(billedTokensOf(usageOf({ uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 })), 10)
    const malformed = {
      bad: 7,
      arr: [],
      deepseek: { model: null, other: { peak: null, off: { uncached: 2 } }, bad: 42 },
    } as unknown as SessionCostUsage
    assert.equal(billedTokensOf(malformed), 2)
    const merged = mergeCostUsage(
      usageOf({ uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }),
      usageOf({ uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 }, 'off'),
      null,
    )
    assert.deepEqual(merged, {
      deepseek: { 'deepseek-v3': {
        peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
        off: { uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
      } },
    })
    assert.equal(mergeCostUsage(null, undefined), null)
    const skipped = mergeCostUsage({ bad: 7 as never, arr: [] as never, deepseek: { model: null as never, other: { peak: null as never } } } as never)
    assert.equal(skipped, null)
  })

  test('calculates session cost with the DeepSeek peak factor and currencies', () => {
    const book = bookOf()
    const usage = usageOf({ uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 })
    assert.equal(calculateSessionCost(null, book), null)
    assert.equal(calculateSessionCost(usage, null), null)
    assert.equal(calculateSessionCost(usage, book), (1 + 0.5 + 1.5 + 2) * 2)
    assert.equal(estimateSessionCost(usage, book, 'usd'), (1 + 0.5 + 1.5 + 2) * 2)
    assert.ok(Math.abs((estimateSessionCost(usage, book, 'cny') ?? 0) - (1 + 0.5 + 1.5 + 2) * 2 / 0.15) < 1e-9)
    assert.equal(estimateSessionCost(null, book, 'usd'), null)
    assert.equal(toCurrency(15, 'usd'), 15)
    assert.equal(toCurrency(1.5, 'cny'), 10)
    const off = calculateSessionCost(usageOf({ uncached: 1_000_000 }, 'off'), book)
    assert.equal(off, 1)
    const nonDeepseek = calculateSessionCost({
      zzz: { mystery: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }, book)
    assert.equal(nonDeepseek, 7)
    const malformed = {
      deepseek: {
        'deepseek-v3': { peak: null },
        unknown: { peak: { uncached: 1 } },
      },
      bad: 7,
    } as unknown as SessionCostUsage
    assert.equal(calculateSessionCost(malformed, book), null)
  })
})
