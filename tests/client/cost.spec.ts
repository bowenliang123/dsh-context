import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, billedTokensOf, mergeCostUsage, priceFaceOf, priceIndexOf, priceLookupsOf, priceOf, priceResolutionOf, pricesBookOf, toCurrency } from '../../src/shared/pricing'
import type { ModelBook, ModelPrices } from '../../src/shared/pricing'
import { formatCost, formatPriceRate } from '../../src/client/cost'
import type { CostBucketTotals, SessionCostUsage } from '../../src/shared/types'

const M = 1_000_000

const FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const PRO = { hit: 0.003625, miss: 0.435, write: 0.435, out: 0.87 }
const KIMI = { hit: 0.19, miss: 0.95, write: 0.95, out: 4 }
const K3 = { hit: 0.3, miss: 3, write: 3, out: 15 }

const BOOK: ModelPrices = {
  deepseek: { 'deepseek-v4-flash': FLASH, 'deepseek-v4-pro': PRO },
  moonshotai: { 'kimi-k2.7-code': KIMI, 'kimi-k3': K3 },
  'opencode-go': { 'deepseek-v4-flash': FLASH },
}

function bookOf(prices: ModelPrices, canonicalOf: Record<string, Record<string, string>> = {}): ModelBook {
  return { prices, index: priceIndexOf(prices, canonicalOf) }
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
  test('mapped and verbatim provider ids and short suffix model ids resolve to their branch rates', () => {
    assert.equal(priceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK_B, 'deepseek-account', 'deepseek-v4-pro'), PRO, 'both native DeepSeek routes share the branch')
    assert.equal(priceOf(BOOK_B, 'opencode-go', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(bookOf({ anthropic: { claude: KIMI } }), 'anthropic', 'claude'), KIMI)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'k3'), K3)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'K3'), K3, 'the suffix tier is case-insensitive too')
  })

  test('several suffix candidates in one branch are ambiguous', () => {
    const book = bookOf({ moonshotai: { 'kimi-k3': K3, 'other-k3': KIMI } })
    assert.equal(priceOf(book, 'kimi-coding', 'k3'), null)
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
  const VENDOR_B = bookOf(VENDOR_BOOK)

  test('the branch index keeps suffix tails; the global index keeps exact keys', () => {
    const branch = VENDOR_B.index.branches.get('anthropic')
    assert.ok(branch?.bySuffix.get('sonnet-5')?.some(c => c.pid === 'anthropic'), 'short spellings resolve inside a known branch')
    assert.equal(VENDOR_B.index.byModel.get('sonnet-5'), undefined, 'the global index never guesses by suffix')
    const exact = [...VENDOR_B.index.byModel.get('claude-sonnet-5') ?? []]
    assert.equal(exact.filter(c => c.pid === 'anthropic').length, 1)
  })

  test('tier: vendor, org, family, and carrier signals resolve; an unmatchable org and model price nothing', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'claude', 'claude-sonnet-5'), ANTHROPIC_RATE)
    assert.deepEqual(priceOf(VENDOR_B, 'codex', 'claude-sonnet-5'), ANTHROPIC_RATE, 'the proxy route spells no vendor')
    const orgBook = bookOf({
      deepseek: { 'deepseek-v4-pro': PRO },
      gateway: { 'deepseek-v4-pro': KIMI },
      acme: { 'acme/model-1': K3 },
    })
    assert.deepEqual(priceOf(orgBook, 'together', 'deepseek-ai/DeepSeek-V4-Pro'), PRO, 'deepseek-ai resolves to the deepseek branch')
    assert.deepEqual(priceOf(orgBook, 'unknown', 'acme/model-1'), K3, 'an org naming its own provider resolves on the full id')
    assert.equal(priceOf(orgBook, 'together', 'zzz-org/Mystery'), null, 'an org and model nothing matches price nothing')
    assert.deepEqual(priceOf(BOOK_B, 'any-gateway', 'deepseek-v4-flash'), FLASH, 'deepseek-v4-flash names deepseek')
    const lone = bookOf({ solo: { 'weird-model-9': K3 } })
    assert.deepEqual(priceOf(lone, 'unknown', 'weird-model-9'), K3, 'a lone carrier prices without any vendor signal')
  })

  test('a deepseek- model id prices from the first-party branch first (issue #93)', () => {
    const AZURE_FLAT = { hit: 1.74, miss: 1.74, write: 1.74, out: 3.48 }
    const hostBook = bookOf({
      deepseek: { 'deepseek-v4-pro': PRO },
      azure: { 'deepseek-v4-pro': AZURE_FLAT, 'deepseek-v4-pro-0813': AZURE_FLAT, 'gpt-x': AZURE_FLAT },
    })
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro'), PRO, 'the id names deepseek; a self-named SDK proves hosting, not authorship')
    assert.deepEqual(priceOf(hostBook, 'hx', 'DeepSeek-V4-Pro'), PRO, 'the seam is case-insensitive')
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro-0813'), AZURE_FLAT, 'an id the first party does not list falls back to the model-side tiers')
    assert.deepEqual(priceOf(hostBook, 'hx', 'gpt-x'), AZURE_FLAT, 'a model id outside the seam resolves as before')
    const hostOnly = bookOf({ azure: { 'deepseek-junk': AZURE_FLAT } })
    assert.deepEqual(priceOf(hostOnly, 'hx', 'deepseek-junk'), AZURE_FLAT, 'no first-party branch in the book leaves the tiers in charge')
  })

  test('unaccounted candidates never win by rate majority alone; float noise counts as agreement', () => {
    const disagree = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
    })
    assert.equal(priceOf(disagree, '', 'x'), null, 'two disagreeing vendors refuse')
    const majority = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
      c: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      d: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
    })
    assert.equal(priceOf(majority, '', 'x'), null, 'a plurality does not outrank an honest ambiguity')
    const noisy = bookOf({
      a: { 'x': { hit: 0.125, miss: 1, write: 1, out: 2 } },
      b: { 'x': { hit: 0.12500000000000003, miss: 1, write: 1, out: 2 } },
    })
    assert.equal(priceOf(noisy, '', 'x')?.hit, 0.125)
  })

  test('an org-prefixed dialect and an explicit org branch resolve; prefix-shaped suffixes still refuse', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'together', 'openai/gpt-oss-120b'), KIMI, 'the bare id resolves once the unknown org is stripped')
    assert.deepEqual(priceOf(VENDOR_B, 'unknown', 'ZZZ/Gpt-Oss-120B'), KIMI, 'the segment lookup is case-insensitive too')
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const R2 = { hit: 2, miss: 2, write: 2, out: 2 }
    const org = bookOf({
      xx: { 'm': R1 },
      'xx-ai': { 'm': R2 },
    })
    assert.deepEqual(priceOf(org, '', 'xx-ai/m'), R2, 'the org segment names a real branch')
    const prefix = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R2 },
    })
    assert.equal(priceOf(prefix, '', 'x-y-z'), null, 'prefix-shaped suffixes still refuse')
    const agree = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R1 },
    })
    assert.deepEqual(priceOf(agree, '', 'x-y-z'), R1, 'a unanimous suffix tier carries the rate')
  })

  test('hostile branches and partial rate entries are skipped at index build', () => {
    const hostile = bookOf({
      junk: ['nope'],
      broken: { 'x': 'nope' },
      good: { 'x': KIMI },
    } as unknown as ModelPrices)
    assert.deepEqual(priceOf(hostile, '', 'x'), KIMI)
    assert.equal(priceOf(hostile, '', 'y'), null)
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const index = priceIndexOf({ junk: 5, a: { 'x-y': R1, 'z-y': R1 }, b: { 'x': { hit: 1 } } } as unknown as ModelPrices, {})
    assert.equal([...index.byModel.get('x-y') ?? []].length, 1)
    assert.equal(index.byModel.get('y'), undefined, 'suffix tails are branch-local')
    assert.equal(index.byModel.get('junk'), undefined)
    assert.equal(index.byModel.get('x'), undefined, 'the partial rate entry dropped')
  })
})

