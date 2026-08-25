/**
 * Step brief (src/client/brief.ts): the per-bar semantic identity derived
 * from the served nodes — turn opener, mid-step inputs, and the bar's own
 * reply — plus the view-bed render of the brief rows and the locate bridge.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'vitest'
import { briefNodes, briefOf, replyTipsOf } from '../src/client/brief.ts'
import { callNamesOf } from '../src/client/callSummary.ts'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

// trendChart.tsx imports ../react, which top-level `require('react')`s the platform seed — shim it for the pure-node lane.
const g = globalThis as { require?: unknown }
g.require ??= createRequire(import.meta.url)
const { aggregateByTurn } = await import('../src/client/components/trendChart.tsx')

const nodes = [
  { seq: 1, cat: 'inject' as const, tokens: 10, form: 'context', time: 900 },
  { seq: 2, cat: 'user' as const, tokens: 10, text: '帮我实现登录功能', time: 1000 },
  { seq: 3, cat: 'assistant' as const, tokens: 20, text: '好的，我来实现', time: 1100 },
  { seq: 4, cat: 'tool' as const, tokens: 20, tool: 'bash', time: 1900 },
  { seq: 5, cat: 'assistant' as const, tokens: 20, calls: ['bash'], time: 2000 },
  { seq: 6, cat: 'user' as const, tokens: 10, text: '再加个单元测试', time: 3000 },
  { seq: 7, cat: 'assistant' as const, tokens: 20, text: '已添加测试', time: 3100 },
]

const requests = [
  { seq: 3, turn: 1, step: 0, time: 1100, system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100 },
  { seq: 5, turn: 1, step: 1, time: 2000, system: 10, tools: 20, user: 25, inject: 5, assistant: 10, tool: 20, total: 90 },
  { seq: 7, turn: 2, step: 0, time: 3100, system: 10, tools: 20, user: 40, inject: 5, assistant: 12, tool: 20, total: 107 },
]

test('briefOf: turn-start step pairs the opener message with its reply', () => {
  const b = briefOf(nodes, requests, 0)
  assert.ok(b !== null)
  assert.equal(b.opener?.seq, 2, 'the turn opened with the user message')
  assert.equal(b.inputs.length, 0, 'turn-start steps hide the inputs row (the opener row covers it)')
  assert.equal(b.response?.seq, 3, 'the response node sits at exactly the request seq')
})

test('briefOf: mid-turn step keeps the opener and lists the new inputs', () => {
  const b = briefOf(nodes, requests, 1)
  assert.ok(b !== null)
  assert.equal(b.opener?.seq, 2, 'any step of the turn recalls the same opener')
  assert.deepEqual(b.inputs.map(n => n.seq), [4], 'the tool result since the previous bar is the step input')
  assert.equal(b.response?.seq, 5)
  assert.deepEqual(b.response?.calls, ['bash'], 'a text-less reply carries its call breadcrumb')
})

test('briefOf: turn-aggregate bars read as turn opener + last-step reply', () => {
  const agg = aggregateByTurn(requests)
  assert.equal(agg.length, 2)
  const b = briefOf(nodes, agg, 0)
  assert.ok(b !== null)
  assert.equal(b.opener?.seq, 2)
  assert.equal(b.inputs.length, 0, 'aggregate bars are always turn starts')
  assert.equal(b.response?.seq, 5, 'the turn bar replies with its last step')
})

test('briefOf: archive copies serve compacted-away nodes; gaps degrade to absence', () => {
  const archived = nodes.filter(n => n.seq !== 3)
    .concat([{ ...nodes[2], gone: 50 }])
    .sort((a, b) => a.seq - b.seq)
  const b = briefOf(archived, requests, 0)
  assert.equal(b?.response?.seq, 3, 'a removed response node still resolves through the archive')

  const sparse = [{ seq: 7, cat: 'assistant' as const, tokens: 20, text: '已添加测试' }]
  const gap = briefOf(sparse, requests, 2)
  assert.equal(gap?.opener, undefined, 'opener outside retention is absent, never an error')
  assert.equal(gap?.response?.seq, 7)
  assert.equal(briefOf(sparse, requests, 9), null, 'out-of-range index yields null')
})

test('replyTipsOf: one-line preview per assistant node, text or call breadcrumb', () => {
  const tips = replyTipsOf(nodes)
  assert.equal(tips.get(3), '好的，我来实现')
  assert.equal(tips.get(5), 'bash')
  assert.equal(tips.has(2), false, 'non-assistant nodes carry no reply tip')
})

test('briefNodes: live tail and archive merge seq-sorted', () => {
  const sorted = briefNodes({
    nodes: [nodes[6], nodes[2]],
    archive: [{ ...nodes[0], gone: 8 }],
  } as never)
  assert.deepEqual(sorted.map(n => n.seq), [1, 3, 7])
})

test('callNamesOf: tool-call names recovered from the conversation join, in order', () => {
  const conv = {
    kind: 'assistant', seq: 7,
    blocks: [{ kind: 'text', text: '好的' }, { kind: 'tool-call', name: 'bash' }, { kind: 'tool-call', name: 'write' }],
  }
  assert.deepEqual(callNamesOf(conv as never), ['bash', 'write'])
  assert.deepEqual(callNamesOf(undefined), [])
  assert.deepEqual(callNamesOf({ kind: 'assistant', seq: 1 } as never), [], 'no blocks, no calls')
})

test('context view: the brief section renders under the trend detail and drives the locate bridge', async () => {
  const bed = await bootViewBed()
  const { hookStates, renderView } = bed
  const ctxKey = [...hookStates.keys()].find(k => k.includes('ContextView') && hookStates.get(k).length > 0)
  assert.ok(ctxKey, 'ContextView fiber registered')
  bed.dataValue = {
    ok: true, model: 'deepseek-v4', provider: 'deepseek', contextWindow: 128000,
    current: { system: 10, tools: 20, user: 30, inject: 5, assistant: 15, tool: 20, total: 100 },
    toolList: [], requests, events: [], nodes, droppedNodes: 0, archive: [],
  }
  let tree = renderView()

  // Default selection: the newest bar (turn 2, seq 7) — opener + reply rows.
  let rows = byClass(tree, 'lc-brief-row')
  assert.equal(rows.length, 2, 'turn-start bar shows opener + reply rows')
  assert.ok(textOf(rows[0]).includes('再加个单元测试'), 'the opener row recalls this turn’s first user message')
  assert.ok(textOf(rows[1]).includes('已添加测试'), 'the reply row previews the step’s response')

  // Hover the mid-turn bar (seq 5): opener from turn 1, tool input chip, call breadcrumb.
  const ctxSlots = hookStates.get(ctxKey)
  ctxSlots[1][1](5)
  tree = renderView()
  rows = byClass(tree, 'lc-brief-row')
  assert.equal(rows.length, 3, 'mid-turn bar adds the inputs row')
  assert.ok(textOf(rows[0]).includes('帮我实现登录功能'), 'hovering any step of the turn recalls its opener')
  assert.ok(textOf(rows[1]).includes('bash'), 'the inputs row chips the new tool result')
  assert.ok(textOf(rows[2]).includes('bash'), 'a text-less reply shows the call breadcrumb')

  // All three rows are whole-row buttons now; clicking the In row locates its first input node.
  assert.equal(rows[1].args[0], 'button', 'the inputs row is whole-row clickable like the others')
  rows[1].args[1].onClick()
  assert.deepEqual(ctxSlots[9][0], { step: 5, seq: 4, cat: 'tool' }, 'row click reveals the first input on this step’s surface')
  const chip = byClass(rows[1], 'lc-brief-chip')[0]
  chip.args[1].onClick()
  assert.deepEqual(ctxSlots[9][0], { step: 5, seq: 4, cat: 'tool' }, 'the chip reveals its own node')

  // The reply row is a locate button: clicking it arms the browser focus bridge.
  assert.equal(rows[2].args[0], 'button', 'wired rows render as buttons')
  rows[2].args[1].onClick()
  const focus = ctxSlots[9][0]
  assert.deepEqual(focus, { step: 7, seq: 5, cat: 'assistant' }, 'a reply node first appears on the NEXT step’s surface')

  // Conversation join armed: a text+calls reply recovers its call breadcrumb as a suffix, and a textless reply's
  // breadcrumb gains the call's argument summary.
  bed.useSessionHolder = (sel) => sel({
    nodes: [
      { kind: 'assistant', seq: 5, blocks: [{ kind: 'tool-call', name: 'bash', argsRaw: '{"command":"pnpm test","description":"跑测试"}' }] },
      { kind: 'assistant', seq: 7, blocks: [{ kind: 'text', text: '已添加测试' }, { kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"/tmp/a.ts"}' }] },
    ],
  })
  tree = renderView()
  rows = byClass(tree, 'lc-brief-row')
  assert.ok(textOf(rows[2]).includes('bash · 跑测试'), 'textless reply: call summary enriches the breadcrumb')
  ctxSlots[1][1](null)
  tree = renderView()
  rows = byClass(tree, 'lc-brief-row')
  assert.ok(textOf(rows[1]).includes('已添加测试 → write'), 'text+calls reply shows the text AND recovers the call')

  // The browser consumes the one-shot focus: selects the owning step, opens the node's category + element.
  ctxSlots[1][1](5)
  tree = renderView()
  byClass(tree, 'lc-brief-row')[2].args[1].onClick()
  ctxSlots[1][1](null) // the pointer then leaves the chart, so the hover preview stops overriding the picker's selection
  tree = renderView()
  const brSlots = bed.brSlots()
  brSlots[12].effect() // nodeFocus effect
  tree = renderView()
  assert.equal(ctxSlots[9][0], null, 'one-shot focus is cleared once applied')
  assert.equal(byClass(tree, 'lc-br-pick')[0].args[1].value, '7', 'browser selects the step whose surface first carries the reply')
  const opened = byClass(tree, 'lc-br-content')
  assert.equal(opened.length, 1, 'exactly the reply node expands')
  assert.match(textOf(opened[0]), /bash/, 'the expanded body shows the reply’s tool call')
})
