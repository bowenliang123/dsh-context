import assert from 'node:assert/strict'
import { describe, test, afterEach, vi } from 'vitest'
import { mapOf, squarify } from '../../src/client/treemap'
import { type Assembled } from '../../src/shared/assemble'
import { type HeaderRecord, type SurfaceNode } from '../../src/shared/types'
import { makeKit, surfaceNodeAt, cleanupMounts, flush, mount } from './helpers/kit'
import { act, createElement as h } from 'react'
import { isNewerRelease } from '../../src/shared/version'

describe('treemap', () => {

const kit = makeKit()

function asm(over: Partial<Assembled>): Assembled {
  return { live: true, header: null, system: null, nodes: [], missingLive: 0, approximate: false, ...over }
}

function header(tools: { name: string; tokens: number }[]): HeaderRecord {
  return { seq: 1, time: 1000, systemTokens: 0, tools }
}

describe('mapOf grouping', () => {
  test('an empty view maps to no regions', () => {
    assert.deepEqual(mapOf(asm({}), kit.t, kit.catLabel), [])
  })

  test('the system prompt is a single block opening the sys row; a zero-token prompt drops out', () => {
    const cats = mapOf(asm({ system: { seq: 1, time: 1, tokens: 100 } }), kit.t, kit.catLabel)
    assert.deepEqual(cats, [{
      cat: 'system',
      tokens: 100,
      blocks: [{ key: 'sys', label: 'System Prompt', tokens: 100, count: 1, elem: 'sys' }],
    }])
    assert.deepEqual(mapOf(asm({ system: { seq: 1, time: 1, tokens: 0 } }), kit.t, kit.catLabel), [])
  })

  test('tool schemas keep one block each (zero-token schemas drop), sorted by size', () => {
    const cats = mapOf(asm({
      header: header([{ name: 'read', tokens: 20 }, { name: 'bash', tokens: 50 }, { name: 'noop', tokens: 0 }]),
    }), kit.t, kit.catLabel)
    assert.equal(cats.length, 1)
    assert.equal(cats[0].cat, 'tools')
    assert.equal(cats[0].tokens, 70)
    assert.deepEqual(cats[0].blocks.map(b => [b.key, b.label, b.tokens, b.elem]), [
      ['tools:bash', 'bash', 50, 'tool:bash'],
      ['tools:read', 'read', 20, 'tool:read'],
    ])
  })

  test('tool results fold by tool name: a multi-result group filters, a singleton opens its row', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(2, { cat: 'tool', tool: 'bash', tokens: 30 }),
      surfaceNodeAt(3, { cat: 'tool', tool: 'bash', tokens: 20 }),
      surfaceNodeAt(4, { cat: 'tool', tool: 'read', tokens: 10 }),
      surfaceNodeAt(5, { cat: 'tool', tokens: 5 }),
      surfaceNodeAt(6, { cat: 'tool', tool: 'zero', tokens: 0 }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.equal(cats.length, 1)
    assert.equal(cats[0].cat, 'tool')
    assert.equal(cats[0].tokens, 65)
    assert.deepEqual(cats[0].blocks, [
      { key: 'tool:bash', label: 'bash', tokens: 50, count: 2, query: 'bash' },
      { key: 'tool:read', label: 'read', tokens: 10, count: 1, elem: 'n4' },
      { key: 'tool:?', label: '?', tokens: 5, count: 1, elem: 'n5' },
    ])
  })

  test('skills group by skill name, falling back to the form label; injections group by form', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(1, { cat: 'skill', skill: 'code', tokens: 10 }),
      surfaceNodeAt(2, { cat: 'skill', skill: 'code', tokens: 5 }),
      surfaceNodeAt(3, { cat: 'skill', form: 'catalog', tokens: 7 }),
      surfaceNodeAt(7, { cat: 'skill', tokens: 3 }),
      surfaceNodeAt(4, { cat: 'inject', form: 'notice', tokens: 8 }),
      surfaceNodeAt(5, { cat: 'inject', form: 'notice', tokens: 4 }),
      surfaceNodeAt(6, { cat: 'inject', tokens: 6 }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => [c.cat, c.tokens]), [['inject', 18], ['skill', 25]])
    assert.deepEqual(cats[0].blocks, [
      { key: 'inject:notice', label: 'Notice', tokens: 12, count: 2, query: 'Notice' },
      { key: 'inject:context', label: 'Context Injection', tokens: 6, count: 1, elem: 'n6' },
    ])
    assert.deepEqual(cats[1].blocks, [
      { key: 'skill:code', label: 'code', tokens: 15, count: 2, query: 'code' },
      { key: 'skill~catalog', label: 'Catalog Update', tokens: 7, count: 1, elem: 'n3' },
      { key: 'skill~context', label: 'Context Injection', tokens: 3, count: 1, elem: 'n7' },
    ])
  })

  test('user and assistant messages stay solo: user labels by seq, assistant by its call breadcrumb', () => {
    const nodes: SurfaceNode[] = [
      surfaceNodeAt(2, { tokens: 10 }),
      surfaceNodeAt(3, { tokens: 5 }),
      surfaceNodeAt(4, { cat: 'assistant', tokens: 20, calls: ['bash', 'write'] }),
      surfaceNodeAt(5, { cat: 'assistant', tokens: 8, text: 'done' }),
    ]
    const cats = mapOf(asm({ nodes }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => c.cat), ['user', 'assistant'])
    assert.deepEqual(cats[0].blocks.map(b => [b.label, b.elem]), [
      ['#2', 'n2'],
      ['#3', 'n3'],
    ])
    assert.deepEqual(cats[1].blocks.map(b => [b.label, b.elem]), [
      ['bash › write', 'n4'],
      ['#5', 'n5'],
    ])
  })

  test('regions keep the canonical category order and their tokens equal their blocks’ sum', () => {
    const cats = mapOf(asm({
      system: { seq: 1, time: 1, tokens: 100 },
      header: header([{ name: 'bash', tokens: 50 }]),
      nodes: [
        surfaceNodeAt(2, { tokens: 10 }),
        surfaceNodeAt(3, { cat: 'assistant', tokens: 30 }),
        surfaceNodeAt(4, { cat: 'tool', tool: 'bash', tokens: 40 }),
      ],
    }), kit.t, kit.catLabel)
    assert.deepEqual(cats.map(c => c.cat), ['system', 'tools', 'user', 'assistant', 'tool'])
    for (const c of cats) {
      assert.equal(c.tokens, c.blocks.reduce((acc, b) => acc + b.tokens, 0))
    }
  })

  test('a category past the fold cap keeps its top blocks and folds the tail into one “more” block; exactly at the cap no fold happens', () => {
    const nodes: SurfaceNode[] = Array.from({ length: 13 }, (_, i) => surfaceNodeAt(i + 1, { tokens: 100 - i }))
    const blocks = mapOf(asm({ nodes }), kit.t, kit.catLabel)[0].blocks
    assert.equal(blocks.length, 12)
    assert.deepEqual(blocks.map(b => b.label), [
      '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '2 more',
    ])
    const rest = blocks[11]
    assert.equal(rest.tokens, 89 + 88, 'the fold sums the tail')
    assert.equal(rest.count, 2)
    assert.equal(rest.elem, undefined)
    assert.equal(rest.query, undefined)

    const capped = Array.from({ length: 12 }, (_, i) => surfaceNodeAt(i + 1, { tokens: 10 + i }))
    const exact = mapOf(asm({ nodes: capped }), kit.t, kit.catLabel)[0].blocks
    assert.equal(exact.length, 12)
    assert.ok(exact.every(b => b.elem !== undefined))
  })
})

