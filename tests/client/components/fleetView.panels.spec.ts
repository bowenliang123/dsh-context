// FleetView integration — the four panels over one family: the team projection (list-row and
// direct seats), pin/hover steering between the list and the inspector, and the comms scan off
// the stubbed fleet route.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_ZH } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, hover, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { projectionsFor, richTimeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

const TEAM_PROJECTION = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    // A member whose session left the list: label resolution falls back to the roster name.
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/'], ready: false, writeScopeWarnings: [] },
  ],
}

/** A stable-snapshot sessions face (useSyncExternalStore loops on a fresh object per read). */
function familySessions() {
  const snapshot = {
    byId: {
      root: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: TEAM_PROJECTION } },
      w1: {
        parentId: 'root', origin: 'subagent', running: true, updatedAt: 8,
        projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' }, subagentTiming: { settledMs: 42000 } },
      },
    },
  }
  return {
    list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} },
  }
}

/** The fleet route stub: a delegation prompt + descriptor per session, and one relay into w1. */
function stubFleetRoute(): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const { sessionId } = JSON.parse(init.body) as { sessionId: string }
    const value = sessionId === 'w1'
      ? {
        descriptor: { mode: 'continuable', label: 'worker-bee', provider: 'spawn', agentModel: 'deepseek-v4' },
        initialPrompt: 'Review the schema parser.',
        messages: [
          { seq: 9, time: 1_700_000_000_000, kind: 'relay', from: 'root', text: 'how far along?' },
          { seq: 8, time: 1_699_999_000_000, kind: 'relay', from: 'w9', text: 'ghost says hi' },
          { seq: 7, time: 1_699_998_000_000, kind: 'relay', from: 'stranger', text: 'who dis' },
          { seq: 6, time: 1_699_997_000_000, kind: 'relay', from: 'root', text: 'second from lead' },
          // A self-addressed row (a member noting to itself) joins the recipient list once.
          { seq: 5, time: 1_699_996_000_000, kind: 'relay', from: 'w1', text: 'note to self' },
          // An unattested sender (an old log shape) still lists under the recipient.
          { seq: 4, time: 1_699_995_000_000, kind: 'mailbox', text: 'anonymous delivery' },
        ],
        truncated: false,
      }
      : { messages: [], truncated: false }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
  })
}

function makeView(ctx: TestClientCtx, useKit = kit) {
  return makeFleetView(asClientCtx(ctx), useKit, makeAgentHeads())
}

