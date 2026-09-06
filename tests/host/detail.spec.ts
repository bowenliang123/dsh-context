// The on-demand detail channel (src/host/detail.ts): the nested-inject
// gating on the connection/sessions faces (load-order independent), the
// gate's live flip on unload, and the endpoint's typed outcomes — the detail
// payload off the live fold state, the typed `null` for a gone session or an
// absent unit, and the failure envelope for bad payloads and hostile reads
// (the channel must never throw into the transport).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { watchDetailChannel } from '../../src/host/detail'
import { resolveBounds } from '../../src/host/config'
import type { TimelineState } from '../../src/host/fold'
import { assistantMessage, header, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const BOUNDS = resolveBounds({})

type Handler = (endpoint: string, payload: unknown) => unknown

interface CtxSpec {
  connection?: unknown
  sessions?: unknown
  sessionQuery?: unknown
  stateOf?: (session: unknown, key: string) => unknown
}

/**
 * A minimal host ctx double with cordis inject semantics: the callback runs
 * once its dependency list completes (here: immediately when the services
 * map has them, never otherwise), and its returned disposer is collected.
 */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { channel?: string; handler?: Handler }; disposers: (() => void)[] } {
  const captured: { channel?: string; handler?: Handler } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessions' in spec) services.set('sessions', spec.sessions)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  const ctx = {
    get: (name: string) => services.get(name),
    sessionProjections: { stateOf: spec.stateOf ?? (() => undefined) },
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  // Wire the connection face so handle() captures its registration.
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { rpc?: { handle?: unknown } }
    if (typeof conn.rpc?.handle === 'function') {
      conn.rpc.handle = (channel: string, handler: Handler) => {
        captured.channel = channel
        captured.handler = handler
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

/** A live sessions face whose get() serves the `s1` id only. */
function sessionsWith(session: unknown): { get(id: string): unknown } {
  return { get: (id: string) => (id === 's1' ? session : undefined) }
}

function okSession(): object {
  return { id: 's1' }
}

describe('watchDetailChannel gating', () => {
  test('the gate stays closed without the connection or sessions service', () => {
    // Neither service.
    assert.equal(watchDetailChannel(ctxOf({}).ctx, BOUNDS).live, false)
    // Sessions only.
    assert.equal(watchDetailChannel(ctxOf({ sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    // Connection only.
    const connOnly = ctxOf({ connection: { rpc: { handle: () => () => {} } } })
    assert.equal(watchDetailChannel(connOnly.ctx, BOUNDS).live, false)
    // A connection without the rpc.handle face, or a sessions without get.
    assert.equal(watchDetailChannel(ctxOf({ connection: { rpc: {} }, sessions: sessionsWith(okSession()) }).ctx, BOUNDS).live, false)
    assert.equal(watchDetailChannel(ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: { get: 42 },
    }).ctx, BOUNDS).live, false)
  })

  test('the gate opens on registration and closes on unload', () => {
    const { ctx, captured, disposers } = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
    })
    const gate = watchDetailChannel(ctx, BOUNDS)
    assert.equal(gate.live, true)
    assert.equal(captured.channel, '/dsh-context')
    assert.equal(typeof captured.handler, 'function')
    // Unload: the inject fiber's disposer closes the gate (the wire flips back to inline).
    for (const d of disposers) d()
    assert.equal(gate.live, false)
  })

  test('a rejecting registry keeps the gate closed without throwing', () => {
    const ctx = {
      get: (name: string) =>
        name === 'connection'
          ? {
            rpc: {
              handle: () => {
                throw new Error('registration rejected')
              },
            },
          }
          : name === 'sessions'
            ? sessionsWith(okSession())
            : undefined,
      sessionProjections: { stateOf: () => undefined },
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => (d === 'connection' || d === 'sessions'))) cb(ctx)
      },
    }
    assert.equal(watchDetailChannel(ctx as unknown as Context, BOUNDS).live, false)
  })
})