describe('squarify', () => {
  const sized = (tokens: number, tag = ''): { tokens: number; tag: string } => ({ tokens, tag })

  test('empty, all-zero, degenerate, and single-item inputs lay out nothing or fill the box without a gap', () => {
    assert.deepEqual(squarify([], { x: 0, y: 0, w: 100, h: 100 }), [])
    assert.deepEqual(squarify([sized(0), sized(0)], { x: 0, y: 0, w: 100, h: 100 }), [])
    assert.deepEqual(squarify([sized(10)], { x: 0, y: 0, w: 0, h: 100 }), [])
    assert.deepEqual(squarify([sized(10)], { x: 0, y: 0, w: 100, h: 0 }), [])
    assert.deepEqual(squarify([sized(10, 'a'), sized(0)], { x: 5, y: 6, w: 100, h: 50 }), [
      { item: { tokens: 10, tag: 'a' }, rect: { x: 5, y: 6, w: 100, h: 50 } }],
    )
  })

  test('two equal items in a square share one vertical strip', () => {
    const out = squarify([sized(50, 'a'), sized(50, 'b')], { x: 0, y: 0, w: 100, h: 100 })
    assert.deepEqual(out.map(o => o.rect), [
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 },
    ])
  })

  test('items tile the box exactly, biggest first, without overlap or overflow', () => {
    for (const box of [{ x: 0, y: 0, w: 640, h: 240 }, { x: 10, y: 20, w: 100, h: 400 }]) {
      const items = [sized(4000, 'a'), sized(3000, 'b'), sized(2000, 'c'), sized(1000, 'd'), sized(500, 'e'), sized(250, 'f')]
      const out = squarify(items, box)
      assert.equal(out.length, items.length)
      assert.equal(out[0].item.tag, 'a', 'sorted biggest-first')
      let area = 0
      for (const o of out) {
        area += o.rect.w * o.rect.h
        assert.ok(o.rect.x >= box.x - 1e-6 && o.rect.y >= box.y - 1e-6)
        assert.ok(o.rect.x + o.rect.w <= box.x + box.w + 1e-3)
        assert.ok(o.rect.y + o.rect.h <= box.y + box.h + 1e-3)
        for (const p of out) {
          if (p === o) continue
          const overlap = Math.max(0, Math.min(o.rect.x + o.rect.w, p.rect.x + p.rect.w) - Math.max(o.rect.x, p.rect.x))
            * Math.max(0, Math.min(o.rect.y + o.rect.h, p.rect.y + p.rect.h) - Math.max(o.rect.y, p.rect.y))
          assert.ok(overlap < 1e-6, `no overlap: ${JSON.stringify(o.rect)} vs ${JSON.stringify(p.rect)}`)
        }
      }
      assert.ok(Math.abs(area - box.w * box.h) < 0.01, `area ${area} ≈ box ${box.w * box.h}`)
    }
  })

  test('a new strip starts when the next item would worsen the strip’s worst aspect ratio', () => {
    const out = squarify([sized(40, 'a'), sized(30, 'b'), sized(20, 'c'), sized(10, 'd')], { x: 0, y: 0, w: 100, h: 100 })
    assert.ok(Math.abs(out[0].rect.w - 70) < 1e-9 && Math.abs(out[0].rect.x) < 1e-9)
    assert.ok(Math.abs(out[1].rect.y - out[0].rect.h) < 1e-9, 'b stacks under a in the first strip')
    assert.ok(Math.abs(out[2].rect.x - 70) < 1e-9, 'c opens the second strip')
    assert.ok(Math.abs(out[3].rect.y - out[2].rect.h) < 1e-9 && Math.abs(out[3].rect.x - 70) < 1e-9, 'd sits under c')
  })
})
})

