import { useEffect, useRef, useState } from 'react'
import type {
  BackfillCoverage, BackfillSessionIssue, OverviewDay, OverviewPage, OverviewPartTotal, OverviewProjectStat,
  OverviewRequest, OverviewScope,
  OverviewSummary, OverviewTally, OverviewTallyStat, OverviewTimingWindow, OverviewValue, TimingTotals,
  OverviewResolvedWindow,
} from '../shared/types'
import { BACKFILL_ROUTE, OVERVIEW_ROUTE } from './apiRoutes'
import { postRoute, postRouteAction } from './route'
import { asRecord } from './services'
import { invalidate, subscribeInvalidations } from './invalidation'
import { notePricingPending } from './costRefresh'

const POLL_MS = 30_000

const REFRESH_COALESCE_MS = 250

const COVERAGE_REFRESH_MS = 1_000

const COVERAGE_REFRESH_MAX_MS = 15_000

const COVERAGE_REFRESH_ATTEMPTS = 10

const ISSUES_MAX = 64

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeOf(value: unknown): number | null {
  const n = numOf(value)
  return n !== null && n >= 0 ? n : null
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function partsOf(value: unknown): OverviewPartTotal[] | null {
  if (!Array.isArray(value)) return null
  const parts: OverviewPartTotal[] = []
  for (const entry of value) {
    const data = asRecord(entry)
    const key = data === null ? undefined : stringOf(data.key)
    const valueOf = data === null ? null : numOf(data.value)
    if (key === undefined || valueOf === null) continue
    parts.push({ key, value: valueOf })
  }
  return parts
}

function timingOf(value: unknown): TimingTotals | null {
  return asRecord(value) === null ? null : value as TimingTotals
}

function windowTimingOf(value: unknown): OverviewTimingWindow | null {
  const data = asRecord(value)
  if (data === null) return null
  const calls = nonNegativeOf(data.calls)
  const toolCalls = nonNegativeOf(data.toolCalls)
  const toolsMs = nonNegativeOf(data.toolsMs)
  const wallMs = nonNegativeOf(data.wallMs)
  if (calls === null || toolCalls === null || toolsMs === null || wallMs === null) return null
  return { calls, toolCalls, toolsMs, wallMs }
}

function resolvedWindowOf(value: unknown): OverviewResolvedWindow | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const start = numOf(data.start)
  const end = data.end === null ? null : numOf(data.end)
  const from = data.from === null ? null : stringOf(data.from)
  const to = data.to === null ? null : stringOf(data.to)
  if (start === null || (end === null && data.end !== null) || from === undefined || to === undefined) return undefined
  return { start, end, from, to }
}

function issuesOf(value: unknown): BackfillSessionIssue[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sessions: BackfillSessionIssue[] = []
  for (const entry of value.slice(0, ISSUES_MAX) as unknown[]) {
    const data = asRecord(entry)
    const id = data === null ? undefined : stringOf(data.id)
    const reason = data === null ? undefined : stringOf(data.reason)
    if (id === undefined || reason === undefined) continue
    sessions.push({ id, reason })
  }
  return sessions.length > 0 ? sessions : undefined
}

function coverageOf(value: unknown): BackfillCoverage | null {
  const data = asRecord(value)
  if (data === null) return null
  const fields = ['complete', 'remaining', 'failed', 'running', 'total', 'covered', 'unsupported', 'unreadable'] as const
  for (const field of fields) {
    if (field === 'complete' || field === 'running') {
      if (typeof data[field] !== 'boolean') return null
    } else if (nonNegativeOf(data[field]) === null) {
      return null
    }
  }
  const unreadableSessions = issuesOf(data.unreadableSessions)
  const failedSessions = issuesOf(data.failedSessions)
  return {
    complete: data.complete as boolean,
    running: data.running as boolean,
    remaining: data.remaining as number,
    failed: data.failed as number,
    total: data.total as number,
    covered: data.covered as number,
    unsupported: data.unsupported as number,
    unreadable: data.unreadable as number,
    ...(unreadableSessions === undefined ? {} : { unreadableSessions }),
    ...(failedSessions === undefined ? {} : { failedSessions }),
  }
}

