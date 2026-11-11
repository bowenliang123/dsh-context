// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { deltaBandsOf, deltaTotalsOf, dnaBaseLabel, dnaDeltaMaximaOf, dnaOf, trendBandsOf, type TrendBand } from '../../src/client/dna'
import { CAT_COLOR } from '../../src/client/categories'
import { makeKit, surfaceNode } from './helpers/kit'
import { assemble, type Assembled } from '../../src/shared/assemble'
import { type ContextHeaders, type ContextTimeline, type HeaderRecord, type HeaderTool, type RequestRecord, type SurfaceNode, type SystemPromptNode } from '../../src/shared/types'
import { createContextSettings, overviewThresholdOf, type SettingsField, type SettingsScopeLike } from '../../src/client/settings'
import { fromPartyOf, includesAgent, initialsOf, avatarLabelsOf, avatarLabelOf, kindGroupOf, nameOfParty, NAME_PARTY_PREFIX, previewOf, settledToneOf, UNKNOWN_PARTY } from '../../src/client/commsModel'
import { type CommsRow } from '../../src/client/fleetDetail'

describe('dna', () => {

function asm(over: Partial<Assembled>): Assembled {
  return { live: true, header: null, system: null, nodes: [], missingLive: 0, approximate: false, ...over }
}

function header(over: Partial<HeaderRecord>): HeaderRecord {
  return { seq: 10, time: 9000, tools: [], ...over }
}

function system(over: Partial<SystemPromptNode> = {}): SystemPromptNode {
  return { seq: 3, time: 9000, tokens: 100, ...over }
}

function tool(name: string, tokens: number): HeaderTool {
  return { name, tokens }
}


describe('dnaOf', () => {
  test('empty context yields no bands; an epoch without a system prompt yields tool bands only', () => {
    assert.deepEqual(dnaOf(asm({})), [])
    assert.deepEqual(dnaOf(asm({ header: header({ tools: [tool('bash', 30)] }) })).map(i => i.key), ['tool:bash'])
  })

  test('the system prompt leads, then the header epoch\'s tool schemas in producer order', () => {
    const items = dnaOf(asm({
      system: system(),
      header: header({ tools: [tool('bash', 30), tool('write', 20)] }),
      nodes: [surfaceNode({ seq: 1 })],
    }))
    assert.deepEqual(items.map(i => i.key), ['sys', 'tool:bash', 'tool:write', 'n1'])
    assert.deepEqual(items.map(i => i.cat), ['system', 'tools', 'tools', 'user'])
    assert.deepEqual(items.map(i => i.tokens), [100, 30, 20, 5])
    assert.equal(items[0].time, 9000, 'the system band carries the prompt node\'s time')
    assert.equal('time' in items[1], false, 'tool bands carry no time')
    assert.ok(!('node' in items[0]), 'header bands carry no node')
  })

  test('message bands follow node seqs with their node and logged time; zero-token bands stay; header bands stay at the front on a refresh', () => {
    const a = surfaceNode({ seq: 3, tokens: 7, time: 3000 })
    const b = surfaceNode({ seq: 8, cat: 'tool', tokens: 9 })
    const items = dnaOf(asm({ nodes: [a, b] }))
    assert.deepEqual(items.map(i => i.key), ['n3', 'n8'])
    assert.deepEqual(items.map(i => i.cat), ['user', 'tool'])
    assert.equal(items[0].time, 3000)
    assert.equal('time' in items[1], false)
    assert.equal((items[0] as { node?: SurfaceNode }).node, a)
    assert.equal((items[1] as { node?: SurfaceNode }).node, b)
    const refreshed = dnaOf(asm({
      system: system({ seq: 50 }),
      header: header({ seq: 50, tools: [tool('bash', 30)] }),
      nodes: [surfaceNode({ seq: 3 }), surfaceNode({ seq: 20, cat: 'tool' }), surfaceNode({ seq: 60, cat: 'assistant' })],
    }))
    assert.deepEqual(refreshed.map(i => i.key), ['sys', 'tool:bash', 'n3', 'n20', 'n60'])
    assert.deepEqual(dnaOf(asm({ nodes: [surfaceNode({ seq: 1, tokens: 0 }), surfaceNode({ seq: 2 })] })).map(i => i.key), ['n1', 'n2'], 'zero-token items keep their band')
  })
})

describe('trendBandsOf', () => {
  test('read-order bands carry the category colors and cumulative offsets from the floor; zero-token bands keep their slot', () => {
    const bands = trendBandsOf(asm({
      system: system(),
      header: header({ tools: [tool('bash', 30)] }),
      nodes: [surfaceNode({ seq: 1 }), surfaceNode({ seq: 2, cat: 'assistant', tokens: 20 })],
    }))
    assert.deepEqual(bands.map(b => b.key), ['sys', 'tool:bash', 'n1', 'n2'])
    assert.deepEqual(bands.map(b => b.cat), ['system', 'tools', 'user', 'assistant'])
    assert.deepEqual(bands.map(b => b.tokens), [100, 30, 5, 20])
    assert.deepEqual(bands.map(b => b.off), [0, 100, 130, 135])
    for (const b of bands) assert.equal(b.color, CAT_COLOR[b.cat])
    assert.ok(!('node' in bands[0]), 'header bands carry no node')
    assert.equal((bands[2] as { node: SurfaceNode }).node.cat, 'user', 'message bands hand the node through')
    const zero = trendBandsOf(asm({ nodes: [surfaceNode({ seq: 1, tokens: 0 }), surfaceNode({ seq: 2, tokens: 7 })] }))
    assert.deepEqual(zero.map(b => b.off), [0, 0])
    assert.equal(zero[1].off + zero[1].tokens, 7)
  })
})

describe('dnaBaseLabel', () => {
  const kit = makeKit()
  const bands = trendBandsOf(asm({
    system: system(),
    header: header({ tools: [tool('bash', 30)] }),
    nodes: [
      surfaceNode({ seq: 1, cat: 'assistant' }),
      surfaceNode({ seq: 2, cat: 'tool', tool: 'write' }),
      surfaceNode({ seq: 3, cat: 'tool' }),
      surfaceNode({ seq: 4, cat: 'inject', form: 'notice' }),
      surfaceNode({ seq: 5, cat: 'inject' }),
      surfaceNode({ seq: 6, cat: 'user', skill: 'sync' }),
    ],
  }))
  const label = (key: string): string => {
    const b = bands.find(x => x.key === key)
    assert.ok(b !== undefined)
    return dnaBaseLabel(b, kit.t, kit.catLabel)
  }

  test('header bands name the system prompt and the tool schema; message bands name the item the way its browser row would', () => {
    assert.equal(label('sys'), kit.catLabel('system'))
    assert.equal(label('tool:bash'), 'bash')
    assert.equal(label('n1'), kit.catLabel('assistant'))
    assert.equal(label('n2'), 'write')
    assert.equal(label('n3'), '?')
    assert.equal(label('n4'), kit.t('form.notice'))
    assert.equal(label('n5'), kit.t('form.context'))
    assert.equal(label('n6'), kit.t('node.skillTag', { name: 'sync' }))
  })
})

describe('deltaBandsOf', () => {
  function barsOf(spec: [key: string, cat: string, tokens: number][][]): TrendBand[][] {
    return spec.map(list => {
      let off = 0
      const out: TrendBand[] = list.map(([key, cat, tokens]) => {
        const color = CAT_COLOR[cat as keyof typeof CAT_COLOR]
        const band = (key.startsWith('n')
          ? { key, cat, tokens, off, color, node: { seq: Number(key.slice(1)), cat, tokens } as SurfaceNode }
          : { key, cat, tokens, off, color }) as TrendBand
        off += tokens
        return band
      })
      return out
    })
  }

  test('no baseline or an unchanged step carries no change; growth rides up in read order; removals hang down and keep their node', () => {
    const [b1] = barsOf([[['sys', 'system', 100], ['n1', 'user', 200]]])
    assert.deepEqual(deltaBandsOf(b1, null), { up: [], down: [] })
    const [prev, same] = barsOf([
      [['sys', 'system', 100], ['n1', 'user', 200]],
      [['sys', 'system', 100], ['n1', 'user', 200]],
    ])
    assert.deepEqual(deltaBandsOf(same, prev), { up: [], down: [] })
    const [before, after] = barsOf([
      [['sys', 'system', 100], ['n1', 'user', 100], ['a1', 'assistant', 60], ['t1', 'tool', 40]],
      [['sys', 'system', 100], ['n1', 'user', 100], ['a1', 'assistant', 90], ['n4', 'user', 30]],
    ])
    const d = deltaBandsOf(after, before)
    assert.deepEqual(d.up.map(b => [b.key, b.tokens, b.off]), [['a1', 30, 0], ['n4', 30, 30]])
    assert.deepEqual(d.down.map(b => [b.key, b.tokens, b.off]), [['t1', -40, 0]])
    assert.deepEqual(d.up.map(b => b.cat), ['assistant', 'user'])
    assert.equal(d.up[0].color, CAT_COLOR.assistant)
    const n4 = d.up[1]
    assert.ok('node' in n4)
    assert.equal(n4.node.seq, 4, 'message delta bands hand the node through for labels')

    const kit = makeKit()
    const removed = deltaBandsOf(trendBandsOf(asm({})), trendBandsOf(asm({ nodes: [surfaceNode({ seq: 9, cat: 'tool', tool: 'write', tokens: 50 })] })))
    assert.equal(removed.down.length, 1)
    assert.equal(removed.down[0].tokens, -50)
    assert.equal(dnaBaseLabel(removed.down[0], kit.t, kit.catLabel), 'write', 'a removed item\'s node still reaches the label builder')
  })
})


describe('deltaTotalsOf', () => {
  const band = (key: string, tokens: number): TrendBand => ({ key, cat: 'assistant', tokens, off: 0, color: CAT_COLOR.assistant, node: { seq: 1, cat: 'assistant', tokens } })

  test('sums the churn; no predecessor changes nothing; negative tokens land on the right arm', () => {
    const prev = [band('a', 10), band('b', 5), band('c', 7)]
    const next = [band('a', 13), band('b', 2), band('d', 4)]
    assert.deepEqual(deltaTotalsOf(next, prev), { up: 7, down: 10 }, 'a and d rose (+3, +4); b shrank (−3) and c dropped (−7)')
    assert.deepEqual(deltaTotalsOf([band('a', 5)], null), { up: 0, down: 0 })
    assert.deepEqual(deltaTotalsOf([band('a', 5)], [band('a', 5)]), { up: 0, down: 0 }, 'an unchanged item is no churn')
    assert.deepEqual(deltaTotalsOf([band('a', -4)], [band('a', 0)]), { up: 0, down: 4 })
    assert.deepEqual(deltaTotalsOf([], [band('a', -4)]), { up: 4, down: 0 })
    assert.deepEqual(deltaTotalsOf([], [band('a', 0)]), { up: 0, down: 0 })
  })
})


describe('dnaDeltaMaximaOf', () => {
  const nodeOf = (seq: number, tokens: number, cat: SurfaceNode['cat'] = 'assistant'): SurfaceNode => surfaceNode({ seq, tokens, cat })
  const current = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 }
  const timeline = (over: Partial<ContextTimeline> = {}): ContextTimeline => ({
    ok: true,
    current,
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  })
  const reqAt = (seq: number): RequestRecord => ({
    time: seq, seq, total: 100, system: 10, tools: 5, user: 20, inject: 5, skill: 0, assistant: 40, tool: 20,
  })
  const reference = (data: ContextTimeline, headers: ContextHeaders | null, requests: RequestRecord[]): { up: number; down: number } => {
    let up = 0
    let down = 0
    let prev: TrendBand[] | null = null
    for (const req of requests) {
      const totals = deltaTotalsOf(trendBandsOf(assemble(data, headers, req.seq)), prev)
      if (totals.up > up) up = totals.up
      if (totals.down > down) down = totals.down
      prev = trendBandsOf(assemble(data, headers, req.seq))
    }
    return { up, down }
  }

  test('empty requests stay at zero', () => {
    assert.deepEqual(dnaDeltaMaximaOf(timeline(), null, []), { up: 0, down: 0 })
  })

  test('matches the band fold on a plain growing surface', () => {
    const data = timeline({ nodes: [nodeOf(1, 50), nodeOf(2, 70), nodeOf(3, 20, 'tool'), nodeOf(4, 90)] })
    const requests = [reqAt(1), reqAt(2), reqAt(3), reqAt(4), reqAt(4)]
    assert.deepEqual(dnaDeltaMaximaOf(data, null, requests), reference(data, null, requests))
  })

  test('matches the band fold across system prompt refreshes, including zero-token epochs', () => {
    const data = timeline({
      nodes: [nodeOf(1, 50), nodeOf(2, 30), nodeOf(3, 80)],
      systems: [system({ seq: 1, tokens: 100 }), system({ seq: 3, tokens: 0 }), system({ seq: 5, tokens: 140 })],
    })
    const requests = [reqAt(1), reqAt(3), reqAt(5), reqAt(6), reqAt(9)]
    assert.deepEqual(dnaDeltaMaximaOf(data, null, requests), reference(data, null, requests))
  })

  test('matches the band fold across header epochs with changing tool schemas', () => {
    const data = timeline({ nodes: [nodeOf(2, 40), nodeOf(4, 60, 'user'), nodeOf(6, 25, 'tool')] })
    const headers: ContextHeaders = { headers: [header({ seq: 1, tools: [tool('bash', 30), tool('read', 12)] }), header({ seq: 5, tools: [tool('bash', 44)] })] }
    const requests = [reqAt(1), reqAt(2), reqAt(5), reqAt(6), reqAt(7)]
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), reference(data, headers, requests))
  })

  test('a negative node token falls back to the exact band fold instead of the surface fast path', () => {
    const data = timeline({ nodes: [nodeOf(1, 50), nodeOf(2, -30), nodeOf(3, 70)] })
    const requests = [reqAt(1), reqAt(2), reqAt(3)]
    assert.deepEqual(dnaDeltaMaximaOf(data, null, requests), reference(data, null, requests))
  })

  test('an archive, unsorted nodes, or non-monotonic requests fall back to the exact band fold', () => {
    const archived = timeline({ nodes: [nodeOf(5, 40)], archive: [{ ...nodeOf(1, 70), gone: 4 }] })
    const requests = [reqAt(1), reqAt(2), reqAt(5)]
    assert.deepEqual(dnaDeltaMaximaOf(archived, null, requests), reference(archived, null, requests))
    const unsorted = timeline({ nodes: [nodeOf(3, 20), nodeOf(1, 50), nodeOf(2, 70)] })
    assert.deepEqual(dnaDeltaMaximaOf(unsorted, null, requests), reference(unsorted, null, requests))
    const backwards = timeline({ nodes: [nodeOf(1, 50), nodeOf(2, 70)] })
    const descending = [reqAt(3), reqAt(2), reqAt(1)]
    assert.deepEqual(dnaDeltaMaximaOf(backwards, null, descending), reference(backwards, null, descending))
  })

  test('a removed negative-token tool lands its refund on the up arm like the band fold', () => {
    const data = timeline({ nodes: [] })
    const headers: ContextHeaders = { headers: [header({ seq: 1, tools: [tool('bash', -30)] }), header({ seq: 4, tools: [] })] }
    const requests = [reqAt(2), reqAt(4), reqAt(5)]
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), reference(data, headers, requests))
  })

  test('a removed zero-token tool evaluates the leftover arms with no effect', () => {
    const data = timeline({ nodes: [] })
    const headers: ContextHeaders = { headers: [header({ seq: 1, tools: [tool('bash', 0)] }), header({ seq: 4, tools: [] })] }
    const requests = [reqAt(2), reqAt(4), reqAt(5)]
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), { up: 0, down: 0 })
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), reference(data, headers, requests))
  })

  test('a tool whose tokens shrink between header epochs lands the drop on the down arm', () => {
    const data = timeline({ nodes: [] })
    const headers: ContextHeaders = { headers: [header({ seq: 1, tools: [tool('bash', 40)] }), header({ seq: 4, tools: [tool('bash', 10)] })] }
    const requests = [reqAt(2), reqAt(4), reqAt(5)]
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), { up: 0, down: 30 })
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), reference(data, headers, requests))
  })

  test('negative token deltas and header removals land on the down arm like the band fold', () => {
    const data = timeline({ nodes: [nodeOf(1, 50, 'tool'), nodeOf(3, 20)] })
    const headers: ContextHeaders = { headers: [header({ seq: 1, tools: [tool('bash', 40)] }), header({ seq: 4, tools: [] })] }
    const requests = [reqAt(2), reqAt(4), reqAt(5)]
    assert.deepEqual(dnaDeltaMaximaOf(data, headers, requests), reference(data, headers, requests))
  })
})