describe('versionSource', () => {

const HOUR_MS = 60 * 60 * 1000
const RETRY_MS = 30_000
const RETRY_MAX = 5
const ROUTE = 'api/dsh-context/version'

interface Call {
  url: string
  body: unknown
}

interface Envelope {
  ok: boolean
  json: () => Promise<{ ok: boolean; value: unknown }>
}

function reply(value: unknown): Envelope {
  return { ok: true, json: async () => ({ ok: true, value }) }
}

function stubVersion(handler: (call: number) => unknown): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init: { body: string; method?: string }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) })
    return reply(handler(calls.length - 1))
  })
  return { calls }
}

function versionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest: '1.1.0', ...over }
}

type Module = typeof import('../../src/client/versionSource')

async function fresh(version?: string): Promise<Module> {
  vi.resetModules()
  const globals = globalThis as Record<string, unknown>
  if (version === undefined) delete globals.__DSH_CTX_VERSION__
  else globals.__DSH_CTX_VERSION__ = version
  return await import('../../src/client/versionSource')
}

interface Probe {
  settled: () => string
  unmount: () => Promise<void>
}

async function probe(module: Module): Promise<Probe> {
  const { useNewerVersion } = module
  const seen: string[] = []
  function VersionProbe(): null {
    seen.push(useNewerVersion() ?? '')
    return null
  }
  const m = await mount(h(VersionProbe, {}))
  await flush()
  return { settled: () => seen[seen.length - 1], unmount: () => m.unmount() }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('isNewerRelease (the shared host-side compare)', () => {
  test('release channels rank above pre-releases; the v prefix and garbage stay handled', () => {
    assert.equal(isNewerRelease('1.2.3', '1.2.2'), true)
    assert.equal(isNewerRelease('1.2.3', '1.2.3'), false)
    assert.equal(isNewerRelease('1.2.2', '1.2.3'), false)
    assert.equal(isNewerRelease('v1.3.0', '1.2.9'), true)
    assert.equal(isNewerRelease('1.3.0-rc.1', '1.3.0'), false, 'an rc stays below its release')
    assert.equal(isNewerRelease('1.3.0', '1.3.0-rc.1'), true, 'a release outranks the rc the client parser used to miss')
    assert.equal(isNewerRelease('1.3.0-rc.1', '1.2.0'), true)
    assert.equal(isNewerRelease('1.2.1', '1.2'), false, 'an unparsable current never reports newer')
    assert.equal(isNewerRelease('x.y', '0.0.0'), false)
  })
})

describe('the version route', () => {
  test('posts an empty body, trusts the served updateAvailable flag, and paints a newer version', async () => {
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => versionBody({ current: '1.0.0', latest: '1.2.3', updateAvailable: true }))
    const p = await probe(module)
    assert.equal(p.settled(), '1.2.3')
    assert.deepEqual(calls, [{ url: ROUTE, body: {} }])
    await p.unmount()
  })

  test('a served updateAvailable of false hides an upgrade even when latest is numerically newer', async () => {
    const module = await fresh('1.0.0')
    stubVersion(() => versionBody({ current: '1.0.0', latest: '1.2.3', updateAvailable: false }))
    const p = await probe(module)
    assert.equal(p.settled(), '', 'the host-side decision wins')
    await p.unmount()
  })

  test('a payload without updateAvailable falls back to the shared compare against the build version', async () => {
    const module = await fresh('1.0.0')
    stubVersion(() => ({ ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest: '1.2.3' }))
    const p = await probe(module)
    assert.equal(p.settled(), '1.2.3')
    await p.unmount()
    const older = await fresh('1.2.3')
    stubVersion(() => ({ ready: true, failed: false, checkedAt: 1, current: '1.2.3', latest: '1.3.0-rc.1' }))
    const q = await probe(older)
    assert.equal(q.settled(), '1.3.0-rc.1', 'an rc above the current build still counts on the fallback path')
    await q.unmount()
    const same = await fresh('1.2.3')
    stubVersion(() => ({ ready: true, failed: false, checkedAt: 1, current: '1.2.3', latest: '1.2.3' }))
    const r = await probe(same)
    assert.equal(r.settled(), '', 'a fallback compare against an equal latest stays quiet')
    await r.unmount()
  })

  test('a dev build never checks the version route and paints nothing', async () => {
    const module = await fresh()
    const { calls } = stubVersion(() => versionBody())
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.deepEqual(calls, [])
    await p.unmount()
  })

  test('a same or older version paints nothing and does not poll again', async () => {
    for (const latest of ['1.0.0', '0.9.0']) {
      vi.useFakeTimers()
      const module = await fresh('1.0.0')
      const { calls } = stubVersion(() => versionBody({ latest }))
      const p = await probe(module)
      assert.equal(p.settled(), '', `${latest} is not newer than the build`)
      assert.equal(calls.length, 1)
      assert.equal(vi.getTimerCount(), 0)
      await advance(10 * RETRY_MS)
      assert.equal(calls.length, 1, 'a ready answer stops the polling')
      await p.unmount()
    }
  })

  test('a payload with no current version falls back to comparing against the build version', async () => {
    const module = await fresh('1.0.0')
    stubVersion(() => ({ ready: true, failed: false, checkedAt: 1, current: null, latest: '9.9.9' }))
    const p = await probe(module)
    assert.equal(p.settled(), '9.9.9', 'a null current compares the served latest against the build')
    await p.unmount()
  })

  test('a ready reply without a latest version never paints and the ladder gives up', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => ({ ready: true, failed: false, checkedAt: 1, current: '1.0.0' }))
    const p = await probe(module)
    assert.equal(p.settled(), '', 'no latest means nothing to paint')
    await advance(RETRY_MS * (RETRY_MAX + 2))
    assert.equal(p.settled(), '', 'a ready answer stays cached through the whole retry ladder')
    await advance(2 * 60 * 60 * 1000)
    assert.equal(p.settled(), '', 'a latest-less ready reply never paints and the ladder has stopped')
    assert.equal(calls.length, 1, 'the ready cache meant exactly one network read')
    await p.unmount()
  })

  test('a not-ready reply retries after 30s and paints once the host turns ready', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => (call === 0 ? versionBody({ ready: false, failed: true }) : versionBody()))
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.equal(calls.length, 1)
    await advance(RETRY_MS)
    assert.equal(calls.length, 2, 'the retryable cache expires exactly at the retry delay')
    assert.equal(p.settled(), '1.1.0')
    assert.equal(vi.getTimerCount(), 0)
    await p.unmount()
  })

  test('a not-ready read is served from the retry-window cache until it expires', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => versionBody({ ready: false, failed: false }))
    const first = await probe(module)
    await first.unmount()
    const second = await probe(module)
    assert.equal(calls.length, 1, 'a second read inside the retry window reuses the cached answer')
    await advance(RETRY_MS)
    assert.equal(calls.length, 2, 'the retry window is the 30s retry delay')
    await second.unmount()
  })

  test('a malformed or empty reply never paints and keeps retrying', async () => {
    const replies: unknown[] = [[], { ready: 'yes' }, {}, null, 'junk']
    for (const bad of replies) {
      vi.useFakeTimers()
      const module = await fresh('1.0.0')
      const { calls } = stubVersion(call => (call === 0 ? bad : versionBody()))
      const p = await probe(module)
      assert.equal(p.settled(), '', `malformed reply ${JSON.stringify(bad)} paints nothing`)
      assert.equal(calls.length, 1)
      await advance(RETRY_MS)
      assert.equal(calls.length, 2, `malformed reply ${JSON.stringify(bad)} retries`)
      await p.unmount()
      vi.useRealTimers()
    }
  })

  test('a ready reply without usable current/latest fields paints nothing', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => (call === 0
      ? { ready: true, failed: false, checkedAt: 1, current: 42, latest: '' }
      : versionBody()))
    const p = await probe(module)
    assert.equal(p.settled(), '', 'a ready reply without a latest version cannot paint')
    assert.equal(calls.length, 1)
    assert.equal(vi.getTimerCount(), 1)
    for (let i = 0; i < 5; i++) await advance(RETRY_MS)
    assert.equal(vi.getTimerCount(), 0, 'the hook still gives up after five attempts')
    assert.equal(p.settled(), '')
    await p.unmount()
  })

  test('a second read within the TTL reuses the answer; after the TTL it refetches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => versionBody({ latest: call === 0 ? '1.1.0' : '1.2.0' }))
    const first = await probe(module)
    assert.equal(first.settled(), '1.1.0')
    await first.unmount()
    vi.setSystemTime(1_000_000 + HOUR_MS - 1)
    const second = await probe(module)
    assert.equal(second.settled(), '1.1.0', 'the cached answer serves the second mount')
    assert.equal(calls.length, 1)
    await second.unmount()
    vi.setSystemTime(1_000_000 + HOUR_MS)
    const third = await probe(module)
    assert.equal(third.settled(), '1.2.0', 'an expired answer refetches')
    assert.equal(calls.length, 2)
    await third.unmount()
  })

  test('concurrent mounts share one in-flight version read', async () => {
    const module = await fresh('1.0.0')
    const calls: unknown[] = []
    let release: (res: Envelope) => void = () => {}
    vi.stubGlobal('fetch', (_input: unknown, init: { body: string; method?: string }) => {
      calls.push({ body: JSON.parse(String(init.body)), method: init.method })
      return new Promise<Envelope>((resolve) => { release = resolve })
    })
    const a = await probe(module)
    const b = await probe(module)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { body: {}, method: 'POST' })
    await act(async () => {
      release(reply(versionBody()))
      await Promise.resolve()
    })
    await flush()
    assert.equal(a.settled(), '1.1.0')
    assert.equal(b.settled(), '1.1.0')
    await a.unmount()
    await b.unmount()
  })

  test('gives up after five failed attempts instead of polling forever', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => {
      throw new Error('offline')
    })
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.equal(calls.length, 1)
    for (let i = 0; i < 4; i++) {
      await advance(RETRY_MS)
      assert.equal(calls.length, 2 + i)
    }
    assert.equal(vi.getTimerCount(), 0, 'no timer survives the fifth attempt')
    await advance(10 * RETRY_MS)
    assert.equal(calls.length, 5, 'five attempts, then silence')
    await p.unmount()
  })

  test('an unmount drops a late answer and clears the armed retry', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => {
      throw new Error('offline')
    })
    const p = await probe(module)
    assert.equal(vi.getTimerCount(), 1)
    await p.unmount()
    assert.equal(vi.getTimerCount(), 0, 'the pending retry is cleared with the hook')
    await advance(10 * RETRY_MS)
    assert.equal(calls.length, 1)

    const pendingCalls: unknown[] = []
    let release: (res: Envelope) => void = () => {}
    vi.stubGlobal('fetch', (_input: unknown, init: { body: string }) => {
      pendingCalls.push(JSON.parse(String(init.body)))
      return new Promise<Envelope>((resolve) => { release = resolve })
    })
    const late = await probe(module)
    await late.unmount()
    release(reply(versionBody()))
    await flush()
    assert.equal(late.settled(), '', 'the late result is dropped')
    assert.equal(pendingCalls.length, 1)
  })

  test('resetVersionSource clears the ready cache so the next read refetches', async () => {
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => versionBody({ latest: call === 0 ? '1.1.0' : '1.2.0' }))
    const first = await probe(module)
    assert.equal(first.settled(), '1.1.0')
    await first.unmount()
    module.resetVersionSource()
    const second = await probe(module)
    assert.equal(second.settled(), '1.2.0')
    assert.equal(calls.length, 2)
    await second.unmount()
  })

  test('resetVersionSource clears an in-flight read so a later mount refetches', async () => {
    const module = await fresh('1.0.0')
    const releases: ((res: Envelope) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Envelope>((resolve) => { releases.push(resolve) }))
    const first = await probe(module)
    assert.equal(releases.length, 1)
    module.resetVersionSource()
    const second = await probe(module)
    assert.equal(releases.length, 2, 'the reset dropped the in-flight handle and the mount fetched again')
    await act(async () => {
      releases[0]?.(reply(versionBody({ latest: '1.1.0' })))
      releases[1]?.(reply(versionBody({ latest: '1.2.0' })))
      await Promise.resolve()
    })
    await flush()
    assert.equal(first.settled(), '1.1.0')
    assert.equal(second.settled(), '1.2.0')
    await first.unmount()
    await second.unmount()
  })
})
})