function summaryOf(value: unknown): OverviewSummary | null {
  const data = asRecord(value)
  if (data === null) return null
  const sessions = nonNegativeOf(data.sessions)
  const sessionsTotal = nonNegativeOf(data.sessionsTotal)
  const tokens = nonNegativeOf(data.tokens)
  const turns = nonNegativeOf(data.turns)
  const costUsd = data.costUsd === null ? null : numOf(data.costUsd)
  const costSessions = nonNegativeOf(data.costSessions)
  const usageSessions = nonNegativeOf(data.usageSessions)
  const coverage = coverageOf(data.coverage)
  const windowTiming = windowTimingOf(data.windowTiming)
  const window = resolvedWindowOf(data.window)
  if (sessions === null || sessionsTotal === null || tokens === null || turns === null
    || costSessions === null || usageSessions === null || coverage === null || windowTiming === null) return null
  if (costUsd === null && data.costUsd !== null) return null
  const cacheHit = data.cacheHit === null ? null : stringOf(data.cacheHit) ?? null
  return {
    sessions,
    sessionsTotal,
    sessionsArchived: nonNegativeOf(data.sessionsArchived) ?? 0,
    archivedScoped: nonNegativeOf(data.archivedScoped) ?? 0,
    tokens,
    turns,
    costUsd,
    costSessions,
    usageSessions,
    cacheHit,
    tokenParts: data.tokenParts === null ? null : partsOf(data.tokenParts),
    timing: timingOf(data.timing),
    windowTiming,
    ...(window === undefined ? {} : { window }),
    coverage,
  }
}

function daysOf(value: unknown): OverviewDay[] | null {
  if (!Array.isArray(value)) return null
  const days: OverviewDay[] = []
  for (const entry of value) {
    const data = asRecord(entry)
    const key = data === null ? undefined : stringOf(data.key)
    const tokens = data === null ? null : nonNegativeOf(data.tokens)
    const sessions = data === null ? null : nonNegativeOf(data.sessions)
    if (key === undefined || tokens === null || sessions === null) continue
    const costUsd = data === null || data.costUsd === null ? null : numOf(data.costUsd)
    days.push({ key, tokens, sessions, costUsd })
  }
  return days
}

function pageOf(value: unknown): OverviewPage | null {
  const data = asRecord(value)
  if (data === null) return null
  const items = data.items
  const index = nonNegativeOf(data.index)
  const count = nonNegativeOf(data.count)
  const total = nonNegativeOf(data.total)
  if (!Array.isArray(items) || index === null || count === null || total === null) return null
  const rows: OverviewPage['items'] = []
  for (const entry of items) {
    const row = asRecord(entry)
    const id = row === null ? undefined : stringOf(row.id)
    const title = row === null ? undefined : stringOf(row.title)
    const updatedAt = row === null ? null : numOf(row.updatedAt)
    if (row === null || id === undefined || title === undefined || updatedAt === null) continue
    const parts = partsOf(row.parts)
    if (parts === null) continue
    rows.push({
      id,
      title,
      ...(stringOf(row.cwd) === undefined ? {} : { cwd: row.cwd as string }),
      updatedAt,
      running: row.running === true,
      archived: row.archived === true,
      ...(stringOf(row.group) === undefined ? {} : { group: row.group as string }),
      tokens: nonNegativeOf(row.tokens) ?? 0,
      turns: nonNegativeOf(row.turns) ?? 0,
      ...(nonNegativeOf(row.steps) === null ? {} : { steps: row.steps as number }),
      parts,
      total: nonNegativeOf(row.total) ?? 0,
      ...(numOf(row.contextWindow) === null ? {} : { contextWindow: row.contextWindow as number }),
      ...(numOf(row.maxOutputTokens) === null ? {} : { maxOutputTokens: row.maxOutputTokens as number }),
      ...(stringOf(row.model) === undefined ? {} : { model: row.model as string }),
      ...(stringOf(row.lastUser) === undefined ? {} : { lastUser: row.lastUser as string }),
      costUsd: row.costUsd === null ? null : numOf(row.costUsd),
      ...(stringOf(row.createdDay) === undefined ? {} : { createdDay: row.createdDay as string }),
    })
  }
  const groups: OverviewPage['groups'] = []
  if (Array.isArray(data.groups)) {
    for (const entry of data.groups) {
      const group = asRecord(entry)
      const key = group === null ? undefined : stringOf(group.key)
      const groupCount = group === null ? null : nonNegativeOf(group.count)
      if (key === undefined || groupCount === null) continue
      groups.push({ key, count: groupCount })
    }
  }
  const scopeTotal = nonNegativeOf(data.scopeTotal) ?? total
  return { items: rows, index, count, total, scopeTotal, groups }
}

function tallyOf(value: unknown): OverviewTally | null {
  const data = asRecord(value)
  if (data === null || !Array.isArray(data.stats)) return null
  const field = data.field
  if (field !== 'skills' && field !== 'tools' && field !== 'cmds') return null
  const stats: OverviewTallyStat[] = []
  for (const entry of data.stats) {
    const row = asRecord(entry)
    const name = row === null ? undefined : stringOf(row.name)
    const n = row === null ? null : nonNegativeOf(row.n)
    const sessions = row === null ? null : nonNegativeOf(row.sessions)
    const last = row === null ? null : numOf(row.last)
    if (name === undefined || n === null || sessions === null || last === null) continue
    stats.push({ name, n, sessions, last })
  }
  return { field, stats }
}

