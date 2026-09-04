// Projection narrowing (src/client/services.ts): the no-white-screen wire
// guards — numOf, timelineOf fast/slow paths, contextPressureOf,
// contextBreakdownOf, tokenUsageOf, timingOf, headersOf — plus the seat
// helpers over the harness service faces (conversationNodesOf, imageLoaderOf).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  canOpenPathsOf,
  contextBreakdownOf,
  contextPressureOf,
  conversationNodesOf,
  headersOf,
  imageLoaderOf,
  numOf,
  openPathVia,
  timelineOf,
  timingOf,
  tokenUsageOf,
  workspaceOf,
} from '../../src/client/services'
import type { ClientCtx, ConversationNodeLike } from '../../src/client/services'
import type { TimingTotals } from '../../src/shared/types'

/** The chat-view snapshot face: the selector sees the whole snapshot. */
const useChatOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T) => sel(snapshot))

describe('conversationNodesOf — the chat-seat window join', () => {
  const nodes: ConversationNodeLike[] = [{ kind: 'user', seq: 1 }, { kind: 'assistant', seq: 2 }]

  test('serves the chat seat (ChatSnapshot.legacy.nodes)', () => {
    const out = conversationNodesOf({ useChat: useChatOf({ legacy: { nodes } }) })
    assert.equal(out, nodes)
  })

  test('absent seats, non-array payloads, and hostile seats degrade to undefined', () => {
    assert.equal(conversationNodesOf({}), undefined)
    assert.equal(conversationNodesOf({ useChat: useChatOf({}) }), undefined, 'chat snapshot without legacy')
    assert.equal(conversationNodesOf({ useChat: useChatOf(null) }), undefined, 'null snapshot')
    assert.equal(conversationNodesOf({ useChat: () => { throw new Error('boom') } }), undefined, 'hostile seat')
  })
})

describe('imageLoaderOf — the uiConversation loader', () => {
  const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx
  const attachment = { attachmentId: 'a1' }

  test('uses the uiConversation.imageUrl face', async () => {
    const calls: string[] = []
    const load = imageLoaderOf(ctxWith({ uiConversation: { imageUrl: (sid: string, att: { attachmentId: string }) => {
      calls.push(sid + ':' + att.attachmentId)
      return Promise.resolve('blob:modern')
    } } }), 'sv')
    assert.equal(await load!(attachment), 'blob:modern')
    assert.deepEqual(calls, ['sv:a1'])
  })

  test('absent faces, bad session ids, and hostile service reads degrade to undefined', () => {
    assert.equal(imageLoaderOf(ctxWith({}), 'sv'), undefined)
    assert.equal(imageLoaderOf(ctxWith({ uiConversation: {} }), 'sv'), undefined)
    assert.equal(imageLoaderOf(ctxWith({}), undefined), undefined)
    assert.equal(imageLoaderOf(ctxWith({}), ''), undefined)
    const ctxThrows = { get: (): never => { throw new Error('service absent') } } as unknown as ClientCtx
    assert.equal(imageLoaderOf(ctxThrows, 'sv'), undefined)
  })
})

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

describe('timingOf', () => {
  const wellFormed = {
    wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9,
    tools: { bash: { calls: 5, ms: 20_000 }, read: { calls: 4, ms: 10_000 } },
  }

  test('non-records stay null', () => {
    assert.equal(timingOf(null), null)
    assert.equal(timingOf(undefined), null)
    assert.equal(timingOf('x'), null)
    assert.equal(timingOf(5), null)
  })

  test('a well-formed value round-trips every scalar and row', () => {
    assert.deepEqual(timingOf(wellFormed), wellFormed)
  })

  test('wrong-typed or negative scalars zero out', () => {
    const out = timingOf({ wallMs: -1, ttftMs: 'x', genMs: NaN, calls: Infinity, toolsMs: Infinity, toolCalls: 3 })
    assert.deepEqual(out, { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 3, tools: {} })
  })

  test('rows failing the shape drop individually; the ranking survives', () => {
    const out = timingOf({
      wallMs: 10, tools: {
        good: { calls: 1, ms: 5 },
        noCalls: { ms: 5 },
        negMs: { calls: 1, ms: -5 },
        nullRow: null,
        numRow: 7,
      },
    })
    assert.deepEqual(out?.tools, { good: { calls: 1, ms: 5 } })
  })

  test('a non-record tools map degrades to an empty ranking', () => {
    for (const tools of [null, 'x', 5, [ { calls: 1, ms: 1 } ]]) {
      const out = timingOf({ wallMs: 1, tools })
      assert.deepEqual(out?.tools, {})
    }
  })

  test('a hostile __proto__ row is skipped, not assigned as the prototype', () => {
    const out = timingOf({ wallMs: 1, tools: JSON.parse('{"__proto__": {"calls": 1, "ms": 5}}') })
    assert.deepEqual(out?.tools, {})
    assert.equal(Object.getPrototypeOf(out?.tools ?? {}), Object.prototype)
  })
})

