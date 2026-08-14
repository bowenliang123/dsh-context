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

// -- second snapshot: incremental (same count) must be served from cache --
const before = await handler('snapshot', { sessionId: 's1' })
assert.deepEqual(before.value, v, 'cached result for unchanged log')

// -- append one event: fold advances --
live.events.push({ seq: 9, type: 'assistant/message', time: 7000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'more' }] } } })
const after = await handler('snapshot', { sessionId: 's1' })
assert.equal(after.ok, true)
assert.equal(after.value.requests.length, 2, 'new request folded')
assert.equal(after.value.requests[1].turn, 2)

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

console.log('✔ host half functional test passed (RPC shape, fold, incrementality, cache, error paths)')
