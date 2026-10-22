import { asRecord, contextBreakdownOf } from '../client/services'
import type { ContextBreakdown } from '../shared/types'
import type { ChartKit, SurfaceHost, SurfaceUi } from './hostTypes'
import { langOf, type Lang } from './i18n'

const COMPONENTS = ['StackedBar', 'ColumnChart', 'Legend', 'Table'] as const
const FORMATTERS = ['relativeTime', 'cells', 'truncate'] as const

/** React.memo/forwardRef components are objects, plain ones functions. */
function isComponent(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

/** The kit only when every member this plugin draws with is present: feature detection, never a version check. */
export function kitOf(ui: SurfaceUi): ChartKit | undefined {
  const face = ui as unknown as Record<string, unknown>
  if (!COMPONENTS.every(name => isComponent(face[name]))) return undefined
  if (typeof face.seriesColor !== 'function' || typeof face.hashSeries !== 'function') return undefined
  const format = asRecord(face.format)
  if (format === null || !FORMATTERS.every(name => typeof format[name] === 'function')) return undefined
  return ui as ChartKit
}

export interface HostUsage {
  occupancy?: { usedTokens: number; contextWindow?: number }
  breakdown?: ContextBreakdown
  cost?: { currency: string; amount: number }
}

export interface SurfaceFacts {
  sessionId?: string
  cwd?: string
  lang: Lang
  usage: HostUsage
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function usageOf(value: unknown): HostUsage {
  const data = asRecord(value)
  if (data === null) return {}
  const usage: HostUsage = {}
  const occupancy = asRecord(data.occupancy)
  if (occupancy !== null && finite(occupancy.usedTokens) && occupancy.usedTokens >= 0) {
    usage.occupancy = {
      usedTokens: occupancy.usedTokens,
      ...(finite(occupancy.contextWindow) && occupancy.contextWindow > 0 ? { contextWindow: occupancy.contextWindow } : {}),
    }
  }
  const breakdown = contextBreakdownOf(data.breakdown)
  if (breakdown !== null) usage.breakdown = breakdown
  const cost = asRecord(data.cost)
  if (cost !== null && typeof cost.currency === 'string' && cost.currency !== '' && finite(cost.amount) && cost.amount >= 0) {
    usage.cost = { currency: cost.currency, amount: cost.amount }
  }
  return usage
}

/** The curated host snapshot, re-proved field by field; a throwing or absent `snapshot()` degrades to no facts. */
export function surfaceFactsOf(host: SurfaceHost | undefined): SurfaceFacts {
  let raw: unknown
  try {
    raw = host?.snapshot?.()
  } catch {
    raw = undefined
  }
  const data = asRecord(raw)
  return {
    ...(typeof data?.sessionId === 'string' && data.sessionId !== '' ? { sessionId: data.sessionId } : {}),
    ...(typeof data?.cwd === 'string' && data.cwd !== '' ? { cwd: data.cwd } : {}),
    lang: langOf(data?.lang),
    usage: usageOf(data?.usage),
  }
}
