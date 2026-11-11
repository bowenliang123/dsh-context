import assert from 'node:assert/strict'
import { describe, test, vi, afterAll, beforeAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { identifiedMessages, watchStepIdentity, type PreStepDecision } from '../../src/host/stepIdentity'
import { createCatalogService, type CatalogFetcher } from '../../src/host/catalog'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectHarnessVersion } from '../../src/host/version'

describe('stepIdentity', () => {

function identified(id = 'm-1'): Record<string, unknown> {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

describe('identifiedMessages', () => {
  test('an all-identified list returns undefined and copies nothing', () => {
    const messages = [identified('a'), identified('b')]
    assert.equal(identifiedMessages(messages), undefined)
  })

  test('a missing, empty, null, or non-string id is minted; untouched entries keep their references', () => {
    const broken = [
      { role: 'user', source: { kind: 'user' }, content: [] },
      { id: '', role: 'user' },
      { id: null },
      { id: 42 },
    ]
    const fixed = identifiedMessages(broken)
    assert.ok(fixed !== undefined)
    assert.equal(fixed.length, broken.length)
    for (const [index, message] of fixed.entries()) {
      assert.match((message as { id: string }).id, /^dshctx-[0-9a-f-]{36}$/, `entry ${index} minted`)
    }
    assert.deepEqual(
      fixed.map(message => ({ ...(message as object), id: undefined })),
      broken.map(message => ({ ...(message as object), id: undefined })),
      'every non-id field passes through',
    )
    const good = identified('keep')
    const mixed = identifiedMessages([good, {}, good])
    assert.ok(mixed !== undefined)
    assert.equal(mixed[0], good)
    assert.equal(mixed[2], good)
    assert.notEqual((mixed[1] as { id: string }).id, (mixed[0] as { id: string }).id)
    const tailGood = identified('head')
    const fixedTail = identifiedMessages([tailGood, tailGood, { role: 'user' }])
    assert.ok(fixedTail !== undefined)
    assert.equal(fixedTail[0], tailGood)
    assert.equal(fixedTail[1], tailGood)
    assert.match((fixedTail[2] as { id: string }).id, /^dshctx-/)
  })

  test('non-object entries stay verbatim (unfixable without inventing a container)', () => {
    const messages = [null, 42, 'x']
    assert.equal(identifiedMessages(messages), undefined)
  })
})

describe('watchStepIdentity', () => {
  async function drive(inner: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
    const ctx = new Context()
    watchStepIdentity(ctx)
    return ctx.waterfall('agent/pre-step', { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 }, inner)
  }

  test('an enter decision with an unidentified message comes back minted', async () => {
    const decision: PreStepDecision = { kind: 'enter', messages: [{ role: 'user', content: [] }] }
    const result = await drive(() => Promise.resolve(decision))
    assert.equal(result.kind, 'enter')
    assert.match((result.messages![0] as { id: string }).id, /^dshctx-/)
    assert.equal((result.messages![0] as { role: string }).role, 'user', 'the rest of the message survives')
  })

  test('a decision the guard cannot improve passes through by reference', async () => {
    const identifiedDecision = { kind: 'enter', messages: [identified('m-9')] }
    assert.equal(await drive(() => Promise.resolve(identifiedDecision)), identifiedDecision)
    const reject = { kind: 'reject' }
    assert.equal(await drive(() => Promise.resolve(reject)), reject)
    const enter = { kind: 'enter' }
    assert.equal(await drive(() => Promise.resolve(enter)), enter)
  })

  test('a hostile decision or entry fails the guard open, verbatim', async () => {
    const hostileDecision = {
      get kind(): string { throw new Error('hostile decision') },
    }
    assert.equal(await drive(() => Promise.resolve(hostileDecision)), hostileDecision)
    const hostileMessages = {
      kind: 'enter',
      get messages(): unknown[] { throw new Error('hostile messages') },
    }
    assert.equal(await drive(() => Promise.resolve(hostileMessages)), hostileMessages)
  })

  test('the guard rides outermost: it post-processes what later listeners returned', async () => {
    const ctx = new Context()
    const order: string[] = []
    watchStepIdentity(ctx)
    ctx.on('agent/pre-step', async (_input, next) => {
      order.push('inner-pre')
      const decision = await next()
      order.push('inner-post')
      return decision
    })
    const result = await ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: [], signal: new AbortController().signal, step: 1, turn: 1 },
      () => Promise.resolve({ kind: 'enter', messages: [{ role: 'user' }] } as PreStepDecision),
    )
    assert.deepEqual(order, ['inner-pre', 'inner-post'])
    assert.match(((result.messages as unknown[])[0]! as { id: string }).id, /^dshctx-/, 'the message the loop would append is identified')
  })
})
})