describe('FleetView — the four panels over one family', () => {
  test('the roster row open button jumps to the session', async () => {
    stubFleetRoute()
    const opened = new Array<string>()
    const ctx = new TestClientCtx({
      services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await click(query(queryAll(m.container, '.lc-fleet-row')[1], '.lc-fleet-row-open'))
    assert.deepEqual([...opened], ['w1'])
    await m.unmount()
    ctx.dispose()
  })


  test('team chip, team panel, roster list, and comms panel all render off the one derivation', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    // The network card header carries the team chip.
    assert.ok(text(query(m.container, '.lc-agents')).includes('team · 3 members · 1 tasks'))
    // The team panel: roster + task board.
    const teamCard = query(m.container, '.lc-members')
    assert.ok(text(teamCard).includes('worker-bee'))
    assert.ok(text(query(m.container, '.lc-tasks')).includes('schema parsing'))
    // The roster list.
    assert.deepEqual(queryAll(m.container, '.lc-fleet-row').length, 2)
    // The comms panel opens collapsed.
    assert.ok(text(query(m.container, '.lc-comms')).includes('Scan 2 sessions'))

    // The inspector follows the current session and lands its fleet detail.
    await until(() => text(query(m.container, '.lc-inspector')).includes('Main Agent'), 'inspector never followed')
    await m.unmount()
    ctx.dispose()
  })

  test('hovering a list row steers the inspector; pinning sticks and rings the graph card', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    const row = queryAll(m.container, '.lc-fleet-row')[1]
    await hover(row)
    assert.ok(text(query(m.container, '.lc-inspector')).includes('worker-bee'))
    await click(row)
    // The pin survives the hover leaving, and the graph card rings.
    await hover(queryAll(m.container, '.lc-fleet-row')[0])
    const inspector = query(m.container, '.lc-inspector')
    assert.ok(text(inspector).includes('worker-bee'))
    assert.ok(inspector.hasAttribute('data-pinned'))
    assert.ok(query(m.container, '[data-agent="w1"]').className.includes('lc-agent-pinned'))

    // The landed detail fills the prompt and descriptor sections.
    await until(() => text(query(m.container, '.lc-inspector')).includes('Review the schema parser.'), 'prompt never landed')
    assert.ok(text(query(m.container, '.lc-inspector')).includes('spawn · deepseek-v4'))
    // Team membership section with the owned task.
    assert.ok(text(query(m.container, '.lc-inspector')).includes('schema parsing'))

    // Unpin returns the inspector to the hover/current follow.
    await click(query(m.container, '.lc-inspector-btn'))
    assert.ok(!query(m.container, '.lc-inspector').hasAttribute('data-pinned'))
    await m.unmount()
    ctx.dispose()
  })

  test('the comms scan merges the family logs into one timeline', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    await click(query(m.container, '.lc-comms-scan'))
    await until(() => queryAll(m.container, '.lc-comms-row').length === 6, 'the relays never surfaced')
    const rows = queryAll(m.container, '.lc-comms-row')
    assert.ok(text(rows[0]).includes('Main Agent'))
    assert.ok(text(rows[0]).includes('worker-bee'))
    assert.ok(text(rows[0]).includes('how far along?'))
    // Label resolution: a member outside the forest names itself off the roster, a stranger its raw id.
    assert.ok(text(rows[1]).includes('ghost-nine'))
    assert.ok(text(rows[2]).includes('stranger'))

    // A comms peer click pins the sender into the inspector.
    await click(queryAll(rows[0], '.lc-comms-peer')[0])
    const inspector = query(m.container, '.lc-inspector')
    assert.ok(text(inspector).includes('Main Agent'))
    assert.ok(inspector.hasAttribute('data-pinned'))

    // Pinning a sender outside the family releases immediately instead of haunting the inspector.
    await click(queryAll(rows[1], '.lc-comms-peer')[0])
    await until(() => !query(m.container, '.lc-inspector').hasAttribute('data-pinned'), 'the ghost pin never released')
    await m.unmount()
    ctx.dispose()
  })

  test('the direct projection seat serves the team when the viewed session leads it', async () => {
    stubFleetRoute()
    // Rows carry no agentTeam value; the tab's own projection does.
    const snapshot = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        w1: { parentId: 'root', origin: 'subagent', running: false, updatedAt: 8 },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'root',
      useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM_PROJECTION }),
    }))
    assert.ok(query(m.container, '.lc-members') !== null)
    assert.ok(query(m.container, '.lc-tasks') !== null)
    // The lead badge lands on the roster row too.
    assert.ok(text(query(m.container, '.lc-fleet-row-self')).includes('lead'))
    await m.unmount()
    ctx.dispose()
  })

  test('a solo session keeps the graph alone — no list, comms, or team panels', async () => {
    stubFleetRoute()
    const snapshot = { byId: { only: { displayTitle: 'Solo', running: false, updatedAt: 1 } } }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'only', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(query(m.container, '.lc-agents') !== null)
    assert.equal(queryAll(m.container, '.lc-fleet-list').length, 0)
    assert.equal(queryAll(m.container, '.lc-comms').length, 0)
    assert.equal(queryAll(m.container, '.lc-members').length, 0)
    assert.equal(queryAll(m.container, '.lc-tasks').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('zh locale renders the panel chrome in Chinese', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ locale: 'zh', services: { sessions: familySessions() } })
    const View = makeFleetView(asClientCtx(ctx), makeKit('zh'), makeAgentHeads())
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.members.title']))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.list.title']))
    assert.ok(text(m.container).includes(DICT_ZH['fleet.comms.title']))
    await m.unmount()
    ctx.dispose()
  })
})
