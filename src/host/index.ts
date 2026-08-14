/**
 * dsh-context — Host half (installed package entry).
 *
 * A plain Cordis plugin module (ESM, zero runtime dependencies) loaded by the
 * harness as the `dsh-context` loader row. It replays a session's durable
 * event log into a per-request context-composition timeline (fold.ts) and
 * serves it to the Client half over a generic Connection RPC channel
 * (`/dsh-context` snapshot, snapshot.ts).
 *
 * Performance: live sessions are folded straight from the in-memory log
 * (`sessions.get(id).events` — no clone, no parse) and the fold is
 * INCREMENTAL: per-session state advances only over newly appended events.
 * Cold (persisted, not live) sessions fall back to `sessionQuery` and are
 * served from cache once folded, since their logs never grow.
 *
 * Token figures use the same fixed-density heuristic as the harness's own
 * token-meter (pricing.ts). Labels are sent structured
 * (kind/form/name/count) so the Client localizes.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Snapshot } from '../shared/types'
import type { RpcResult } from './services'
import { computeSnapshot } from './snapshot'
import type { SessionState } from './snapshot'

export const name = 'dsh-context'

/** Required services: the generic Connection RPC registry (host half). */
export const inject = ['connection']

export function apply(ctx: Context): void {
  // sessionId -> { fold state + last built result + the count it reflects }.
  const states = new Map<string, SessionState>()

  ctx.effect(() => {
    return ctx.connection.rpc.handle(
      '/dsh-context',
      async (endpoint: string, payload: unknown): Promise<RpcResult<Snapshot>> => {
        try {
          if (endpoint !== 'snapshot') {
            return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } }
          }
          const sessionId = payload !== null && typeof payload === 'object'
            ? (payload as { sessionId?: unknown }).sessionId
            : undefined
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { ok: false, error: { code: 'internal', message: 'missing sessionId', details: {} } }
          }
          const value = await computeSnapshot(ctx, states, sessionId)
          return { ok: true, value }
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: err instanceof Error ? err.message : String(err),
              details: {},
            },
          }
        }
      },
      { authority: 'trusted-host' },
    )
  }, 'dsh-context: rpc channel')
}

// ---- public type surface (stable for downstream consumers) -------------------

export type { Category, ContextEventRecord, RequestRecord, Snapshot, SurfaceNode } from '../shared/types'
export type { SessionEvent } from './services'
