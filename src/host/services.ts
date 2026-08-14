/**
 * Host-side service contracts — the exact API surface this plugin consumes
 * from the harness.
 *
 * The `@deepseek-ai/*` service type packages publish broken dependency chains
 * on npm (e.g. `dsh-paths` is missing), so this third-party plugin declares
 * the documented harness contracts locally. These are TYPE-ONLY: the runtime
 * services come from the user's harness. The `Context` augmentation below
 * makes `ctx.connection` / `ctx.sessions` / `ctx.sessionQuery` typed for the
 * whole Host half.
 */

import type { Context } from '@deepseek-ai/cordis'

/** A minimal session-log event, as folded by this plugin. */
export interface SessionEvent {
  seq: number
  type: string
  time: number
  data?: unknown
  surfaceOp?: unknown
}

/** The in-memory log of a LIVE session (`sessions.get(id)`). */
export interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

export interface SessionLike {
  readonly events: readonly SessionEvent[]
}

/** The durable-log accessor used for COLD (persisted, not live) sessions. */
export interface SessionQueryLike {
  listEvents(id: string): Promise<readonly unknown[]>
  readSession(id: string): Promise<{ events?: readonly SessionEvent[] }>
}

/** The generic Connection RPC channel registry (`ctx.connection.rpc`). */
export interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    options: { authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

/** The harness RpcResult envelope ({ok:true,value} | {ok:false,error}). */
export type RpcError = { code: string; message: string; details: unknown }
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: { rpc: HostConnectionRpc }
    sessions: SessionStoreLike
    sessionQuery: SessionQueryLike
  }
}