describe('dnaDeltaMaximaOf randomized parity', () => {
  const current = { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 }
  const reqAt = (seq: number): RequestRecord => ({
    time: seq, seq, total: 100, system: 10, tools: 5, user: 20, inject: 5, skill: 0, assistant: 40, tool: 20,
  })
  const CATS_POOL: SurfaceNode['cat'][] = ['user', 'assistant', 'tool', 'inject', 'skill']

  test('the fast path and the fallback agree across 300 randomized scenarios', () => {
    let seed = 0x2f6e2b1
    const rand = (n: number): number => {
      seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0
      return seed % n
    }
    for (let scenario = 0; scenario < 300; scenario++) {
      const nodeCount = rand(12)
      const nodes: SurfaceNode[] = Array.from({ length: nodeCount }, (_, i) => ({
        seq: i + 1,
        cat: CATS_POOL[rand(CATS_POOL.length)],
        tokens: rand(120),
      }))
      if (rand(4) === 0) nodes.reverse()
      const archive: SurfaceNode[] = []
      if (rand(3) === 0 && nodes.length > 1) {
        archive.push({ ...nodes[0], gone: nodes[nodes.length - 1].seq })
      }
      const systems: SystemPromptNode[] = []
      if (rand(2) === 0) {
        for (let i = 0; i < 1 + rand(3); i++) systems.push({ seq: 1 + rand(10), time: i, tokens: rand(4) === 0 ? 0 : 20 + rand(200) })
      }
      const headers: ContextHeaders = { headers: [] }
      if (rand(3) !== 0) {
        for (let i = 0; i < 1 + rand(3); i++) {
          const tools: HeaderTool[] = []
          for (let k = 0; k < rand(4); k++) tools.push({ name: `t${k + rand(3)}`, tokens: rand(80) })
          headers.headers.push({ seq: 1 + rand(10), time: i, tools })
        }
      }
      const requestCount = rand(10)
      let seq = 1 + rand(4)
      const requests: RequestRecord[] = []
      for (let i = 0; i < requestCount; i++) {
        requests.push(reqAt(seq))
        seq += rand(4) === 0 ? 0 : 1 + rand(3)
        if (rand(10) === 0) seq = Math.max(1, seq - 2)
      }
      const data: ContextTimeline = {
        ok: true,
        current,
        requests: [],
        events: [],
        nodes,
        droppedNodes: archive.length > 0 ? 1 : 0,
        archive,
        ...(systems.length > 0 ? { systems } : {}),
      }
      let up = 0
      let down = 0
      let prev: TrendBand[] | null = null
      for (const req of requests) {
        const bands = trendBandsOf(assemble(data, headers, req.seq))
        const totals = deltaTotalsOf(bands, prev)
        if (totals.up > up) up = totals.up
        if (totals.down > down) down = totals.down
        prev = bands
      }
      assert.deepEqual(
        dnaDeltaMaximaOf(data, headers, requests),
        { up, down },
        `scenario ${scenario}: nodes=${JSON.stringify(nodes)} archive=${JSON.stringify(archive)} systems=${JSON.stringify(systems)} headers=${JSON.stringify(headers.headers)} requests=${JSON.stringify(requests.map(r => r.seq))}`,
      )
    }
  })
})
})