describe('billedTokensOf (the token face of the billed buckets)', () => {
  test('any usage key mapping is summed across providers, models, and periods; null and empty total zero', () => {
    assert.equal(billedTokensOf(null), 0)
    assert.equal(billedTokensOf(undefined), 0)
    assert.equal(billedTokensOf({}), 0)
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
    assert.equal(billedTokensOf(usage), 7)
  })
})

describe('estimateSessionCost', () => {
  test('null usage or book, and usage without any priced bucket, price to null', () => {
    assert.equal(estimateSessionCost(null, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK_B, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
    assert.equal(estimateSessionCost({}, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), null)
  })

  test('a provider id the registry does not know still prices by model id', () => {
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
    close(estimateSessionCost({ 'deepseek-account': { 'deepseek-v4-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK_B, 'cny'), 2)
  })

  test('non-number bucket fields are coerced to zero while real fields still price', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: garbage } } }, BOOK_B, 'usd'), 0)
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

  test('null and absent sides drop out; nothing usable merges to null; an all-zero bucket still counts', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(null, usage, undefined), usage)
    assert.equal(mergeCostUsage(null, undefined, null), null)
    assert.equal(mergeCostUsage(), null)
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
    assert.deepEqual(priceFaceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), {
      pid: 'deepseek', mid: 'deepseek-v4-flash', rate: FLASH, via: 'provider-alias', confidence: 'high',
    })
    assert.deepEqual(priceFaceOf(BOOK_B, 'kimi-coding', 'k3'), {
      pid: 'moonshotai', mid: 'kimi-k3', rate: K3, via: 'provider-alias', confidence: 'high',
    }, 'the suffix path names the full registry spelling')
    assert.deepEqual(priceFaceOf(BOOK_B, 'future-gateway', 'deepseek-v4-pro'), {
      pid: 'deepseek', mid: 'deepseek-v4-pro', rate: PRO, via: 'family', confidence: 'medium',
    })
    assert.deepEqual(priceFaceOf(BOOK_B, 'any-gateway', 'kimi-k2.7-code'), {
      pid: 'moonshotai', mid: 'kimi-k2.7-code', rate: KIMI, via: 'family', confidence: 'medium',
    })
    assert.equal(priceFaceOf(BOOK_B, '', 'mystery'), null)
    assert.equal(priceFaceOf(null, 'deepseek-official', 'deepseek-v4-flash'), null)
  })
})

