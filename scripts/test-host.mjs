#!/usr/bin/env node
/**
 * Functional smoke test for the packaged host half: mounts the plugin on a
 * fake ctx (sessions/sessionQuery/connection), drives the captured RPC
 * handler with a synthetic event log, and asserts the snapshot shape.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let handler = null
const disposers = []
const sessionsMap = new Map()

const live = {
  events: [
    { seq: 1, type: 'request/header', time: 1000, data: {
      header: { system: 'You are a harness agent.', tools: [{ name: 'bash', description: 'run a command' }], config: { model: 'deepseek-v4', provider: 'deepseek' } },
    } },
    { seq: 2, type: 'request/context', time: 1000, data: { contextWindow: 128000 } },
    { seq: 3, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'Hello there, a fairly long user message that should cost more than one token!' }] } },
    { seq: 4, type: 'user/message', time: 3000, data: { source: { kind: 'plugin', form: 'notice', plugin: 'dsh-agent-presets', summary: 'Skill injected (code-review)' }, content: [{ type: 'text', text: 'injected text' }] } },
    { seq: 5, type: 'tool/call', time: 4000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
    { seq: 6, type: 'tool/result', time: 4100, data: { callId: 'c1', message: { content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } } },
    { seq: 7, type: 'assistant/message', time: 5000, data: { turn: 1, step: 1, usage: { inputTokens: 900, outputTokens: 40 }, message: { content: [{ type: 'text', text: 'Hi!' }] } } },
    { seq: 8, type: 'compaction/summary', time: 6000, data: { shadowedTokenCount: 5000, shadowedSeqs: [3, 4, 5, 6] } },
  ],
}

const ctx = {
  get(name) {
    if (name === 'sessions') return { get: (id) => sessionsMap.get(id) }
    if (name === 'sessionQuery') return {
      listEvents: async () => [],
      readSession: async (id) => {
        // The real provider throws SessionQueryError for absent sessions.
        if (!sessionsMap.has(id)) throw new Error(`session ${id} not found`)
        return { events: [] }
      },
    }
    return undefined
  },
  effect(fn) { disposers.push(fn()); return () => {} },
  connection: {
    rpc: {
      handle(channel, fn, options) {
        assert.equal(channel, '/dsh-context')
        assert.deepEqual(options, { authority: 'trusted-host' })
        handler = fn
        return async () => {}
      },
    },
  },
}

apply(ctx)
assert.ok(handler !== null, 'RPC handler must be registered')

sessionsMap.set('s1', live)

// -- first snapshot: full fold --
const res = await handler('snapshot', { sessionId: 's1' })
assert.equal(res.ok, true, `snapshot should succeed: ${JSON.stringify(res)}`)
const v = res.value
assert.equal(v.model, 'deepseek-v4')
assert.equal(v.provider, 'deepseek')
assert.equal(v.contextWindow, 128000)
assert.ok(v.current.system > 0, 'system prompt tokens')
assert.ok(v.current.tools > 0, 'tool schema tokens')
assert.ok(v.current.user > 0, 'user message tokens')
assert.ok(v.current.inject > 0, 'injection tokens')
assert.ok(v.current.tool > 0, 'tool result tokens')
assert.ok(v.current.assistant > 0, 'assistant tokens')
assert.equal(v.requests.length, 1)
assert.equal(v.requests[0].prompt, 900)
assert.equal(v.requests[0].output, 40)
assert.ok(v.events.some(e => e.kind === 'inject' && e.form === 'notice'), 'injection event recorded')
assert.ok(v.events.some(e => e.kind === 'compaction'), 'compaction event recorded')
assert.ok(v.nodes.length >= 4, 'surface nodes folded')
assert.equal(v.nodes[0].time, 2000, 'nodes carry their event timestamp')
// Message projection must price CONTENT: assistant replies and tool results
// carry their message body (data.message), not a flat envelope price.
const asstNode = v.nodes.find(n => n.seq === 7)
assert.equal(asstNode.tokens, 9, "assistant 'Hi!' prices its text content (1 + 4 + 4)")
const toolNode = v.nodes.find(n => n.seq === 6)
assert.equal(toolNode.tokens, 13, 'tool result prices its nested content (5 + 4 + 4)')
assert.equal(toolNode.tool, 'bash', 'tool result node names its tool')
assert.equal(asstNode.text, 'Hi!', 'assistant node carries its text preview')

// -- events are attributed to the request that follows them (turn/step) --
const injectEv = v.events.find(e => e.kind === 'inject')
assert.ok(injectEv, 'injection event present')
assert.equal(injectEv.turn, 1, 'inject before step 1\'s call lands on Turn 1')
assert.equal(injectEv.step, 1, 'inject lands on Step 1')
const compactEv = v.events.find(e => e.kind === 'compaction')
assert.ok(compactEv, 'compaction event present')
assert.equal(compactEv.turn, undefined, 'compaction with no following request yet stays unlabeled')
assert.equal(compactEv.step, undefined, 'no step for a trailing event')

// -- second snapshot: incremental (same count) must be served from cache --
const before = await handler('snapshot', { sessionId: 's1' })
assert.deepEqual(before.value, v, 'cached result for unchanged log')

// -- append one event: fold advances --
live.events.push({ seq: 9, type: 'assistant/message', time: 7000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'more' }] } } })
const after = await handler('snapshot', { sessionId: 's1' })
assert.equal(after.ok, true)
assert.equal(after.value.requests.length, 2, 'new request folded')
assert.equal(after.value.requests[1].turn, 2)
const compactAfter = after.value.events.find(e => e.kind === 'compaction')
assert.equal(compactAfter.turn, 2, 'compaction between turns lands on the next turn')
assert.equal(compactAfter.step, 1, 'compaction lands on the next turn\'s first step')

// -- an empty-content assistant message (usage-only step) prices 0 tokens --
live.events.push({ seq: 10, type: 'assistant/message', time: 8000, data: { turn: 2, step: 2, message: { content: [] } } })
const emptyMsg = await handler('snapshot', { sessionId: 's1' })
assert.equal(emptyMsg.ok, true)
const emptyNode = emptyMsg.value.nodes.find(n => n.seq === 10)
assert.ok(emptyNode, 'usage-only message is still a surface node')
assert.equal(emptyNode.tokens, 0, 'empty assistant message prices 0, like dsh deriveEventMessage')
// The compaction precedes turn 2 step 1 — a LATER step in the same turn must
// not re-attribute it.
const compactStill = emptyMsg.value.events.find(e => e.kind === 'compaction')
assert.equal(compactStill.turn, 2, 'compaction stays on Turn 2')
assert.equal(compactStill.step, 1, 'compaction stays on Step 1 (first request after it)')

// -- error paths --
const bad = await handler('snapshot', {})
assert.equal(bad.ok, false)
assert.match(bad.error.message, /sessionId/)
const unknown = await handler('nope', { sessionId: 's1' })
assert.equal(unknown.ok, false)
assert.match(unknown.error.message, /unknown endpoint/)
const missing = await handler('snapshot', { sessionId: 'ghost' })
assert.equal(missing.ok, false)
assert.match(missing.error.message, /not found|not live/)

// -- turn-based retention: long sessions trim by whole turns, never mid-turn --
// 400 turns x 4 steps = 1600 requests exceeds the step bound; the fold must
// keep the newest 300 WHOLE turns (turns 101..400, 1200 requests).
const many = []
let seq = 1000
for (let turn = 1; turn <= 400; turn++) {
  for (let step = 0; step < 4; step++) {
    many.push({
      seq: seq++, type: 'assistant/message', time: seq * 1000,
      data: { turn, step, message: { content: [{ type: 'text', text: 'x' }] } },
    })
  }
}
sessionsMap.set('long', { events: many })
const long = await handler('snapshot', { sessionId: 'long' })
assert.equal(long.ok, true)
assert.equal(long.value.requests.length, 1200, 'kept 300 turns x 4 steps after trimming')
assert.equal(long.value.requests[0].turn, 101, 'trim starts at a whole turn boundary')
assert.equal(long.value.requests[0].step, 0, 'trim starts at the first step of that turn')
const keptTurns = new Set(long.value.requests.map(r => r.turn))
assert.equal(keptTurns.size, 300, 'all 300 kept turns are present')
assert.ok([...keptTurns].every(t => t >= 101 && t <= 400), 'kept turns are the newest ones')
assert.equal(long.value.requests.filter(r => r.turn === 101).length, 4, 'first kept turn is complete')
assert.equal(long.value.requests.filter(r => r.turn === 400).length, 4, 'last turn is complete')

console.log('✔ host half functional test passed (RPC shape, fold, incrementality, cache, error paths, turn-based retention, event turn/step attribution)')
