/**
 * The on-demand DETAIL channel of the split `contextTimeline` generation.
 *
 * The projection's wire value is the slim head (fold.ts `buildTimelineHead`);
 * the heavy collections (per-request records, context events, the served
 * surface window, the removed-node archive) are served HERE instead — one
 * targeted read per viewing client, only while its Context tab or /context
 * modal is open, instead of riding every session.list row, control baseline,
 * follow snapshot, and push frame whole (see shared/types.ts
 * `ContextTimelineDetail`).
 *
 * The channel is the harness's generic Connection RPC (`ctx.connection.rpc`),
 * the same transport the plugin used before the v0.9 projection migration —
 * verified present on every supported baseline (0.1.2-rc.1+). The handler
 * resolves the session through the harness's own ladder: a LIVE session's
 * unit state comes straight off the registry's `stateOf` (no second fold);
 * a session only ever VIEWED cold (prepared into the observation cache —
 * `SessionStore.prepare` never enters it into the live store) is observed
 * through `ctx.sessionQuery` and its immutable log folded from init (cheap:
 * a cold session's log is static, and the client's per-session store reads
 * it once per page view). A session that left the live set mid-request, a
 * unit that never registered, or a session nothing can observe resolves to
 * a typed `null` — the client keeps its last detail and offers a retry,
 * never an unhandled rejection.
 *
 * Load order is never assumed: `watchDetailChannel` nests a `ctx.inject` on
 * the two faces, so a connection service that activates AFTER this plugin
 * still arms the channel (cordis replays the inject when the dependency set
 * completes). The returned gate is read by the timeline unit's view at every
 * serve, so the wire generation flips to slim the moment the channel goes
 * live and flips back if it unloads — the client reconciles both (it detects
 * the generation per value, timelineSource.ts). A deployment whose
 * connection/sessions services never compose keeps the gate closed forever
 * and serves the inline value unchanged.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { applyTimeline, buildTimelineDetail, createTimelineState } from './fold'

/** The plugin's generic Connection RPC channel (the pre-v0.9 name, kept). */
export const DETAIL_CHANNEL = '/dsh-context'
/** The one endpoint the channel serves: the session's timeline detail. */
export const DETAIL_ENDPOINT = 'detail'

/** The channel's liveness, read by the timeline unit's view at every serve. */
export interface DetailChannelGate {
  readonly live: boolean
}

/** The host `connection` service, as far as the channel consumes it. */
interface ConnectionHostFace {
  rpc?: {
    // The handler's result is awaited by the transport; the cold rung below
    // awaits the observation read.
    handle?(
      channel: string,
      handler: (endpoint: string, payload: unknown) => unknown,
    ): () => void
  }
}

/** The host `sessions` service, as far as the channel consumes it (the strict-global-read idiom). */
interface SessionsHostFace {
  get?(id: string): unknown
}

/**
 * The host `sessionQuery` service, as far as the channel consumes it: the
 * cold-session rung. A session that is only VIEWED is never entered into the
 * live store (`SessionStore.prepare` with a persistence seed does not
 * register it) — the observation reader carries it instead, with the full
 * immutable log on `events`.
 */
interface SessionQueryFace {
  observeSession?(id: string, options?: { projectionMode?: 'all' | 'none' }): Promise<unknown>
}

/** The RPC failure envelope the transport expects (ConnectionRpcFailure). */
function failure(code: string, message: string): { ok: false; error: { code: string; message: string; details: object } } {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Arm the detail endpoint whenever the connection and sessions services are
 * both composed (see the module header for the load-order contract). The
 * registration rides the injected fiber: either service unloading withdraws
 * the channel and closes the gate.
 */
export function watchDetailChannel(ctx: Context, bounds: FoldBounds): DetailChannelGate {
  const gate = { live: false }
  ctx.inject(['connection', 'sessions'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    // Bind at extraction (an unbound hand-off loses `this` on the real faces).
    const handle = typeof connection?.rpc?.handle === 'function'
      ? connection.rpc.handle.bind(connection.rpc)
      : undefined
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (handle === undefined || getSession === undefined) return
    const projections = ctx.sessionProjections

    const handler = async (endpoint: string, payload: unknown): Promise<unknown> => {
      if (endpoint !== DETAIL_ENDPOINT) {
        return failure('dsh-context/unknown-endpoint', `unknown endpoint: ${endpoint}`)
      }
      const sessionId = payload !== null && typeof payload === 'object'
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          // Live (attached) session: read the registry's CURRENT fold state —
          // no second fold. `stateOf` materializes the cell at the session
          // cursor (no-op when the drive is current); never mutate the result.
          const state = projections.stateOf(session as never, 'contextTimeline')
          // The unit is absent only in the baseline-gated composition, which never
          // installs this channel — a miss is defensive.
          if (state === undefined) return { ok: true, value: null }
          return { ok: true, value: buildTimelineDetail(state, bounds) }
        }
        // Cold session (viewed through a prepared observation, never entered
        // into the live store): observe it and fold the detail from its
        // immutable log. The lease disposes promptly; the query's prepared
        // cache retains the session for reuse. A session nothing can observe
        // resolves to the typed null — the client keeps its last detail.
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return { ok: true, value: null }
        const observation = await observe(sessionId, { projectionMode: 'none' })
        const events = (observation as { events?: unknown } | null)?.events
        if (!Array.isArray(events)) return { ok: true, value: null }
        let state = createTimelineState()
        try {
          for (const ev of events) state = applyTimeline(state, ev as never, bounds)
        } finally {
          const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
          if (typeof dispose === 'function') dispose.call(observation)
        }
        return { ok: true, value: buildTimelineDetail(state, bounds) }
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    try {
      c.effect(() => {
        const unregister = handle(DETAIL_CHANNEL, handler)
        return () => {
          unregister()
        }
      }, 'dsh-context: detail channel')
    } catch {
      // A hostile or rejecting registry must not take the plugin down — the
      // gate stays closed and the wire value stays inline.
      return
    }
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}
