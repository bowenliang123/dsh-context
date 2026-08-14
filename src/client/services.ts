/**
 * Client-side service contracts — the exact API surface this plugin consumes
 * from the harness web half.
 *
 * The `@deepseek-ai/*` service type packages publish broken dependency chains
 * on npm, so this plugin declares the exact client API surface locally.
 * These are TYPE-ONLY: the runtime services come from the user's harness.
 */

import type { Context } from '@deepseek-ai/cordis'

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string } }

export interface ClientConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>
}

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  subscribe(fn: () => void): () => void
}

export interface SlotRegistration {
  name: string
  id: string
  order: number
  label: () => string
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string }) => unknown,
  ): unknown
}

/** The client context: cordis plus the services this plugin injects. */
export type ClientCtx = Context & {
  connection: { rpc: ClientConnectionRpc }
  locale: LocaleService
  slots: SlotsService
}
