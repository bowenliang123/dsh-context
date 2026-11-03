import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, makeKit, mount, query, queryAll, text, typeText, until } from '../helpers/kit'
import { projectionsFor, richTimeline } from './contextViewHarness'

const TEAM = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    { id: 'task-1', revision: 1, subject: 'schema parsing', description: 'Parse it.', status: 'pending', ownerName: 'worker-bee', blockedBy: ['task-0', 'task-missing'], writeScopes: ['src/'], ready: false, writeScopeWarnings: ['overlap warning'] },
    { id: 'task-0', revision: 1, subject: 'schema research', description: 'Research it.', status: 'completed', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
  ],
  failure: 'invalid revision',
}

function familySessions(team: unknown = TEAM) {
  const snapshot = {
    byId: {
      root: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: team } },
      w1: {
        parentId: 'root', origin: 'subagent', running: true, updatedAt: 8,
        projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' } },
      },
      w2: {
        parentId: 'root', origin: 'subagent', running: false, updatedAt: 6,
        projectionValues: { subagent: { mode: 'one-shot', label: 'side-quest' }, subagentTiming: { lastTurnCompleted: true } },
      },
    },
  }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

function stubFleetRoute(): void {
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    const { sessionId } = JSON.parse(init.body) as { sessionId: string }
    const value = sessionId === 'w1'
      ? {
        messages: [
          { seq: 2, time: 2000, kind: 'settled', from: 'root', text: 'done', summary: 'Background subagent w1 finished and will do no further work unless you send it more.', report: 'Schema report' },
          { seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'Parse the schema' },
        ],
        messagesTotal: 6,
        truncated: false,
      }
      : sessionId === 'w2'
        ? { messages: [], truncated: false, initialPrompt: 'Scan the package namespace apps/web in the TypeScript monorepo at the workspace root.' }
        : { messages: [], truncated: false }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
  })
}

function makeView(ctx: TestClientCtx, locale: 'en' | 'zh' = 'en') {
  return makeFleetView(asClientCtx(ctx), makeKit(locale), makeAgentHeads())
}

