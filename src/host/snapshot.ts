/**
 * Snapshot building — turns the folded per-session state into the wire
 * `Snapshot` served to the Client half, and resolves the log sources for
 * live vs cold sessions.
 *
 * `computeSnapshot` is the per-session entry point called by the RPC
 * endpoint (index.ts): live sessions fold from the in-memory log, cold
 * (persisted) sessions fall back to `sessionQuery` and are served from
 * cache once folded, since their logs never grow.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextEventRecord, RequestRecord, Snapshot } from '../shared/types'
import { createFold, foldInto } from './fold'
import type { FoldState } from './fold'
import type { SessionEvent } from './services'

export interface SessionState {
  fold: FoldState
  /** Number of log events the cached result reflects. */
  count: number
  result: Snapshot | null
}

function buildResult(st: FoldState): Snapshot {
  const surfaceTotal = st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
  const result: Snapshot = {
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
    nodes: [],
    droppedNodes: 0,
  }
  // Bound the payload: the newest surface nodes carry the most signal.
  const MAX_NODES = 200
  result.droppedNodes = Math.max(0, st.surface.length - MAX_NODES)
  result.nodes = st.surface.slice(-MAX_NODES)

  // Attribute each event to the requests around it — the context that event
  // contributed to (same attachment the chart uses for ✂ markers). `turn`/
  // `step` name the FIRST request logged after the event (an injection lands
  // on the step that consumed it, a between-turn compaction on the next
  // turn's first step); `fromTurn`/`fromStep` name the request logged right
  // BEFORE it, so boundary events can show the gap they sit in
  // ("Step 2→3", or "Turn 50 · Step 8 → Turn 51 · Step 1"). Both lists stay
  // sorted by seq, so one pointer walk suffices. Events with no following
  // request (still in flight, or older than the retained window) keep only
  // the `from*` side; events before the first retained request keep none.
  let ri = 0
  for (const ev of result.events) {
    while (ri < result.requests.length && result.requests[ri].seq <= ev.seq) ri++
    const next = result.requests[ri]
    const prev = ri > 0 ? result.requests[ri - 1] : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

export async function computeSnapshot(ctx: Context, states: Map<string, SessionState>, sessionId: string): Promise<Snapshot> {
  let st = states.get(sessionId)
  if (st === undefined) {
    st = { fold: createFold(), count: -1, result: null }
    states.set(sessionId, st)
  }

  // Resolve the log sources lazily per call: `sessions` / `sessionQuery` may
  // be provided after this plugin applies, and a replaced service must not
  // leave us holding a stale instance.
  const sessions = ctx.get('sessions')
  const sessionQuery = ctx.get('sessionQuery')

  // Live sessions fold from the in-memory log — no clone, no disk parse.
  const live = sessions !== undefined ? sessions.get(sessionId) : undefined
  let events: readonly SessionEvent[]
  if (live !== undefined) {
    events = live.events
  } else {
    if (sessionQuery === undefined) throw new Error('session is not live and sessionQuery is unavailable')
    if (st.result !== null && st.count >= 0) {
      // Cold logs never grow: probe the lightweight record count only.
      const records = await sessionQuery.listEvents(sessionId)
      if (records.length === st.count) return st.result
    }
    const snapshot = await sessionQuery.readSession(sessionId)
    events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
  }

  if (events.length === st.count && st.result !== null) return st.result
  if (events.length < st.fold.n) st.fold = createFold() // defensive: log replaced
  foldInto(st.fold, events)
  st.count = events.length
  st.result = buildResult(st.fold)
  return st.result
}
