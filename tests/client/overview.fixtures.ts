import { vi } from 'vitest'
import { rangeWindowOf, type OverviewRange, type TallyStat } from '../../src/client/overview'
import { UNGROUPED_KEY } from '../../src/client/overviewModel'
import type { ContextActivity, OverviewCoverage, OverviewPick, OverviewScope, OverviewSort, OverviewTallyField } from '../../src/shared/types'
import { dayKeyOf } from '../../src/shared/days'

export const win = (range: OverviewRange, now: number) => rangeWindowOf(range, now)

export function statOf(name: string, n: number, last: number, sessions = 1): TallyStat {
  return { name, n, sessions, last }
}

export const NOW = Date.now()
export const TODAY = dayKeyOf(NOW) ?? ''
export const YESTERDAY = dayKeyOf(NOW - 86_400_000) ?? ''
export const MIDNIGHT = new Date(new Date(NOW).setHours(0, 0, 0, 0)).getTime()

export const COMPLETE_COVERAGE = { complete: true, running: false, remaining: 0, failed: 0, total: 3, covered: 3, unsupported: 0 }

export interface ServerRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running?: boolean
  archived?: boolean
  group?: string
  tokens: number
  turns: number
  steps?: number
  parts: { key: string; value: number }[]
  total: number
  contextWindow?: number
  costUsd?: number | null
  createdDay?: string
  lastUser?: string
  activeDays: string[]
  tallies?: Partial<Record<OverviewTallyField, string[]>>
}

export interface ServerTallies {
  skills: TallyStat[]
  tools: TallyStat[]
  cmds: TallyStat[]
}

export function panelRows(): ServerRow[] {
  return [
    {
      id: 'a',
      title: 'alpha session',
      cwd: '/repo/alpha',
      updatedAt: MIDNIGHT,
      running: true,
      group: 'workspace-one',
      tokens: 1800,
      turns: 3,
      steps: 5,
      parts: [
        { key: 'system', value: 100 },
        { key: 'tools', value: 50 },
        { key: 'user', value: 30 },
        { key: 'inject', value: 10 },
        { key: 'skill', value: 10 },
        { key: 'assistant', value: 200 },
        { key: 'tool', value: 100 },
      ],
      total: 500,
      contextWindow: 1000,
      costUsd: 0.72,
      createdDay: '2026-09-10',
      lastUser: 'fix the flaky spec',
      activeDays: [TODAY, YESTERDAY],
      tallies: { skills: ['tdd'], tools: ['read', 'bash'], cmds: ['git'] },
    },
    {
      id: 'b',
      title: 'beta session',
      cwd: '/repo/beta',
      updatedAt: NOW - 10 * 86_400_000,
      tokens: 25,
      turns: 1,
      parts: [{ key: 'user', value: 10 }],
      total: 10,
      costUsd: null,
      activeDays: [YESTERDAY],
      tallies: { tools: ['grep'], cmds: ['node'] },
    },
    {
      id: 'c',
      title: 'gamma session',
      updatedAt: NOW - 40 * 86_400_000,
      tokens: 0,
      turns: 0,
      parts: [],
      total: 0,
      activeDays: [],
    },
  ]
}

export function panelRowsWithArchivedBeta(): ServerRow[] {
  return panelRows().map(row => (row.id === 'b' ? { ...row, archived: true } : row))
}

export function panelTallies(): ServerTallies {
  return {
    skills: [],
    tools: [statOf('read', 5, NOW - 1000, 2), statOf('grep', 4, NOW - 6000, 2), statOf('bash', 1, NOW - 2000)],
    cmds: [statOf('git', 2, NOW - 1500), statOf('pnpm', 1, NOW - 5000), statOf('node', 1, NOW - 7000)],
  }
}

export function panelTalliesZero(): ServerTallies {
  return { skills: [], tools: [], cmds: [] }
}

export function panelSessionsSnapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ids: ['a', 'b'],
    byId: { a: { cwd: '/repo/alpha' }, b: { cwd: '/repo/beta' } },
    ...over,
  }
}

export function pinCurrentSession(id: string | null): void {
  if (id === null) localStorage.removeItem('dsh.sessions.current')
  else localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
}

export const useHookOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T): T => sel(snapshot))