async function settleEvents(m: Awaited<ReturnType<typeof mount>>, count = 2): Promise<void> {
  await until(() => queryAll(m.container, '.lc-pulse-event').length === count, 'timeline events never landed')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

describe('Multi-Agent Network', () => {
  test('combines the spatial tree with full-fleet statistics and a natural-order lane layout', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))

    assert.ok(text(query(m.container, '.lc-pulse-header')).includes(DICT_EN['fleet.pulse.title']))
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '4')
    assert.equal(query(m.container, '[data-pulse-stat="running"]').textContent, '2')
    assert.equal(query(m.container, '[data-pulse-stat="tasks"]').textContent, '3')
    await until(() => query(m.container, '[data-pulse-stat="messages"]').textContent === '6', 'message totals never landed')
    await settleEvents(m)
    const events = queryAll<HTMLElement>(m.container, '.lc-pulse-event')
    assert.deepEqual(events.map(event => event.dataset.time).sort(), ['1000', '2000'])
    assert.equal(events.find(event => event.dataset.time === '1000')!.style.left, '36px')
    assert.equal(events.find(event => event.dataset.time === '2000')!.style.left, '68px')
    assert.ok(events.every(event => event.dataset.from === 'root' && event.dataset.to === 'w1'))
    assert.equal(queryAll(m.container, '.lc-pulse-edge-line').length, 1)
    assert.ok(events.find(event => event.dataset.time === '2000')!.getAttribute('aria-label')!.includes('runtime settlement notice'))
    assert.equal(query(m.container, '.lc-pulse-header [data-pulse-latest]').getAttribute('data-pulse-latest'), '2000')
    assert.ok(query(m.container, '[data-sequence-scroller]') !== null)
    assert.equal(query(m.container, '.lc-pulse-slot').getAttribute('cx'), '36')
    assert.equal(queryAll(m.container, '.lc-members, .lc-summary, .lc-comms-channels').length, 0)
    const main = query(m.container, '.lc-pulse-main-graph')
    assert.ok(main.children[0].classList.contains('lc-col-graph'))
    assert.ok(main.children[1].classList.contains('lc-pulse-boards'))
    assert.ok(query(main, '.lc-col-graph > .lc-agents.lc-agents-compact') !== null)
    assert.equal(queryAll(main, '.lc-pulse-boards > .lc-card').length, 2)
    assert.equal(queryAll(main, '.lc-col-graph .lc-agent-card').length, 3)
    assert.ok(query(m.container, '[data-task="task-1"]') !== null)
    assert.ok(query(m.container, '[data-task="w2"]') !== null)
    await m.unmount()
    ctx.dispose()
  })

  test('merges durable parent delegations without counting them as messages', async () => {
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const { sessionId } = JSON.parse(init.body) as { sessionId: string }
      const value = sessionId === 'catalog-root'
        ? {
          messages: [],
          delegations: [{ seq: 9, time: 500, to: 'catalog-child', mode: 'continuable', label: 'Explore the host' }],
          truncated: false,
        }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const snapshot = {
      byId: {
        'catalog-root': { displayTitle: 'Main Agent', running: false, updatedAt: 10 },
        'catalog-child': {
          parentId: 'catalog-root', origin: 'subagent', running: false, updatedAt: 8,
          projectionValues: { subagent: { mode: 'continuable', label: 'catalog-worker' } },
        },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'catalog-root', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-pulse-event').length === 1, 'delegation never landed')
    assert.equal(query(m.container, '[data-pulse-stat="messages"]').textContent, '0')
    assert.equal(query(m.container, '[data-pulse-latest]').getAttribute('data-pulse-latest'), '500')
    assert.ok(text(query(m.container, '.lc-pulse-timeline .lc-card-sub')).includes('1/1'))
    await click(query(m.container, '[data-event-key="catalog-root:9:catalog-child"]'))
    assert.ok(text(query(m.container, '.lc-pulse-delegation-detail')).includes('Explore the host'))
    await m.unmount()
    ctx.dispose()
  })

  test('modern ownerId team projections keep team tasks, their agent status, and one work item per owner', async () => {
    stubFleetRoute()
    const modernTeam = {
      enabled: true,
      tasks: [{
        id: 'task-7',
        subject: 'Modern task',
        description: 'Rendered without a roster.',
        status: 'in_progress',
        ownerId: 'w1',
        blockedBy: [],
        writeScopes: [],
        ready: false,
        writeScopeWarnings: [],
      }],
    }
    const ctx = new TestClientCtx({ services: { sessions: familySessions(modernTeam) } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const group = query(m.container, '[data-owner-group="id:w1"]')
    assert.ok(text(query(group, '.lc-pulse-work-group-head')).includes('worker-bee'))
    assert.ok(text(query(group, '.lc-pulse-work-group-head')).includes(DICT_EN['agents.running']))
    const task = query<HTMLElement>(group, '[data-task="task-7"]')
    assert.equal(text(query(task, '.lc-pulse-work-id')), '#7')
    assert.equal(text(query(task, '.lc-pulse-work-subject')), 'Modern task')
    assert.ok(text(query(task, '.lc-pulse-work-identity')).includes('worker-bee'))
    assert.equal(queryAll(m.container, '[data-task="w1"]').length, 0)
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 2)
    await click(query(group, '.lc-pulse-work-group-owner'))
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 1)
    await m.unmount()
    ctx.dispose()
  })

  test('links event participants, lanes, owners, and focused dependencies through one agent selection', async () => {
    stubFleetRoute()
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM }) }))
    await settleEvents(m)

    await click(query(m.container, '[data-event-key="w1:1:1000:relay"]'))
    assert.ok(text(query(m.container, '.lc-pulse-inspector')).includes('Parse the schema'))
    const worker = queryAll<HTMLElement>(m.container, '.lc-comms-person').find(person => text(person).includes('worker-bee'))!
    await click(query(worker, '.lc-inspector-btn'))
    const peerActions = queryAll<HTMLElement>(worker, '.lc-inspector-btn')
    await click(peerActions[1])
    await click(peerActions[2])
    assert.deepEqual(opened, ['w1', 'w1'])
    assert.equal(query(m.container, '.lc-agent-card[data-agent="w1"]').getAttribute('aria-pressed'), 'true')
    assert.equal(query(m.container, '.lc-pulse-lane-agent[data-agent="w1"]').getAttribute('aria-pressed'), 'true')
    assert.deepEqual(
      queryAll<HTMLElement>(m.container, '.lc-pulse-lane-label[data-lane-label]').map(el => el.dataset.laneLabel),
      ['root', 'w1'],
    )
    assert.ok(query(m.container, '[data-task="task-1"]').className.includes('lc-pulse-work-related'))
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 1)
    assert.equal(queryAll(m.container, '.lc-comms-event').length, 2)

    await click(query(m.container, '.lc-pulse-selection'))
    assert.equal(query(m.container, '.lc-agent-card[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(query(m.container, '.lc-pulse-lane-agent[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.deepEqual(
      queryAll<HTMLElement>(m.container, '.lc-pulse-lane-label[data-lane-label]').map(el => el.dataset.laneLabel),
      ['root', 'w1', 'w2', 'w9'],
    )
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 3)
    const subjectOf = (): string => text(query(m.container, '[data-task="w2"] .lc-pulse-work-subject'))
    await until(() => subjectOf().startsWith('Scan the package namespace apps/web'), 'delegation prompt never reached the work header')
    assert.equal(subjectOf().length, 61)
    assert.ok(subjectOf().endsWith('…'))
    assert.ok(text(query(m.container, '[data-task="w2"] .lc-pulse-work-owner')).includes('side-quest'))
    await typeText(query<HTMLInputElement>(m.container, '.lc-pulse-tasks .lc-pulse-search'), 'namespace')
    assert.deepEqual(queryAll<HTMLElement>(m.container, '.lc-pulse-work-item').map(el => el.dataset.task), ['w2'])
    await typeText(query<HTMLInputElement>(m.container, '.lc-pulse-tasks .lc-pulse-search'), '')
    await click(query(m.container, '[data-owner="w1"]'))
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 1)
    await click(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus'))
    assert.ok(text(query(m.container, '[data-task="task-1"] .lc-pulse-work-detail')).includes('Parse it.'))
    assert.ok(text(query(m.container, '[data-task="task-1"]')).includes('overlap warning'))
    assert.ok(text(query(m.container, '[data-task="task-1"]')).includes('src/'))
    assert.ok(text(query(m.container, '[data-task="task-1"]')).includes(DICT_EN['fleet.taskBlocked']))
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes('invalid revision'))
    await click(query(m.container, '[data-dependency="task-0"]'))
    assert.equal(query(m.container, '.lc-agent-card[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(query(m.container, '.lc-pulse-lane-agent[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(query(m.container, '[data-task="task-0"] .lc-pulse-work-focus').getAttribute('aria-expanded'), 'true')
    assert.ok(text(query(m.container, '[data-task="task-0"]')).includes('Research it.'))
    await click(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus'))
    await click(query(m.container, '[data-dependency="task-missing"]'))
    assert.equal(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus').getAttribute('aria-expanded'), 'true')
    await click(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus'))
    assert.equal(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus').getAttribute('aria-expanded'), 'false')
    const ownerless = { ...TEAM, tasks: TEAM.tasks.map(task => task.id === 'task-0' ? { ...task, ownerName: undefined } : task) }
    await m.update(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline(), { agentTeam: ownerless }) }))
    await click(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus'))
    await click(query(m.container, '[data-dependency="task-0"]'))
    assert.equal(query(m.container, '[data-task="task-0"] .lc-pulse-work-focus').getAttribute('aria-expanded'), 'true')
    await click(query(m.container, '.lc-agent-card[data-agent="w1"]'))
    assert.equal(query(m.container, '.lc-agent-card[data-agent="w1"]').getAttribute('aria-pressed'), 'true')
    assert.equal(query(m.container, '.lc-pulse-lane-agent[data-agent="w1"]').getAttribute('aria-pressed'), 'true')
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 1)
    await click(query(m.container, '[data-owner="w1"]'))
    assert.equal(query(m.container, '.lc-agent-card[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(query(m.container, '.lc-pulse-lane-agent[data-agent="w1"]').getAttribute('aria-pressed'), 'false')
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 3)
    await click(query(m.container, '.lc-pulse-lane-agent[data-agent="w9"]'))
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes(DICT_EN['fleet.tasks.noMatch']))
    await m.unmount()
    ctx.dispose()
  })

  test('filters both the primary timeline and the compact stream by kind and search', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await settleEvents(m)

    const reports = queryAll<HTMLElement>(m.container, '.lc-pulse-event-tools button').find(button => text(button).includes(DICT_EN['fleet.comms.kind.report']))!
    await click(reports)
    assert.equal(queryAll(m.container, '.lc-pulse-event').length, 1)
    assert.equal(queryAll(m.container, '.lc-comms-event').length, 1)
    assert.ok(text(query(m.container, '.lc-comms-event')).includes('Schema report'))
    const search = query<HTMLInputElement>(m.container, '.lc-pulse-event-tools .lc-pulse-search')
    await typeText(search, 'no matching event')
    assert.equal(queryAll(m.container, '.lc-pulse-event, .lc-comms-event').length, 0)
    assert.ok(text(query(m.container, '.lc-pulse-events')).includes(DICT_EN['fleet.comms.noMatch']))
    await typeText(search, '')
    const messages = queryAll<HTMLElement>(m.container, '.lc-pulse-event-tools button').find(button => text(button).includes(DICT_EN['fleet.comms.kind.message']))!
    await click(messages)
    await typeText(search, 'worker-bee')
    assert.equal(queryAll(m.container, '.lc-pulse-event').length, 1)
    assert.equal(queryAll(m.container, '.lc-comms-event').length, 1)
    assert.ok(text(query(m.container, '.lc-comms-event')).includes('Parse the schema'))
    await m.unmount()
    ctx.dispose()
  })

  test('scrolls the natural sequence to its earliest and latest records', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions() } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await settleEvents(m)
    const scroller = query<HTMLElement>(m.container, '[data-sequence-scroller]')
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 1000 },
    })
    const actions = queryAll<HTMLButtonElement>(m.container, '.lc-pulse-sequence-actions button')
    await click(actions[0])
    assert.equal(scroller.scrollLeft, 0)
    await click(actions[1])
    assert.equal(scroller.scrollLeft, 1000)
    await m.unmount()
    ctx.dispose()
  })

  test('folds quiet lanes without changing fleet totals and reveals search matches explicitly', async () => {
    const byId = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`q${index}`, {
      ...(index > 0 ? { parentId: 'q0', origin: 'subagent' } : {}),
      displayTitle: `Agent ${index}`,
      running: index === 1,
      updatedAt: 10 - index,
      projectionValues: index > 0 ? { subagent: { mode: 'one-shot', label: `Agent ${index}` } } : {},
    }]))
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const { sessionId } = JSON.parse(init.body) as { sessionId: string }
      const messages = sessionId === 'q2'
        ? [{ seq: 1, time: 500, kind: 'relay', from: 'q3', text: 'burst' }]
        : []
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, value: { messages, truncated: false } }),
      } as Response)
    })
    const snapshot = { byId }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'q0', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-pulse-lane-label[data-lane-label]').length === 3, 'quiet lanes never folded')
    assert.equal(queryAll(m.container, '[data-quiet-lane]').length, 1)
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '10')
    assert.ok(text(query(m.container, '.lc-pulse-quiet')).includes('7'))
    await click(query(m.container, '[data-quiet-lane] button'))
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label[data-lane-label]').length, 10)
    assert.equal(queryAll(m.container, '[data-quiet-lane]').length, 0)
    await click(query(m.container, '.lc-pulse-quiet'))
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label[data-lane-label]').length, 3)
    assert.equal(queryAll(m.container, '[data-quiet-lane]').length, 1)
    await act(async () => { query(query(m.container, '[data-quiet-lane]'), 'button').dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.ok(query<HTMLElement>(m.container, '[data-sequence-scroller]').scrollTop > 0)
    await typeText(query<HTMLInputElement>(m.container, '.lc-pulse-timeline .lc-pulse-search'), 'Agent 8')
    assert.ok(query(m.container, '[data-lane-label="q8"]') !== null)
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '10')
    await m.unmount()
    ctx.dispose()
  })

  test('loads a clipped event in full once and keeps the complete detail on reopen', async () => {
    const snapshot = {
      byId: {
        'full-root': { displayTitle: 'Main Agent', running: true, updatedAt: 10 },
        'full-w1': { parentId: 'full-root', origin: 'subagent', running: false, updatedAt: 8, projectionValues: { subagent: { mode: 'continuable', label: 'full-worker' } } },
      },
    }
    const fulls: Array<(value: unknown) => void> = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; full?: boolean }
      if (body.full === true) return new Promise(resolve => { fulls.push(resolve) })
      const value = body.sessionId === 'full-w1'
        ? { messages: [{ seq: 1, time: 1000, kind: 'relay', from: 'full-root', text: 'excerpt…', clipped: true }], truncated: true }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'full-root', useProjection: projectionsFor(richTimeline()) }))
    await settleEvents(m, 1)
    await click(query(m.container, '.lc-pulse-event'))
    assert.ok(text(query(m.container, '.lc-pulse-inspector')).includes('excerpt…'))
    assert.equal(fulls.length, 1)
    fulls[0]!({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        value: { messages: [{ seq: 1, time: 1000, kind: 'relay', from: 'full-root', text: 'the complete event body' }], truncated: false },
      }),
    })
    await until(() => text(query(m.container, '.lc-pulse-inspector')).includes('the complete event body'), 'full event never landed')
    await click(query(m.container, '.lc-comms-hit'))
    assert.ok(text(query(m.container, '.lc-pulse-inspector')).includes('the complete event body'))
    await click(query(m.container, '.lc-comms-hit'))
    assert.ok(text(query(m.container, '.lc-pulse-inspector')).includes('the complete event body'))
    assert.equal(fulls.length, 1)
    await click(query(m.container, '.lc-comms-detail-close'))
    assert.ok(text(query(m.container, '.lc-pulse-inspector')).includes('the complete event body'))
    await m.unmount()
    ctx.dispose()
  })

  test('upgrades a focused delegation to its full prompt and reply', async () => {
    const snapshot = {
      byId: {
        'task-root': { displayTitle: 'Main Agent', running: false, updatedAt: 10 },
        'task-w1': { parentId: 'task-root', origin: 'subagent', running: false, updatedAt: 8, projectionValues: { subagent: { mode: 'one-shot', label: 'task-worker' }, subagentTiming: { lastTurnCompleted: true } } },
      },
    }
    const fulls: Array<(value: unknown) => void> = []
    const opened: string[] = []
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; full?: boolean }
      if (body.full === true) return new Promise(resolve => { fulls.push(resolve) })
      const value = body.sessionId === 'task-w1'
        ? { initialPrompt: 'Inspect the…', lastReply: { time: 1000, text: 'Three of…' }, messages: [], truncated: true }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }, uiWorkspace: { openSession: (id: string) => { opened.push(id) } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'task-root', useProjection: projectionsFor(richTimeline()) }))
    await until(() => text(query(m.container, '[data-task="task-w1"]')).includes('latest turn complete'), 'delegation state never landed')
    await click(query(m.container, '[data-task="task-w1"] .lc-pulse-work-focus'))
    assert.equal(fulls.length, 1)
    assert.ok(text(query(m.container, '[data-task="task-w1"]')).includes('Inspect the…'))
    fulls[0]!({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        value: { initialPrompt: 'Inspect the complete schema.', lastReply: { time: 1000, text: 'Three of three checks passed.' }, messages: [], truncated: false },
      }),
    })
    await until(() => text(query(m.container, '[data-task="task-w1"]')).includes('Three of three checks passed.'), 'full delegation reply never landed')
    assert.ok(text(query(m.container, '[data-task="task-w1"]')).includes('Inspect the complete schema.'))
    const actions = queryAll(m.container, '[data-task="task-w1"] .lc-pulse-work-actions button')
    await click(actions[0])
    await click(actions[1])
    assert.deepEqual(opened, ['task-w1', 'task-w1'])
    await m.unmount()
    ctx.dispose()
  })

  test('treats non-team subagents as compact delegations rather than member cards', async () => {
    stubFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: familySessions(null) } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '3')
    assert.equal(query(m.container, '[data-pulse-stat="tasks"]').textContent, '2')
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 2)
    assert.ok(query(m.container, '[data-task="w1"]') !== null)
    assert.ok(query(m.container, '[data-task="w2"]') !== null)
    assert.ok(text(query(m.container, '[data-task="w2"]')).includes(DICT_EN['fleet.pulse.latestTurn']))
    assert.ok(!text(query(m.container, '[data-task="w2"]')).includes(DICT_EN['fleet.task.completed']))
    const agentItem = query<HTMLElement>(m.container, '[data-task="w2"]')
    await act(async () => { agentItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(!agentItem.className.includes('lc-pulse-work-task-hover'))
    await act(async () => { agentItem.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.equal(queryAll(m.container, '.lc-member-card').length, 0)
    await click(query(m.container, '[data-task="w2"] .lc-pulse-work-focus'))
    assert.ok(text(query(m.container, '[data-task="w2"]')).includes(DICT_EN['fleet.pulse.delegation']))
    await m.unmount()
    ctx.dispose()
  })

  test('keeps unowned team work actionable without inventing an agent owner', async () => {
    stubFleetRoute()
    const team = {
      members: TEAM.members,
      tasks: [{ id: 'free', subject: 'Claimable research', description: 'Anyone can claim this.', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }],
    }
    const ctx = new TestClientCtx({ services: { sessions: familySessions(team) } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(text(query(m.container, '.lc-pulse-work-unowned')).includes(DICT_EN['fleet.taskUnowned']))
    await click(query(m.container, '[data-task="free"] .lc-pulse-work-focus'))
    assert.ok(text(query(m.container, '[data-task="free"]')).includes('Anyone can claim this.'))
    assert.ok(text(query(m.container, '[data-task="free"]')).includes(DICT_EN['fleet.taskReady']))
    assert.equal(queryAll(m.container, '[data-task="free"] .lc-pulse-work-actions').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('an in-place session switch removes all previous traffic', async () => {
    stubFleetRoute()
    let snapshot: unknown = {
      byId: {
        root: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { agentTeam: TEAM } },
        w1: { parentId: 'root', origin: 'subagent', running: true, updatedAt: 8, projectionValues: { subagent: { mode: 'continuable', label: 'worker-bee' } } },
        w2: { parentId: 'root', origin: 'subagent', running: false, updatedAt: 6, projectionValues: { subagent: { mode: 'one-shot', label: 'side-quest' } } },
      },
    }
    const listeners = new Set<() => void>()
    const face = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await settleEvents(m)
    snapshot = { byId: { solo: { displayTitle: 'Solo', running: false, updatedAt: 1 } } }
    for (const listener of listeners) listener()
    await m.update(h(View, { sessionId: 'solo', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-pulse-event').length === 0, 'old-session traffic contaminated solo')
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '1')
    await m.unmount()
    ctx.dispose()
  })

  test('complete history backfills beyond the preview cap without any user action', async () => {
    const snapshot = {
      byId: {
        'hist-root': { displayTitle: 'Main Agent', running: false, updatedAt: 10 },
        'hist-w1': { parentId: 'hist-root', origin: 'subagent', running: false, updatedAt: 8, projectionValues: { subagent: { mode: 'continuable', label: 'history-worker' } } },
      },
    }
    const messages = Array.from({ length: 85 }, (_, index) => ({ seq: index + 1, time: 1000 + index, kind: 'relay', from: 'hist-root', text: `event ${index + 1}` }))
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; history?: boolean }
      const value = body.sessionId === 'hist-w1'
        ? { messages: body.history === true ? messages : messages.slice(0, 80), truncated: true }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'hist-root', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-pulse-event').length === 85, 'complete history never backfilled')
    assert.equal(query(m.container, '[data-pulse-stat="messages"]').textContent, '85')
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    const sequence = query<HTMLElement>(m.container, '[data-sequence-scroller]')
    Object.defineProperty(sequence, 'clientWidth', { configurable: true, value: 256 })
    sequence.scrollLeft = 640
    await act(async () => { sequence.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll(m.container, '.lc-pulse-event').length < 85, 'sequence window never bounded the DOM')
    assert.ok(query(m.container, '.lc-pulse-track-stack').style.width.includes('2760px'))
    const list = query(m.container, '.lc-pulse-event-list')
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 256 })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    list.scrollTop = 640
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll(m.container, '.lc-comms-event').length < 85, 'event window never bounded the DOM')
    await click(query(m.container, '.lc-pulse-event-list .lc-comms-hit'))
    assert.ok(query(m.container, '.lc-pulse-inspector .lc-comms-detail') !== null)
    assert.ok(queryAll(m.container, '.lc-comms-event').length < 85)
    assert.ok(queryAll(m.container, '.lc-pulse-event').length < 85)
    assert.ok(sequence.scrollLeft > 0)
    assert.equal(query(m.container, '[data-pulse-stat="messages"]').textContent, '85')
    await m.unmount()
    ctx.dispose()
  })

  test('preview details remain visible when complete-history reads fail', async () => {
    const snapshot = {
      byId: {
        'preview-root': { displayTitle: 'Main Agent', running: false, updatedAt: 10 },
        'preview-w1': { parentId: 'preview-root', origin: 'subagent', running: false, updatedAt: 8, projectionValues: { subagent: { mode: 'continuable', label: 'preview-worker' } } },
      },
    }
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { sessionId: string; history?: boolean }
      const value = body.history === true ? null : body.sessionId === 'preview-w1'
        ? { messages: [{ seq: 1, time: 1000, kind: 'relay', from: 'preview-root', text: 'preview event' }], truncated: false }
        : { messages: [], truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'preview-root', useProjection: projectionsFor(richTimeline()) }))
    await until(() => queryAll(m.container, '.lc-pulse-event').length === 1, 'preview fallback never landed')
    assert.ok(text(m.container).includes('preview event'))
    await m.unmount()
    ctx.dispose()
  })

  test('failed detail reads leave team work standing and settle to an empty stream', async () => {
    const team = {
      members: [
        { id: 'cold-root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'cold-w1', name: 'cold-worker', role: 'teammate', phase: 'active' },
      ],
      tasks: [],
    }
    const snapshot = {
      byId: {
        'cold-root': { displayTitle: 'Cold Lead', running: false, updatedAt: 3, projectionValues: { agentTeam: team } },
        'cold-w1': { parentId: 'cold-root', origin: 'subagent', running: false, updatedAt: 2, projectionValues: { subagent: { mode: 'one-shot', label: 'cold-worker' } } },
      },
    }
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 } as Response))
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'cold-root', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(text(m.container).includes('cold-worker'))
    await until(() => text(query(m.container, '.lc-pulse-events')).includes(DICT_EN['fleet.comms.empty']), 'failed reads never settled')
    await m.unmount()
    ctx.dispose()
  })

  test('serves a direct team projection without a family forest and localizes the mission header', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const ctx = new TestClientCtx({ services: {} })
    const View = makeView(ctx, 'zh')
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline(), { agentTeam: TEAM }) }))
    assert.ok(text(query(m.container, '.lc-pulse-header')).includes(DICT_ZH['fleet.pulse.title']))
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '3')
    assert.equal(query(m.container, '[data-pulse-stat="tasks"]').textContent, '2')
    assert.equal(queryAll(m.container, '.lc-pulse-work-item').length, 2)
    assert.equal(queryAll(m.container, '.lc-pulse-event').length, 2)
    assert.equal(query(m.container, '[data-pulse-stat="running"]').textContent, '—')
    assert.ok(text(query(m.container, '[data-owner-group="id:w1"] .lc-pulse-work-group-head')).includes(DICT_ZH['fleet.pulse.statusUnknown']))
    assert.ok(text(query(m.container, '[data-task="task-1"] .lc-pulse-work-identity')).includes(DICT_ZH['fleet.pulse.statusUnknown']))
    await click(query(m.container, '[data-task="task-1"] .lc-pulse-work-focus'))
    assert.ok(text(query(m.container, '[data-task="task-1"] .lc-pulse-work-detail')).includes(DICT_ZH['fleet.pulse.statusUnknown']))
    await m.unmount()
    ctx.dispose()
  })

  test('opens the agent session from the lane jump button', async () => {
    stubFleetRoute()
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sessions: familySessions(), uiWorkspace: { openSession: (id: string) => { opened.push(id) } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    const lane = query(m.container, '[data-lane-label="w2"]')
    assert.equal(queryAll(lane, 'button').length, 2)
    await click(query(lane, '[aria-label="Open session"]'))
    assert.deepEqual(opened, ['w2'])
    await m.unmount()
    ctx.dispose()

    const sidebar: Array<{ address: string; options: unknown }> = []
    const sidebarCtx = new TestClientCtx({
      services: {
        sessions: familySessions(),
        sidebarRight: { openResource: (address: string, options?: unknown) => { sidebar.push({ address, options }) } },
      },
    })
    const SidebarView = makeView(sidebarCtx)
    const sidebarMount = await mount(h(SidebarView, { sessionId: 'root', useProjection: projectionsFor(richTimeline()) }))
    await click(query(query(sidebarMount.container, '[data-task="w2"]'), '.lc-pulse-work-focus'))
    await click(queryAll(sidebarMount.container, '[data-task="w2"] .lc-pulse-work-actions button')[0]!)
    assert.deepEqual(sidebar, [{
      address: 'dsh-resource://subagentchat/session/w2?parent=root&mode=one-shot',
      options: { kind: 'subagentchat', preferNewPane: true },
    }])
    await sidebarMount.unmount()
    sidebarCtx.dispose()
  })
})