describe('canonical authority and branch dialects', () => {
  const ANTHROPIC_RATE = { hit: 0.1, miss: 2, write: 2.5, out: 10 }
  const AZURE_ANTHROPIC_RATE = { hit: 0.2, miss: 2, write: 2.5, out: 10 }
  const OPENAI_RATE = { hit: 0.4, miss: 4, write: 5, out: 20 }
  const AZURE_OPENAI_RATE = { hit: 0.5, miss: 4, write: 6.25, out: 20 }
  const VERTEX_RATE = { hit: 0.1, miss: 2, write: 2, out: 10 }
  const LLM_GATEWAY_RATE = { hit: 0.2, miss: 4, write: 0.375, out: 20 }
  const CLOUDFLARE_RATE = { hit: 0.2, miss: 10, write: 12.5, out: 50 }
  const OPENCODE_RATE = { hit: 0.12, miss: 2.2, write: 2.2, out: 11 }
  const ZHIPU_RATE = { hit: 0.23, miss: 0.8, write: 0.8, out: 2.8 }
  const ZAI_RATE = { hit: 0.3, miss: 1, write: 1, out: 3 }
  const PRICES: ModelPrices = {
    anthropic: { 'claude-sonnet-5-5': ANTHROPIC_RATE, 'claude-mystery': ANTHROPIC_RATE },
    azure: { 'claude-sonnet-5-5': AZURE_ANTHROPIC_RATE, 'gpt-5.6-sol': AZURE_OPENAI_RATE },
    openai: { 'gpt-5.6-sol': OPENAI_RATE, 'claude-mystery': OPENAI_RATE },
    'google-vertex': { 'gemini-4-argon': VERTEX_RATE },
    'llmgateway-providers': { 'google-vertex/gemini-4-argon': LLM_GATEWAY_RATE },
    'cloudflare-ai-gateway': { 'anthropic/claude-fable-5': CLOUDFLARE_RATE },
    opencode: { 'claude-sonnet-5': OPENCODE_RATE, 'kimi-k3': K3 },
    'opencode-go': { 'glm-5.3': ZHIPU_RATE },
    moonshotai: { 'kimi-k3': K3 },
    zhipuai: { 'glm-5.3': ZHIPU_RATE },
    zai: { 'glm-5.3': ZAI_RATE },
    reseller: { 'claude-sonnet-5-5': KIMI, 'glm-5.3': KIMI },
    'fireworks-ai': { 'model-1': K3 },
    togetherai: { 'model-1': K3 },
    vercel: { 'model-1': K3 },
    'alibaba-token-plan': { 'model-1': K3 },
    'alibaba-token-plan-cn': { 'model-1': K3 },
    laba: { other: K3 },
    labb: { other: K3 },
    'multi-a': { mystery: K3 },
    'multi-b': { mystery: KIMI },
  }
  const CANON: Record<string, Record<string, string>> = {
    anthropic: { 'claude-sonnet-5-5': 'anthropic/claude-sonnet-5-5', 'claude-mystery': 'anthropic/claude-mystery' },
    azure: { 'claude-sonnet-5-5': 'anthropic/claude-sonnet-5-5', 'gpt-5.6-sol': 'openai/gpt-5.6-sol' },
    openai: { 'gpt-5.6-sol': 'openai/gpt-5.6-sol', 'claude-mystery': 'openai/claude-mystery' },
    'google-vertex': { 'gemini-4-argon': 'google/gemini-4-argon' },
    'llmgateway-providers': { 'google-vertex/gemini-4-argon': 'google/gemini-4-argon' },
    'cloudflare-ai-gateway': { 'anthropic/claude-fable-5': 'anthropic/claude-fable-5' },
    opencode: { 'claude-sonnet-5': 'anthropic/claude-sonnet-5', 'kimi-k3': 'moonshotai/kimi-k3' },
    'opencode-go': { 'glm-5.3': 'zhipuai/glm-5.3' },
    moonshotai: { 'kimi-k3': 'moonshotai/kimi-k3' },
    zhipuai: { 'glm-5.3': 'zhipuai/glm-5.3' },
    zai: { 'glm-5.3': 'zhipuai/glm-5.3' },
    reseller: { 'claude-sonnet-5-5': 'anthropic/claude-sonnet-5-5', 'glm-5.3': 'zhipuai/glm-5.3' },
    laba: { other: 'laba/other' },
    labb: { other: 'labb/other' },
    'multi-a': { mystery: 'laba/mystery' },
    'multi-b': { mystery: 'labb/mystery' },
  }
  const CANON_BOOK = bookOf(PRICES, CANON)

  test('authority tiers: canonical maker, direct branch, org branch, branch dialect, normalization, zen, and aliases', () => {
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'proxy', 'gpt-5.6-sol'), { pid: 'openai', mid: 'gpt-5.6-sol', rate: OPENAI_RATE, via: 'canonical-maker', confidence: 'high', canonical: 'openai/gpt-5.6-sol' })
    assert.equal(priceFaceOf(CANON_BOOK, 'CLIProxyAPI', 'claude-sonnet-5-5')?.pid, 'anthropic')
    assert.equal(priceFaceOf(CANON_BOOK, 'claude-vision', 'claude-sonnet-5-5')?.via, 'canonical-maker')
    assert.equal(priceFaceOf(CANON_BOOK, 'codex-vision', 'gpt-5.6-sol')?.via, 'canonical-maker')
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'magpie', 'google-vertex/gemini-4-argon'), { pid: 'google-vertex', mid: 'gemini-4-argon', rate: VERTEX_RATE, via: 'org-branch', confidence: 'high', canonical: 'google/gemini-4-argon' })
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'cloudflare-ai-gateway', 'claude-fable-5'), { pid: 'cloudflare-ai-gateway', mid: 'anthropic/claude-fable-5', rate: CLOUDFLARE_RATE, via: 'branch-suffix', confidence: 'high', canonical: 'anthropic/claude-fable-5' })
    assert.equal(priceFaceOf(CANON_BOOK, 'chanyan', 'kimi-k3')?.pid, 'moonshotai')
    assert.equal(priceFaceOf(CANON_BOOK, 'chanyan', 'glm-5.3')?.pid, 'zhipuai')
    assert.deepEqual(priceResolutionOf(CANON_BOOK, 'chanyan', 'k3'), { kind: 'unpriced', miss: { reason: 'no-entry' } })
    assert.equal(priceFaceOf(CANON_BOOK, 'azure', 'gpt-5.6-sol')?.pid, 'azure')
    assert.equal(priceFaceOf(CANON_BOOK, 'openai', 'gpt-5.6-sol')?.pid, 'openai')
    assert.equal(priceFaceOf(CANON_BOOK, 'anthropic', 'claude-sonnet-5-5')?.pid, 'anthropic')
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'anthropic', 'claude-sonnet-5.5'), { pid: 'anthropic', mid: 'claude-sonnet-5-5', rate: ANTHROPIC_RATE, via: 'branch-normalized', confidence: 'medium', canonical: 'anthropic/claude-sonnet-5-5' })
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'opencode', 'claude-sonnet-5'), {
      pid: 'opencode', mid: 'claude-sonnet-5', rate: OPENCODE_RATE, via: 'direct', confidence: 'high', canonical: 'anthropic/claude-sonnet-5',
    })
    assert.equal(priceFaceOf(CANON_BOOK, 'opencode', 'kimi-k3')?.pid, 'opencode')
    assert.deepEqual(priceFaceOf(CANON_BOOK, 'opencode-go', 'glm-5.3'), {
      pid: 'opencode-go', mid: 'glm-5.3', rate: ZHIPU_RATE, via: 'direct', confidence: 'high', canonical: 'zhipuai/glm-5.3',
    })
    assert.equal(priceFaceOf(CANON_BOOK, 'fireworks', 'model-1')?.pid, 'fireworks-ai')
    assert.equal(priceFaceOf(CANON_BOOK, 'together', 'model-1')?.pid, 'togetherai')
    assert.equal(priceFaceOf(CANON_BOOK, 'vercel-ai-gateway', 'model-1')?.pid, 'vercel')
    assert.equal(priceFaceOf(CANON_BOOK, 'zai-coding-cn', 'glm-5.3')?.pid, 'zhipuai')
  })

  test('a single-vendor branch never falls back, while multiple labs need an org or family hint', () => {
    assert.deepEqual(priceResolutionOf(CANON_BOOK, 'anthropic', 'gpt-5.6-sol'), { kind: 'unpriced', miss: { reason: 'model-unknown' } })
    assert.deepEqual(priceResolutionOf(CANON_BOOK, 'unknown', 'mystery'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.equal(priceFaceOf(CANON_BOOK, 'unknown', 'claude-mystery')?.pid, 'anthropic')
    assert.equal(priceFaceOf(CANON_BOOK, 'unknown', 'claude-sonnet-5.5')?.pid, 'anthropic', 'normalized global ids resolve through the maker')
  })

  test('authority misses and ambiguous branch-local lookups fall through without inventing a rate', () => {
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const R2 = { hit: 2, miss: 2, write: 2, out: 2 }
    const edge = bookOf({
      'reseller-a': { 'ghost-model': R1, 'laba/x': R1, 'claude-ghost': R1, 'z-ai/mystery2': R1 },
      'reseller-b': { 'laba/x': R2, 'labb/x': R2, 'claude-ghost': R2, 'z-ai/mystery2': R2 },
      laba: { other: R1 },
      labb: { other: R1 },
      anthropic: { 'a-claude-zzz': R1, 'b-claude-zzz': R2 },
      openai: { 'claude-ghost': R2 },
    }, {
      'reseller-a': {
        'ghost-model': 'ghost/ghost-model',
        'laba/x': 'laba/x',
        'claude-ghost': 'anthropic/claude-ghost',
        'z-ai/mystery2': 'laba/z-ai/mystery2',
      },
      'reseller-b': {
        'laba/x': 'labb/laba/x',
        'labb/x': 'labb/x',
        'claude-ghost': 'openai/claude-ghost',
        'z-ai/mystery2': 'labb/z-ai/mystery2',
      },
      laba: { other: 'laba/other' },
      labb: { other: 'labb/other' },
      openai: { 'claude-ghost': 'openai/claude-ghost' },
    })
    assert.equal(priceFaceOf(edge, 'unknown', 'ghost-model')?.pid, 'reseller-a', 'a lab without a branch falls to the unique carrier')
    assert.deepEqual(priceResolutionOf(edge, 'unknown', 'laba/x'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.deepEqual(priceResolutionOf(edge, 'unknown', 'z-ai/mystery2'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.deepEqual(priceResolutionOf(edge, 'unknown', 'claude-ghost'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 3 } })
    assert.deepEqual(priceResolutionOf(edge, 'unknown', 'claude-zzz'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.deepEqual(priceResolutionOf(CANON_BOOK, 'azure', 'private-model'), { kind: 'unpriced', miss: { reason: 'no-entry' } })
    assert.deepEqual(priceResolutionOf(CANON_BOOK, 'unknown', 'google-vertex/private'), { kind: 'unpriced', miss: { reason: 'no-entry' } })
    assert.deepEqual(priceResolutionOf(null, 'codex', 'gpt-5.6-sol'), { kind: 'unpriced', miss: { reason: 'book-unavailable' } })
    const book = bookOf({
      'reseller-a': { mystery: R1, 'claude-yyy': R1 },
      'reseller-b': { mystery: R2, 'claude-yyy': R2 },
      moonshotai: { 'kimi-mystery': R1, 'other-mystery': R2 },
      anthropic: { 'a-claude-yyy': R1, 'b-claude-yyy': R2 },
      'google-vertex': { 'a-gemini-rrr': R1, 'b-gemini-rrr': R2 },
    }, {
      'reseller-a': { mystery: 'moonshotai/mystery', 'claude-yyy': 'anthropic/claude-yyy' },
      'reseller-b': { mystery: 'moonshotai/mystery', 'claude-yyy': 'openai/claude-yyy' },
      moonshotai: { 'kimi-mystery': 'moonshotai/kimi-mystery', 'other-mystery': 'moonshotai/other-mystery' },
      anthropic: { 'a-claude-yyy': 'anthropic/a-claude-yyy', 'b-claude-yyy': 'anthropic/b-claude-yyy' },
      'google-vertex': { 'a-gemini-rrr': 'google/a', 'b-gemini-rrr': 'google/b' },
    })
    assert.deepEqual(priceResolutionOf(book, 'unknown', 'mystery'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.deepEqual(priceResolutionOf(book, 'unknown', 'claude-yyy'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
    assert.deepEqual(priceResolutionOf(book, 'unknown', 'google-vertex/gemini-rrr'), { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: 2 } })
  })

  test('priceLookupsOf keeps priced and unpriced faces distinct', () => {
    const usage = {
      codex: { 'gpt-5.6-sol': { off: bucket(0, M, 0, 0) } },
      unknown: { private: { off: bucket(0, M, 0, 0) } },
    }
    const lookups = priceLookupsOf(usage, CANON_BOOK)
    assert.equal(lookups.length, 2)
    assert.equal(lookups[0].face?.pid, 'openai')
    assert.equal(lookups[1].miss?.reason, 'no-entry')
    assert.deepEqual(priceLookupsOf(null, CANON_BOOK), [])
    assert.deepEqual(priceLookupsOf(usage, null), [])
    assert.deepEqual(priceLookupsOf({ junk: 5 } as unknown as SessionCostUsage, CANON_BOOK), [])
  })
})

describe('subscription plan branches', () => {
  const ZERO = { hit: 0, miss: 0, write: 0, out: 0 }
  const QWEN = { hit: 0.25, miss: 2, write: 2, out: 6 }
  const MIMO = { hit: 0.0028, miss: 0.14, write: 0.14, out: 0.28 }
  const MINIMAX = { hit: 0.03, miss: 0.3, write: 0.3, out: 1.2 }
  const ZAI = { hit: 0.3, miss: 1, write: 1, out: 3 }
  const ZHIPU = { hit: 0.23, miss: 0.8, write: 0.8, out: 2.8 }
  const PRICES: ModelPrices = {
    'kimi-code-plan-global': { k3: ZERO },
    moonshotai: { 'kimi-k3': K3 },
    'alibaba-token-plan': { 'qwen3.8-max': ZERO, 'deepseek-v4-pro': ZERO },
    alibaba: { 'qwen3.8-max': QWEN },
    zai: { 'glm-5.3': ZAI },
    zhipuai: { 'glm-5.3': ZHIPU },
    deepseek: { 'deepseek-v4-pro': PRO },
    'xiaomi-token-plan-cn': { 'mimo-v2.5': ZERO },
    xiaomi: { 'mimo-v2.5': MIMO },
    minimax: { 'MiniMax-M2.5': MINIMAX },
  }
  const CANON: Record<string, Record<string, string>> = {
    'kimi-code-plan-global': { k3: 'moonshotai/kimi-k3' },
    moonshotai: { 'kimi-k3': 'moonshotai/kimi-k3' },
    'alibaba-token-plan': { 'qwen3.8-max': 'alibaba/qwen3.8-max', 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' },
    alibaba: { 'qwen3.8-max': 'alibaba/qwen3.8-max' },
    zai: { 'glm-5.3': 'zhipuai/glm-5.3' },
    zhipuai: { 'glm-5.3': 'zhipuai/glm-5.3' },
    deepseek: { 'deepseek-v4-pro': 'deepseek/deepseek-v4-pro' },
    'xiaomi-token-plan-cn': { 'mimo-v2.5': 'xiaomi/mimo-v2.5' },
    xiaomi: { 'mimo-v2.5': 'xiaomi/mimo-v2.5' },
    minimax: { 'MiniMax-M2.5': 'minimax/MiniMax-M2.5' },
  }
  const PLAN_BOOK = bookOf(PRICES, CANON)

  test('plan branches never enter the per-token book, and their routes fall back to the maker reference', () => {
    assert.equal(PLAN_BOOK.index.branches.has('kimi-code-plan-global'), false)
    assert.equal(PLAN_BOOK.index.branches.has('alibaba-token-plan'), false)
    assert.equal(PLAN_BOOK.index.branches.has('xiaomi-token-plan-cn'), false)
    assert.deepEqual(priceOf(PLAN_BOOK, 'kimi-code-plan-global', 'k3'), K3)
    assert.deepEqual(priceOf(PLAN_BOOK, 'qwen-token-plan', 'qwen3.8-max'), QWEN)
    assert.deepEqual(priceOf(PLAN_BOOK, 'qwen-token-plan', 'deepseek-v4-pro'), PRO)
    assert.deepEqual(priceOf(PLAN_BOOK, 'xiaomi-token-plan-cn', 'mimo-v2.5'), MIMO)
    assert.deepEqual(priceOf(PLAN_BOOK, 'zai-coding-plan', 'glm-5.3'), ZAI)
    assert.deepEqual(priceOf(PLAN_BOOK, 'zhipuai-coding-plan', 'glm-5.3'), ZHIPU)
    assert.deepEqual(priceOf(PLAN_BOOK, 'alibaba-token-plan', 'qwen3.8-max'), QWEN)
    assert.deepEqual(priceOf(PLAN_BOOK, 'minimax-coding-plan', 'MiniMax-M2.5'), MINIMAX)
  })
})

const FIXTURE = {
  deepseek: {
    npm: '@ai-sdk/openai-compatible',
    models: {
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, reasoning: 0.6, cache_read: 0.003 } },
      'deepseek-v4-pro': { cost: { input: 0.435, output: 0.87 } },
      'glm-free': { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      'broken-missing-input': { cost: { output: 1 } },
      'broken-missing-output': { cost: { input: 1 } },
      'broken-negative': { cost: { input: -1, output: 1 } },
      'broken-nan': { cost: { input: Number.NaN, output: Number.POSITIVE_INFINITY } },
      'broken-no-cost': {},
      'broken-not-record': null,
    },
  },
  anthropic: {
    npm: '@ai-sdk/anthropic',
    models: { 'claude-sonnet-5': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } },
  },
  gateway: {
    npm: '@ai-sdk/openai-compatible',
    models: { 'claude-sonnet-5': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } },
  },
  foreign: {
    npm: '@ai-sdk/openai',
    models: { 'claude-sonnet-5': { cost: { input: 9, output: 9, cache_read: 9, cache_write: 9 } } },
  },
  moonshotai: { models: { 'kimi-k2.7-code': { cost: { input: 1.9, output: 8, cache_read: 0.38, cache_write: 3 } } } },
  minimax: { models: { 'broken-input': { cost: { input: 'junk', output: 2 } } } },
  zhipuai: { models: 'nope' },
  'junk-provider': 7,
  'provider-the-plugin-never-maps': { models: { m: { cost: { input: 1, output: 2 } } } },
}

describe('pricesBookOf', () => {
  test('extracts every pricing provider under its registry id, skipping junk entries', () => {
    const { prices } = pricesBookOf(FIXTURE) ?? {}
    assert.deepEqual(prices, {
      deepseek: {
        'deepseek-v4-flash': { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 },
        'deepseek-v4-pro': { hit: 0.435, miss: 0.435, write: 0.435, out: 0.87 },
        'glm-free': { hit: 0, miss: 0, write: 0, out: 0 },
      },
      anthropic: { 'claude-sonnet-5': { hit: 0.2, miss: 2, write: 2.5, out: 10 } },
      gateway: { 'claude-sonnet-5': { hit: 0.2, miss: 2, write: 2.5, out: 10 } },
      foreign: { 'claude-sonnet-5': { hit: 9, miss: 9, write: 9, out: 9 } },
      moonshotai: { 'kimi-k2.7-code': { hit: 0.38, miss: 1.9, write: 3, out: 8 } },
      'provider-the-plugin-never-maps': { m: { hit: 1, miss: 1, write: 1, out: 2 } },
    })
    assert.equal(pricesBookOf(null), null)
    assert.equal(pricesBookOf('x'), null)
    assert.equal(pricesBookOf([FIXTURE]), null)
    assert.deepEqual(pricesBookOf({}), { prices: {}, index: { byModel: new Map(), byNormalized: new Map(), branches: new Map() } }, 'an empty payload prices an empty book')
  })

  test('own __proto__ provider and model ids never become price entries', () => {
    const payload = JSON.parse('{"__proto__":{"models":{"m":{"cost":{"input":1,"output":2}}}},"deepseek":{"models":{"__proto__":{"cost":{"input":1,"output":2}},"real":{"cost":{"input":1,"output":2}}}}}') as Record<string, unknown>
    const book = pricesBookOf(payload)
    assert.ok(book !== null)
    assert.deepEqual(Object.keys(book.prices), ['deepseek'])
    assert.deepEqual(Object.keys(book.prices.deepseek), ['real'])
    assert.equal(Object.getPrototypeOf(book.prices.deepseek), Object.prototype)
  })

  test('canonical ids join the branch index and mark its labs', () => {
    const book = pricesBookOf({
      p: {
        models: {
          a: { cost: { input: 1, output: 2 }, canonical_model_id: 'lab/a' },
          b: { cost: { input: 3, output: 4 }, canonical_model_id: 'lab/b' },
          c: { cost: { input: 5, output: 6 } },
        },
      },
    })
    const branch = book?.index.branches.get('p')
    assert.equal(branch?.labs.size, 1)
    assert.deepEqual(branch?.byExact.get('a')?.[0], { pid: 'p', mid: 'a', rate: { hit: 1, miss: 1, write: 1, out: 2 }, canonical: 'lab/a', lab: 'lab' })
    assert.equal(branch?.byExact.get('c')?.[0]?.canonical, undefined)
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation; below 1, two significant digits; CNY uses ¥', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
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


describe('priceResolutionOf memoization', () => {
  test('repeated lookups on the same book return the same resolution; a fresh book re-resolves', () => {
    const first = priceResolutionOf(BOOK_B, 'deepseek', 'deepseek-v4-flash')
    const second = priceResolutionOf(BOOK_B, 'deepseek', 'deepseek-v4-flash')
    assert.equal(second, first, 'the second lookup serves the memoized resolution')
    const changed = bookOf({ deepseek: { 'deepseek-v4-flash': { hit: 0.01, miss: 0.2, write: 0.2, out: 1 } } })
    const third = priceResolutionOf(changed, 'deepseek', 'deepseek-v4-flash')
    assert.notEqual(third, first, 'a new book re-resolves instead of reusing the stale face')
    assert.equal(third.kind, 'priced')
    assert.deepEqual(third.kind === 'priced' ? third.face.rate : null, { hit: 0.01, miss: 0.2, write: 0.2, out: 1 })
  })
})
