import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BACKFILL_ROUTE } from '../../../src/host/backfill'

export const FAST_PACING = {
  now: () => performance.now(),
  sleep: () => Promise.resolve(),
  minRestMs: 1,
  workBudgetMs: 1_000_000,
  roundPauseMs: 1,
}

export async function until<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

export interface RouteBox {
  path?: string
  fetch?: (request: Request) => Promise<Response>
}

export async function trigger(route: RouteBox): Promise<Response> {
  for (let i = 0; i < 300 && route.fetch === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(route.fetch !== undefined, 'the backfill route registered')
  return route.fetch(new Request(`http://dsh.test${BACKFILL_ROUTE}`, { method: 'POST' }))
}

export interface LogLine {
  level: string
  text: string
}

export function captureLogs(ctx: Context): LogLine[] {
  const lines: LogLine[] = []
  ctx.logger.exporter({
    levels: { root: 3, 'dsh-context': 3 },
    export(message) {
      lines.push({ level: message.type, text: message.args.map(a => String(a)).join(' ') })
    },
  })
  return lines
}

export function unsupportedFormatError(name: string): Error {
  const error = new Error(
    'subagent/descriptor 0 uses unsupported descriptor version 2'
    + '; source v0 artifact remains unchanged (raw log: C:\\Users\\u\\.dsh\\sessions\\log.jsonl.zstd)',
  )
  error.name = name
  return error
}

export function connectionOf(route: RouteBox): unknown {
  return {
    fetch: {
      register: (r: { path: string; fetch: RouteBox['fetch'] }) => {
        route.path = r.path
        route.fetch = r.fetch
        return () => {}
      },
    },
  }
}

export interface FakeState {
  listed: unknown
  served: Set<string>
  live: Set<string>
  coldReads: string[]
  coldSnapshots: string[]
  failReads: Map<string, unknown>
}

export interface ColdFaceOverrides {
  sessionQuery?: unknown
  sessionProjectionCache?: unknown
  sessionPersistence?: unknown
  sessions?: unknown
}

export function coldFaces(ctx: Context, state: FakeState, overrides: ColdFaceOverrides = {}): void {
  const face = (name: keyof ColdFaceOverrides, fallback: object): object =>
    name in overrides ? overrides[name] as object : fallback
  ctx.provide('sessionQuery', face('sessionQuery', { listSessions: async () => state.listed }))
  ctx.provide('sessionProjectionCache', face('sessionProjectionCache', {
    cachedSnapshot: (header: { id: string }) =>
      state.served.has(header.id)
        ? { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
        : undefined,
    coldSnapshot: (header: { id: string }) => {
      state.coldSnapshots.push(header.id)
      return { asOfSeq: 0, values: {} }
    },
  }))
  ctx.provide('sessionPersistence', face('sessionPersistence', {
    open: async (id: string) => {
      state.coldReads.push(id)
      if (state.failReads.has(id)) throw state.failReads.get(id)
      const events: SessionEvent[] = []
      return {
        header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }
    },
  }))
  ctx.provide('sessions', face('sessions', { get: (id: string) => (state.live.has(id) ? { id } : undefined) }))
}

export function arm(ctx: Context, state: FakeState, overrides: ColdFaceOverrides = {}): RouteBox {
  const route: RouteBox = {}
  ctx.provide('connection', connectionOf(route))
  coldFaces(ctx, state, overrides)
  return route
}

export function fakeState(listed: unknown): FakeState {
  return {
    listed,
    served: new Set(),
    live: new Set(),
    coldReads: [],
    coldSnapshots: [],
    failReads: new Map(),
  }
}