describe('catalog', () => {

const PRICES = {
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
}


interface FetchCall { url: string }

function fetcherOf(
  routes: readonly { match: (url: string) => boolean; body?: unknown; status?: number; reject?: boolean }[],
  calls: FetchCall[] = [],
): CatalogFetcher {
  return (url) => {
    calls.push({ url })
    const route = routes.find(candidate => candidate.match(url))
    if (route === undefined) return Promise.reject(new Error('unexpected ' + url))
    if (route.reject === true) return Promise.reject(new Error('down'))
    return Promise.resolve({
      ok: (route.status ?? 200) === 200,
      status: route.status ?? 200,
      json: async () => route.body,
    } as unknown as Response)
  }
}

function catalogOf(routes: readonly { match: (url: string) => boolean; body?: unknown; status?: number; reject?: boolean }[], extra: {
  now?: () => number
  currentVersion?: string
  calls?: FetchCall[]
} = {}) {
  const calls: FetchCall[] = extra.calls ?? []
  return {
    calls,
    service: createCatalogService({
      fetch: fetcherOf(routes, calls),
      now: extra.now,
      currentVersion: extra.currentVersion ?? '0.82.2',
    }),
  }
}

const isVersionUrl = (url: string): boolean => url.includes('registry.npmjs.org') || url.includes('registry.npmmirror.com')
const isPricesUrl = (url: string): boolean => url === 'https://models.dev/api.json'

describe('catalog service', () => {
  test('serves the npm latest version, falling back to the mirror and caching for the TTL', async () => {
    let clock = 1_000
    const calls: FetchCall[] = []
    const { service } = catalogOf([
      { match: url => url.includes('registry.npmjs.org'), body: { version: '' } },
      { match: url => url.includes('registry.npmmirror.com'), body: { version: '0.83.0' } },
    ], { calls, now: () => clock })
    assert.equal(service.currentVersion(), '0.82.2')
    const first = await service.version()
    assert.deepEqual(first, { value: '0.83.0', ready: true, failed: false, checkedAt: 1_000 })
    assert.equal(calls.length, 2)
    const cached = await service.version()
    assert.equal(cached.value, '0.83.0')
    assert.equal(calls.length, 2)
    clock += 60 * 60 * 1000
    await service.version()
    assert.equal(calls.length, 4)
  })

  test('reports a failed version check when every registry fails or answers garbage', async () => {
    const { service, calls } = catalogOf([
      { match: isVersionUrl, reject: true },
    ])
    const read = await service.version()
    assert.deepEqual(read, { value: null, ready: false, failed: true, checkedAt: read.checkedAt })
    assert.equal(calls.length, 2)
    const retry = await service.version()
    assert.equal(retry.failed, true)
    assert.equal(calls.length, 2, 'a failed check is cached until the TTL')
    const garbage = catalogOf([{ match: isVersionUrl, body: { version: 7 } }]).service
    assert.equal((await garbage.version()).failed, true)
  })

  test('coalesces concurrent version checks into one fetch pair', async () => {
    const { service, calls } = catalogOf([
      { match: isVersionUrl, body: { version: '0.83.1' } },
    ])
    const [a, b] = await Promise.all([service.version(), service.version()])
    assert.equal(a.value, '0.83.1')
    assert.equal(b.value, '0.83.1')
    assert.equal(calls.length, 1)
  })

  test('parses the models.dev catalog into a compact price book once', async () => {
    let clock = 5_000
    const { service, calls } = catalogOf([
      { match: isPricesUrl, body: PRICES },
    ], { now: () => clock })
    assert.equal(service.book(), null)
    const read = await service.prices()
    assert.equal(read.ready, true)
    assert.equal(read.failed, false)
    const book = service.book()
    assert.ok(book !== null)
    assert.equal(book.prices.deepseek['deepseek-v4-flash'].miss, 0.15)
    assert.equal(book.index.byModel.get('deepseek-v4-flash')?.[0]?.rate.out, 0.6)
    const again = await service.prices()
    assert.equal(again.ready, true)
    assert.equal(calls.length, 1)
    clock += 60 * 60 * 1000
    await service.prices()
    assert.equal(calls.length, 2)
  })

  test('degrades a malformed or unreachable price catalog without throwing', async () => {
    const malformed = catalogOf([{ match: isPricesUrl, body: [1, 2, 3] }], { now: () => 0 }).service
    assert.deepEqual(await malformed.prices(), { value: null, ready: false, failed: true, checkedAt: 0 })
    assert.equal(malformed.book(), null)
    const rejected = catalogOf([{ match: isPricesUrl, reject: true }]).service
    const read = await rejected.prices()
    assert.equal(read.ready, false)
    assert.equal(read.failed, true)
    assert.equal(read.ready, false)
  })

  test('dispose stops later reads from serving a book', async () => {
    const { service } = catalogOf([{ match: isPricesUrl, body: PRICES }])
    await service.prices()
    assert.ok(service.book() !== null)
    service.dispose()
    assert.equal(service.book(), null)
    await service.ensure()
    assert.equal(service.book(), null)
  })

  test('a non-ok registry response counts as a failed check', async () => {
    const { service } = catalogOf([{ match: isVersionUrl, status: 500 }])
    const read = await service.version()
    assert.equal(read.ready, false)
    assert.equal(read.failed, true)
  })
})

describe('catalog defaults', () => {
  test('defaults its fetch to the global one, and ensure() only kicks the price fetch', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => PRICES } as unknown as Response
    })
    try {
      const service = createCatalogService({ currentVersion: '0.82.2' })
      assert.equal(service.book(), null)
      service.ensure()
      const read = await service.prices()
      assert.equal(read.ready, true)
      assert.ok(service.book() !== null, 'the price fetch lands in the book')
      assert.deepEqual(calls, ['https://models.dev/api.json'], 'ensure never checks the registry')
      service.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('reads the plugin version from its own package manifest when no override is injected', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const service = createCatalogService({
      fetch: fetcherOf([{ match: isVersionUrl, body: { version: '0.90.0' } }]),
    })
    assert.equal(service.currentVersion(), pkg.version)
    assert.equal((await service.version()).value, '0.90.0')
  })
})

