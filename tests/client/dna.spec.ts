// dnaOf (src/client/dna.ts): the DNA strip's per-item decomposition — the system prompt and the header epoch's
// tool schemas lead, the message flow follows in the assembled model-visible order (the order the model reads the context).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { deltaBandsOf, dnaBaseLabel, dnaOf, trendBandsOf } from '../../src/client/dna'
import type { TrendBand } from '../../src/client/dna'
import { CAT_COLOR } from '../../src/client/categories'
import { makeKit, surfaceNode } from './helpers/kit'
import type { Assembled } from '../../src/client/assemble'
import type { HeaderRecord, HeaderTool, SurfaceNode, SystemPromptNode } from '../../src/shared/types'

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
  test('empty context yields no bands', () => {
    assert.deepEqual(dnaOf(asm({})), [])
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

  test('an epoch without a system prompt yields tool bands only', () => {
    const items = dnaOf(asm({ header: header({ tools: [tool('bash', 30)] }) }))
    assert.deepEqual(items.map(i => i.key), ['tool:bash'])
  })

  test('message bands follow the assembled node order and hand the node through, with time only when logged', () => {
    const a = surfaceNode({ seq: 3, tokens: 7, time: 3000 })
    const b = surfaceNode({ seq: 8, cat: 'tool', tokens: 9 })
    const items = dnaOf(asm({ nodes: [a, b] }))
    assert.deepEqual(items.map(i => i.key), ['n3', 'n8'])
    assert.deepEqual(items.map(i => i.cat), ['user', 'tool'])
    assert.equal(items[0].time, 3000)
    assert.equal('time' in items[1], false)
    assert.equal((items[0] as { node?: SurfaceNode }).node, a)
    assert.equal((items[1] as { node?: SurfaceNode }).node, b)
  })

  test('a mid-session epoch refresh keeps the header bands at the FRONT (the epoch seq is bookkeeping, not prompt position)', () => {
    // The regression this pins: dsh appends `request/header` at dispatch time of the first request using the header, so a
    // refreshed epoch's seq lands AFTER every message already in context — epoch-seq ordering parked the system/tools
    // bands behind the tool results those very schemas describe.
    const items = dnaOf(asm({
      system: system({ seq: 50 }),
      header: header({ seq: 50, tools: [tool('bash', 30)] }),
      nodes: [surfaceNode({ seq: 3 }), surfaceNode({ seq: 20, cat: 'tool' }), surfaceNode({ seq: 60, cat: 'assistant' })],
    }))
    assert.deepEqual(items.map(i => i.key), ['sys', 'tool:bash', 'n3', 'n20', 'n60'])
  })

  test('zero-token items keep their band (the bar drops zero widths, the reading order stays truthful)', () => {
    const items = dnaOf(asm({ nodes: [surfaceNode({ seq: 1, tokens: 0 }), surfaceNode({ seq: 2 })] }))
    assert.deepEqual(items.map(i => i.key), ['n1', 'n2'])
  })

  test('bands read in the assembled order — a compacted summary leads at its prompt seat despite its newest seq', () => {
    const items = dnaOf(asm({
      nodes: [surfaceNode({ seq: 60, tokens: 20, seat: 1 }), surfaceNode({ seq: 3 }), surfaceNode({ seq: 40 })],
    }))
    assert.deepEqual(items.map(i => i.key), ['n60', 'n3', 'n40'])
  })
})

describe('trendBandsOf', () => {
  test('read-order bands carry the category colors and cumulative offsets from the floor', () => {
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
  })

  test('zero-token bands keep their slot: the next offset still counts them', () => {
    const bands = trendBandsOf(asm({ nodes: [surfaceNode({ seq: 1, tokens: 0 }), surfaceNode({ seq: 2, tokens: 7 })] }))
    assert.deepEqual(bands.map(b => b.off), [0, 0])
    assert.equal(bands[1].off + bands[1].tokens, 7)
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

  test('header bands name the system prompt and the tool schema', () => {
    assert.equal(label('sys'), kit.catLabel('system'))
    assert.equal(label('tool:bash'), 'bash')
  })

  test('message bands name the item the way its browser row would', () => {
    assert.equal(label('n1'), kit.catLabel('assistant'))
    assert.equal(label('n2'), 'write')
    assert.equal(label('n3'), '?')
    assert.equal(label('n4'), kit.t('form.notice'))
    assert.equal(label('n5'), kit.t('form.context'))
    assert.equal(label('n6'), kit.t('node.skillTag', { name: 'sync' }))
  })
})

describe('deltaBandsOf', () => {
  // Fixture builder: one bar's band list per entry; bands shared across bars pair up by key.
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

  test('no baseline (the first bar) carries no change at all', () => {
    const [b1] = barsOf([[['sys', 'system', 100], ['n1', 'user', 200]]])
    assert.deepEqual(deltaBandsOf(b1, null), { up: [], down: [] })
  })

  test('newcomers and growth ride the up arm in read order; removals hang on the down arm', () => {
    const [b1, b2] = barsOf([
      [['sys', 'system', 100], ['n1', 'user', 100], ['a1', 'assistant', 60], ['t1', 'tool', 40]],
      [['sys', 'system', 100], ['n1', 'user', 100], ['a1', 'assistant', 90], ['n4', 'user', 30]],
    ])
    const d = deltaBandsOf(b2, b1)
    // Up: a1 grew +30 (keeping its read-order slot), then the n4 newcomer +30. Down: t1 left −40.
    assert.deepEqual(d.up.map(b => [b.key, b.tokens, b.off]), [['a1', 30, 0], ['n4', 30, 30]])
    assert.deepEqual(d.down.map(b => [b.key, b.tokens, b.off]), [['t1', -40, 0]])
    assert.deepEqual(d.up.map(b => b.cat), ['assistant', 'user'])
    assert.equal(d.up[0].color, CAT_COLOR.assistant)
    const n4 = d.up[1]
    assert.ok('node' in n4)
    assert.equal(n4.node.seq, 4, 'message delta bands hand the node through for labels')
  })

  test('unchanged items vanish from both arms entirely', () => {
    const [b1, b2] = barsOf([
      [['sys', 'system', 100], ['n1', 'user', 200]],
      [['sys', 'system', 100], ['n1', 'user', 200]],
    ])
    assert.deepEqual(deltaBandsOf(b2, b1), { up: [], down: [] })
  })

  test('a removed item\'s node still reaches the label builder', () => {
    const kit = makeKit()
    const prev = trendBandsOf(asm({ nodes: [surfaceNode({ seq: 9, cat: 'tool', tool: 'write', tokens: 50 })] }))
    const cur = trendBandsOf(asm({}))
    const d = deltaBandsOf(cur, prev)
    assert.equal(d.down.length, 1)
    assert.equal(d.down[0].tokens, -50)
    assert.equal(dnaBaseLabel(d.down[0], kit.t, kit.catLabel), 'write')
  })
})
