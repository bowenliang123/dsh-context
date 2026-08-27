// Projection narrowing (src/client/services.ts): the no-white-screen wire
// guards — numOf, timelineOf fast/slow paths, contextPressureOf,
// contextBreakdownOf, tokenUsageOf, headersOf.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  canOpenPathsOf,
  contextBreakdownOf,
  contextPressureOf,
  headersOf,
  numOf,
  openPathVia,
  timelineOf,
  tokenUsageOf,
  workspaceOf,
} from '../../src/client/services'
import type { ClientCtx } from '../../src/client/services'

describe('numOf', () => {
  test('finite numbers pass through', () => {
    assert.equal(numOf(42), 42)
    assert.equal(numOf(0), 0)
    assert.equal(numOf(-1.5), -1.5)
  })

  test('NaN/Infinity degrade to 0', () => {
    assert.equal(numOf(NaN), 0)
    assert.equal(numOf(Infinity), 0)
    assert.equal(numOf(-Infinity), 0)
  })

  test('non-numbers and missing values degrade to 0', () => {
    assert.equal(numOf('7'), 0)
    assert.equal(numOf(undefined), 0)
    assert.equal(numOf(null), 0)
    assert.equal(numOf({}), 0)
  })
})

describe('timelineOf', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6, total: 7 }

  test('non-records stay null', () => {
    assert.equal(timelineOf(null), null)
    assert.equal(timelineOf(undefined), null)
    assert.equal(timelineOf(5), null)
    assert.equal(timelineOf('x'), null)
  })

  test('a well-formed wire value passes through by reference', () => {
    const wire = {
      ok: true,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      contextWindow: 128000,
      current,
      requests: [],
      events: [],
      nodes: [],
      archive: [],
      droppedNodes: 0,
    }
    assert.equal(timelineOf(wire), wire)
  })

  test('current missing/non-object rebuilds a zeroed breakdown', () => {
    for (const bad of [{}, { current: null }, { current: 7 }]) {
      assert.deepEqual(timelineOf(bad), {
        ok: true,
        current: { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 },
        requests: [],
        events: [],
        nodes: [],
        droppedNodes: 0,
        archive: [],
      })
    }
  })

  test('current with some non-number fields is numOf-coerced', () => {
    const out = timelineOf({ current: { system: 12, tools: 'x', user: undefined } })
    assert.ok(out !== null)
    assert.deepEqual(out.current, { system: 12, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
  })

  test('non-array collections become empty lists', () => {
    const out = timelineOf({
      current,
      requests: 'nope',
      events: 7,
      nodes: null,
      archive: undefined,
    })
    assert.ok(out !== null)
    assert.deepEqual(out.requests, [])
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.nodes, [])
    assert.deepEqual(out.archive, [])
  })

  test('null/non-object collection entries are dropped', () => {
    const node = { kind: 'message', seq: 1 }
    const out = timelineOf({ current: 1, nodes: [node, null, 42, 's'] })
    assert.ok(out !== null)
    assert.deepEqual(out.nodes, [node])
  })

  test('model/provider/contextWindow: wrong-typed dropped, right-typed kept', () => {
    const kept = timelineOf({ current: 1, model: 'm', provider: 'p', contextWindow: 100 })
    assert.ok(kept !== null)
    assert.equal(kept.model, 'm')
    assert.equal(kept.provider, 'p')
    assert.equal(kept.contextWindow, 100)
    const dropped = timelineOf({ current: 1, model: 5, provider: {}, contextWindow: 'x' })
    assert.ok(dropped !== null)
    assert.ok(!('model' in dropped))
    assert.ok(!('provider' in dropped))
    assert.ok(!('contextWindow' in dropped))
  })

  test('images/toolCalls/surfaceFloor/archiveFloor are kept only when numbers', () => {
    const kept = timelineOf({ current: 1, images: 3, toolCalls: 2, surfaceFloor: 10, archiveFloor: 4 })
    assert.ok(kept !== null)
    assert.equal(kept.images, 3)
    assert.equal(kept.toolCalls, 2)
    assert.equal(kept.surfaceFloor, 10)
    assert.equal(kept.archiveFloor, 4)
    const dropped = timelineOf({ current: 1, images: 'n', toolCalls: {}, surfaceFloor: null, archiveFloor: true })
    assert.ok(dropped !== null)
    assert.ok(!('images' in dropped))
    assert.ok(!('toolCalls' in dropped))
    assert.ok(!('surfaceFloor' in dropped))
    assert.ok(!('archiveFloor' in dropped))
  })

  test('cost is kept only when a plain non-array object', () => {
    const cost = { 'deepseek-v4-flash': { peak: { input: 1 } } }
    const kept = timelineOf({ current: 1, cost })
    assert.ok(kept !== null)
    assert.equal(kept.cost, cost)
    for (const bad of [[], null, 5]) {
      const out = timelineOf({ current: 1, cost: bad })
      assert.ok(out !== null)
      assert.ok(!('cost' in out))
    }
  })

  test('droppedNodes is numOf-coerced', () => {
    assert.equal(timelineOf({ current: 1, droppedNodes: 4 })?.droppedNodes, 4)
    assert.equal(timelineOf({ current: 1, droppedNodes: 'x' })?.droppedNodes, 0)
  })
})

describe('contextPressureOf', () => {
  test('records pass through', () => {
    const value = { pressureTokens: 10, surfaceTokens: 20 }
    assert.equal(contextPressureOf(value), value)
  })

  test('non-records degrade to null', () => {
    assert.equal(contextPressureOf(null), null)
    assert.equal(contextPressureOf(undefined), null)
    assert.equal(contextPressureOf(42), null)
  })
})

