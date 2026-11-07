import type { Context } from '@deepseek-ai/cordis'
import { type ConnectionHostFace, registerPostRoute } from './connection'

type RouteFetch = (request: Request) => Response | Promise<Response>

interface RouteGate {
  live: boolean
}

interface PostRouteMount {
  ctx: Context
  deps: string[]
  path: string
  label: string
  gate?: RouteGate
  handler(c: Context): RouteFetch | undefined
}

export type BodyRead = { ok: true; body: unknown } | { ok: false; response: Response }

interface ObserveFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

export type ObserveSession = (id: string, options: unknown) => Promise<unknown>

export function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

export function revisionOf(observation: unknown): string | undefined {
  const revision = observation !== null && typeof observation === 'object'
    ? (observation as { revision?: unknown }).revision
    : undefined
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

export function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

export async function readBody(request: Request): Promise<BodyRead> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return { ok: false, response: failure('dsh-context/bad-request', 'body is not JSON') }
  }
}

export function observeOf(ctx: Context): ObserveSession | undefined {
  const query = ctx.get('sessionQuery') as ObserveFace | undefined
  const observe = typeof query?.observeSession === 'function' ? query.observeSession.bind(query) : undefined
  return observe !== undefined ? (id, options) => observe(id, options) : undefined
}

export function leaseOf(observation: unknown): () => void {
  const dispose = (observation as { [Symbol.dispose]?: unknown } | null | undefined)?.[Symbol.dispose]
  return typeof dispose === 'function' ? () => { dispose.call(observation) } : () => {}
}

export function mountPostRoute(mount: PostRouteMount): unknown {
  const { ctx, deps, path, label, gate } = mount
  return ctx.inject(deps, (c) => {
    const fetch = mount.handler(c)
    if (fetch === undefined) return
    const connection = c.get('connection') as ConnectionHostFace | undefined
    if (!registerPostRoute(c, connection, path, fetch, label)) return
    if (gate === undefined) return
    gate.live = true
    return () => { gate.live = false }
  })
}