export function panelSummaryRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessions: 2,
    sessionsTotal: 3,
    sessionsArchived: 1,
    archivedScoped: 0,
    tokens: 1800,
    turns: 5,
    costUsd: 1.5,
    costSessions: 1,
    usageSessions: 1,
    cacheHit: '33.33',
    tokenParts: [
      { key: 'system', value: 500 },
      { key: 'tools', value: 300 },
      { key: 'assistant', value: 600 },
      { key: 'mystery', value: 400 },
      { key: 'zero', value: 0 },
    ],
    timing: { wallMs: 180_000, ttftMs: 2_000, genMs: 60_000, calls: 8, toolsMs: 40_000, toolBusyMs: 30_000, toolCalls: 14, tools: {} },
    windowTiming: { calls: 8, toolCalls: 14, toolsMs: 40_000, wallMs: 180_000 },
    coverage: COMPLETE_COVERAGE,
    ...over,
  }
}

export function scopeOf(body: Record<string, unknown>): OverviewScope {
  const scope = body.scope
  return scope !== null && typeof scope === 'object' ? scope as OverviewScope : {}
}

function dayInWindow(key: string, window: { start?: number | null; end?: number | null }): boolean {
  const floor = window.start === null || window.start === undefined ? null : dayKeyOf(window.start)
  const ceiling = window.end === null || window.end === undefined ? null : dayKeyOf(window.end)
  return (floor === null || key >= floor) && (ceiling === null || key <= ceiling)
}

function inRangeOf(row: ServerRow, range: OverviewScope['range']): boolean {
  const effective = range ?? '30d'
  const window = typeof effective === 'object'
    ? effective
    : effective === 'today'
      ? { start: MIDNIGHT, end: null }
      : { start: NOW - (effective === '7d' ? 7 : 30) * 86_400_000, end: null }
  if (row.updatedAt >= (window.start ?? 0) && (window.end === null || row.updatedAt <= window.end)) return true
  return row.activeDays.some(key => dayInWindow(key, window))
}

function coveredOf(row: ServerRow, coverage: OverviewCoverage): boolean {
  return coverage === 'all' || (row.archived === true) === (coverage === 'archived')
}

function matchesFilters(row: ServerRow, scope: OverviewScope, pick: OverviewPick | null | undefined): boolean {
  if (!coveredOf(row, scope.coverage ?? 'all')) return false
  if (!inRangeOf(row, scope.range)) return false
  if (scope.day !== null && scope.day !== undefined && !row.activeDays.includes(scope.day)) return false
  const query = (scope.query ?? '').trim().toLowerCase()
  if (query !== '') {
    const inTitle = row.title.toLowerCase().includes(query)
    const inCwd = row.cwd !== undefined && row.cwd.toLowerCase().includes(query)
    const inLastUser = row.lastUser !== undefined && row.lastUser.toLowerCase().includes(query)
    if (!inTitle && !inCwd && !inLastUser) return false
  }
  if (scope.group !== null && scope.group !== undefined) {
    const groupMatch = scope.group === UNGROUPED_KEY || scope.group === '__ungrouped__'
      ? row.group === undefined
      : row.group === scope.group
    if (!groupMatch) return false
  }
  if (pick !== null && pick !== undefined && row.tallies?.[pick.field]?.includes(pick.name) !== true) return false
  return true
}

