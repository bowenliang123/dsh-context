/**
 * Functional smoke test for the packaged host half (v0.9): mounts the plugin
 * on a fake ctx, captures the `contextTimeline` session-projection unit it
 * registers, drives the unit's pure `init`/`apply`/`view` over synthetic
 * event logs, and asserts the snapshot shape the browser receives.
 *
 * The harness framework normally drives `apply` per committed `session/event`
 * and persists the state via the projection cache; those parts are not this
 * plugin's concern. What we own and verify here: the fold semantics, the wire
 * view shape, reference-stability of the apply contract, and the retention /
 * attribution rules.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { apply } from '../lib/index.js'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'

test('host half: projection unit, fold semantics, attribution, retention, determinism, config bounds', async () => {
  const defs = new Map()
  const disposers = []
  const fakeCtx = {
    inject(list, cb) { cb(this) }, // ctx.inject(['sessionProjections'], ...)
    effect(fn) { disposers.push(fn()); return () => {} },
    sessionProjections: {
      register(d) { defs.set(d.key, d); return () => {} },
    },
  }
  apply(fakeCtx)
  const def = defs.get('contextTimeline')
  const hdef = defs.get('contextHeaders')
  assert.ok(def !== undefined, 'contextTimeline projection unit registered')
  assert.ok(hdef !== undefined, 'contextHeaders projection unit registered')
  assert.equal(def.key, 'contextTimeline')
  assert.equal(typeof def.init, 'function')
  assert.equal(typeof def.apply, 'function')
  assert.equal(typeof def.view, 'function')

  /** Fold a full event log through the unit (the framework's watermark would
   * restrict this to the delta; determinism here is the same output). */
  const drive = (events) => {
    let st = def.init()
    for (const ev of events) st = def.apply(st, ev)
    return def.view(st)
  }

  // ---- synthetic log: header, context, user+inject, tool call/result, step ----
  const live = { events: [
    { seq: 1, type: 'request/header', time: 1000, data: {
      header: { system: 'You are a harness agent.', tools: [{ name: 'bash', description: 'run a command' }], config: { model: 'deepseek-v4', provider: 'deepseek' } },
    } },
    { seq: 2, type: 'request/context', time: 1000, data: { contextWindow: 128000 } },
    { seq: 3, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'Hello there, a fairly long user message that should cost more than one token!' }] } },
    { seq: 4, type: 'user/message', time: 3000, data: { source: { kind: 'plugin', form: 'notice', plugin: 'dsh-agent-presets', summary: 'Skill injected (code-review)' }, content: [{ type: 'text', text: 'injected text' }] } },
    { seq: 5, type: 'tool/call', time: 4000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
    // Real tool/result envelope: the durable message carries source.kind='tool' + callId
    { seq: 6, type: 'tool/result', time: 4100, data: { callId: 'c1', message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } } },
    { seq: 7, type: 'assistant/message', time: 5000, data: { turn: 1, step: 1, usage: { inputTokens: 900, outputTokens: 40 }, message: { content: [{ type: 'text', text: 'Hi!' }] } } },
    { seq: 8, type: 'compaction/summary', time: 6000, data: { shadowedTokenCount: 5000, shadowedSeqs: [3, 4, 5, 6] } },
  ] }

  const v = drive(live.events)
  assert.equal(v.ok, true)
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
  assert.equal(toolNode.tool, 'bash', 'tool result node names its tool (via source.callId)')
  assert.equal(asstNode.text, 'Hi!', 'assistant node carries its text preview')

  // callNames is consume-once: the entry leaves the persisted state when its
  // tool/result folds in, instead of growing for the session's lifetime.
  {
    let st = def.init()
    for (const ev of live.events) st = def.apply(st, ev)
    assert.equal(st.callNames.c1, undefined, 'call name entry deleted once its result folded in')
  }

  // -- occupancy is NOT folded by the host anymore (R3): the client reads the
  // official token-meter `contextPressure` projection (token-meter owns
  // estimation and replay); the timeline wire carries only the heuristic
  // composition + per-request provider usage (record.prompt/output) --
  assert.equal(v.occupancy, undefined, 'the host no longer mirrors contextPressure inside contextTimeline')
  assert.equal(v.requests[0].prompt, 900, 'provider usage still rides the request records (usage sample input + cache)')

  // -- events are attributed to the requests around them (turn/step + range) --
  const injectEv = v.events.find(e => e.kind === 'inject')
  assert.ok(injectEv, 'injection event present')
  assert.equal(injectEv.turn, 1, 'inject before step 1\'s call lands on Turn 1')
  assert.equal(injectEv.step, 1, 'inject lands on Step 1')
  assert.equal(injectEv.fromTurn, undefined, 'no request before the first inject')
  const compactEv = v.events.find(e => e.kind === 'compaction' && e.seq === 8)
  assert.ok(compactEv, 'compaction event present')
  assert.equal(compactEv.turn, undefined, 'compaction with no following request yet stays unlabeled')
  assert.equal(compactEv.step, undefined, 'no step for a trailing event')
  assert.equal(compactEv.fromTurn, 1, 'trailing event still knows the request before it')
  assert.equal(compactEv.fromStep, 1, 'trailing event keeps its from-step')

  // -- determinism + reference-stability of the projection contract --
  // Unrelated events must return the SAME state reference (Object.is gates the
  // framework change feed); view() must not mutate persisted state.
  let base = def.init()
  for (const ev of live.events) base = def.apply(base, ev)
  assert.ok(base.events.length > 0, 'folded state carries events')
  assert.equal(def.apply(base, { type: 'todo/write', seq: 99, time: 0, data: { todos: [] } }), base,
    'unrelated events keep the same reference (no change notification)')
  assert.equal(def.apply(base, { type: 'totally/unknown', seq: 100, time: 0, data: {} }), base,
    'unknown event vocabulary is safely ignored')
  const emptyView = def.view(def.init())
  assert.equal(emptyView.ok, true)
  assert.equal(emptyView.requests.length, 0)
  assert.equal(emptyView.events.length, 0)
  assert.equal(emptyView.nodes.length, 0)
  assert.equal(emptyView.droppedNodes, 0)
  assert.equal(emptyView.current.total, 0)
  assert.ok(!('turn' in base.events[0] || 'step' in base.events[0]), 'view() attributions stay on copies, never on persisted state')

  // -- append a same-turn step: the compaction now spans Step 1 -> Step 2 --
  live.events.push({ seq: 9, type: 'assistant/message', time: 7000, data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'more' }] } } })
  const after = drive(live.events)
  assert.equal(after.requests.length, 2, 'new request folded')
  assert.equal(after.requests[1].turn, 1)
  const compactAfter = after.events.find(e => e.kind === 'compaction' && e.seq === 8)
  assert.equal(compactAfter.turn, 1, 'compaction inside a turn lands on the same turn')
  assert.equal(compactAfter.step, 2, 'compaction lands on the step whose request follows it')
  assert.equal(compactAfter.fromTurn, 1, 'same-turn range keeps the previous request\'s turn')
  assert.equal(compactAfter.fromStep, 1, 'same-turn range keeps the previous step')

  // -- a cross-turn compaction: prev turn 1 step 2 -> next turn 2 step 1 --
  live.events.push({ seq: 10, type: 'compaction/summary', time: 7500, data: { shadowedTokenCount: 3000, shadowedSeqs: [3, 4] } })
  live.events.push({ seq: 11, type: 'assistant/message', time: 8000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'more2' }] } } })
  const cross = drive(live.events)
  const compactCross = cross.events.find(e => e.kind === 'compaction' && e.seq === 10)
  assert.equal(compactCross.turn, 2, 'between-turn compaction lands on the next turn')
  assert.equal(compactCross.step, 1, 'lands on the next turn\'s first step')
  assert.equal(compactCross.fromTurn, 1, 'cross-turn range remembers the previous turn')
  assert.equal(compactCross.fromStep, 2, 'cross-turn range remembers the previous step')

  // -- an empty-content assistant message (usage-only step) prices 0 tokens --
  live.events.push({ seq: 12, type: 'assistant/message', time: 9000, data: { turn: 2, step: 2, message: { content: [] } } })
  const emptyMsg = drive(live.events)
  const emptyNode = emptyMsg.nodes.find(n => n.seq === 12)
  assert.ok(emptyNode, 'usage-only message is still a surface node')
  assert.equal(emptyNode.tokens, 0, 'empty assistant message prices 0, like dsh deriveEventMessage')
  // A LATER step in the same turn must not re-attribute the compaction.
  const compactStill = emptyMsg.events.find(e => e.kind === 'compaction' && e.seq === 8)
  assert.equal(compactStill.turn, 1, 'compaction stays on Turn 1')
  assert.equal(compactStill.step, 2, 'compaction stays on Step 2 (first request after it)')

  // Repeat the same log: the fold is a deterministim replay, so a fresh fold
  // must reproduce the identical wire value (what the projection cache relies on).
  const again = drive(live.events)
  assert.deepEqual(again, emptyMsg, 'deterministic replay across fresh folds')

  // -- the shadow price covers the SEQ list, not the declared range end: a
  // prune replacement node whose seq lies beyond the range must still be
  // removed (the producer's shadowedSeqs include it) --
  const shadow = drive([
    { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: 'a'.repeat(40) }] } },
    // two tool results, 80-char text each: 20 + 4 (text) + 4 (tool-result) + 4 (role) = 32
    { seq: 2, type: 'tool/result', time: 2000, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'b'.repeat(80) }] }] } } },
    { seq: 3, type: 'tool/result', time: 3000, data: { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'c'.repeat(80) }] }] } } },
    // metering event: range says [2,2] but the shadowed seqs cover 2 AND 3
    { seq: 4, type: 'compaction/prune', time: 4000, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2, 3], shadowedTokenCount: 64 } },
    // replacement: 'd' -> 1 + 4 (text) + 4 (tool-result) + 4 (role) = 13
    { seq: 5, type: 'tool/result', time: 5000, surfaceOp: { op: 'replace', start: 2, end: 2 }, data: { message: { source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'd' }] }] } } },
  ])
  assert.equal(shadow.current.tool, 13, 'shadowed seqs beyond the range end are removed too (only the replacement survives)')
  assert.equal(shadow.current.user, 18, 'unrelated nodes keep their price (40 chars: 10 + 4 + 4)')
  assert.equal(shadow.current.total, 18 + 13, 'total reflects the seq-based removal')
  // no tool/call events in this log, so no call name is registered — the tool
  // label stays empty (never a crash)
  assert.equal(shadow.nodes.find(n => n.seq === 5).tool, undefined, 'no registered call name -> no tool label')

  // -- the removed nodes land in the archive (the Context browser's per-step
  // reconstruction raw material), stamped with the replacing event's seq --
  assert.deepEqual(shadow.archive.map(n => n.seq), [2, 3], 'both shadowed nodes archived in removal order')
  assert.ok(shadow.archive.every(n => n.gone === 5), 'archive entries carry the replacing event seq as gone')
  assert.equal(shadow.surfaceFloor, undefined, 'no live-node drop without an overflow')
  // Reconstructing step seq 4 (between removal and replacement... here: any
  // request with seq > 3 and < 5) sees the pre-shadow surface.
  const preShadow = [...shadow.nodes, ...shadow.archive].filter(n => n.seq < 4 && (n.gone === undefined || n.gone > 4))
  assert.deepEqual(preShadow.map(n => n.seq).sort(), [1, 2, 3], 'pre-shadow steps still see the shadowed nodes')

  // -- archive retention: count cap + request-window prune --
  let archiveCfg = null
  apply({ ...fakeCtx, sessionProjections: { register(d) { if (d.key === 'contextTimeline') archiveCfg = d; return () => {} } } }, { maxArchiveNodes: 1 })
  const capped = (() => {
    let st = archiveCfg.init()
    for (const ev of [
      { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: 'a'.repeat(40) }] } },
      { seq: 2, type: 'compaction/prune', time: 2000, data: { shadowedSeqs: [1], shadowedTokenCount: 18 } },
      { seq: 3, type: 'user/message', time: 3000, surfaceOp: { op: 'replace', start: 1, end: 1 }, data: { content: [{ type: 'text', text: 'b' }] } },
      { seq: 4, type: 'user/message', time: 4000, data: { content: [{ type: 'text', text: 'c'.repeat(40) }] } },
      { seq: 5, type: 'compaction/prune', time: 5000, data: { shadowedSeqs: [4], shadowedTokenCount: 18 } },
      { seq: 6, type: 'user/message', time: 6000, surfaceOp: { op: 'replace', start: 4, end: 4 }, data: { content: [{ type: 'text', text: 'd' }] } },
    ]) st = archiveCfg.apply(st, ev)
    return archiveCfg.view(st)
  })()
  assert.deepEqual(capped.archive.map(n => n.seq), [4], 'maxArchiveNodes keeps the newest removals only')
  assert.equal(capped.archiveFloor, 3, 'archiveFloor names the newest dropped removal')

  // -- surfaceFloor: the coverage floor of the served live-node slice --
  let floorCfg = null
  apply({ ...fakeCtx, sessionProjections: { register(d) { if (d.key === 'contextTimeline') floorCfg = d; return () => {} } } }, { maxNodes: 2 })
  const floored = (() => {
    let st = floorCfg.init()
    for (let s = 1; s <= 4; s++) {
      st = floorCfg.apply(st, { seq: s, type: 'user/message', time: s * 1000, data: { content: [{ type: 'text', text: 'x'.repeat(20) }] } })
    }
    return floorCfg.view(st)
  })()
  assert.equal(floored.droppedNodes, 2, 'two oldest live nodes outside the served slice')
  assert.equal(floored.surfaceFloor, 2, 'surfaceFloor is the newest dropped live seq')

  // -- inject pinning: live inject nodes older than the served tail are still
  // served (they land first and are few), so the browser can always list them;
  // droppedNodes/surfaceFloor count only the non-inject overflow --
  let pinCfg = null
  apply({ ...fakeCtx, sessionProjections: { register(d) { if (d.key === 'contextTimeline') pinCfg = d; return () => {} } } }, { maxNodes: 2 })
  const pinnedView = (() => {
    let st = pinCfg.init()
    st = pinCfg.apply(st, { seq: 1, type: 'user/message', time: 1000, data: { source: { kind: 'plugin', form: 'context', plugin: 'dsh-test' }, content: [{ type: 'text', text: 'injected context' }] } })
    for (let s = 2; s <= 5; s++) {
      st = pinCfg.apply(st, { seq: s, type: 'user/message', time: s * 1000, data: { content: [{ type: 'text', text: 'x'.repeat(20) }] } })
    }
    return pinCfg.view(st)
  })()
  assert.deepEqual(pinnedView.nodes.map(n => n.seq), [1, 4, 5], 'the out-of-window inject node is pinned ahead of the served tail, seq-ordered')
  assert.equal(pinnedView.nodes[0].cat, 'inject', 'the pinned node keeps its category')
  assert.equal(pinnedView.droppedNodes, 2, 'droppedNodes counts only the non-inject overflow')
  assert.equal(pinnedView.surfaceFloor, 3, 'surfaceFloor is the newest UNSERVED seq (pinned injects excluded)')
  assert.equal(pinCfg.schema.safeParse(pinnedView).success, true, 'pinning view passes the wire schema')

  // -- the wire view passes the unit's own schema (drift guard incl. archive) --
  assert.equal(def.schema.safeParse(shadow).success, true, 'archive-carrying view passes the wire schema')

  // -- contextHeaders unit: full header content epochs, dedupe + cap --
  const hdrive = (events) => {
    let st = hdef.init()
    for (const ev of events) st = hdef.apply(st, ev)
    return hdef.view(st)
  }
  const hlog = hdrive([
    { seq: 1, type: 'request/header', time: 1000, data: { reason: 'initial', header: { system: 'You are an agent.', tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }], config: { model: 'm', provider: 'p' } } } },
    { seq: 2, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'hi' }] } },
    { seq: 3, type: 'request/header', time: 3000, data: { reason: 'change', header: { system: 'You are another agent.', tools: [], config: { model: 'm2', provider: 'p' } } } },
  ])
  assert.equal(hlog.headers.length, 2, 'one epoch per request/header event')
  assert.equal(hlog.headers[0].system, 'You are an agent.', 'epoch carries the full system prompt')
  assert.equal(hlog.headers[0].tools.length, 1, 'epoch carries the tool schemas')
  assert.equal(hlog.headers[0].tools[0].name, 'bash')
  assert.equal(hlog.headers[0].tools[0].description, 'run a command')
  assert.deepEqual(hlog.headers[0].tools[0].schema.parameters, { type: 'object' }, 'raw schema content preserved')
  assert.ok(hlog.headers[0].tools[0].tokens > 0, 'tool schema priced')
  assert.equal(hlog.headers[1].system, 'You are another agent.')
  assert.equal(hdef.apply(hdef.init(), { type: 'user/message', seq: 9, time: 0, data: {} }).headers.length, 0,
    'non-header events leave the headers state empty')
  assert.equal(hdef.schema.safeParse(hlog).success, true, 'headers view passes its wire schema')
  // cap: 60 epochs keep the newest 50
  const manyHeaders = []
  for (let i = 1; i <= 60; i++) {
    manyHeaders.push({ seq: i, type: 'request/header', time: i * 1000, data: { reason: 'change', header: { system: 's' + i, config: { model: 'm' + i } } } })
  }
  assert.equal(hdrive(manyHeaders).headers.length, 50, 'header epochs capped')
  assert.equal(hdrive(manyHeaders).headers[0].system, 's11', 'the oldest epochs are dropped first')

  // -- tool names also resolve from the content block's toolCallId when the
  // source is absent on a (legacy) envelope --
  const legacyTool = drive([
    { seq: 1, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: 'x'.repeat(40) }] } },
    { seq: 2, type: 'tool/result', time: 2000, data: { message: { content: [{ type: 'tool-result', toolCallId: 't9', content: [{ type: 'text', text: 'y' }] }] } } },
  ])
  assert.equal(legacyTool.nodes.find(n => n.seq === 2).tool, undefined,
    'no source and no registered call name -> no tool label (never crashes)')

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
  const long = drive(many)
  assert.equal(long.requests.length, 1200, 'kept 300 turns x 4 steps after trimming')
  assert.equal(long.requests[0].turn, 101, 'trim starts at a whole turn boundary')
  assert.equal(long.requests[0].step, 0, 'trim starts at the first step of that turn')
  const keptTurns = new Set(long.requests.map(r => r.turn))
  assert.equal(keptTurns.size, 300, 'all 300 kept turns are present')
  assert.ok([...keptTurns].every(t => t >= 101 && t <= 400), 'kept turns are the newest ones')
  assert.equal(long.requests.filter(r => r.turn === 101).length, 4, 'first kept turn is complete')
  assert.equal(long.requests.filter(r => r.turn === 400).length, 4, 'last turn is complete')

  // -- streamed chunks are structurally ignored (same reference): token-level
  // events carry no state change for the timeline since the occupancy mirror
  // left the fold (R3) --
  const chunkEvent = { seq: 3, type: 'assistant/chunk', time: 3000, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5000 } } } }
  assert.equal(def.apply(base, chunkEvent), base, 'usage chunks keep the same reference (no change feed)')
  const snap3 = drive([
    { seq: 1, type: 'request/context', time: 1000, data: { contextWindow: 100000 } },
    { seq: 2, type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'a'.repeat(40) }] } },
    { seq: 3, type: 'assistant/chunk', time: 3000, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5000, cacheReadTokens: 1000, outputTokens: 0 } } } },
  ])
  assert.equal(snap3.occupancy, undefined, 'chunk usage never re-enters the timeline')
  assert.equal(snap3.contextWindow, 100000, 'route capacity still folds from request/context')

  // -- entry config: bounded slices are honored (config -> bounds threading) --
  let cfgDef = null
  apply({ ...fakeCtx, sessionProjections: { register(d) { if (d.key === 'contextTimeline') cfgDef = d; return () => {} } } }, { maxNodes: 2, maxKeptTurns: 1 })
  const bounded = (() => {
    let st = cfgDef.init()
    for (const ev of live.events) st = cfgDef.apply(st, ev)
    return cfgDef.view(st)
  })()
  // The served slice is the newest `maxNodes` tail PLUS pinned live injects
  // (fixture: surface [3,4,6,7,9,11,12], tail [11,12] + pinned inject seq 4;
  // seqs 3/6/7/9 are the unserved overflow).
  assert.deepEqual(bounded.nodes.map(n => n.seq), [4, 11, 12], 'maxNodes bounds the tail; live injects are pinned on top')
  assert.ok(bounded.nodes.filter(n => n.cat !== 'inject').length <= 2, 'the non-inject tail still honors maxNodes')
  assert.equal(bounded.droppedNodes, 4, 'pinned injects do not count as dropped')
  assert.equal(bounded.surfaceFloor, 9, 'surfaceFloor is the newest unserved seq')
  assert.ok(bounded.requests.length <= 8, 'maxKeptTurns bounds the retained history (400-turn fixture trimmed by whole turns)')
  assert.equal(typeof cfgDef.schema.safeParse(bounded).success, 'boolean', 'custom-bounds view still passes the unit schema')

  // -- model-switch semantics (R6): the only durable signal is a request
  // header differing from the previous one (reason 'change'); route/capacity
  // metadata (request/context) must NOT fire a switch event by itself, and a
  // provider-only change with the same model is not a switch either --
  const switchLog = drive([
    { seq: 1, type: 'request/header', time: 1000, data: { reason: 'initial', header: { system: 's', config: { model: 'model-a', provider: 'deepseek' } } } },
    { seq: 2, type: 'request/header', time: 2000, data: { reason: 'change', header: { system: 's', config: { model: 'model-b', provider: 'deepseek' } } } },
    { seq: 3, type: 'request/context', time: 2000, data: { model: 'model-b', provider: 'deepseek', contextWindow: 64000 } },
    { seq: 4, type: 'request/header', time: 3000, data: { reason: 'change', header: { system: 's', config: { model: 'model-b', provider: 'openai' } } } },
    { seq: 5, type: 'request/header', time: 4000, data: { reason: 'change', header: { system: 's', config: { model: 'model-b', provider: 'openai' } } } },
  ])
  const switchEvents = switchLog.events.filter(e => e.kind === 'model')
  assert.equal(switchEvents.length, 1, 'exactly one model-switch event')
  assert.equal(switchEvents[0].from, 'model-a', 'switch records the previous model')
  assert.equal(switchEvents[0].to, 'model-b', 'switch records the new model')
  assert.equal(switchLog.model, 'model-b', 'current model follows the header')
  assert.equal(switchLog.provider, 'openai', 'provider-only change updates the route, not a switch')
  assert.equal(switchLog.contextWindow, 64000, 'request/context supplies route capacity')

  // Usage mapping (R5): prompt-side = input + cacheRead + cacheWrite (billed
  // input), output = outputTokens; reasoningTokens stay inside outputTokens.
  const usageLog = drive([
    { seq: 1, type: 'assistant/message', time: 1000, data: { turn: 1, step: 1, usage: { inputTokens: 800, cacheReadTokens: 150, cacheWriteTokens: 50, outputTokens: 30, reasoningTokens: 10 }, message: { content: [] } } },
  ])
  assert.equal(usageLog.requests[0].prompt, 1000, 'prompt side sums the disjoint input buckets')
  assert.equal(usageLog.requests[0].output, 30, 'output is outputTokens (reasoning already inside)')
  assert.equal(usageLog.cost, undefined, 'no model name -> nothing priced into the cost totals')
  assert.equal(v.cost, undefined, 'a non-flash/pro model (deepseek-v4) is not priced')

  // -- session-cost totals (cumulative, per family x UTC pricing period) --
  // Peak windows are 01:00-04:00 and 06:00-10:00 UTC. The model NAME decides
  // the family, provider-agnostically (an OpenRouter-style spelling counts).
  const PEAK = Date.UTC(2026, 0, 5, 2, 0, 0) // 02:00 UTC -> peak
  const OFF = Date.UTC(2026, 0, 5, 12, 0, 0) // 12:00 UTC -> off-peak
  const costLog = drive([
    { seq: 1, type: 'request/header', time: PEAK - 1000, data: { header: { config: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' } } } },
    { seq: 2, type: 'assistant/message', time: PEAK, data: { turn: 1, step: 1, usage: { inputTokens: 800, cacheReadTokens: 150, cacheWriteTokens: 50, outputTokens: 30 }, message: { content: [] } } },
    { seq: 3, type: 'assistant/message', time: PEAK + 1000, data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 10 }, message: { content: [] } } },
    { seq: 4, type: 'assistant/message', time: OFF, data: { turn: 1, step: 3, usage: { inputTokens: 100, cacheReadTokens: 900 }, message: { content: [] } } },
  ])
  assert.deepEqual(costLog.cost.flash.peak, { uncached: 1000, cacheRead: 150, cacheWrite: 50, output: 40 },
    'same-period requests accumulate; missing buckets count as 0')
  assert.deepEqual(costLog.cost.flash.off, { uncached: 100, cacheRead: 900, cacheWrite: 0, output: 0 },
    'off-peak requests land in their own period bucket')
  assert.equal(costLog.cost.pro, undefined, 'no pro usage -> no pro branch')
  // A model switch re-attributes later requests to the new family.
  const costSwitch = drive([
    { seq: 1, type: 'request/header', time: OFF - 1000, data: { header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } } } },
    { seq: 2, type: 'assistant/message', time: OFF, data: { turn: 1, step: 1, usage: { inputTokens: 100 }, message: { content: [] } } },
    { seq: 3, type: 'request/header', time: OFF + 1000, data: { reason: 'change', header: { config: { model: 'deepseek-v4-pro', provider: 'deepseek' } } } },
    { seq: 4, type: 'assistant/message', time: OFF + 2000, data: { turn: 1, step: 2, usage: { inputTokens: 300, outputTokens: 20 }, message: { content: [] } } },
  ])
  assert.deepEqual(costSwitch.cost.flash.off.uncached, 100, 'usage before the switch stays on flash')
  assert.deepEqual(costSwitch.cost.pro.off, { uncached: 300, cacheRead: 0, cacheWrite: 0, output: 20 }, 'usage after the switch prices as pro')
  // The wire value must not alias persisted state (same rule as requests/events).
  {
    let st = def.init()
    for (const ev of [
      { seq: 1, type: 'request/header', time: 1000, data: { header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } } } },
      { seq: 2, type: 'assistant/message', time: OFF, data: { turn: 1, step: 1, usage: { inputTokens: 100 }, message: { content: [] } } },
    ]) st = def.apply(st, ev)
    const view = def.view(st)
    assert.ok(view.cost.flash.off !== st.cost.flash.off, 'view() copies the cost totals, never aliases persisted state')
  }

  // -- plain-JSON persisted state (R7): the projection-cache precondition.
  // Every `apply` result must survive the harness's lossless-JSON snapshotter;
  // an `undefined`-valued property ANYWHERE in the unit state rejects the whole
  // session's checkpoint write (TypeError: projection checkpoint is not
  // losslessly JSON-serializable), starving unrelated rows — including the
  // `title` projection that powers the session list after a restart. Fold the
  // live log (arm-then-consumed shadowed seqs included — live.events arms at
  // seq 10 and consumes via the seq 11 surface event) PLUS one
  // `assistant/message` whose data intentionally LACKS numeric turn/step (they
  // are optional in the durable vocabulary), so no tolerated-absence branch can
  // ever leave an `undefined`-valued property behind. Check every intermediate
  // state through the REAL harness snapshotter.
  const jsonLog = [...live.events, { seq: 99, type: 'assistant/message', time: 9999, data: { message: { content: [{ type: 'text', text: 'no turn/step here' }] } } }]
  const jsonStates = []
  let jsonSt = def.init()
  for (const ev of jsonLog) {
    jsonSt = def.apply(jsonSt, ev)
    jsonStates.push(jsonSt)
  }
  for (const [i, st] of jsonStates.entries()) {
    const cloned = snapshotJsonValue(st)
    assert.ok(cloned !== undefined, `state after event ${i + 1} is losslessly JSON-serializable (plain-JSON projection-cache precondition)`)
    assert.deepEqual(cloned, JSON.parse(JSON.stringify(st)), `state after event ${i + 1} round-trips losslessly`)
  }
  // And the armed-but-unconsumed intermediate (compaction arm alone) must also
  // stay serializable.
  const armed = def.apply(def.init(), { seq: 1, type: 'compaction/summary', time: 1000, data: { shadowedSeqs: [2], shadowedTokenCount: 10 } })
  assert.ok(snapshotJsonValue(armed) !== undefined, 'armed pendingShadowedSeqs state is still plain JSON')

  // -- dual-contract compatibility (dsh 0.1.1-rc.1+): each unit carries the
  // NEW contract fields alongside the old ones. `stateSchema` validates the
  // PERSISTED fold state before a checkpoint row seeds a fold; `wire`
  // (viewSchema + view) is the ONLY channel through which the 0.1.1-rc.1+
  // registry delivers a unit to the browser — a unit without `wire` is
  // host-only and its key never reaches the client (the Context tab would stay
  // on its loading screen forever). Both fields are load-bearing --
  assert.equal(typeof def.stateSchema, 'object', 'timeline: 0.1.1+ contract field stateSchema present')
  assert.ok(def.stateSchema && typeof def.stateSchema.parse === 'function', 'timeline: stateSchema is a validator')
  assert.ok(def.wire !== undefined && typeof def.wire === 'object', 'timeline: 0.1.1+ client view (wire) present')
  assert.ok(def.wire.viewSchema && typeof def.wire.viewSchema.parse === 'function', 'timeline: wire.viewSchema is a validator')
  assert.equal(typeof def.wire.view, 'function', 'timeline: wire.view is the client view')
  assert.equal(def.wire.view, def.view, 'timeline: old view and wire.view are the same projection')
  assert.equal(typeof hdef.stateSchema, 'object', 'headers: 0.1.1+ contract field stateSchema present')
  assert.ok(hdef.wire !== undefined && hdef.wire.viewSchema && typeof hdef.wire.view === 'function', 'headers: wire block present and complete')

  // Every intermediate fold state passes the state validator (the persisted
  // cache seeds folds from these rows), and the wire view through `wire`
  // reproduces the old `view` output exactly.
  for (const [i, st] of jsonStates.entries()) {
    assert.deepEqual(def.stateSchema.parse(st), st, `timeline: stateSchema round-trips persisted state after event ${i + 1}`)
    assert.deepEqual(def.wire.viewSchema.parse(def.wire.view(st)), def.view(st),
      `timeline: wire view equals the old view through the wire schema (state ${i + 1})`)
  }
  assert.ok(snapshotJsonValue(def.stateSchema.parse(armed)) !== undefined, 'timeline: armed state passes the state schema and stays plain JSON')
  assert.deepEqual(hdef.stateSchema.parse(hdef.init()), { headers: [] }, 'headers: stateSchema accepts the empty state')
  {
    let st = hdef.init()
    for (const ev of [
      { seq: 1, type: 'request/header', time: 1000, data: { reason: 'initial', header: { system: 'You are an agent.', tools: [{ name: 'bash', parameters: { type: 'object' } }] } } },
      { seq: 2, type: 'request/header', time: 3000, data: { reason: 'change', header: { system: 'You are another agent.', tools: [] } } },
    ]) st = hdef.apply(st, ev)
    assert.deepEqual(hdef.stateSchema.parse(st), st, 'headers: stateSchema round-trips persisted state')
    assert.deepEqual(hdef.wire.viewSchema.parse(hdef.wire.view(st)), hdef.view(st), 'headers: wire view equals the old view')
  }

  console.log('✔ host half functional test passed (projection unit, fold semantics, attribution, retention, shadow-price seqs, reference stability, determinism, config bounds, inject pinning, model switch, usage mapping, session-cost totals, plain-JSON state)')

})

test('host HMR safety: fiber dispose removes both projection registrations', () => {
  // cordis scopes each register() disposer to the calling fiber: unloading
  // (or HMR-swapping) the plugin must drop both keys from drives/snapshots.
  // The registry owns the tie-in; this pins the contract our plugin relies
  // on — every registration returns a working remover.
  const defs = new Map()
  const removers = []
  const ctx = {
    inject(list, cb) { cb(this) },
    effect(fn) { fn(); return () => {} },
    sessionProjections: {
      register(d) {
        defs.set(d.key, d)
        const remove = () => { defs.delete(d.key) }
        removers.push(remove)
        return remove
      },
    },
  }
  apply(ctx)
  assert.deepEqual([...defs.keys()].sort(), ['contextHeaders', 'contextTimeline'], 'both units registered')
  for (const remove of removers) remove() // simulate fiber dispose
  assert.equal(defs.size, 0, 'fiber dispose removes every registration')
})
