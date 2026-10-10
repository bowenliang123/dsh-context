// FleetView — the Fleet tab root: the agent network card on a page of its own, split out of the Context tab.
// It reads the same `contextTimeline` head and the same detail source the Context tab does, so every figure it
// paints must match the card's sidebar mount.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { projectionsFor, richTimeline, timeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

/** The outward sessions face: one row, the current session, no subagent. The snapshot object stays identical
 * across reads — the card subscribes through useSyncExternalStore, which loops on a fresh snapshot per read. */
function selfOnly(id: string) {
  const snapshot = { byId: { [id]: { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

function makeView(ctx: TestClientCtx) {
  return makeFleetView(asClientCtx(ctx), kit, makeAgentHeads())
}

const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }

describe('FleetView — the agent family on its own page', () => {
  test("the card renders off the tab's own projections, footer note included", async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    assert.ok(text(query(m.container, '.lc-agents')).includes('Agent Network'))
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.ok(text(self).includes('Main Agent'))
    // richTimeline carries three steps; the duration is the whole-session timing total.
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    assert.ok(text(query(m.container, '.lc-foot')).startsWith(DICT_EN['footer'].slice(0, 24)))
    await m.unmount()
    ctx.dispose()
  })

  test('the slim head composes the card before the detail collections land', async () => {
    // The read stays in flight for the whole test: the head's own counters must carry the card.
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-slim') } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-slim',
      useProjection: projectionsFor(timeline({
        contextWindow: 128000,
        counts: { turns: 1, steps: 3, injects: 0, compactions: 0, prunes: 0 },
        last: { seq: 6, total: 420, prompt: 410 },
        detailRev: 6,
      })),
    }))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '3 steps', 'the head counts the steps itself')
    assert.ok(!text(m.container).includes(DICT_EN['detail.loading']), 'no waiting state once the head is served')
    await m.unmount()
    ctx.dispose()
  })

  test('a cold session names its retryable read instead of spinning', async () => {
    let reads = 0
    vi.stubGlobal('fetch', () => {
      reads += 1
      return Promise.resolve({ ok: false, status: 503 } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-cold') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-cold', useProjection: () => undefined }))

    assert.equal(query(m.container, '.lc-empty').textContent, DICT_EN['loading'], 'first paint names the read')
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    // The note's retry refires the read; it keeps failing, so the note stands rather than the page going blank.
    const before = reads
    await click(query(m.container, '.lc-br-retry'))
    await until(() => reads > before, 'the retry never refired the read')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await m.unmount()
    ctx.dispose()
  })

  test('the baseline gate rides the Fleet tab too', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-gate') } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-gate',
      useProjection: projectionsFor(timeline({ unsupported: { current: '0.1.0', minimum: '0.2.0' } })),
    }))

    assert.ok(query(m.container, '.lc-gate-card') !== null, 'the gate names the unsupported harness here as well')
    await m.unmount()
    ctx.dispose()
  })

  test('without a session id the page still paints and the card stays hidden', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-none') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))

    assert.equal(queryAll(m.container, '.lc-agents').length, 0)
    assert.ok(text(query(m.container, '.lc-foot')).startsWith(DICT_EN['footer'].slice(0, 24)))
    await m.unmount()
    ctx.dispose()
  })
})
