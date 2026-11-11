import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Assembled } from '../../../src/client/assemble'
import { incrementHas, incrementOf } from '../../../src/client/components/browserIncrement'
import type { ContextHeaders, HeaderTool, SurfaceNode, SystemPromptNode } from '../../../src/shared/types'
import { click, flush, hover, mount, query, queryAll, surfaceNode, text, tipRows, unhover } from '../helpers/kit'
import type { Mounted } from '../helpers/kit'
import { Browser, ROW, catRow, elemRows, kit, pickStep, props, req, tl, withEpochContent } from './browserHarness'

function asm(over: Partial<Assembled> = {}): Assembled {
  return { live: false, header: null, system: null, nodes: [], missingLive: 0, approximate: false, ...over }
}

const node = (seq: number, cat: SurfaceNode['cat'], tokens: number): SurfaceNode => ({ seq, cat, tokens })
const system = (seq: number, tokens: number): SystemPromptNode => ({ seq, time: 1, tokens })
const tool = (name: string, tokens: number): HeaderTool => ({ name, tokens })
const header = (seq: number, tools: HeaderTool[]): Assembled['header'] => ({ seq, time: 1, tools })

describe('incrementOf', () => {
  test('keeps only the nodes, system prompt, and tools absent from the base view', () => {
    const view = asm({
      nodes: [node(1, 'user', 5), node(2, 'tool', 10), node(3, 'assistant', 20)],
      system: system(4, 100),
      header: header(5, [tool('bash', 50), tool('write', 25)]),
    })
    const base = asm({
      nodes: [node(1, 'user', 5)],
      header: header(5, [tool('bash', 50)]),
    })
    const inc = incrementOf(view, base)
    assert.deepEqual(inc.nodes.map(n => n.seq), [2, 3])
    assert.deepEqual(inc.byCat.tool?.map(n => n.seq), [2])
    assert.deepEqual([...inc.seqs].sort(), [2, 3])
    assert.equal(inc.counts.tool, 1)
    assert.equal(inc.counts.assistant, 1)
    assert.equal(inc.counts.user, 0)
    assert.equal(inc.tokens.tool, 10)
    assert.equal(inc.tokens.assistant, 20)
    assert.equal(inc.counts.system, 1)
    assert.equal(inc.tokens.system, 100)
    assert.deepEqual(inc.tools.map(t => t.name), ['write'])
    assert.deepEqual([...inc.toolNames], ['write'])
    assert.equal(inc.header?.tools.length, 1)
    assert.equal(inc.counts.tools, 1)
    assert.equal(inc.tokens.tools, 25)
    assert.equal(inc.items, 4)
    assert.equal(inc.total, 155)
    assert.deepEqual(inc.parts.map(p => p.value), [100, 25, 0, 0, 0, 20, 10])
    assert.deepEqual(inc.removed, { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
    assert.equal(inc.tokenUp.system, 100)
    assert.equal(inc.tokenUp.tools, 25)
    assert.equal(inc.tokenUp.assistant, 20)
    assert.equal(inc.tokenUp.tool, 10)
    assert.deepEqual(inc.tokenDown, { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })

  test('shared items contribute only their token delta; removed items land in the down side', () => {
    const view = asm({
      nodes: [node(1, 'user', 9)],
      system: system(2, 100),
      header: header(3, [tool('bash', 9)]),
    })
    const base = asm({
      nodes: [node(1, 'user', 5)],
      system: system(2, 80),
      header: header(3, [tool('bash', 5), tool('write', 7)]),
    })
    const inc = incrementOf(view, base)
    assert.equal(inc.counts.user, 0)
    assert.equal(inc.tokens.user, 0)
    assert.equal(inc.tokenUp.user, 4)
    assert.equal(inc.tokenUp.system, 20)
    assert.equal(inc.tokenUp.tools, 4)
    assert.equal(inc.removed.tools, 1)
    assert.equal(inc.tokenDown.tools, 7)
    assert.equal(inc.tokenDown.user, 0)
  })

  test('an unchanged base adds nothing; a missing base adds the whole view', () => {
    const view = asm({
      nodes: [node(1, 'user', 5)],
      system: system(2, 10),
      header: header(3, [tool('bash', 5)]),
    })
    const same = incrementOf(view, view)
    assert.equal(same.items, 0)
    assert.equal(same.total, 0)
    assert.equal(same.header, null)
    assert.equal(same.system, null)
    assert.deepEqual(same.parts.map(p => p.value), [0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(same.tokenUp, { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
    assert.deepEqual(same.tokenDown, same.tokenUp)

    const all = incrementOf(view, null)
    assert.equal(all.items, 3)
    assert.equal(all.total, 20)
    assert.equal(all.header?.tools.length, 1)
    assert.equal(all.system?.tokens, 10)
  })

  test('a header-less current view removes the base tools; a retained base header hides the unchanged names', () => {
    const noHeader = incrementOf(asm({ nodes: [node(1, 'user', 1)] }), asm({ header: header(1, [tool('bash', 5)]) }))
    assert.equal(noHeader.counts.tools, 0)
    assert.equal(noHeader.header, null)
    assert.equal(noHeader.removed.tools, 1)
    assert.equal(noHeader.tokenDown.tools, 5)
  })

  test('a base node skipped by the current view still advances the merge past the gap', () => {
    const inc = incrementOf(
      asm({ nodes: [node(1, 'user', 5), node(3, 'assistant', 10)] }),
      asm({ nodes: [node(1, 'user', 5), node(2, 'tool', 10)] }),
    )
    assert.deepEqual(inc.nodes.map(n => n.seq), [3])
    assert.equal(inc.removed.tool, 1)
    assert.equal(inc.tokenDown.tool, 10)
    assert.equal(inc.tokenUp.assistant, 10)
  })

  test('token decreases, a removed system, and trailing removals land on the down side', () => {
    const decreased = incrementOf(
      asm({ nodes: [node(1, 'user', 5)], system: system(9, 80), header: header(1, [tool('bash', 5)]) }),
      asm({ nodes: [node(1, 'user', 9)], system: system(9, 100), header: header(1, [tool('bash', 9)]) }),
    )
    assert.equal(decreased.tokenDown.user, 4)
    assert.equal(decreased.tokenDown.system, 20)
    assert.equal(decreased.tokenDown.tools, 4)

    const goneSystem = incrementOf(asm({}), asm({ system: system(9, 100) }))
    assert.equal(goneSystem.removed.system, 1)
    assert.equal(goneSystem.tokenDown.system, 100)

    const tail = incrementOf(
      asm({ nodes: [node(1, 'user', 10)] }),
      asm({ nodes: [node(1, 'user', 10), node(2, 'tool', 15)] }),
    )
    assert.equal(tail.removed.tool, 1)
    assert.equal(tail.tokenDown.tool, 15)
  })

  test('incrementHas resolves every item key the browser and trend share', () => {
    const inc = incrementOf(asm({
      nodes: [node(7, 'user', 5)],
      system: system(8, 10),
      header: header(9, [tool('bash', 5)]),
    }), null)
    assert.equal(incrementHas(inc, 'n7'), true)
    assert.equal(incrementHas(inc, 'n8'), false)
    assert.equal(incrementHas(inc, 'sys'), true)
    assert.equal(incrementHas(inc, 'tools'), true)
    assert.equal(incrementHas(inc, 'tool:bash'), true)
    assert.equal(incrementHas(inc, 'tool:write'), false)
    assert.equal(incrementHas(inc, 'free'), false)
    const empty = incrementOf(asm({}), null)
    assert.equal(incrementHas(empty, 'sys'), false)
    assert.equal(incrementHas(empty, 'tools'), false)
  })
})

const headers: ContextHeaders = {
  headers: [{ seq: 3, time: 1, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 40 }] }],
}

const data = tl({
  current: { system: 100, tools: 90, user: 30, inject: 5, skill: 0, assistant: 10, tool: 40, total: 275 },
  requests: [
    req({ seq: 10, turn: 1, step: 0, system: 100, tools: 90, user: 10, inject: 5, assistant: 10, total: 215 }),
    req({ seq: 20, turn: 1, step: 1, system: 100, tools: 90, user: 30, inject: 5, assistant: 10, tool: 40, total: 275 }),
  ],
  nodes: [
    surfaceNode({ seq: 1, cat: 'user', tokens: 10, text: 'base question' }),
    surfaceNode({ seq: 5, cat: 'inject', tokens: 5, form: 'notice', text: 'base notice' }),
    surfaceNode({ seq: 6, cat: 'assistant', tokens: 10, text: 'base reply' }),
    surfaceNode({ seq: 15, cat: 'user', tokens: 20, text: 'new question' }),
    surfaceNode({ seq: 18, cat: 'tool', tokens: 40, tool: 'bash', text: 'new result' }),
    surfaceNode({ seq: 25, cat: 'assistant', tokens: 10, text: 'live reply' }),
  ],
  systems: [{ seq: 2, time: 1, tokens: 100 }],
})

const richHeaders: ContextHeaders = {
  headers: [
    { seq: 3, time: 1, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 40 }] },
    { seq: 12, time: 2, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 40 }, { name: 'read', tokens: 30 }] },
  ],
}

const richData = tl({
  ...data,
  systems: [{ seq: 12, time: 2, tokens: 100 }],
})

function deltaButton(m: Mounted): HTMLElement {
  return query(m.container, '.lc-br-delta-ctl .lc-gran-btn')
}

function cat(m: Mounted, key: keyof typeof ROW): HTMLElement {
  return queryAll(m.container, '.lc-br-cat')[ROW[key]]
}

function rowPills(m: Mounted, key: keyof typeof ROW): { countUp: string | null; countDown: string | null; tokenUp: string | null; tokenDown: string | null } {
  const row = cat(m, key)
  const pill = (selector: string): string | null => {
    const el = row.querySelector<HTMLElement>(selector)
    return el === null ? null : text(el)
  }
  return {
    countUp: pill('.lc-br-delta-up'),
    countDown: pill('.lc-br-delta-down'),
    tokenUp: pill('.lc-br-tdelta-up'),
    tokenDown: pill('.lc-br-tdelta-down'),
  }
}

describe('ContextBrowser incremental mode', () => {
  test('the toggle rides the DNA group on its right, labels the added total, and keeps the diff pills', async () => {
    const m = await mount(h(Browser, props({ data, headers, delta: true, onDeltaChange: () => {} })))
    await pickStep(m, '20')
    const dnaGroup = query(m.container, '.lc-br-dna-ctl')
    const deltaGroup = query(m.container, '.lc-br-delta-ctl')
    assert.equal(dnaGroup.nextElementSibling, deltaGroup, 'the switch sits right of DNA mode')
    assert.equal(deltaGroup.getAttribute('title'), kit.t('browser.deltaTip'))
    assert.equal(text(deltaButton(m)), 'Delta')
    assert.ok(deltaButton(m).className.includes('lc-gran-on'))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Added ≈ 60 of 275'))

    assert.ok(text(cat(m, 'user')).includes('1 Items'))
    assert.deepEqual(rowPills(m, 'user'), { countUp: '+1', countDown: null, tokenUp: '+20', tokenDown: null })
    assert.ok(text(cat(m, 'user')).includes('≈20'))
    assert.ok(text(cat(m, 'user')).includes('33%'))
    assert.ok(text(cat(m, 'tool')).includes('1 Items'))
    assert.deepEqual(rowPills(m, 'tool'), { countUp: '+1', countDown: null, tokenUp: '+40', tokenDown: null })
    assert.ok(text(cat(m, 'tool')).includes('67%'))

    assert.ok(text(cat(m, 'inject')).includes('0 Items'), 'an unchanged category stays at zero additions')
    assert.ok(cat(m, 'inject').className.includes('lc-br-cat-empty'))
    assert.deepEqual(rowPills(m, 'inject'), { countUp: null, countDown: null, tokenUp: null, tokenDown: null })
    assert.ok(text(cat(m, 'inject')).includes('≈0'))
    assert.deepEqual(queryAll(m.container, '.lc-stacked-seg').map(seg => seg.style.width.slice(0, 4)), ['33.3', '66.6'])

    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1, 'only the added node lists')
    assert.ok(text(elemRows(m)[0]).includes('new question'))
    assert.ok(!text(elemRows(m)[0]).includes('base question'))
    await m.unmount()
  })

  test('the baseline toggle re-scopes the additions; turn with no predecessor adds the whole view', async () => {
    const m = await mount(h(Browser, props({ data, headers, delta: true, onDeltaChange: () => {} })))
    await pickStep(m, '20')
    assert.ok(text(cat(m, 'user')).includes('1 Items'))
    const turnBtn = queryAll(m.container, '.lc-card-title .lc-gran-btn').find(b => text(b) === 'prev turn')
    assert.ok(turnBtn !== undefined)
    await click(turnBtn)
    assert.ok(text(cat(m, 'user')).includes('2 Items'))
    assert.deepEqual(rowPills(m, 'user'), { countUp: '+2', countDown: null, tokenUp: '+30', tokenDown: null })
    assert.ok(text(cat(m, 'inject')).includes('1 Items'))
    await m.unmount()
  })

  test('a controlled pair follows the parent, a lone prop is ignored, and a local toggle works standalone', async () => {
    const calls: boolean[] = []
    const linked = (on: boolean) => h(Browser, props({ data, headers, delta: on, onDeltaChange: (next) => { calls.push(next) } }))
    const m = await mount(linked(true))
    await pickStep(m, '20')
    assert.ok(deltaButton(m).className.includes('lc-gran-on'))
    await click(deltaButton(m))
    assert.deepEqual(calls, [false])
    assert.ok(deltaButton(m).className.includes('lc-gran-on'), 'still on until the parent re-renders the prop')
    await m.update(linked(false))
    assert.ok(!deltaButton(m).className.includes('lc-gran-on'))
    assert.ok(text(cat(m, 'user')).includes('2 Items'), 'the full category is back')
    assert.deepEqual(rowPills(m, 'user'), { countUp: '+1', countDown: null, tokenUp: '+20', tokenDown: null })
    await m.unmount()

    const lone = await mount(h(Browser, props({ data, headers, delta: true })))
    await pickStep(lone, '20')
    assert.ok(!deltaButton(lone).className.includes('lc-gran-on'), 'a lone delta prop is ignored')
    assert.ok(text(cat(lone, 'user')).includes('2 Items'))
    await lone.unmount()

    const local = await mount(h(Browser, props({ data, headers })))
    await pickStep(local, '20')
    await click(deltaButton(local))
    assert.ok(deltaButton(local).className.includes('lc-gran-on'))
    assert.ok(text(cat(local, 'user')).includes('1 Items'))
    await local.unmount()
  })

  test('DNA mode filters the flat feed and the per-item bar, keeping added tool and system groups', async () => {
    const m = await mount(h(Browser, props({
      data: richData,
      headers: richHeaders,
      dna: true,
      onDnaChange: () => {},
      delta: true,
      onDeltaChange: () => {},
    })))
    await pickStep(m, '20')
    const flat = queryAll(m.container, '.lc-br-flat > .lc-br-elem')
    const labels = flat.map(r => text(r))
    assert.equal(labels.length, 4)
    assert.ok(labels[0].includes('#5') && labels[0].includes('bash'), 'newest message first, true prompt position kept')
    assert.ok(labels[1].includes('#4') && labels[1].includes('new question'))
    assert.ok(labels[2].includes('Tool Schemas') && labels[2].includes('1 Items') && labels[2].includes('≈30'))
    assert.ok(labels[3].includes('System Prompt') && labels[3].includes('≈100'))
    assert.ok(!text(m.container).includes('base question'))
    assert.ok(!text(m.container).includes('base reply'))

    const segs = queryAll(m.container, '.lc-stacked-seg')
    assert.equal(segs.length, 4)
    await hover(segs[2])
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['User Messages', '≈20 · 11% of added context', null])
    await hover(segs[0])
    const systemTip = tipRows(query(m.container, '.lc-bar-tip'))
    assert.ok(systemTip[0]?.startsWith('System Prompt'))
    assert.equal(systemTip[1], '≈100 · 53% of added context')

    await unhover(query(m.container, '.lc-stacked'))
    await hover(query(flat[2], '.lc-br-elem-row'))
    assert.deepEqual(segs.map(seg => seg.className.includes('lc-stacked-seg-on')), [false, true, false, false])
    await hover(query(flat[3], '.lc-br-elem-row'))
    assert.deepEqual(segs.map(seg => seg.className.includes('lc-stacked-seg-on')), [true, false, false, false])
    await m.unmount()
  })

  test('added system and tool categories open their lone item', async () => {
    const served = withEpochContent(richHeaders, {
      12: { system: 'SYS', tools: [{ name: 'bash' }, { name: 'write' }, { name: 'read' }] },
    })
    const m = await mount(h(Browser, props({ data: richData, ...served, delta: true, onDeltaChange: () => {} })))
    await pickStep(m, '20')
    assert.ok(text(cat(m, 'system')).includes('1 Items'))
    assert.ok(text(cat(m, 'system')).includes('≈100'))
    assert.ok(text(cat(m, 'tools')).includes('1 Items'))
    assert.ok(text(cat(m, 'tools')).includes('≈30'))

    await click(catRow(m, 'system'))
    await flush()
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 1)
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('System Prompt'))
    await click(catRow(m, 'tools'))
    await flush()
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 1)
    const toolRow = query(m.container, '.lc-br-elem-on')
    assert.ok(text(toolRow).includes('read'))
    assert.ok(!text(toolRow).includes('bash'))
    assert.ok(!text(toolRow).includes('write'))
    await m.unmount()
  })

  test('split badges separate additions from removals in both modes', async () => {
    const shrinking = tl({
      current: { system: 0, tools: 0, user: 30, inject: 0, skill: 0, assistant: 0, tool: 0, total: 30 },
      requests: [
        req({ seq: 10, turn: 1, step: 0, user: 17, total: 17 }),
        req({ seq: 20, turn: 1, step: 1, user: 30, total: 30 }),
      ],
      nodes: [surfaceNode({ seq: 1, cat: 'user', tokens: 10 }), surfaceNode({ seq: 15, cat: 'user', tokens: 20 })],
      archive: [surfaceNode({ seq: 4, cat: 'user', tokens: 7, gone: 15 })],
    })
    const m = await mount(h(Browser, props({ data: shrinking, headers: null, delta: true, onDeltaChange: () => {} })))
    await pickStep(m, '20')
    assert.ok(text(cat(m, 'user')).includes('1 Items'), 'one item was added')
    assert.deepEqual(rowPills(m, 'user'), { countUp: '+1', countDown: '-1', tokenUp: '+20', tokenDown: '-7' })
    assert.ok(text(cat(m, 'user')).includes('≈20'), 'the added item carries its own 20 tokens')
    assert.ok(text(cat(m, 'user')).includes('100%'))
    await m.unmount()

    const full = await mount(h(Browser, props({ data: shrinking, headers: null })))
    await pickStep(full, '20')
    assert.ok(text(cat(full, 'user')).includes('2 Items'), 'the full category returns outside incremental mode')
    assert.ok(text(cat(full, 'user')).includes('≈30'))
    assert.deepEqual(rowPills(full, 'user'), { countUp: '+1', countDown: '-1', tokenUp: '+20', tokenDown: '-7' })
    await full.unmount()
  })

  test('the block map and its empty state stay increment-scoped', async () => {
    const m = await mount(h(Browser, props({ data: richData, headers: richHeaders, delta: true, onDeltaChange: () => {} })))
    await pickStep(m, '20')
    await click(query(m.container, '.lc-br-map-btn'))
    const heads = queryAll(m.container, '.lc-map-cat-label').map(el => text(el))
    assert.deepEqual(heads.sort(), ['System Prompt', 'Tool Results', 'Tool Schemas', 'User Messages'])
    await hover(queryAll(m.container, '.lc-map-block')[0])
    assert.ok(text(query(m.container, '.lc-map-tip')).includes('of added context'))
    await hover(queryAll(m.container, '.lc-map-cat-head')[0])
    assert.ok(text(query(m.container, '.lc-map-tip')).includes('of added context'))
    assert.ok(!text(query(m.container, '.lc-map-tip')).includes('of used context'))
    await m.unmount()

    const noNew = tl({ ...richData, nodes: richData.nodes.filter(n => n.seq !== 25) })
    const empty = await mount(h(Browser, props({ data: noNew, headers: richHeaders, delta: true, onDeltaChange: () => {} })))
    await click(query(empty.container, '.lc-br-map-btn'))
    assert.equal(text(query(empty.container, '.lc-map-empty')), 'No items were added at this step')
    await empty.unmount()
  })

  test('the empty incremental feed says nothing was added; a search keeps the row-miss wording', async () => {
    const noNew = tl({ ...data, nodes: data.nodes.filter(n => n.seq !== 25) })
    const m = await mount(h(Browser, props({ data: noNew, headers, dna: true, onDnaChange: () => {}, delta: true, onDeltaChange: () => {} })))
    assert.ok(text(query(m.container, '.lc-br-flat')).includes('No items were added at this step'))
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Added ≈ 0 of 275'))
    await m.unmount()
  })

  test('focusing an added item keeps the mode; focusing a pre-existing item drops it', async () => {
    const calls: boolean[] = []
    const wired = (key: string) => h(Browser, props({
      data,
      headers,
      delta: true,
      onDeltaChange: (on) => { calls.push(on) },
      nodeFocus: { step: 20, key, cat: 'user' },
      onNodeFocusHandled: () => {},
    }))
    const m = await mount(wired('n15'))
    assert.deepEqual(calls, [], 'an added item stays inside the increment')
    await m.update(wired('n1'))
    assert.deepEqual(calls, [false], 'a pre-existing item needs the full view')
    await m.unmount()

    const catCalls: boolean[] = []
    const focused = await mount(h(Browser, props({
      data,
      headers,
      delta: true,
      onDeltaChange: (on) => { catCalls.push(on) },
      catFocus: { cat: 'user' },
      onCatFocusHandled: () => {},
    })))
    assert.deepEqual(catCalls, [false], 'a category jump leaves the increment')
    await focused.unmount()

    const liveCalls: boolean[] = []
    const live = await mount(h(Browser, props({
      data,
      headers,
      delta: true,
      onDeltaChange: (on) => { liveCalls.push(on) },
      nodeFocus: { step: 'live', key: 'n25', cat: 'assistant' },
      onNodeFocusHandled: () => {},
    })))
    assert.deepEqual(liveCalls, [], 'the live tail item is part of the live increment')
    await live.unmount()

    const unknownCalls: boolean[] = []
    const unknown = await mount(h(Browser, props({
      data,
      headers,
      delta: true,
      onDeltaChange: (on) => { unknownCalls.push(on) },
      nodeFocus: { step: 999, key: 'n1', cat: 'user' },
      onNodeFocusHandled: () => {},
    })))
    assert.deepEqual(unknownCalls, [false], 'an unknown step falls back to the live view')
    await unknown.unmount()

    const fresh = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      nodes: [surfaceNode({ seq: 1, tokens: 10, text: 'first question' })],
    })
    const noBaseCalls: boolean[] = []
    const noBase = await mount(h(Browser, props({
      data: fresh,
      headers: null,
      delta: true,
      onDeltaChange: (on) => { noBaseCalls.push(on) },
      nodeFocus: { step: 'live', key: 'n1', cat: 'user' },
      onNodeFocusHandled: () => {},
    })))
    assert.deepEqual(noBaseCalls, [], 'with no predecessor everything is an addition')
    await noBase.unmount()
  })
})
