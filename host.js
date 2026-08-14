/**
 * last-context — Host half.
 *
 * Replays a session's durable event log into a per-request context-composition
 * timeline, and serves it to the Client half over a Package-private
 * `snapshot` RPC.
 *
 * Performance: live sessions are folded straight from the in-memory log
 * (`sessions.get(id).events` — no clone, no parse) and the fold is
 * INCREMENTAL: per-session state advances only over newly appended events.
 * Cold (persisted, not live) sessions fall back to `sessionQuery` and are
 * served from cache once folded, since their logs never grow.
 *
 * Token figures use the same fixed-density heuristic as the harness's own
 * token-meter (4 chars ≈ 1 token, +4 per content block, +4 role framing).
 * Labels are sent structured (kind/form/name/count) so the Client localizes.
 */

// ---- harness token-meter heuristic (mirrors dsh-token-meter/estimate.ts) ----
var CHARS_PER_TOKEN = 4
var BLOCK_OVERHEAD = 4
var ROLE_OVERHEAD = 4

function estimateBlocks(blocks) {
  var tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i]
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

function estimateMessage(message) {
  return estimateBlocks(message && message.content) + ROLE_OVERHEAD
}

function estimateSystem(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

function estimateToolSchema(tool) {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// ---- content extraction -----------------------------------------------------

function firstText(blocks) {
  if (!Array.isArray(blocks)) return ''
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

function toolCallNames(blocks) {
  var names = []
  if (!Array.isArray(blocks)) return names
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (b && b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

function isInjection(source) {
  // plugin context (AGENTS.md, snapshots, notices, …) and user-explicit skill
  // invocations both ride user-role messages with a declared form.
  return source !== null && typeof source === 'object'
    && (source.kind === 'plugin' || source.kind === 'skill-invocation' || typeof source.form === 'string')
}

// ---- the incremental fold -----------------------------------------------------

function createFold() {
  return {
    n: 0, // number of log events already folded
    surface: [], // { seq, cat, tokens, form?, text?, tool?, err?, skill?, calls? }
    sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    toolList: [], // { name, tokens }
    model: undefined,
    provider: undefined,
    lastModel: undefined,
    contextWindow: undefined,
    requests: [], // one entry per answered model call
    events: [], // notable context events (structured; the Client labels them)
    callNames: {}, // callId -> tool name
  }
}

function categoryOf(type, message) {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (isInjection(message && message.source)) return 'inject'
  return 'user'
}

function applySurface(st, ev, type, data, message) {
  var cat = categoryOf(type, message)
  var node = { seq: ev.seq, cat: cat, tokens: estimateMessage(message) }
  var source = message && message.source
  var form = source && source.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    var text = firstText(message && message.content)
    if (text !== '') node.text = text
    else {
      var names = toolCallNames(message && message.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    var block = message && message.content && message.content[0]
    var name = block && block.callId !== undefined ? st.callNames[block.callId] : undefined
    if (name) node.tool = name
    if (data && data.error) node.err = true
  } else if (source && source.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source && source.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(function (s) { return s && s.name }).filter(Boolean).join(', ').slice(0, 80)
    } else {
      var ptext = firstText(message && message.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    var utext = firstText(message && message.content)
    if (utext !== '') node.text = utext
  }

  var op = ev.surfaceOp
  if (op !== null && typeof op === 'object' && op.op === 'replace') {
    var si = -1
    var ei = -1
    for (var i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      var removed = st.surface.splice(si, ei - si + 1, node)
      for (var r = 0; r < removed.length; r++) st.sums[removed[r].cat] -= removed[r].tokens
      st.sums[cat] += node.tokens
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  return node
}

function foldInto(st, events) {
  for (var e = st.n; e < events.length; e++) {
    var ev = events[e]
    if (ev === null || typeof ev !== 'object') continue
    var data = ev.data
    switch (ev.type) {
      case 'request/header': {
        var header = data && data.header ? data.header : {}
        var tools = Array.isArray(header.tools) ? header.tools : []
        st.toolList = tools.map(function (t) {
          return { name: typeof t.name === 'string' ? t.name : '?', tokens: estimateToolSchema(t) }
        })
        st.toolsTokens = st.toolList.reduce(function (a, t) { return a + t.tokens }, 0)
        if (tools.length > 0) st.toolsTokens += BLOCK_OVERHEAD
        st.systemTokens = estimateSystem(header.system)
        if (header.config && typeof header.config.model === 'string') st.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') st.provider = header.config.provider
        if (data && data.reason === 'change' && st.model && st.lastModel && st.model !== st.lastModel) {
          st.events.push({ seq: ev.seq, time: ev.time, kind: 'model', from: st.lastModel, to: st.model })
        }
        if (st.model) st.lastModel = st.model
        break
      }
      case 'request/context':
        if (data && typeof data.contextWindow === 'number') st.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') st.model = data.model
        if (data && typeof data.provider === 'string') st.provider = data.provider
        break
      case 'tool/call':
        if (data && data.callId !== undefined && typeof data.name === 'string') st.callNames[data.callId] = data.name
        break
      case 'user/message': {
        var node = applySurface(st, ev, ev.type, data, data)
        var source = data && data.source
        if (isInjection(source)) {
          var rec = { seq: ev.seq, time: ev.time, kind: 'inject', form: source.form || 'context', tokens: node.tokens }
          if (source.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else if (typeof source.plugin === 'string' && source.plugin !== '') {
            rec.name = source.plugin
          }
          st.events.push(rec)
        }
        break
      }
      case 'tool/result':
        applySurface(st, ev, ev.type, data, data && data.message)
        break
      case 'assistant/message': {
        // Snapshot the request exactly as dispatched: current surface + header,
        // before this response joins the surface.
        var usage = data && data.usage
        var record = {
          turn: data && data.turn, step: data && data.step, time: ev.time, seq: ev.seq,
          system: st.systemTokens,
          tools: st.toolsTokens,
          user: st.sums.user,
          inject: st.sums.inject,
          assistant: st.sums.assistant,
          tool: st.sums.tool,
        }
        record.total = record.system + record.tools + record.user + record.inject + record.assistant + record.tool
        if (usage && typeof usage.inputTokens === 'number') {
          record.prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
          if (typeof usage.outputTokens === 'number') record.output = usage.outputTokens
        }
        st.requests.push(record)
        applySurface(st, ev, ev.type, data, data && data.message)
        break
      }
      case 'compaction/summary':
        st.events.push({
          seq: ev.seq, time: ev.time, kind: 'compaction',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          count: data && Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        })
        break
      case 'compaction/prune':
        st.events.push({
          seq: ev.seq, time: ev.time, kind: 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
        })
        break
      default:
        break
    }
  }
  st.n = events.length
  if (st.requests.length > 160) st.requests = st.requests.slice(-160)
  if (st.events.length > 150) st.events = st.events.slice(-150)
}

function buildResult(st) {
  var surfaceTotal = st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
  var result = {
    ok: true,
    model: st.model,
    provider: st.provider,
    contextWindow: st.contextWindow,
    current: {
      system: st.systemTokens,
      tools: st.toolsTokens,
      user: st.sums.user,
      inject: st.sums.inject,
      assistant: st.sums.assistant,
      tool: st.sums.tool,
      total: surfaceTotal + st.systemTokens + st.toolsTokens,
    },
    toolList: st.toolList,
    requests: st.requests,
    events: st.events,
  }
  // Bound the payload: the newest surface nodes carry the most signal.
  var MAX_NODES = 200
  result.droppedNodes = Math.max(0, st.surface.length - MAX_NODES)
  result.nodes = st.surface.slice(-MAX_NODES)
  return result
}

return {
  apply(ctx) {
    var sessionQuery = ctx.get('sessionQuery')
    var sessions = ctx.get('sessions')
    if (sessionQuery === undefined && sessions === undefined) {
      console.error('last-context: neither sessions nor sessionQuery is available; snapshot RPC disabled')
      return
    }

    // sessionId -> { fold state + last built result + the count it reflects }.
    var states = new Map()

    harness.handle('snapshot', async function (args) {
      try {
        var sessionId = args !== null && typeof args === 'object' ? args.sessionId : undefined
        if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'missing sessionId' }

        var st = states.get(sessionId)
        if (st === undefined) {
          st = { fold: createFold(), count: -1, result: null }
          states.set(sessionId, st)
        }

        // Live sessions fold from the in-memory log — no clone, no disk parse.
        var live = sessions !== undefined ? sessions.get(sessionId) : undefined
        var events
        if (live !== undefined) {
          events = live.events
        } else {
          if (sessionQuery === undefined) return { ok: false, error: 'session is not live and sessionQuery is unavailable' }
          if (st.result !== null && st.count >= 0) {
            // Cold logs never grow: probe the lightweight record count only.
            var records = await sessionQuery.listEvents(sessionId)
            if (records.length === st.count) return st.result
          }
          var snapshot = await sessionQuery.readSession(sessionId)
          events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
        }

        if (events.length === st.count && st.result !== null) return st.result
        if (events.length < st.fold.n) st.fold = createFold() // defensive: log replaced
        foldInto(st.fold, events)
        st.count = events.length
        st.result = buildResult(st.fold)
        return st.result
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) }
      }
    })
  },
}