describe('the detail endpoint', () => {
  function liveCtx(state: TimelineState | undefined): { ctx: Context; captured: { handler?: Handler } } {
    return ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => state,
    })
  }

  test('unknown endpoints and bad payloads fail with typed envelopes', async () => {
    const { ctx, captured } = liveCtx(undefined)
    watchDetailChannel(ctx, BOUNDS)
    const handler = captured.handler!
    assert.deepEqual(await handler('nope', { sessionId: 's1' }), {
      ok: false,
      error: { code: 'dsh-context/unknown-endpoint', message: 'unknown endpoint: nope', details: {} },
    })
    for (const payload of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await handler('detail', payload) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
  })

  test('a session outside the live set resolves to the typed null', async () => {
    const { state } = driveTimeline([userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await captured.handler!('detail', { sessionId: 'gone' }), { ok: true, value: null })
  })

  test('an absent unit state resolves to the typed null', async () => {
    const { ctx, captured } = liveCtx(undefined)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await captured.handler!('detail', { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a cold session (never entered into the live store) folds its detail off the observed log', async () => {
    const events = [
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
    ]
    let disposed = 0
    let observedOptions: unknown
    const { ctx, captured } = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: (id: string, opts: unknown) => {
          observedOptions = opts
          return Promise.resolve(id === 'cold1'
            ? { events, [Symbol.dispose]: () => { disposed++ } }
            : null)
        },
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await captured.handler!('detail', { sessionId: 'cold1' }) as {
      ok: boolean
      value: { rev: number; requests: unknown[]; nodes: unknown[] } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null)
    assert.equal(result.value.requests.length, 1, 'the observed log folded')
    assert.equal(result.value.nodes.length, 2)
    assert.deepEqual(observedOptions, { projectionMode: 'none' }, 'the observation skips projection work')
    assert.equal(disposed, 1, 'the observation lease disposed after the fold')
    // A session nothing can observe (the query resolves null) stays a typed null.
    assert.deepEqual(await captured.handler!('detail', { sessionId: 'nobody' }), { ok: true, value: null })
  })

  test('an observation without a dispose face still serves (nothing to release)', async () => {
    const events = [userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' })]
    const { ctx, captured } = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: () => Promise.resolve({ events }),
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await captured.handler!('detail', { sessionId: 'cold1' }) as { ok: boolean; value: { nodes: unknown[] } | null }
    assert.equal(result.ok, true)
    assert.equal(result.value?.nodes.length, 1)
  })

  test('a sessionQuery without the observe face (or a rejecting read) degrades cleanly', async () => {
    // Face present but the method missing.
    const noFace = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {},
    })
    watchDetailChannel(noFace.ctx, BOUNDS)
    assert.deepEqual(await noFace.captured.handler!('detail', { sessionId: 'cold' }), { ok: true, value: null })

    // The observation read rejects (persistence down).
    const rejecting = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {
        observeSession: () => Promise.reject(new Error('persistence down')),
      },
    })
    watchDetailChannel(rejecting.ctx, BOUNDS)
    const result = await rejecting.captured.handler!('detail', { sessionId: 'cold' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'gateway/internal')
    assert.equal(result.error.message, 'persistence down')
  })

  test('serves the fold state\'s detail payload with its revision', async () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
    ])
    const { ctx, captured } = liveCtx(state)
    watchDetailChannel(ctx, BOUNDS)
    const result = await captured.handler!('detail', { sessionId: 's1' }) as { ok: true; value: { rev: number; requests: unknown[]; nodes: unknown[] } }
    assert.equal(result.ok, true)
    assert.equal(result.value.rev, 2, 'two detail-mutating folds')
    assert.equal(result.value.requests.length, 1)
    assert.equal(result.value.nodes.length, 2)
  })

  test('hostile reads degrade to the failure envelope, never a throw', async () => {
    // sessions.get throwing.
    const throwingGet = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: {
        get: () => {
          throw new Error('hostile sessions')
        },
      },
    })
    watchDetailChannel(throwingGet.ctx, BOUNDS)
    const r1 = await throwingGet.captured.handler!('detail', { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(r1.ok, false)
    assert.equal(r1.error.code, 'gateway/internal')
    assert.equal(r1.error.message, 'hostile sessions')

    // stateOf throwing.
    const throwingState = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => {
        throw new Error('hostile registry')
      },
    })
    watchDetailChannel(throwingState.ctx, BOUNDS)
    const r2 = await throwingState.captured.handler!('detail', { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r2.ok, false)
    assert.equal(r2.error.message, 'hostile registry')

    // A state whose collections are junk (the detail builder throws).
    const junkState = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => ({ requests: null }),
    })
    watchDetailChannel(junkState.ctx, BOUNDS)
    const r3 = await junkState.captured.handler!('detail', { sessionId: 's1' }) as { ok: boolean }
    assert.equal(r3.ok, false)

    // A non-Error rejection stringifies into the envelope.
    const stringThrow = ctxOf({
      connection: { rpc: { handle: () => () => {} } },
      sessions: {
        get: () => {
          throw 'string boom'
        },
      },
    })
    watchDetailChannel(stringThrow.ctx, BOUNDS)
    const r4 = await stringThrow.captured.handler!('detail', { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r4.ok, false)
    assert.equal(r4.error.message, 'string boom')
  })
})