function projectsOf(value: unknown): OverviewProjectStat[] | null {
  if (!Array.isArray(value)) return null
  const projects: OverviewProjectStat[] = []
  for (const entry of value) {
    const row = asRecord(entry)
    const key = row === null ? undefined : stringOf(row.key)
    const tokens = row === null ? null : nonNegativeOf(row.tokens)
    const sessions = row === null ? null : nonNegativeOf(row.sessions)
    if (key === undefined || tokens === null || sessions === null) continue
    projects.push({ key, tokens, sessions })
  }
  return projects
}

export function overviewValueOf(value: unknown): OverviewValue | null {
  const data = asRecord(value)
  if (data === null) return null
  const revision = stringOf(data.revision)
  if (revision === undefined) return null
  if (data.unchanged === true) return { revision, unchanged: true }
  if (typeof data.pricingReady !== 'boolean') return null
  const pricingReady = data.pricingReady
  if (data.summary !== undefined) {
    const summary = summaryOf(data.summary)
    return summary === null ? null : { revision, pricingReady, summary }
  }
  if (data.days !== undefined) {
    const days = daysOf(data.days)
    return days === null ? null : { revision, pricingReady, days }
  }
  if (data.page !== undefined) {
    const page = pageOf(data.page)
    return page === null ? null : { revision, pricingReady, page }
  }
  if (data.tally !== undefined) {
    const tally = tallyOf(data.tally)
    return tally === null ? null : { revision, pricingReady, tally }
  }
  if (data.projects !== undefined) {
    const projects = projectsOf(data.projects)
    return projects === null ? null : { revision, pricingReady, projects }
  }
  return null
}

export interface PartState<T> {
  data: T | null
  pending: boolean
  stale: boolean
  error: boolean
  revision: string | null
}

interface PartOptions<T> {
  request: Omit<OverviewRequest, 'revision'> | null
  enabled: boolean
  pick: (value: OverviewValue) => T | null
}

interface HeldPart<T> {
  key: string
  revision: string
  value: T
}

function heldFor<T>(held: HeldPart<T> | null, key: string): HeldPart<T> | null {
  return held !== null && held.key === key ? held : null
}

function useOverviewPart<T>(options: PartOptions<T>): PartState<T> {
  const { request, enabled, pick } = options
  const key = request === null ? '' : JSON.stringify(request)
  const pickRef = useRef(pick)
  pickRef.current = pick
  const [held, setHeld] = useState<HeldPart<T> | null>(null)
  const heldRef = useRef<HeldPart<T> | null>(null)
  const [pending, setPending] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState(false)
  const hold = (next: HeldPart<T>): void => {
    heldRef.current = next
    setHeld(next)
  }

  useEffect(() => {
    if (!enabled || request === null) {
      setPending(false)
      return
    }
    const live = { cancelled: false, inFlight: false, queued: false }
    const stopped = (): boolean => live.cancelled
    const busy = (): boolean => live.inFlight
    const queued = (): boolean => live.queued
    const timers = { refresh: null as ReturnType<typeof setTimeout> | null }
    const pricingReady = { current: undefined as boolean | undefined }
    const clearTimer = (): void => {
      if (timers.refresh !== null) {
        clearTimeout(timers.refresh)
        timers.refresh = null
      }
    }
    const fetchNow = async (): Promise<void> => {
      if (busy()) {
        live.queued = true
        return
      }
      live.inFlight = true
      setPending(true)
      try {
        const heldPart = heldFor(heldRef.current, key)
        const body: OverviewRequest = { ...request, revision: heldPart === null ? null : heldPart.revision }
        const read = await postRoute(OVERVIEW_ROUTE, body, overviewValueOf, { label: 'overview ' + request.part })
        if (stopped()) return
        if (read === null) {
          setError(true)
          setStale(true)
          return
        }
        setError(false)
        if ('unchanged' in read) {
          notePricingPending(pricingReady.current)
          setStale(false)
          return
        }
        pricingReady.current = read.pricingReady
        notePricingPending(read.pricingReady)
        const picked = pickRef.current(read)
        if (picked === null) return
        hold({ key, revision: read.revision, value: picked })
        setStale(false)
      } catch {
        if (!stopped()) {
          setError(true)
          setStale(true)
        }
      } finally {
        live.inFlight = false
        if (!stopped()) setPending(false)
        if (queued() && !stopped()) {
          live.queued = false
          void fetchNow()
        }
      }
    }
    const schedule = (delay: number): void => {
      clearTimer()
      timers.refresh = setTimeout(() => { timers.refresh = null; void fetchNow() }, delay)
    }
    const off = subscribeInvalidations((event) => {
      if (stopped()) return
      if (event.kind === 'overview' || event.kind === 'sessions' || event.kind === 'pricing') schedule(REFRESH_COALESCE_MS)
    })
    schedule(0)
    const pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchNow()
    }, POLL_MS)
    return () => {
      live.cancelled = true
      clearTimer()
      clearInterval(pollTimer)
      off()
    }
  }, [key, enabled])

  const heldPart = heldFor(held, key)
  const active = enabled && request !== null
  const painted = heldPart ?? (active && !error ? held : null)
  return {
    data: painted === null ? null : painted.value,
    pending,
    stale: stale || (painted !== null && heldPart === null),
    error,
    revision: heldPart === null ? null : heldPart.revision,
  }
}