describe('settings', () => {

class TestSettingsScope implements SettingsScopeLike {
  private snapshot: { status: string; value: unknown; writable: boolean }
  private readonly listeners = new Set<() => void>()
  readonly sets: { field: string; value: unknown }[] = []

  constructor(snapshot: { status: string; value: unknown; writable: boolean }) {
    this.snapshot = snapshot
  }

  getSnapshot(): { status: string; value: unknown; writable: boolean } {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  failSet = false

  set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value })
    return this.failSet ? Promise.reject(new Error('write failed')) : Promise.resolve()
  }

  emit(snapshot: { status: string; value: unknown; writable: boolean }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

describe('createContextSettings defaults', () => {
  test('starts loading with schema defaults and not writable', () => {
    const s = createContextSettings()
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'loading',
      placement: 'all',
      granularity: 'step',
      mode: 'total',
      deltaBase: 'step',
      toolSort: 'count',
      fileSort: 'lines',
      insightsEntry: 'show',
      durationCurve: 'show',
      overviewAutoSteps: '100',
      overviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
      writable: false,
    })
  })
})

describe('overviewThresholdOf', () => {
  test('maps the numeric steps to a threshold and off to null', () => {
    assert.equal(overviewThresholdOf('100'), 100)
    assert.equal(overviewThresholdOf('200'), 200)
    assert.equal(overviewThresholdOf('300'), 300)
    assert.equal(overviewThresholdOf('off'), null)
  })
})