describe('catalog refresh and failure backoff', () => {
  test('a stale price book refreshes after the TTL and bumps the prices version', async () => {
    let clock = 1_000
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => clock })
    await service.prices()
    assert.equal(calls.length, 1)
    assert.equal(service.pricesVersion(), 1, 'the first successful book is version one')
    clock += 60 * 60 * 1000
    await service.prices()
    assert.equal(calls.length, 2, 'the TTL expiry refetches the catalogue')
    assert.equal(service.pricesVersion(), 2, 'a refreshed book bumps the version so revisions move')
  })

  test('a failed price fetch backs off before the next attempt and then retries', async () => {
    let clock = 1_000
    const calls: FetchCall[] = []
    const { service } = catalogOf([{ match: isPricesUrl, reject: true }], { now: () => clock, calls })
    await service.prices()
    assert.equal(calls.length, 1)
    assert.equal(service.book(), null)
    service.ensure()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls.length, 1, 'an immediate retry stays inside the failure backoff')
    assert.equal(service.pricesVersion(), 0)
    clock += 30_000
    await service.prices()
    assert.equal(calls.length, 2, 'the backoff expires and the fetch is retried')
  })
})
})

describe('version', () => {

const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

const resolverIn = (root: string) => (...segments: string[]): string => join(root, ...segments)
const homeResolver = (home: string): (...segments: string[]) => string => resolverIn(join(HOMES, home))

function ctxWithHome(homePath: unknown): Context {
  const ctx = new Context()
  ctx.provide('dshHomePath', homePath)
  return ctx
}

function runningResolver(home: string, root: string = HOMES): (specifier: string) => string {
  const anchor = join(root, home, 'profiles', 'running-probe.cjs')
  return specifier => pathToFileURL(createRequire(anchor).resolve(specifier)).href
}

const NO_RUNNING = (): string => { throw new Error('no running module tree') }

const ELSEWHERE = join(tmpdir(), 'dsh-context-plugin-root')

const fixedUrl = (url: string) => (): string => url

let scratch = ''

function writeScratchHome(
  home: string,
  packageName: string,
  manifest: string,
  entry?: { path: string; decoyManifest?: string },
): string {
  const dir = join(scratch, home, 'profiles', 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest)
  if (entry !== undefined) {
    const entryPath = join(dir, entry.path)
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(entryPath, '')
    if (entry.decoyManifest !== undefined) {
      writeFileSync(join(dirname(entryPath), 'package.json'), entry.decoyManifest)
    }
  }
  return join(scratch, home)
}

const scratchResolver = (home: string): (...segments: string[]) => string => resolverIn(join(scratch, home))

function shadow(home: string, packageName: string): void {
  writeScratchHome(home, packageName,
    JSON.stringify({ name: packageName, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-context-version-'))
  shadow('library-only', '@deepseek-ai/dsh')
  writeScratchHome('library-only', '@deepseek-ai/dsh-session-projection',
    JSON.stringify({ name: '@deepseek-ai/dsh-session-projection', version: '0.1.1-rc.2' }))
  writeScratchHome('entry-only', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('entry-nested', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.4', exports: { '.': './a/b/index.js' } }),
    { path: 'a/b/index.js', decoyManifest: JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9' }) })
  writeScratchHome('entry-badjson', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.5', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'not json{' })
  writeScratchHome('entry-null', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.6', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'null' })
  writeScratchHome('entry-primitive', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.7', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: '"oops"' })
  writeScratchHome('entry-gone', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.8', exports: { '.': './lib/gone.js' } }))
  shadow('entry-gone', '@deepseek-ai/dsh-session-projection')
  shadow('entry-gone', '@deepseek-ai/dsh-session')
  writeScratchHome('entry-orphan', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-orphan', version: '1.0.0', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('entry-orphan', '@deepseek-ai/dsh')
  shadow('entry-orphan', '@deepseek-ai/dsh-session-projection')
  writeScratchHome('nonstring-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: 42, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('nonstring-version', '@deepseek-ai/dsh-session-projection')
  shadow('nonstring-version', '@deepseek-ai/dsh-session')
  writeScratchHome('empty-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('empty-version', '@deepseek-ai/dsh-session-projection')
  shadow('empty-version', '@deepseek-ai/dsh-session')
  mkdirSync(join(scratch, 'empty', 'profiles'), { recursive: true })
  shadow('empty', '@deepseek-ai/dsh')
  shadow('empty', '@deepseek-ai/dsh-session-projection')
  shadow('empty', '@deepseek-ai/dsh-session')
  writeScratchHome('running-supported', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.2.0-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-old', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.7-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-decoy', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('running-decoy', '@deepseek-ai/dsh-session-projection')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectHarnessVersion — running anchor', () => {
  test('outranks a stale home mirror, even when the running tree is below the baseline', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('old')), runningResolver('running-supported', scratch), ELSEWHERE), '0.2.0-rc.2')
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('future')), runningResolver('running-old', scratch), ELSEWHERE), '0.1.7-rc.2')
  })

  test('discards a witness inside this package own closure and never probes the CLI package for the home anchor', () => {
    const ctx = ctxWithHome(homeResolver('old'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli')), '0.1.7-rc.2')
    const empty = ctxWithHome(scratchResolver('empty'))
    assert.equal(detectHarnessVersion(empty, runningResolver('module-skips-cli'), ELSEWHERE), '0.2.0-rc.2')
  })

  test('an unusable running witness falls through to the home anchor', () => {
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('running-decoy', scratch), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl('data:text/javascript,'), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), join(ELSEWHERE, 'inner')), '0.3.0-rc.1')
  })
})

describe('detectHarnessVersion — home anchor', () => {
  test('reads the CLI package manifest of the running installation', () => {
    const ctx = (home: string) => ctxWithHome(homeResolver(home))
    assert.equal(detectHarnessVersion(ctx('old'), NO_RUNNING), '0.1.7-rc.2')
    assert.equal(detectHarnessVersion(ctx('baseline'), NO_RUNNING), '0.2.0-rc.2')
    assert.equal(detectHarnessVersion(ctx('future'), NO_RUNNING), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx('dev'), NO_RUNNING), '0.0.0-dev')
  })

  test('falls through to the library packages when the CLI row is absent', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('library-only')), NO_RUNNING), '0.1.1-rc.2')
  })

  test('ascends from the entry point, skipping mismatched, invalid, null, and primitive manifests', () => {
    const cases: [string, string | undefined][] = [
      ['entry-only', '0.1.1-rc.1'],
      ['entry-nested', '0.1.1-rc.4'],
      ['entry-badjson', '0.1.1-rc.5'],
      ['entry-null', '0.1.1-rc.6'],
      ['entry-primitive', '0.1.1-rc.7'],
      ['entry-gone', undefined],
    ]
    for (const [home, expected] of cases) {
      assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver(home)), NO_RUNNING), expected, home)
    }
  })
})

describe('detectHarnessVersion — degradation arms (fail open)', () => {
  test('an absent, non-function, or hostile home probe yields undefined', () => {
    assert.equal(detectHarnessVersion(new Context(), NO_RUNNING), undefined)
    assert.equal(detectHarnessVersion(ctxWithHome(42), NO_RUNNING), undefined)
    const throwing = ctxWithHome(() => { throw new Error('hostile home') })
    assert.equal(detectHarnessVersion(throwing, NO_RUNNING), undefined)
    const hostile = { get() { throw new Error('hostile ctx') } } as unknown as Context
    assert.equal(detectHarnessVersion(hostile, NO_RUNNING), undefined)
  })

  test('the default running anchor discards this package own devDependencies', () => {
    assert.equal(detectHarnessVersion(new Context()), undefined)
  })

  test('a resolving package whose manifest never matches → undefined', () => {
    const ctx = ctxWithHome(scratchResolver('entry-orphan'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('unreadable/invalid/odd manifests all degrade to undefined', () => {
    for (const home of ['nonstring-version', 'empty-version', 'empty']) {
      const ctx = ctxWithHome(scratchResolver(home))
      assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined, home)
    }
  })
})
})
