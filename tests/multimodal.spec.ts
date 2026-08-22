/**
 * Multimodal token estimates and pie-chart consistency:
 *
 * - Host fold: `image` blocks price through the official DeepSeek docs
 *   calculator (117-384 tokens by pixel dimensions), not the token-meter's
 *   generic JSON branch (~40); unknown dimensions degrade to that JSON
 *   price; compaction shadows stay internally consistent with the
 *   corrected prices.
 * - Client headline: with the official `contextBreakdown` projection
 *   delivered, the composition counts (part.raw) are the panel's exact
 *   system/tools/messages figures — the four surface categories subdivide
 *   the message bucket and always sum to it — while the bar widths
 *   (part.value) stay anchored to the provider total. Without the
 *   projection the fold's own sums serve.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { apply } from '../lib/index.js'
import { headlineOf } from '../src/client/headline.ts'

const defs = new Map()
apply({
  inject(list, cb) { cb(this) },
  effect(fn) { fn(); return () => {} },
  sessionProjections: { register(d) { defs.set(d.key, d); return () => {} } },
})
const def = defs.get('contextTimeline')
const drive = (events) => {
  let st = def.init()
  for (const ev of events) st = def.apply(st, ev)
  return def.view(st)
}

test('host fold: image blocks price by the official DeepSeek image token formula', () => {
  // 2048×1365 → 313 tokens on the official docs calculator; the durable ref
  // JSON would have priced ~40.
  const v = drive([
    { seq: 1, type: 'user/message', time: 1000, data: { content: [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 153600, width: 2048, height: 1365, name: 'shot.png' } },
    ] } },
    { seq: 2, type: 'user/message', time: 2000, data: { content: [
      { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: 512000, width: 800, height: 600 } },
    ] } },
    // Unknown dimensions: the meter's generic JSON branch prices the ref.
    { seq: 3, type: 'user/message', time: 3000, data: { content: [
      { type: 'image', attachment: { attachmentId: 'a3' } },
    ] } },
    // Images nested in a tool result price the same way (recursion).
    { seq: 4, type: 'tool/call', time: 4000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { seq: 5, type: 'tool/result', time: 4100, data: { callId: 'c1', message: { source: { kind: 'tool', callId: 'c1' }, content: [
      { type: 'tool-result', toolCallId: 'c1', content: [
        { type: 'image', attachment: { attachmentId: 'a4', mediaType: 'image/png', bytes: 1000, width: 512, height: 512 } },
      ] },
    ] } } },
  ])
  const n1 = v.nodes.find(n => n.seq === 1)
  // text 'hi' = ceil(2/4)+4 = 5; image 313+4; role framing +4.
  assert.equal(n1.tokens, 5 + 313 + 4 + 4, 'text + corrected image + framing')
  const n2 = v.nodes.find(n => n.seq === 2)
  assert.equal(n2.tokens, 341 + 4 + 4, '800×600 → 341 + block + role')
  const jsonFallback = 4 + Math.ceil(JSON.stringify({ attachmentId: 'a3' }).length / 4)
  // The fold sees the whole block: { type:'image', attachment:{...} }.
  const wholeBlock = 4 + Math.ceil(JSON.stringify({ type: 'image', attachment: { attachmentId: 'a3' } }).length / 4)
  const n3 = v.nodes.find(n => n.seq === 3)
  assert.equal(n3.tokens, wholeBlock + 4, 'unknown dims degrade to the JSON price (+ role)')
  assert.ok(jsonFallback < wholeBlock)
  const n5 = v.nodes.find(n => n.seq === 5)
  // tool-result: outer +4, nested image 201+4 (512×512 → 201), role +4.
  assert.equal(n5.tokens, 201 + 4 + 4 + 4, 'nested tool-result image priced by dims')
  // Category sums carry the corrected figures.
  assert.equal(v.current.user, n1.tokens + n2.tokens + n3.tokens)
  // Whole-session image count: three user uploads + the nested tool-result image.
  assert.equal(v.images, 4, 'image blocks counted across user messages and tool results')

  // Compaction shadows the two image messages: the fold subtracts its own
  // corrected prices, keeping the surface sum internally consistent.
  const v2 = drive([
    { seq: 1, type: 'user/message', time: 1000, data: { content: [
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 153600, width: 2048, height: 1365 } },
    ] } },
    { seq: 2, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'keep me' }] } },
    { seq: 3, type: 'compaction/summary', time: 3000, data: { shadowedTokenCount: 999, shadowedSeqs: [1] } },
    { seq: 4, type: 'user/message', time: 3100, surfaceOp: { op: 'replace', start: 1, end: 1 }, data: { content: [{ type: 'text', text: 'summary' }] } },
  ])
  const kept = v2.nodes.find(n => n.seq === 2)
  const summary = v2.nodes.find(n => n.seq === 4)
  assert.equal(v2.current.user, kept.tokens + summary.tokens, 'shadowed image leaves no residue')
  assert.equal(v2.images, 1, 'the image count is cumulative — compaction does not decrement it')
  console.log('✔ host fold image pricing passed (official formula, JSON fallback, nesting, compaction shadow)')
})

test('client headline: composition counts match the ring panel, widths stay anchored', () => {
  const data = {
    ok: true,
    current: { system: 100, tools: 200, user: 300, inject: 100, assistant: 400, tool: 200, total: 1300 },
    toolList: [],
    requests: [{ seq: 1, time: 1, system: 100, tools: 200, user: 300, inject: 100, assistant: 400, tool: 200, total: 1300, prompt: 2600 }],
    events: [], nodes: [], droppedNodes: 0, archive: [],
  }
  // The official breakdown disagrees with the fold sums (e.g. corrected
  // image pricing in the fold): the DELIVERED panel figures win outright.
  const breakdown = { systemTokens: 110, toolsTokens: 210, messageTokens: 1000 }
  const pressure = { projectedTokens: 5200, contextWindow: 128000 }
  const head = headlineOf(data, pressure, breakdown)
  const raw = Object.fromEntries(head.parts.map(p => [p.key, p.raw]))
  assert.equal(raw.system, 110, 'system = official figure')
  assert.equal(raw.tools, 210, 'tools = official figure')
  const msgRaw = raw.user + raw.inject + raw.assistant + raw.tool
  assert.equal(msgRaw, 1000, 'surface categories sum exactly to the official message figure')
  // Subdivision follows the fold's ratios (300/100/400/200 of 1000).
  assert.equal(raw.user, 300)
  assert.equal(raw.assistant, 400)
  // Bar widths anchor to the provider total: they sum to the anchor.
  const anchored = head.parts.reduce((s, p) => s + p.value, 0)
  assert.equal(anchored, Math.round(5200), 'anchored bar fills the provider total')
  // …and keep the official ratios (uniform scale of the raw figures).
  const sysBar = head.parts.find(p => p.key === 'system')
  assert.equal(sysBar.value, Math.round(110 * (5200 / 1320)))
  assert.equal(head.tokens, 5200)
  assert.equal(head.pct, Math.round(5200 / 128000 * 100))

  // No breakdown delivered (older harness): the fold's own sums serve.
  const fallback = headlineOf(data, pressure, null)
  const rawFb = Object.fromEntries(fallback.parts.map(p => [p.key, p.raw]))
  assert.equal(rawFb.system, 100)
  assert.equal(rawFb.user + rawFb.inject + rawFb.assistant + rawFb.tool, 1000)
  assert.equal(rawFb.assistant, 400)

  // No anchor either (no pressure, no provider usage on any request):
  // value === raw on every part.
  const anchorless = { ...data, requests: [] }
  const plain = headlineOf(anchorless, null, breakdown)
  for (const p of plain.parts) assert.equal(p.value, p.raw)

  // Tiny message bucket: rounding residue never turns a category negative.
  const tiny = headlineOf({
    ...data,
    current: { system: 0, tools: 0, user: 10, inject: 10, assistant: 10, tool: 10, total: 40 },
    requests: [],
  }, null, { systemTokens: 0, toolsTokens: 0, messageTokens: 2 })
  for (const p of tiny.parts) assert.ok((p.raw ?? 0) >= 0, `${p.key} stays non-negative`)
  console.log('✔ headline pie-consistency passed (official counts, exact subdivision, anchored widths)')
})