function groupCountsOf(rows: readonly ServerRow[], workspaces: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    if (row.group === undefined) ungrouped++
    else counts.set(row.group, (counts.get(row.group) ?? 0) + 1)
  }
  const groups: { key: string; count: number }[] = []
  for (const title of workspaces) {
    const count = counts.get(title) ?? 0
    if (count > 0) groups.push({ key: title, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

export function panelSummaryValue(body: Record<string, unknown>, rows: readonly ServerRow[] = panelRows()): Record<string, unknown> {
  const scope = scopeOf(body)
  const coverage = scope.coverage ?? 'all'
  const scoped = rows.filter(row => inRangeOf(row, scope.range))
  const covered = scoped.filter(row => coveredOf(row, coverage))
  return {
    revision: 'rev-summary',
    pricingReady: true,
    summary: panelSummaryRaw({
      sessions: covered.length,
      sessionsTotal: rows.length,
      archivedScoped: covered.filter(row => row.archived === true).length,
      sessionsArchived: rows.filter(row => row.archived === true).length,
    }),
  }
}

export function panelDaysValue(): Record<string, unknown> {
  return {
    revision: 'rev-days',
    pricingReady: true,
    days: [
      { key: TODAY, tokens: 100, sessions: 1, costUsd: 0.05 },
      { key: YESTERDAY, tokens: 75, sessions: 2, costUsd: null },
    ],
  }
}

export function panelPageValue(
  body: Record<string, unknown>,
  rows: readonly ServerRow[] = panelRows(),
  workspaces: readonly string[] = ['workspace-one'],
): Record<string, unknown> {
  const scope = scopeOf(body)
  const pick = (body.pick ?? null) as OverviewPick | null
  const filtered = rows.filter(row => matchesFilters(row, scope, pick))
  const scoped = rows.filter(row => matchesFilters(row, { ...scope, group: null }, null))
  const sort = (body.sort ?? 'recent') as OverviewSort
  const sorted = [...filtered]
  if (sort === 'tokens') sorted.sort((left, right) => right.tokens - left.tokens)
  else if (sort === 'context') sorted.sort((left, right) => right.total - left.total)
  else sorted.sort((left, right) => right.updatedAt - left.updatedAt)
  const count = Math.max(1, Math.ceil(sorted.length / 12))
  const requested = typeof body.page === 'number' && Number.isFinite(body.page) ? Math.max(0, Math.floor(body.page)) : 0
  const index = Math.min(requested, count - 1)
  return {
    revision: 'rev-page',
    pricingReady: true,
    page: {
      items: sorted.slice(index * 12, (index + 1) * 12).map(row => ({
        id: row.id,
        title: row.title,
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        updatedAt: row.updatedAt,
        running: row.running === true,
        archived: row.archived === true,
        ...(row.group === undefined ? {} : { group: row.group }),
        tokens: row.tokens,
        turns: row.turns,
        ...(row.steps === undefined ? {} : { steps: row.steps }),
        parts: row.parts,
        total: row.total,
        ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
        ...(row.costUsd === undefined ? { costUsd: null } : { costUsd: row.costUsd }),
        ...(row.createdDay === undefined ? {} : { createdDay: row.createdDay }),
        ...(row.lastUser === undefined ? {} : { lastUser: row.lastUser }),
      })),
      index,
      count,
      total: sorted.length,
      scopeTotal: scoped.length,
      groups: groupCountsOf(scoped, workspaces),
    },
  }
}

export function panelTallyValue(body: Record<string, unknown>, tallies: ServerTallies = panelTallies()): Record<string, unknown> {
  const field = (body.tally ?? 'skills') as OverviewTallyField
  return { revision: 'rev-tally', pricingReady: true, tally: { field, stats: tallies[field] } }
}

export interface RouteCall {
  route: string
  body: Record<string, unknown>
  method: string | undefined
}

export interface PanelRoutes {
  rows?: readonly ServerRow[]
  workspaces?: readonly string[]
  tallies?: ServerTallies
  summary?: (body: Record<string, unknown>) => unknown
  days?: (body: Record<string, unknown>) => unknown
  page?: (body: Record<string, unknown>) => unknown
  tally?: (body: Record<string, unknown>) => unknown
  skills?: (body: Record<string, unknown>) => unknown
}

export function stubPanelRoutes(routes: PanelRoutes = {}): RouteCall[] {
  const calls: RouteCall[] = []
  const rows = routes.rows ?? panelRows()
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string; method?: string }) => {
    const route = String(input)
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ route, body, method: init?.method })
    if (route.endsWith('/overview')) {
      const part = body.part
      const value = part === 'summary'
        ? await (routes.summary ?? ((request: Record<string, unknown>) => panelSummaryValue(request, rows)))(body)
        : part === 'days'
          ? await (routes.days ?? panelDaysValue)(body)
          : part === 'page'
            ? await (routes.page ?? ((request: Record<string, unknown>) => panelPageValue(request, rows, routes.workspaces ?? ['workspace-one'])))(body)
            : await (routes.tally ?? ((request: Record<string, unknown>) => panelTallyValue(request, routes.tallies ?? panelTallies())))(body)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    if (route.endsWith('/skills')) {
      const value = await (routes.skills ?? (() => ({ skills: [] })))(body)
      return { ok: true, json: async () => ({ ok: true, value }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  })
  return calls
}

export function overviewBodies(calls: readonly RouteCall[], part: string): Record<string, unknown>[] {
  return calls.filter(call => call.route.endsWith('/overview') && call.body.part === part).map(call => withoutRevision(call.body))
}

export function withoutRevision(body: Record<string, unknown>): Record<string, unknown> {
  const { revision, ...rest } = body
  void revision
  return rest
}

export type { ContextActivity }
