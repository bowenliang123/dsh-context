import type { Context } from '@deepseek-ai/cordis'
import type { ColdReadGate } from '../../../src/host/coldRead'

export type RouteFetch = (request: Request) => Promise<Response>

export interface FakeRoute {
  path?: string
  fetch?: RouteFetch
  methods?: readonly string[]
  requestBody?: string
}

interface LoggerFace {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export interface FakeCtxOptions {
  logger?: Partial<LoggerFace>
  sessionProjections?: unknown
  serviceGetters?: Record<string, () => unknown>
  injectAll?: boolean
  captureRoutes?: boolean
}

export interface FakeCtx {
  ctx: Context
  captured: FakeRoute
  routes: Map<string, FakeRoute>
  disposers: (() => void)[]
  emit(event: string, ...args: unknown[]): void
  dispose(): void
}

interface ConnectionLike {
  fetch?: { register?: unknown }
}

const noop = (): void => {}

export function connectionOf(register: (route: FakeRoute) => unknown = () => noop()): { fetch: { register: (route: FakeRoute) => unknown } } {
  return { fetch: { register } }
}

export function fakeCtx(services: object, options: FakeCtxOptions = {}): FakeCtx {
  const provided = new Map<string, unknown>()
  for (const [name, value] of Object.entries(services)) provided.set(name, value)
  const captured: FakeRoute = {}
  const routes = new Map<string, FakeRoute>()
  const disposers: (() => void)[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  if (options.captureRoutes !== false) {
    const connection = provided.get('connection') as ConnectionLike | undefined
    const fetch = connection?.fetch
    const register = fetch?.register
    if (typeof register === 'function' && fetch !== undefined) {
      fetch.register = (route: FakeRoute) => {
        const dispose = (register as (route: FakeRoute) => unknown).call(fetch, route)
        captured.path = route.path
        captured.fetch = route.fetch
        routes.set(String(route.path), route)
        return () => {
          routes.delete(String(route.path))
          if (captured.path === route.path) {
            captured.path = undefined
            captured.fetch = undefined
          }
          if (typeof dispose === 'function') (dispose as () => void)()
        }
      }
    }
  }

  const logger: LoggerFace = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    ...options.logger,
  }
  const ctx = {
    get: (name: string) => {
      const getter = options.serviceGetters?.[name]
      if (getter !== undefined) return getter()
      return provided.get(name)
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const known = listeners.get(event) ?? []
      known.push(listener)
      listeners.set(event, known)
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    logger,
    sessionProjections: options.sessionProjections ?? { stateOf: () => undefined },
    effect(fn: () => unknown, _label?: string) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return noop
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (options.injectAll !== true && !deps.every(dep => provided.has(dep))) return
      const dispose = cb(ctx)
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
  }
  return {
    ctx: ctx as unknown as Context,
    captured,
    routes,
    disposers,
    emit: (event, ...args) => { ctx.emit(event, ...args) },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

export const OPEN_GATE: ColdReadGate = { admit: read => read() }

export const SKIP_GATE: ColdReadGate = { admit: () => Promise.resolve(undefined) }

export interface Observing {
  observeSession(id: string, options?: unknown): Promise<unknown>
  wasDisposed(): boolean
  disposeCount(): number
}

export function observing(events: unknown, over: Record<string, unknown> = {}): Observing {
  let disposed = 0
  return {
    observeSession: () => Promise.resolve({
      events,
      ...over,
      [Symbol.dispose]() { disposed++ },
    }),
    wasDisposed: () => disposed > 0,
    disposeCount: () => disposed,
  }
}

export function observationOf(events: readonly unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'live',
    cursor: events.length === 0 ? -1 : (events[events.length - 1] as { seq?: number } | undefined)?.seq ?? -1,
    events,
    [Symbol.dispose]: noop,
    ...over,
  }
}

export function postRequest(path: string, body?: unknown): Request {
  return new Request(`http://dsh.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}

export async function postJson(captured: { fetch?: RouteFetch }, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await captured.fetch!(postRequest(path, body))
  return await response.json() as Record<string, unknown>
}

export async function responseJson(captured: { fetch?: RouteFetch }): Promise<Record<string, unknown>> {
  const response = await captured.fetch!(postRequest('/'))
  return await response.json() as Record<string, unknown>
}