describe('store', () => {
  test('subscribers are notified on change and unsubscribe stops', () => {
    const s = createContextSettings()
    let calls = 0
    const unsubscribe = s.store.subscribe(() => { calls++ })
    s.set('defaultTrendMode', 'delta')
    assert.equal(calls, 1)
    assert.equal(s.store.getSnapshot().mode, 'delta')
    unsubscribe()
    s.set('defaultTrendMode', 'total')
    assert.equal(calls, 1)
  })
})

describe('set', () => {
  test('without attach it echoes locally; the hidden placement serves from the scope and a pick; no-ops stay silent', () => {
    const s = createContextSettings()
    s.set('defaultGranularity', 'turn')
    assert.equal(s.defaultGranularity(), 'turn')
    s.set('defaultPlacement', 'sidebar')
    assert.equal(s.defaultPlacement(), 'sidebar')
    s.set('defaultDeltaBase', 'turn')
    assert.equal(s.defaultDeltaBase(), 'turn')
    s.set('promptPrefix', 'Be terse.')
    assert.equal(s.store.getSnapshot().promptPrefix, 'Be terse.')
    s.set('overviewAutoSteps', 'off')
    assert.equal(s.overviewAutoSteps(), 'off')
    s.set('defaultOverviewRange', 'today')
    assert.equal(s.defaultOverviewRange(), 'today')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultPlacement: 'hide' }, writable: true }))
    assert.equal(s.defaultPlacement(), 'hide')
    s.set('defaultPlacement', 'all')
    assert.equal(s.defaultPlacement(), 'all')
    s.set('defaultPlacement', 'hide')
    assert.equal(s.defaultPlacement(), 'hide')

    const unchanged = createContextSettings()
    let calls = 0
    unchanged.store.subscribe(() => { calls++ })
    unchanged.set('defaultGranularity', 'step')
    assert.equal(calls, 0)
    unchanged.set('defaultGranularity', 'bogus')
    assert.equal(unchanged.defaultGranularity(), 'step')
    assert.equal(calls, 0)
  })

  test('with attach it echoes locally and writes through the scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta')
    assert.deepEqual(scope.sets, [{ field: 'defaultTrendMode', value: 'delta' }])
  })

  test('a rejected scope write settles handled and rolls the echo back to the scope truth', async () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { defaultTrendMode: 'total' }, writable: true })
    s.attach(scope)
    scope.failSet = true
    s.set('defaultTrendMode', 'delta')
    assert.equal(s.defaultTrendMode(), 'delta', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(s.defaultTrendMode(), 'total', 'the echo rolls back to the scope truth')
  })

  test('a rejected gate write echoes first, then degrades without a scope truth or rolls back to one', async () => {
    const cases: [SettingsField, string, string | undefined, string, (s: ReturnType<typeof createContextSettings>) => string][] = [
      ['defaultPlacement', 'sidebar', undefined, 'all', s => s.defaultPlacement()],
      ['defaultPlacement', 'tab', 'sidebar', 'sidebar', s => s.defaultPlacement()],
      ['insightsEntry', 'hide', undefined, 'show', s => s.insightsEntry()],
      ['insightsEntry', 'show', 'hide', 'hide', s => s.insightsEntry()],
      ['fleetTab', 'hide', undefined, 'show', s => s.fleetTab()],
      ['fleetTab', 'show', 'hide', 'hide', s => s.fleetTab()],
    ]
    for (const [field, picked, truth, expected, read] of cases) {
      const s = createContextSettings()
      const scope = new TestSettingsScope({ status: 'ready', value: truth === undefined ? {} : { [field]: truth }, writable: true })
      s.attach(scope)
      scope.failSet = true
      s.set(field, picked)
      assert.equal(read(s), picked, `${field}: the optimistic echo lands first`)
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(read(s), expected, `${field}: the refused echo settles`)
    }
  })

  test('a rejected non-gate write keeps a preference the scope does not carry, or rolls back to its truth', async () => {
    const kept = createContextSettings()
    const emptyScope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    kept.attach(emptyScope)
    emptyScope.failSet = true
    kept.set('defaultFileSort', 'path')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(kept.defaultFileSort(), 'path', 'the in-session choice survives')

    const rolled = createContextSettings()
    const promptScope = new TestSettingsScope({ status: 'ready', value: { promptPrefix: 'kept' }, writable: true })
    rolled.attach(promptScope)
    promptScope.failSet = true
    rolled.set('promptPrefix', 'draft')
    assert.equal(rolled.store.getSnapshot().promptPrefix, 'draft', 'the optimistic echo lands first')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(rolled.store.getSnapshot().promptPrefix, 'kept', 'the echo rolls back to the scope truth')
  })
})