describe('contextBreakdownOf', () => {
  test('all three finite numbers pass through as a value', () => {
    assert.deepEqual(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: 3 }), {
      systemTokens: 1,
      toolsTokens: 2,
      messageTokens: 3,
    })
  })

  test('non-records degrade to null', () => {
    assert.equal(contextBreakdownOf(null), null)
    assert.equal(contextBreakdownOf('x'), null)
  })

  test('a missing/NaN/non-finite field degrades the whole value to null', () => {
    assert.equal(contextBreakdownOf({ toolsTokens: 2, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: NaN, toolsTokens: 2, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 'x', messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: Infinity, messageTokens: 3 }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: undefined }), null)
    assert.equal(contextBreakdownOf({ systemTokens: 1, toolsTokens: 2, messageTokens: -Infinity }), null)
  })
})

describe('tokenUsageOf', () => {
  test('records pass through', () => {
    const value = { total: { input: 100 } }
    assert.equal(tokenUsageOf(value), value)
  })

  test('non-records degrade to null', () => {
    assert.equal(tokenUsageOf(null), null)
    assert.equal(tokenUsageOf(undefined), null)
    assert.equal(tokenUsageOf(3), null)
  })
})

describe('headersOf', () => {
  test('non-records degrade to null', () => {
    assert.equal(headersOf(null), null)
    assert.equal(headersOf(7), null)
  })

  test('a non-array headers field degrades to null', () => {
    assert.equal(headersOf({}), null)
    assert.equal(headersOf({ headers: 'x' }), null)
  })

  test('a null/non-object entry degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [null] }), null)
    assert.equal(headersOf({ headers: ['s'] }), null)
  })

  test('an entry with a non-array tools list degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [{ tools: 'x' }] }), null)
  })

  test('an entry with a defined non-string system degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [{ tools: [], system: 5 }] }), null)
  })

  test('a valid value passes through by reference', () => {
    const value = {
      headers: [
        { seq: 1, time: 1000, tools: [], system: 'prompt' },
        { seq: 2, time: 2000, tools: [{ name: 'bash', tokens: 10 }] },
      ],
    }
    assert.equal(headersOf(value), value)
  })
})

describe('workspaceOf', () => {
  const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx

  test('reads the session row cwd off the sessions list snapshot', () => {
    const ctx = ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: '/repo' } } }) } } })
    assert.equal(workspaceOf(ctx, 'sv'), '/repo')
    assert.equal(workspaceOf(ctx, 'other'), undefined)
  })

  test('absent or malformed faces degrade to undefined', () => {
    assert.equal(workspaceOf(ctxWith({}), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: {} }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: 7 } } }) } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: { sv: { cwd: '/repo' } } }) } } }), undefined), undefined)
  })

  test('hostile snapshots that throw on call or property access degrade safely', () => {
    const throwProp = (): never => { throw new Error('boom') }
    // A snapshot source whose getSnapshot throws; snapshots and rows that throw on property read.
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: throwProp } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => Object.defineProperty({}, 'byId', { get: throwProp }) } } }), 'sv'), undefined)
    assert.equal(workspaceOf(ctxWith({ sessions: { list: { getSnapshot: () => ({ byId: Object.defineProperty({}, 'sv', { get: throwProp }) }) } } }), 'sv'), undefined)
    // A service lookup itself may throw; both readers degrade instead of blanking the view.
    const ctxThrows = { get: throwProp } as unknown as ClientCtx
    assert.equal(workspaceOf(ctxThrows, 'sv'), undefined)
    assert.equal(canOpenPathsOf(ctxThrows), false)
    // A host description that throws on call or on the capability read.
    assert.equal(canOpenPathsOf(ctxWith({ connection: { hostDescription: { getSnapshot: throwProp } } })), false)
    assert.equal(canOpenPathsOf(ctxWith({ connection: { hostDescription: { getSnapshot: () => Object.defineProperty({}, 'canOpenPath', { get: throwProp }) } } })), false)
  })
})

describe('canOpenPathsOf / openPathVia', () => {
  const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx
  const connection = {
    hostDescription: { getSnapshot: () => ({ canOpenPath: true }) },
    api: { host: { openPath: () => Promise.resolve({ opened: true }) } },
  }

  test('the capability bit gates the opener', () => {
    assert.equal(canOpenPathsOf(ctxWith({ connection })), true)
    assert.equal(canOpenPathsOf(ctxWith({ connection: { hostDescription: { getSnapshot: () => ({}) } } })), false)
    assert.equal(canOpenPathsOf(ctxWith({})), false)
  })

  test('openPathVia returns a fire-and-forget caller that swallows failures', async () => {
    const rejecting = { api: { host: { openPath: () => Promise.reject(new Error('no desktop')) } } }
    const open = openPathVia(ctxWith({ connection: rejecting }))
    assert.ok(open !== undefined)
    open('/repo/a.ts') // must not throw
    assert.equal(openPathVia(ctxWith({})), undefined)
  })

  test('the opener forwards the requested path', async () => {
    const calls: string[] = []
    const open = openPathVia(ctxWith({ connection: { api: { host: { openPath: (r: { path: string }) => { calls.push(r.path); return Promise.resolve({ opened: true }) } } } } }))
    open!('/repo/a.ts')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['/repo/a.ts'])
  })
})
