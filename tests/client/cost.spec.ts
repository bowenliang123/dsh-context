// Session-cost estimate (src/client/cost.ts): the model-price-book lookup tiers and the fixed 1 CNY = 0.15 USD conversion.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, priceFaceOf, priceIndexOf, priceOf, toCurrency } from '../../src/client/cost'
import type { ModelBook, ModelPrices } from '../../src/client/cost'
import type { CostBucketTotals, SessionCostUsage } from '../../src/shared/types'

const M = 1_000_000

/** Real-shaped rates (deepseek-v4-flash on models.dev — the official off-peak list; no cache_write published). */
const FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const PRO = { hit: 0.003625, miss: 0.435, write: 0.435, out: 0.87 }
const KIMI = { hit: 0.19, miss: 0.95, write: 0.95, out: 4 }
const K3 = { hit: 0.3, miss: 3, write: 3, out: 15 }

/** The book is keyed by the models.dev provider ids, exactly as extracted. */
const BOOK: ModelPrices = {
  deepseek: { 'deepseek-v4-flash': FLASH, 'deepseek-v4-pro': PRO },
  moonshotai: { 'kimi-k2.7-code': KIMI, 'kimi-k3': K3 },
  'opencode-go': { 'deepseek-v4-flash': FLASH },
}

/** A book plus its resolution index (npm absent → no vendor is "primary"). */
function bookOf(prices: ModelPrices, npmOf: Record<string, string | null> = {}): ModelBook {
  return { prices, index: priceIndexOf(prices, npmOf) }
}