describe('attach', () => {
  test('syncs a ready snapshot with parsed preferences', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: {
        defaultPlacement: 'sidebar',
        defaultGranularity: 'turn',
        defaultTrendMode: 'delta',
        defaultDeltaBase: 'turn',
        defaultToolSort: 'name',
        defaultFileSort: 'path',
        insightsEntry: 'hide',
        defaultDurationCurve: 'hide',
        overviewAutoSteps: '300',
        defaultOverviewRange: '7d',
        fleetTab: 'hide',
        promptPrefix: 'Be terse.',
        promptSuffix: 'Sign as Atlas.',
      },
      writable: true,
    })
    s.attach(scope)
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      placement: 'sidebar',
      granularity: 'turn',
      mode: 'delta',
      deltaBase: 'turn',
      toolSort: 'name',
      fileSort: 'path',
      insightsEntry: 'hide',
      durationCurve: 'hide',
      overviewAutoSteps: '300',
      overviewRange: '7d',
      fleetTab: 'hide',
      promptPrefix: 'Be terse.',
      promptSuffix: 'Sign as Atlas.',
      writable: true,
    })
    const defaults = createContextSettings()
    defaults.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'all', defaultGranularity: 'step', defaultTrendMode: 'total', defaultDeltaBase: 'step', defaultToolSort: 'count', defaultFileSort: 'lines', insightsEntry: 'show', overviewAutoSteps: '200', defaultOverviewRange: 'all' },
      writable: false,
    }))
    assert.equal(defaults.defaultPlacement(), 'all')
    assert.equal(defaults.defaultGranularity(), 'step')
    assert.equal(defaults.defaultTrendMode(), 'total')
    assert.equal(defaults.defaultDeltaBase(), 'step')
    assert.equal(defaults.defaultToolSort(), 'count')
    assert.equal(defaults.defaultFileSort(), 'lines')
    assert.equal(defaults.insightsEntry(), 'show')
    assert.equal(defaults.overviewAutoSteps(), '200')
    assert.equal(defaults.defaultOverviewRange(), 'all')
  })

  test('an unavailable snapshot keeps parsed preferences; any other status reads as loading', () => {
    const unavailable = createContextSettings()
    unavailable.attach(new TestSettingsScope({ status: 'unavailable', value: {}, writable: false }))
    assert.equal(unavailable.store.getSnapshot().status, 'unavailable')
    const pending = createContextSettings()
    pending.attach(new TestSettingsScope({ status: 'pending', value: {}, writable: false }))
    assert.equal(pending.store.getSnapshot().status, 'loading')
  })

  test('null/non-object section values keep the defaults', () => {
    for (const value of [null, 42]) {
      const s = createContextSettings()
      s.attach(new TestSettingsScope({ status: 'ready', value, writable: false }))
      assert.deepEqual(s.store.getSnapshot(), {
        status: 'ready',
        placement: 'all',
        granularity: 'step',
        mode: 'total',
        deltaBase: 'step',
        toolSort: 'count',
        fileSort: 'lines',
        insightsEntry: 'show',
        durationCurve: 'show',
        overviewAutoSteps: '100',
        overviewRange: '30d',
        fleetTab: 'show',
        promptPrefix: '',
        promptSuffix: '',
        writable: false,
      })
    }
  })

  test('invalid preference values keep the defaults', () => {
    const s = createContextSettings()
    s.attach(new TestSettingsScope({
      status: 'ready',
      value: { defaultPlacement: 'window', defaultGranularity: 'bogus', defaultTrendMode: 7, defaultDeltaBase: 'bogus', defaultToolSort: 'alpha', defaultFileSort: 'alpha', insightsEntry: 42, defaultDurationCurve: 'always', overviewAutoSteps: 200, defaultOverviewRange: 'week', fleetTab: 7, promptPrefix: 9, promptSuffix: {} },
      writable: false,
    }))
    assert.equal(s.defaultPlacement(), 'all')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultDeltaBase(), 'step')
    assert.equal(s.defaultToolSort(), 'count')
    assert.equal(s.defaultFileSort(), 'lines')
    assert.equal(s.insightsEntry(), 'show')
    assert.equal(s.defaultDurationCurve(), 'show')
    assert.equal(s.overviewAutoSteps(), '100')
    assert.equal(s.defaultOverviewRange(), '30d')
    assert.equal(s.fleetTab(), 'show')
    assert.equal(s.store.getSnapshot().promptPrefix, '', 'a non-string prompt value degrades to the empty default')
    assert.equal(s.store.getSnapshot().promptSuffix, '')
  })

  test('an invalid scope value degrades a gate to its default instead of keeping the current one', () => {
    const cases: [SettingsField, string, unknown, string, () => string][] = [
      ['defaultPlacement', 'tab', 42, 'all', () => s.defaultPlacement()],
      ['insightsEntry', 'hide', 'visible', 'show', () => s.insightsEntry()],
      ['defaultDurationCurve', 'hide', 'always', 'show', () => s.defaultDurationCurve()],
      ['overviewAutoSteps', '200', '50', '100', () => s.overviewAutoSteps()],
      ['defaultOverviewRange', '7d', 'quarter', '30d', () => s.defaultOverviewRange()],
    ]
    let s = createContextSettings()
    for (const [field, prior, invalid, expected, read] of cases) {
      s = createContextSettings()
      s.set(field, prior)
      assert.notEqual(read(), expected, field)
      s.attach(new TestSettingsScope({ status: 'ready', value: { [field]: invalid }, writable: false }))
      assert.equal(read(), expected, field)
    }
  })

  test('missing fields keep the current state', () => {
    const s = createContextSettings()
    s.set('defaultPlacement', 'tab')
    s.set('defaultToolSort', 'size')
    s.set('insightsEntry', 'hide')
    s.set('defaultDurationCurve', 'hide')
    s.set('overviewAutoSteps', '100')
    s.set('defaultOverviewRange', 'today')
    s.set('promptPrefix', 'drafted')
    s.attach(new TestSettingsScope({ status: 'ready', value: { defaultFileSort: 'latest' }, writable: false }))
    assert.equal(s.defaultPlacement(), 'tab', 'the in-session choice survives a section without the field')
    assert.equal(s.defaultGranularity(), 'step')
    assert.equal(s.defaultTrendMode(), 'total')
    assert.equal(s.defaultToolSort(), 'size', 'the in-session tool sort survives a section without the field')
    assert.equal(s.defaultFileSort(), 'latest')
    assert.equal(s.insightsEntry(), 'hide', 'the in-session entry choice survives a section without the field')
    assert.equal(s.defaultDurationCurve(), 'hide', 'the in-session curve choice survives a section without the field')
    assert.equal(s.overviewAutoSteps(), '100', 'the in-session auto-overview choice survives a section without the field')
    assert.equal(s.defaultOverviewRange(), 'today', 'the in-session overview range survives a section without the field')
    assert.equal(s.store.getSnapshot().promptPrefix, 'drafted', 'the in-session prompt text survives a section without the field')
  })

  test('scope updates republish to subscribers', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 1)
    assert.equal(s.defaultGranularity(), 'turn')
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' }, writable: true })
    assert.equal(calls, 2)
    assert.equal(s.defaultTrendMode(), 'delta')
    scope.emit({ status: 'ready', value: { defaultFileSort: 'path' }, writable: false })
    assert.equal(calls, 3)
    assert.equal(s.store.getSnapshot().writable, false)
    scope.emit({ status: 'ready', value: { defaultFileSort: 'name' }, writable: false })
    assert.equal(calls, 4)
    assert.equal(s.defaultFileSort(), 'name')
  })

  test('an identical scope snapshot does not notify listeners', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({
      status: 'ready',
      value: { defaultGranularity: 'turn', defaultFileSort: 'latest' },
      writable: true,
    })
    s.attach(scope)
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn', defaultFileSort: 'latest' }, writable: true })
    assert.equal(calls, 0)
  })

  test('the disposer detaches its scope subscription; a later set never reaches the dead scope; a superseded attach keeps the newer scope', () => {
    const s = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detach = s.attach(scope)
    detach()
    let calls = 0
    s.store.subscribe(() => { calls++ })
    scope.emit({ status: 'ready', value: { defaultGranularity: 'turn' }, writable: true })
    assert.equal(calls, 0)
    assert.equal(s.defaultGranularity(), 'step')
    s.set('defaultTrendMode', 'delta')
    assert.deepEqual(scope.sets, [])

    const first = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const second = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    const detachFirst = s.attach(first)
    s.attach(second)
    detachFirst()
    s.set('defaultFileSort', 'path')
    assert.deepEqual(first.sets, [])
    assert.deepEqual(second.sets, [{ field: 'defaultFileSort', value: 'path' }])
  })

  test('a snapshot value that throws on property access keeps the current state', () => {
    const s = createContextSettings()
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    s.attach(new TestSettingsScope({ status: 'ready', value: hostile, writable: true }))
    assert.deepEqual(s.store.getSnapshot(), {
      status: 'ready',
      placement: 'all',
      granularity: 'step',
      mode: 'total',
      deltaBase: 'step',
      toolSort: 'count',
      fileSort: 'lines',
      insightsEntry: 'show',
      durationCurve: 'show',
      overviewAutoSteps: '100',
      overviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
      writable: true,
    })
  })
})
})

