import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { boot, call, dayOf, projectsOf, recordOf, summaryOf, timelineOf } from './helpers/overview'

describe('dsh-context overview projects', () => {

  test('projects sum admitted tokens by workspace and reconcile with the scoped summary', async () => {
    const records: unknown[] = []
    const values: Record<string, Record<string, unknown>> = {}
    for (let index = 0; index < 30; index++) {
      const id = `s${String(index).padStart(2, '0')}`
      records.push(recordOf(id))
      values[id] = {
        contextTimeline: timelineOf(),
        contextActivity: { days: { '2026-11-01': dayOf(index + 1, 1) } },
      }
    }
    const workspace = {
      list: () => [
        { id: 'w1', title: 'Beta', sessionIds: ['s00', 's01', 's02'] },
        { id: 'w2', title: 'Alpha', sessionIds: ['s03', 's04'] },
      ],
      archivedSessionIds: ['s29'],
    }
    const harness = await boot({ records, values, workspace })
    const projects = projectsOf(await call(harness, { part: 'projects' }))
    assert.deepEqual(projects, [
      { key: '__ungrouped__', tokens: 450, sessions: 25 },
      { key: 'Alpha', tokens: 9, sessions: 2 },
      { key: 'Beta', tokens: 6, sessions: 3 },
    ])
    const summary = summaryOf(await call(harness, { part: 'summary' }))
    assert.equal(projects.reduce((sum, project) => sum + project.tokens, 0), summary.tokens, 'project tokens reconcile with the scoped summary')
    assert.equal(summary.tokens, 465)
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects', scope: { coverage: 'archived' } })), [
      { key: '__ungrouped__', tokens: 30, sessions: 1 },
    ])
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects', scope: { day: '2026-11-01' } })), projects)
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects', scope: { day: '2026-10-01' } })), [])
  })

  test('projects fold subagent tokens into the parent workspace and count every scoped session', async () => {
    const harness = await boot({
      records: [
        recordOf('p'),
        recordOf('q'),
        recordOf('c', { origin: 'subagent', parentSession: 'p' }),
        recordOf('z'),
        recordOf('u'),
        recordOf('n'),
      ],
      values: {
        p: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-11-01': dayOf(10, 1) } },
        },
        q: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-11-01': dayOf(0, 1) } },
        },
        c: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-11-01': dayOf(20, 1) } },
        },
        z: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-11-01': dayOf(0, 1) } },
        },
        u: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-11-01': dayOf(5, 1) } },
        },
        n: {
          contextTimeline: timelineOf(),
        },
      },
      workspace: {
        list: () => [
          { id: 'w1', title: 'Team', sessionIds: ['p', 'q'] },
          { id: 'w2', title: 'Empty', sessionIds: ['z'] },
          { id: 'w3', title: 'NoActivity', sessionIds: ['n'] },
        ],
        archivedSessionIds: [],
      },
    })
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects' })), [
      { key: 'Team', tokens: 30, sessions: 2 },
      { key: '__ungrouped__', tokens: 5, sessions: 1 },
    ])
  })

  test('project totals admit only the days inside the selected range', async () => {
    const harness = await boot({
      records: [recordOf('a')],
      values: {
        a: {
          contextTimeline: timelineOf(),
          contextActivity: { days: { '2026-10-01': dayOf(3, 1), '2026-11-01': dayOf(7, 1) } },
        },
      },
      workspace: {
        list: () => [{ id: 'w1', title: 'Team', sessionIds: ['a'] }],
        archivedSessionIds: [],
      },
    })
    const range = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 1, 23, 59) }
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects', scope: { range } })), [
      { key: 'Team', tokens: 7, sessions: 1 },
    ])
  })

  test('equal project totals sort by workspace key', async () => {
    const harness = await boot({
      records: [recordOf('right'), recordOf('left')],
      values: {
        left: { contextTimeline: timelineOf(), contextActivity: { days: { '2026-11-01': dayOf(7, 1) } } },
        right: { contextTimeline: timelineOf(), contextActivity: { days: { '2026-11-01': dayOf(7, 1) } } },
      },
      workspace: {
        list: () => [
          { id: 'w1', title: 'Two', sessionIds: ['right'] },
          { id: 'w2', title: 'One', sessionIds: ['left'] },
        ],
        archivedSessionIds: [],
      },
    })
    assert.deepEqual(projectsOf(await call(harness, { part: 'projects' })).map(project => project.key), ['One', 'Two'])
  })
})
