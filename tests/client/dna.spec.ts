import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { deltaBandsOf, deltaTotalsOf, dnaBaseLabel, dnaDeltaMaximaOf, dnaOf, trendBandsOf } from '../../src/client/dna'
import type { TrendBand } from '../../src/client/dna'
import { CAT_COLOR } from '../../src/client/categories'
import { makeKit, surfaceNode } from './helpers/kit'
import { assemble } from '../../src/client/assemble'
import type { Assembled } from '../../src/client/assemble'
import type { ContextHeaders, ContextTimeline, HeaderRecord, HeaderTool, RequestRecord, SurfaceNode, SystemPromptNode } from '../../src/shared/types'

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