describe('commsModel', () => {

function row(over: Partial<CommsRow> & { seq: number; to: string; time: number; text: string }): CommsRow {
  return { key: `${over.to}:${over.seq}:${over.time}:relay`, kind: 'relay', ...over }
}

describe('party keys', () => {
  test('an id outranks a name; name-only parties key by name; the bare arrow is unknown; channels are unordered and agent scope matches either side', () => {
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x', from: 'b', fromName: 'Bee' })), 'b')
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x', fromName: 'Bee' })), NAME_PARTY_PREFIX + 'Bee')
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x' })), UNKNOWN_PARTY)
    assert.equal(nameOfParty(NAME_PARTY_PREFIX + 'Bee'), 'Bee')
    assert.equal(nameOfParty('session-a'), undefined)
    const forward = row({ seq: 1, to: 'b', time: 1, text: 'x', from: 'a' })
    assert.equal(includesAgent(forward, 'a'), true)
    assert.equal(includesAgent(forward, 'b'), true)
    assert.equal(includesAgent(forward, 'c'), false)
  })
})

describe('display helpers', () => {
  test('settled tones and kind groups; previews strip fences and markup and cap at 600; initials cover CJK, hyphens, single words, and blanks', () => {
    assert.equal(settledToneOf('finished'), 'done')
    assert.equal(settledToneOf('finishedFinal'), 'done')
    assert.equal(settledToneOf('failed'), 'error')
    assert.equal(settledToneOf('stopped'), 'warning')
    assert.equal(settledToneOf('declined'), 'warning')
    assert.equal(settledToneOf(null), 'idle')
    assert.equal(kindGroupOf(row({ seq: 1, to: 'a', time: 1, text: '' })), 'message')
    assert.equal(kindGroupOf({ key: 'a', seq: 1, to: 'a', time: 1, kind: 'settled', text: '' }), 'report')

    assert.equal(previewOf('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Title a b 1 2')
    assert.equal(previewOf('```js\nconst x = 1\n```'), '```js const x = 1 ```')
    assert.equal(previewOf('`inline` **bold** [link](https://x)'), 'inline bold link')
    const long = previewOf('x'.repeat(800))
    assert.equal(long.length, 601)
    assert.ok(long.endsWith('…'))

    assert.equal(initialsOf('分析 Agent'), '分析')
    assert.equal(initialsOf('修复会话耗时占比统计'), '修复')
    assert.equal(initialsOf('主 Agent'), '主A')
    assert.equal(initialsOf('standard-axis options'), 'SA')
    assert.equal(initialsOf('Review Code'), 'RC')
    assert.equal(initialsOf('host-cleaner'), 'HC')
    assert.equal(initialsOf('lead'), 'LE')
    assert.equal(initialsOf('a'), 'A')
    assert.equal(initialsOf('  '), '?')
    assert.equal(initialsOf(' - '), '?')
  })

  test('avatar labels stay on one line up to three glyphs, then fold onto two', () => {
    assert.deepEqual(avatarLabelOf('CB'), { lines: ['CB'], condensed: false })
    assert.deepEqual(avatarLabelOf('主控'), { lines: ['主控'], condensed: false })
    assert.deepEqual(avatarLabelOf('DS1'), { lines: ['DS1'], condensed: true })
    assert.deepEqual(avatarLabelOf('修复1'), { lines: ['修复1'], condensed: true })
    assert.deepEqual(avatarLabelOf('DS45'), { lines: ['DS', '45'], condensed: false })
    assert.deepEqual(avatarLabelOf('DS108'), { lines: ['DS', '108'], condensed: false })
    assert.deepEqual(avatarLabelOf('ABCD'), { lines: ['AB', 'CD'], condensed: false })
  })

  test('avatar labels keep the plain initials until two agents collide, then digits split them', () => {
    const labels = avatarLabelsOf([
      { id: 'a', name: 'Spec review of timing fix' },
      { id: 'b', name: 'Standards review of diff' },
      { id: 'c', name: '修复会话耗时占比统计' },
      { id: 'd', name: 'worker-bee' },
      { id: 'a', name: 'Spec review of timing fix' },
    ])
    assert.deepEqual([...labels.entries()], [['a', 'SR1'], ['b', 'SR2'], ['c', '修复'], ['d', 'WB']])
    assert.deepEqual([...avatarLabelsOf([]).entries()], [])
    const solo = avatarLabelsOf([{ id: 'a', name: 'Spec review of timing fix' }])
    assert.deepEqual([...solo.entries()], [['a', 'SR']])
  })
})
})