describe('timelineOf — timing integration', () => {
  const current = { system: 1, tools: 2, user: 3, inject: 4, assistant: 5, tool: 6, total: 7 }
  const base = { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }
  const timing: TimingTotals = { wallMs: 60_000, ttftMs: 8_000, genMs: 12_000, calls: 4, toolsMs: 30_000, toolCalls: 9, tools: { bash: { calls: 5, ms: 20_000 } } }

  test('a well-formed timing passes through by reference (fast path)', () => {
    const wire = { ...base, timing }
    assert.equal(timelineOf(wire), wire)
  })

  test('a malformed timing takes the sanitizing slow path', () => {
    const wire = { ...base, timing: { ...timing, tools: { bash: { calls: 'nope' } } } }
    const out = timelineOf(wire)
    assert.ok(out !== (wire as unknown))
    assert.deepEqual(out?.timing, { ...timing, tools: {} })
  })

  test('a non-record timing is omitted entirely (no null-valued key)', () => {
    const out = timelineOf({ ...base, timing: 'corrupt' })
    assert.ok(out !== null)
    assert.ok(!('timing' in out))
  })

  test('every timingFastOk rejection arm routes down the sanitizing slow path', () => {
    const sanitized = (timingValue: unknown): TimingTotals => {
      const out = timelineOf({ ...base, timing: timingValue })
      assert.ok(out !== null)
      return out.timing as TimingTotals
    }
    // A non-number scalar zeroes out.
    assert.deepEqual(sanitized({ ...timing, wallMs: 'x' }), { ...timing, wallMs: 0 })
    // A non-record tools map (null / array / scalar) degrades to an empty ranking.
    for (const tools of [null, [{ calls: 1, ms: 1 }], 5]) {
      assert.deepEqual(sanitized({ ...timing, tools }), { ...timing, tools: {} })
    }
    // A row failing the shape (null / scalar / non-number fields) drops alone.
    assert.deepEqual(sanitized({ ...timing, tools: { bash: null } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: 5 } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 'x', ms: 1 } } }), { ...timing, tools: {} })
    assert.deepEqual(sanitized({ ...timing, tools: { bash: { calls: 1, ms: 'x' } } }), { ...timing, tools: {} })
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

  test('an entry with a defined non-numeric systemTokens degrades the whole value to null', () => {
    assert.equal(headersOf({ headers: [{ tools: [], systemTokens: 'x' }] }), null)
    assert.equal(headersOf({ headers: [{ tools: [], systemTokens: Number.NaN }] }), null)
  })

  test('a valid value passes through by reference', () => {
    const value = {
      headers: [
        { seq: 1, time: 1000, tools: [], systemTokens: 12 },
        { seq: 2, time: 2000, tools: [{ name: 'bash', tokens: 10 }] },
      ],
    }
    assert.equal(headersOf(value), value)
  })

  test('a legacy content-bearing epoch (pre-#37 wire) normalizes to the metadata shape', () => {
    // 16 chars → ceil(16/4) + 4 = 8, the harness meter's own heuristic.
    const legacy = { headers: [{ seq: 12, time: 1000, system: 'x'.repeat(16), tools: [{ name: 'bash', tokens: 815 }] }] }
    const out = headersOf(legacy)
    assert.equal(out?.headers[0]?.systemTokens, 8)
    // The content fields ride along untouched — the browser never reads them
    // from the delivered value (content fetches per epoch on demand).
    assert.equal((out?.headers[0] as { system?: string }).system, 'x'.repeat(16))
  })

  test('mixed generations price only the unpriced legacy entries', () => {
    const value = {
      headers: [
        { seq: 1, time: 1000, system: 'prompt', tools: [] },
        { seq: 2, time: 2000, system: 'kept', systemTokens: 55, tools: [] },
        { seq: 3, time: 3000, tools: [] },
      ],
    }
    const out = headersOf(value)
    assert.equal(out?.headers[0]?.systemTokens, Math.ceil(6 / 4) + 4)
    assert.equal(out?.headers[1]?.systemTokens, 55)
    assert.equal(out?.headers[2]?.systemTokens, undefined)
  })

  test('a legacy entry whose system is not a non-empty string stays unpriced', () => {
    const out = headersOf({ headers: [{ seq: 1, time: 1, system: '', tools: [] }, { seq: 2, time: 2, system: 7, tools: [] }] })
    assert.equal(out?.headers[0]?.systemTokens, undefined)
    assert.equal(out?.headers[1]?.systemTokens, undefined)
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
