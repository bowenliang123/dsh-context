import { sql, type SQL } from 'drizzle-orm'
import { dayKeyOf } from '../../../shared/days'
import type { OverviewCoverage, OverviewRange } from '../../../shared/types'
import { asRecord } from '../../record'

export type QueryRange = OverviewRange | '8w' | 'all'

export interface QueryPick {
  field: 'skills' | 'tools' | 'cmds' | 'models' | 'providers'
  name: string
}

export interface QueryScope {
  range: QueryRange
  day?: string
  coverage: OverviewCoverage
  group?: string
  query?: string
  pick?: QueryPick
  model?: string
  running?: boolean
}

export interface QueryWindow {
  start: number
  end: number | null
  fromDay: string | null
  toDay: string | null
  all: boolean
}

const MAX_QUERY_CHARS = 500

function isPickField(value: unknown): value is QueryPick['field'] {
  return value === 'skills' || value === 'tools' || value === 'cmds'
    || value === 'models' || value === 'providers'
}

export function scopeOf(value: unknown): QueryScope {
  const data = asRecord(value)
  const range = rangeOf(data?.range)
  const coverage = data?.coverage === 'active' || data?.coverage === 'archived' ? data.coverage : 'all'
  const day = typeof data?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.day) ? data.day : undefined
  const group = typeof data?.group === 'string' ? data.group : undefined
  const query = typeof data?.query === 'string' && data.query !== '' ? data.query.slice(0, MAX_QUERY_CHARS) : undefined
  const model = typeof data?.model === 'string' && data.model !== '' ? data.model : undefined
  const running = typeof data?.running === 'boolean' ? data.running : undefined
  const pickData = asRecord(data?.pick)
  const pick = pickData !== null
    && isPickField(pickData.field)
    && typeof pickData.name === 'string' && pickData.name !== ''
    ? { field: pickData.field, name: pickData.name }
    : undefined
  return {
    range,
    coverage,
    ...(day === undefined ? {} : { day }),
    ...(group === undefined ? {} : { group }),
    ...(query === undefined ? {} : { query }),
    ...(model === undefined ? {} : { model }),
    ...(running === undefined ? {} : { running }),
    ...(pick === undefined ? {} : { pick }),
  }
}

function rangeOf(value: unknown): QueryRange {
  if (value === 'today' || value === '7d' || value === '30d' || value === '8w' || value === 'all') return value
  const data = asRecord(value)
  if (data !== null) {
    const start = typeof data.start === 'number' && Number.isFinite(data.start) ? data.start : undefined
    const end = typeof data.end === 'number' && Number.isFinite(data.end) ? data.end : undefined
    if (start !== undefined && end !== undefined) return start > end ? { start: end, end: start } : { start, end }
  }
  return '30d'
}

export function windowOfScope(scope: QueryScope, now = Date.now()): QueryWindow {
  if (scope.day !== undefined) {
    const start = dayStart(scope.day)
    return { start, end: start + 86_400_000 - 1, fromDay: scope.day, toDay: scope.day, all: false }
  }
  if (scope.range === 'all') return { start: 0, end: null, fromDay: null, toDay: null, all: true }
  if (typeof scope.range === 'object') {
    return rangeWindow(scope.range.start, scope.range.end)
  }
  if (scope.range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { start: midnight.getTime(), end: null, fromDay: dayKeyOf(midnight.getTime()), toDay: null, all: false }
  }
  const days = scope.range === '7d' ? 7 : scope.range === '8w' ? 56 : 30
  return rangeWindow(now - days * 86_400_000, now)
}

function rangeWindow(start: number, end: number): QueryWindow {
  return { start, end, fromDay: dayKeyOf(start), toDay: dayKeyOf(end), all: false }
}

function dayStart(key: string): number {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  return new Date(year, month - 1, day).getTime()
}

export function likePattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, value => `\\${value}`)}%`
}

export function dayRangeClause(column: SQL, window: QueryWindow): SQL | undefined {
  if (window.all) return undefined
  if (window.fromDay === null) return sql`${column} is not null`
  if (window.toDay === null) return sql`${column} >= ${window.fromDay}`
  return sql`${column} >= ${window.fromDay} and ${column} <= ${window.toDay}`
}

export function timeRangeClause(column: SQL, window: QueryWindow): SQL | undefined {
  if (window.all) return undefined
  if (window.end === null) return sql`${column} >= ${window.start}`
  return sql`${column} >= ${window.start} and ${column} <= ${window.end}`
}

export function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function limitOf(value: unknown, fallback: number, max = 500): number {
  const parsed = optionalNumber(value, fallback)
  return Math.max(1, Math.min(max, Math.floor(parsed)))
}

export function offsetOf(value: unknown): number {
  return Math.max(0, Math.floor(optionalNumber(value, 0)))
}