const pickSummary = (value: OverviewValue): { summary: OverviewSummary; pricingReady: boolean } | null =>
  'summary' in value ? { summary: value.summary, pricingReady: value.pricingReady } : null

const pickDays = (value: OverviewValue): { days: OverviewDay[]; pricingReady: boolean } | null =>
  'days' in value ? { days: value.days, pricingReady: value.pricingReady } : null

const pickPage = (value: OverviewValue): { page: OverviewPage; pricingReady: boolean } | null =>
  'page' in value ? { page: value.page, pricingReady: value.pricingReady } : null

const pickTally = (value: OverviewValue): { tally: OverviewTally; pricingReady: boolean } | null =>
  'tally' in value ? { tally: value.tally, pricingReady: value.pricingReady } : null

const pickProjects = (value: OverviewValue): { projects: OverviewProjectStat[]; pricingReady: boolean } | null =>
  'projects' in value ? { projects: value.projects, pricingReady: value.pricingReady } : null

export interface OverviewSummaryState extends PartState<{ summary: OverviewSummary; pricingReady: boolean }> {
  coverage: BackfillCoverage | null
}

export type FoldState = 'idle' | 'starting' | 'running' | 'folding' | 'stalled'

export function foldStateOf(coverage: BackfillCoverage | null): FoldState {
  if (coverage === null) return 'idle'
  if (coverage.running) return 'running'
  if (coverage.complete) return 'idle'
  if (coverage.total === 0) return 'starting'
  return coverage.remaining > 0 ? 'folding' : 'stalled'
}

export async function retryBackfill(): Promise<void> {
  await postRouteAction(BACKFILL_ROUTE, {})
  invalidate('overview')
}

export function useOverviewSummary(scope: OverviewScope | null, enabled: boolean): OverviewSummaryState {
  const state = useOverviewPart({
    request: enabled && scope !== null ? { part: 'summary', scope } : null,
    enabled,
    pick: pickSummary,
  })
  const coverage = state.data?.summary.coverage ?? null
  const following = coverage !== null && !coverage.complete
  const progressKey = coverage === null ? '' : [coverage.remaining, coverage.covered, coverage.total].join(',')
  useEffect(() => {
    if (!enabled || !following) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (cancelled || attempts >= COVERAGE_REFRESH_ATTEMPTS) return
      const delay = Math.min(COVERAGE_REFRESH_MAX_MS, COVERAGE_REFRESH_MS * 2 ** attempts)
      attempts++
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') invalidate('overview')
        schedule()
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, following, progressKey])
  return { ...state, coverage }
}

export function useOverviewDays(scope: OverviewScope | null, enabled: boolean): PartState<{ days: OverviewDay[]; pricingReady: boolean }> {
  return useOverviewPart({
    request: enabled && scope !== null ? { part: 'days', scope } : null,
    enabled,
    pick: pickDays,
  })
}

export function useOverviewPage(request: Omit<OverviewRequest, 'revision'> | null, enabled: boolean): PartState<{ page: OverviewPage; pricingReady: boolean }> {
  return useOverviewPart({ request: enabled ? request : null, enabled, pick: pickPage })
}

export function useOverviewTally(request: Omit<OverviewRequest, 'revision'> | null, enabled: boolean): PartState<{ tally: OverviewTally; pricingReady: boolean }> {
  return useOverviewPart({ request: enabled ? request : null, enabled, pick: pickTally })
}

export function useOverviewProjects(request: Omit<OverviewRequest, 'revision'> | null, enabled: boolean): PartState<{ projects: OverviewProjectStat[]; pricingReady: boolean }> {
  return useOverviewPart({ request: enabled ? request : null, enabled, pick: pickProjects })
}