const BOOK_B: ModelBook = bookOf(BOOK)

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`)
}

describe('toCurrency', () => {
  test('USD passes through; CNY divides the fixed 0.15 rate', () => {
    assert.equal(toCurrency(1.2, 'usd'), 1.2)
    close(toCurrency(1.2, 'cny'), 8)
    close(toCurrency(0.3, 'cny'), 2)
  })
})

describe('priceOf', () => {
  test('a mapped dsh provider id resolves to its models.dev branch', () => {
    assert.equal(priceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK_B, 'deepseek-account', 'deepseek-v4-pro'), PRO, 'both native DeepSeek routes share the branch')
  })

  test('an unmapped dsh provider id passes through to the book verbatim', () => {
    assert.equal(priceOf(BOOK_B, 'opencode-go', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(bookOf({ anthropic: { claude: KIMI } }), 'anthropic', 'claude'), KIMI)
  })

  test('a known provider falls back to a case-insensitive model match', () => {
    assert.equal(priceOf(bookOf({ minimax: { 'MiniMax-M2.5': KIMI } }), 'minimax-cn', 'minimax-m2.5'), KIMI)
  })

  test('a short dsh model id suffix-matches its namespaced registry id', () => {
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'k3'), K3)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'K3'), K3, 'the suffix tier is case-insensitive too')
  })

  test('several suffix candidates in one branch are ambiguous', () => {
    const book = bookOf({ moonshotai: { 'kimi-k3': K3, 'other-k3': KIMI } })
    assert.equal(priceOf(book, 'kimi-coding', 'k3'), null)
  })

  test('a known provider with an unknown model prices null (no cross-provider guess)', () => {
    assert.equal(priceOf(BOOK_B, 'deepseek', 'kimi-k2.7-code'), null)
  })

  test('a provider the book does not carry prices through the model-side index', () => {
    assert.deepEqual(priceOf(BOOK_B, '', 'kimi-k2.7-code'), KIMI, 'exactly one branch carries it')
    assert.deepEqual(priceOf(BOOK_B, 'future-provider', 'kimi-k2.7-code'), KIMI)
    assert.deepEqual(priceOf(BOOK_B, 'any-gateway', 'deepseek-v4-flash'), FLASH, 'the id names its vendor: deepseek')
    assert.equal(priceOf(BOOK_B, '', 'mystery'), null)
  })

  test('a null or missing book prices nothing', () => {
    assert.equal(priceOf(null, 'deepseek-official', 'deepseek-v4-flash'), null)
    assert.equal(priceOf(undefined, '', 'kimi-k2.7-code'), null)
    assert.equal(priceOf(bookOf({}), '', 'kimi-k2.7-code'), null)
  })
})

describe('priceIndexOf / the model-side resolution tiers', () => {
  const ANTHROPIC_RATE = { hit: 0.2, miss: 2, write: 2.5, out: 10 }
  const MIRROR_RATE = { hit: 0.2, miss: 2, write: 2.5, out: 10 }
  const VENDOR_BOOK: ModelPrices = {
    anthropic: { 'claude-sonnet-5': ANTHROPIC_RATE, 'claude-haiku-4': ANTHROPIC_RATE },
    openrouter: { 'claude-sonnet-5': MIRROR_RATE },
    vivgrid: { 'claude-sonnet-5': { hit: 0.5, miss: 2, write: 2.5, out: 10 } },
    'bare-host': { 'gpt-oss-120b': KIMI },
  }
  const VENDOR_NPM = {
    anthropic: '@ai-sdk/anthropic',
    openrouter: '@openrouter/ai-sdk-provider',
    vivgrid: '@ai-sdk/openai',
    'bare-host': null,
  }
  const VENDOR_B = bookOf(VENDOR_BOOK, VENDOR_NPM)

  test('the index lists each model under its exact key and suffix tails', () => {
    const tails = [...VENDOR_B.index.byModel.get('sonnet-5') ?? []]
    assert.ok(tails.some(c => c.pid === 'anthropic'), 'the `-tail` of a registry id is indexed for short dsh spellings')
    const exact = [...VENDOR_B.index.byModel.get('claude-sonnet-5') ?? []]
    assert.equal(exact.filter(c => c.pid === 'anthropic').length, 1, 'the same provider and rate dedups across keys')
  })

  test('the vendor flag is a provider whose @ai-sdk package is named after itself', () => {
    const exact = new Map([...VENDOR_B.index.byModel.get('claude-sonnet-5') ?? []].map(c => [c.pid, c]))
    assert.equal(exact.get('anthropic')?.primary, true)
    assert.equal(exact.get('openrouter')?.primary, false, 'a foreign gateway package is not the vendor')
    assert.equal(exact.get('vivgrid')?.primary, false, 'riding @ai-sdk/openai does not make vivgrid OpenAI')
  })

  test('tier: the model-own vendor wins (issue #91: unknown routes price claude/gpt models)', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'claude', 'claude-sonnet-5'), ANTHROPIC_RATE)
    assert.deepEqual(priceOf(VENDOR_B, 'codex', 'claude-sonnet-5'), ANTHROPIC_RATE, 'the proxy route spells no vendor')
  })

  test('tier: the org segment of vendor/model dialects names the vendor', () => {
    const orgBook = bookOf({
      deepseek: { 'deepseek-v4-pro': PRO },
      gateway: { 'deepseek-v4-pro': KIMI },
      acme: { 'acme/model-1': K3 },
    }, { deepseek: '@ai-sdk/openai-compatible', gateway: '@ai-sdk/openai-compatible' })
    assert.deepEqual(priceOf(orgBook, 'together', 'deepseek-ai/DeepSeek-V4-Pro'), PRO, 'deepseek-ai resolves to the deepseek branch')
    assert.deepEqual(priceOf(orgBook, 'unknown', 'acme/model-1'), K3, 'an org naming its own provider resolves on the full id')
    assert.equal(priceOf(orgBook, 'together', 'zzz-org/Mystery'), null, 'an org and model nothing matches price nothing')
  })

  test('tier: a provider the model id itself names wins over mirrors', () => {
    assert.deepEqual(priceOf(BOOK_B, 'any-gateway', 'deepseek-v4-flash'), FLASH, 'deepseek-v4-flash names deepseek')
  })

  test('a deepseek- model id prices from the first-party branch first (issue #93)', () => {
    // The live-registry shape: azure re-lists `deepseek-v4-pro` flat (no
    // cache_read published) and its `@ai-sdk/azure` package is the only
    // self-named one — DeepSeek rides `@ai-sdk/openai-compatible`, so the
    // model-side tiers would hand the id to azure. The `deepseek-` spelling prices from DeepSeek's own listing instead.
    const AZURE_FLAT = { hit: 1.74, miss: 1.74, write: 1.74, out: 3.48 }
    const hostBook = bookOf({
      deepseek: { 'deepseek-v4-pro': PRO },
      azure: { 'deepseek-v4-pro': AZURE_FLAT, 'deepseek-v4-pro-0813': AZURE_FLAT, 'gpt-x': AZURE_FLAT },
    }, { deepseek: '@ai-sdk/openai-compatible', azure: '@ai-sdk/azure' })
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro'), PRO, 'the id names deepseek; a self-named SDK proves hosting, not authorship')
    assert.deepEqual(priceOf(hostBook, 'hx', 'DeepSeek-V4-Pro'), PRO, 'the seam is case-insensitive')
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro-0813'), AZURE_FLAT, 'an id the first party does not list falls back to the model-side tiers')
    assert.deepEqual(priceOf(hostBook, 'hx', 'gpt-x'), AZURE_FLAT, 'a model id outside the seam resolves as before')
    const hostOnly = bookOf({ azure: { 'deepseek-junk': AZURE_FLAT } }, { azure: '@ai-sdk/azure' })
    assert.deepEqual(priceOf(hostOnly, 'hx', 'deepseek-junk'), AZURE_FLAT, 'no first-party branch in the book leaves the tiers in charge')
  })

  test('an org that is a price-book provider prices its own branch, not an aggregator key (issue #174)', () => {
    // Magpie writes `<provider>/<model>`. models.dev's llmgateway-providers files
    // `google-vertex/gemini-4-argon` as its own model key, so a full-id lookup
    // used to return that lone carrier before Vertex's branch was considered.
    // `google` is also primary and a prefix of `google-vertex`, at a different
    // cache-write rate, so a bare-id pass through the org rule would tie.
    const VERTEX = { hit: 0.1, miss: 2, write: 2, out: 10 }
    const GOOGLE = { hit: 0.1, miss: 2, write: 9, out: 10 }
    const AGG = { hit: 0.2, miss: 4, write: 0.375, out: 20 }
    const GEMINI_FLASH = { hit: 0.15, miss: 1.5, write: 1.5, out: 9 }
    const FLASH_AGG = { hit: 0.15, miss: 1.5, write: 0.0833, out: 9 }
    const gateway = bookOf({
      google: { 'gemini-4-argon': GOOGLE, 'gemini-3.5-flash': GEMINI_FLASH },
      'google-vertex': { 'gemini-4-argon': VERTEX, 'gemini-3.5-flash': GEMINI_FLASH },
      'llmgateway-providers': {
        'google-vertex/gemini-4-argon': AGG,
        'google-vertex/gemini-3.5-flash': FLASH_AGG,
        'google/gemini-4-argon': AGG,
        'not-a-provider/kimi-k2.7-code': AGG,
      },
      deepseek: { 'deepseek-v4-pro': PRO },
      moonshotai: { 'kimi-k2.7-code': KIMI },
    }, {
      google: '@ai-sdk/google',
      'google-vertex': '@ai-sdk/google-vertex',
      'llmgateway-providers': '@ai-sdk/openai-compatible',
      deepseek: '@ai-sdk/openai-compatible',
      moonshotai: '@ai-sdk/openai-compatible',
    })
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'google-vertex/gemini-4-argon'), { pid: 'google-vertex', mid: 'gemini-4-argon', rate: VERTEX })
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'Google-Vertex/Gemini-4-Argon'), { pid: 'google-vertex', mid: 'gemini-4-argon', rate: VERTEX }, 'the org and model spelling are case-insensitive')
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'google-vertex/gemini-3.5-flash'), { pid: 'google-vertex', mid: 'gemini-3.5-flash', rate: GEMINI_FLASH }, 'a matching input/output still keeps the vendor cache-write rate')
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'google/gemini-4-argon'), { pid: 'google', mid: 'gemini-4-argon', rate: GOOGLE }, 'the named provider is exact, not the longer vertex id')
    // Bare id: no org segment, so the model-side tiers stay in charge.
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'kimi-k2.7-code'), { pid: 'moonshotai', mid: 'kimi-k2.7-code', rate: KIMI })
    // `deepseek-` ids still price from the first-party branch ahead of the index.
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'deepseek-v4-pro'), { pid: 'deepseek', mid: 'deepseek-v4-pro', rate: PRO })
    assert.equal(priceOf(gateway, 'deepseek-official', 'deepseek-v4-pro'), PRO, 'a native DeepSeek route still prices its own branch')
    // The org provider does not list this model: fall through to the bare id.
    assert.deepEqual(priceOf(gateway, 'magpie', 'google-vertex/kimi-k2.7-code'), KIMI)
    // An org that is not a provider keeps the full-id carrier, even when the bare id exists elsewhere.
    assert.deepEqual(priceFaceOf(gateway, 'magpie', 'not-a-provider/kimi-k2.7-code'), { pid: 'llmgateway-providers', mid: 'not-a-provider/kimi-k2.7-code', rate: AGG })
    // A non-rate on the org branch is not indexed; the later tiers still run.
    const partial = bookOf({
      'google-vertex': { 'gemini-4-argon': { hit: 1 } },
      solo: { 'gemini-4-argon': K3 },
    } as unknown as ModelPrices)
    assert.deepEqual(priceOf(partial, 'magpie', 'google-vertex/gemini-4-argon'), K3)
  })

  test('tier: a lone carrier prices without any vendor signal', () => {
    const lone = bookOf({ solo: { 'weird-model-9': K3 } })
    assert.deepEqual(priceOf(lone, 'unknown', 'weird-model-9'), K3)
  })

  test('disagreeing candidates price nothing unless a majority agrees', () => {
    const disagree = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b' })
    assert.equal(priceOf(disagree, '', 'x'), null, 'two disagreeing vendors refuse')
    const majority = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
      c: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      d: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b', c: '@ai-sdk/c', d: '@ai-sdk/d' })
    assert.equal(priceOf(majority, '', 'x')?.hit, 1, 'the agreeing majority carries the rate')
  })

  test('float noise in registry sync counts as agreement', () => {
    const noisy = bookOf({
      a: { 'x': { hit: 0.125, miss: 1, write: 1, out: 2 } },
      b: { 'x': { hit: 0.12500000000000003, miss: 1, write: 1, out: 2 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b' })
    assert.equal(priceOf(noisy, '', 'x')?.hit, 0.125)
  })

  test('registry ids are matched case-insensitively', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'claude', 'Claude-Sonnet-5'), ANTHROPIC_RATE)
  })

  test('an org-prefixed dialect falls back to its bare last segment', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'together', 'openai/gpt-oss-120b'), KIMI, 'the bare id resolves once the unknown org is stripped')
    assert.deepEqual(priceOf(VENDOR_B, 'unknown', 'ZZZ/Gpt-Oss-120B'), KIMI, 'the segment lookup is case-insensitive too')
  })

  test('hostile branches and rate entries are skipped at index build', () => {
    const hostile = bookOf({
      junk: ['nope'],
      broken: { 'x': 'nope' },
      good: { 'x': KIMI },
    } as unknown as ModelPrices, { junk: 7 as unknown as string, broken: undefined as unknown as string })
    assert.deepEqual(priceOf(hostile, '', 'x'), KIMI)
    assert.equal(priceOf(hostile, '', 'y'), null)
  })

  test('a non-record branch is refused whole; identical re-pushes dedup', () => {
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const index = priceIndexOf({ junk: 5, a: { 'x-y': R1, 'z-y': R1 }, b: { 'x': { hit: 1 } } } as unknown as ModelPrices, {})
    assert.equal([...index.byModel.get('y') ?? []].length, 1, 'same provider at the same rate lists once')
    assert.equal(index.byModel.get('junk'), undefined)
    assert.equal(index.byModel.get('x'), undefined, 'the partial rate entry dropped')
  })

  test('a tier whose candidates disagree falls through to the next tier', () => {
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const R2 = { hit: 2, miss: 2, write: 2, out: 2 }
    const org = bookOf({
      xx: { 'm': R1 },
      'xx-ai': { 'm': R2 },
    }, { xx: '@ai-sdk/openai-compatible', 'xx-ai': '@ai-sdk/openai-compatible' })
    assert.deepEqual(priceOf(org, '', 'xx-ai/m'), R2, 'an org that is itself a provider prices that branch')
    assert.equal(priceOf(org, '', 'xx-ai-lab/m'), null, 'a longer org that names both providers still ties')
    const prefix = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R2 },
    })
    assert.equal(priceOf(prefix, '', 'x-y-z'), null, 'prefix tier ties and nothing below resolves')
    const agree = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R1 },
    })
    assert.deepEqual(priceOf(agree, '', 'x-y-z'), R1, 'a unanimous prefix tier carries the rate')
  })
})

describe('billedTokensOf (the token face of the billed buckets)', () => {
  test('null and empty usages total zero', () => {
    assert.equal(billedTokensOf(null), 0)
    assert.equal(billedTokensOf(undefined), 0)
    assert.equal(billedTokensOf({}), 0)
  })

  test('sums every bucket across providers, models, and periods', () => {
    const usage: SessionCostUsage = {
      p1: {
        m1: { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, off: { uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 } },
        m2: { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
      p2: { m3: { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 1000 } } },
    }
    assert.equal(billedTokensOf(usage), 1 + 2 + 3 + 4 + 10 + 20 + 30 + 40 + 100 + 1000)
  })

  test('hostile branches skip, the estimator’s own resilience', () => {
    const usage = {
      junk: 5,
      p: { m: 'garbage', m2: { peak: null, off: { uncached: 'x', cacheRead: 7 } } },
    } as unknown as SessionCostUsage
    // The non-record provider/model/period branches drop whole; the junk
    // bucket field coerces to zero (numOf), the number survives.
    assert.equal(billedTokensOf(usage), 7)
  })
})

describe('estimateSessionCost', () => {  test('null usage or null book prices to null', () => {
    assert.equal(estimateSessionCost(null, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK_B, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
  })

  test('usage without any priced bucket returns null', () => {
    assert.equal(estimateSessionCost({}, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), null)
  })

  test('a provider id the registry does not know still prices by model id', () => {
    // The issue #91 shape: a subscription/proxy route (`claude`, a gateway)
    // whose models live under the vendor's registry branch.
    close(estimateSessionCost({ unmapped: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), 0.15)
  })

  test('prices every period bucket at its own rate (hit / miss / write / out)', () => {
    const usage = {
      'deepseek-official': {
        'deepseek-v4-flash': { off: bucket(M, M, M, M) },
        'deepseek-v4-pro': { off: bucket(M, M, M, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, M) } },
    }
    close(estimateSessionCost(usage, BOOK_B, 'usd'), 0.903 + (0.003625 + 0.435 + 0.435 + 0.87) + 0.95 + 4)
  })

  test('peak buckets price at twice the book rate for DeepSeek only', () => {
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
    close(
      estimateSessionCost({ 'kimi-coding': { 'kimi-k2.7-code': split } }, BOOK_B, 'usd'),
      0.95 + 0.95,
      'a flat-rate provider bills a peak bucket at book price, never doubled',
    )
    // The account route shares DeepSeek's period list, so its peak buckets
    // double too — the fold splits them only since providers.ts maps it.
    close(estimateSessionCost({ 'deepseek-account': { 'deepseek-v4-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
  })

  test('a missing model is skipped while priced ones still sum', () => {
    const usage = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK_B, 'usd'), 0.95)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    // 1M peak-window miss bills the official CNY peak price: ¥2.
    close(estimateSessionCost(usage, BOOK_B, 'cny'), 2)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: garbage } } }, BOOK_B, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: mixed } } }, BOOK_B, 'usd'), 2 * (0.003 + 0.5 * 0.15))
  })

  test('hostile provider branches, periods, and buckets are skipped, not fatal', () => {
    const usage = {
      junk: 'x',
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } },
    } as unknown as { [provider: string]: Record<string, Record<string, CostBucketTotals>> }
    close(estimateSessionCost(usage, BOOK_B, 'usd'), 0.3 + 0.95)
  })
})

describe('mergeCostUsage', () => {
  test('sums every bucket across usages, keyed by provider, model, and period', () => {
    const merged = mergeCostUsage(
      { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } },
      {
        'deepseek-official': {
          'deepseek-v4-flash': { peak: bucket(2 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
          'deepseek-v4-pro': { peak: bucket(0, 0, 0, M) },
        },
        'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 3 * M, 0, 0) } },
      },
    )
    assert.deepEqual(merged, {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(3 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
        'deepseek-v4-pro': { peak: bucket(0, 0, 0, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 3 * M, 0, 0) } },
    })
  })

  test('the merged estimate equals the sum of the sides priced apart', () => {
    const a = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, M, 0, 0) } } }
    const b = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 2 * M, 0, 0) } } }
    const total = estimateSessionCost(mergeCostUsage(a, b), BOOK_B, 'usd')
    close(total ?? 0, (estimateSessionCost(a, BOOK_B, 'usd') ?? 0) + (estimateSessionCost(b, BOOK_B, 'usd') ?? 0))
  })

  test('null and absent sides drop out; nothing usable merges to null', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(null, usage, undefined), usage)
    assert.equal(mergeCostUsage(null, undefined, null), null)
    assert.equal(mergeCostUsage(), null)
  })

  test('a bucket that merged with only zeros still counts (the estimator prices $0, not a dash)', () => {
    const zero = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(zero), zero)
    assert.equal(estimateSessionCost(mergeCostUsage(zero), BOOK_B, 'usd'), 0)
  })

  test('hostile branches are skipped, not fatal, and the inputs never mutate', () => {
    const a = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }
    const hostile = {
      junk: 5,
      arr: [{ peak: bucket(M, 0, 0, 0) }],
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
    } as unknown as Record<string, never>
    const merged = mergeCostUsage(a, hostile)
    assert.deepEqual(merged, {
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } },
      'kimi-coding': { 'kimi-k2.7-code': { off: bucket(0, M, 0, 0) } },
    })
    assert.deepEqual(a, { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }, 'the source usage stays untouched')
  })
})

describe('priceFaceOf', () => {
  test('names the registry face every resolution path lands on', () => {
    // Direct branch: the dsh provider's rename maps onto the registry id.
    assert.deepEqual(priceFaceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), { pid: 'deepseek', mid: 'deepseek-v4-flash', rate: FLASH })
    assert.deepEqual(priceFaceOf(BOOK_B, 'kimi-coding', 'k3'), { pid: 'moonshotai', mid: 'kimi-k3', rate: K3 }, 'the suffix path names the full registry spelling')
    // First-party seam: a deepseek- id prices from DeepSeek's own branch.
    assert.deepEqual(priceFaceOf(BOOK_B, 'future-gateway', 'deepseek-v4-pro'), { pid: 'deepseek', mid: 'deepseek-v4-pro', rate: PRO })
    // Model-side tiers: the winning candidate's own face.
    assert.deepEqual(priceFaceOf(BOOK_B, 'any-gateway', 'kimi-k2.7-code'), { pid: 'moonshotai', mid: 'kimi-k2.7-code', rate: KIMI })
    assert.equal(priceFaceOf(BOOK_B, '', 'mystery'), null)
    assert.equal(priceFaceOf(null, 'deepseek-official', 'deepseek-v4-flash'), null)
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
  })

  test('amounts below 1 use two-significant-digit precision', () => {
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
  })

  test('the CNY currency uses the yen symbol', () => {
    assert.equal(formatCost(12.3, 'cny'), '¥12.30')
    assert.equal(formatCost(0.66, 'cny'), '¥0.66')
  })
})

describe('formatPriceRate', () => {
  test('always renders two decimals in the currency symbol', () => {
    assert.equal(formatPriceRate(3, 'cny'), '¥3.00')
    assert.equal(formatPriceRate(4.5, 'cny'), '¥4.50')
    assert.equal(formatPriceRate(0.007, 'usd'), '$0.01')
    assert.equal(formatPriceRate(0.1, 'usd'), '$0.10')
  })
})
