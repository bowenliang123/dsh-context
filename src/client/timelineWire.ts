import type {
  ContextEventRecord,
  ContextTimeline,
  ContextTimelineDetail,
  HeaderRecord,
  HeaderTool,
  HistoryPage,
  HistoryPart,
  RequestRecord,
  SurfaceNode,
  SurfaceNodeWindow,
  SystemPromptNode,
} from '../shared/types'
import { CATS } from '../shared/categories'
import type { ContextDelta } from '../shared/delta'
import type { IncrementCat } from '../shared/increment'
import { asRecord, collectionsOf, timelineOf } from './services'

export interface FactParts {
  head?: ContextTimeline
  series?: RequestRecord[]
  requests?: RequestRecord[]
  nodes?: SurfaceNodeWindow
  events?: ContextTimeline['events']
  files?: { fileOps: NonNullable<ContextTimeline['fileOps']>; fileOpsFloor?: number }
  commands?: { commands: NonNullable<ContextTimeline['commands']>; commandsFloor?: number; commandStats?: ContextTimeline['commandStats'] }
  spans?: NonNullable<ContextTimeline['spans']>
}

export interface FactsRead {
  rev: number
  live: boolean
  asOfSeq?: number
  parts: FactParts
  missing?: readonly string[]
}

export interface HistoryCursor {
  beforeSeq?: number
}

export type HistoryFetcher = (
  part: HistoryPart,
  cursor?: HistoryCursor,
  limit?: number,
) => Promise<HistoryPage<RequestRecord | ContextEventRecord> | null>

export type DeltaFetcher = (seq: number | null, baseSeq: number | null) => Promise<ContextDelta | null>

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function rowsOf(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
}

function nodesPartOf(value: unknown): SurfaceNodeWindow | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const nodes = rowsOf(data.nodes) as SurfaceNode[] | undefined
  const archive = rowsOf(data.archive) as SurfaceNode[] | undefined
  if (nodes === undefined || archive === undefined) return undefined
  return {
    nodes,
    archive,
    droppedNodes: numOf(data.droppedNodes) ?? 0,
    ...(numOf(data.surfaceFloor) === undefined ? {} : { surfaceFloor: numOf(data.surfaceFloor) }),
    ...(numOf(data.archiveFloor) === undefined ? {} : { archiveFloor: numOf(data.archiveFloor) }),
  }
}

export function factsOf(value: unknown): FactsRead | null {
  const data = asRecord(value)
  if (data === null) return null
  const rev = numOf(data.rev)
  if (rev === undefined) return null
  const parts = asRecord(data.parts)
  if (parts === null) return null
  const head = parts.head === undefined ? undefined : timelineOf(parts.head)
  const series = rowsOf(parts.series) as RequestRecord[] | undefined
  const requests = rowsOf(parts.requests) as RequestRecord[] | undefined
  const events = rowsOf(parts.events) as ContextTimeline['events'] | undefined
  const spans = rowsOf(parts.spans) as NonNullable<ContextTimeline['spans']> | undefined
  const files = asRecord(parts.files)
  const fileOps = files === null ? undefined : rowsOf(files.fileOps) as NonNullable<ContextTimeline['fileOps']> | undefined
  const commands = asRecord(parts.commands)
  const commandRows = commands === null ? undefined : rowsOf(commands.commands) as NonNullable<ContextTimeline['commands']> | undefined
  const stats = asRecord(commands?.commandStats)
  const nodes = nodesPartOf(parts.nodes)
  const fileOpsFloor = files === null ? undefined : numOf(files.fileOpsFloor)
  const commandsFloor = commands === null ? undefined : numOf(commands.commandsFloor)
  const missing = Array.isArray(data.missing) ? data.missing.filter((entry): entry is string => typeof entry === 'string') : undefined
  return {
    rev,
    live: data.live === true,
    ...(numOf(data.asOfSeq) === undefined ? {} : { asOfSeq: numOf(data.asOfSeq) }),
    parts: {
      ...(head === null || head === undefined ? {} : { head }),
      ...(series === undefined ? {} : { series }),
      ...(requests === undefined ? {} : { requests }),
      ...(nodes === undefined ? {} : { nodes }),
      ...(events === undefined ? {} : { events }),
      ...(fileOps === undefined
        ? {}
        : {
          files: {
            fileOps,
            ...(fileOpsFloor === undefined ? {} : { fileOpsFloor }),
          },
        }),
      ...(commandRows === undefined
        ? {}
        : {
          commands: {
            commands: commandRows,
            ...(commandsFloor === undefined ? {} : { commandsFloor }),
            ...(stats === null
              ? {}
              : {
                commandStats: {
                  runs: numOf(stats.runs) ?? 0,
                  failed: numOf(stats.failed) ?? 0,
                  ms: numOf(stats.ms) ?? 0,
                  bg: numOf(stats.bg) ?? 0,
                },
              }),
          },
        }),
      ...(spans === undefined ? {} : { spans }),
    },
    ...(missing === undefined || missing.length === 0 ? {} : { missing }),
  }
}

export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  const head = timelineOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
  }
}

const HISTORY_PARTS = new Set<HistoryPart>(['requests', 'events', 'milestones'])

export function historyOf(value: unknown): HistoryPage<RequestRecord | ContextEventRecord> | null {
  const data = asRecord(value)
  if (data === null) return null
  const rev = numOf(data.rev)
  const part = data.part
  const rows = rowsOf(data.rows)
  const first = numOf(data.first)
  const last = typeof data.last === 'number' && Number.isSafeInteger(data.last) && data.last >= -1 ? data.last : undefined
  const total = numOf(data.total)
  if (rev === undefined || typeof part !== 'string' || !HISTORY_PARTS.has(part as HistoryPart)
    || rows === undefined || first === undefined || last === undefined || total === undefined
    || typeof data.atStart !== 'boolean' || typeof data.atEnd !== 'boolean') return null
  const beforeSeq = numOf(data.beforeSeq)
  return {
    rev,
    live: data.live === true,
    part: part as HistoryPart,
    rows: rows as unknown as (RequestRecord | ContextEventRecord)[],
    first,
    last,
    total,
    atStart: data.atStart,
    atEnd: data.atEnd,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
  }
}

function countRecordOf(value: unknown): Record<IncrementCat, number> | null {
  const record = asRecord(value)
  if (record === null) return null
  const out = {} as Record<IncrementCat, number>
  for (const cat of CATS) {
    const n = numOf(record[cat.key])
    if (n === undefined) return null
    out[cat.key] = n
  }
  return out
}

function nullableOf(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null
  return asRecord(value) ?? undefined
}

export function deltaOf(value: unknown): ContextDelta | null {
  const data = asRecord(value)
  if (data === null) return null
  const added = rowsOf(data.added) as SurfaceNode[] | undefined
  const viewNodes = rowsOf(data.viewNodes) as SurfaceNode[] | undefined
  const viewHeader = nullableOf(data.viewHeader)
  const viewSystem = nullableOf(data.viewSystem)
  const system = nullableOf(data.system)
  const tools = rowsOf(data.tools) as HeaderTool[] | undefined
  const header = nullableOf(data.header)
  const counts = countRecordOf(data.counts)
  const tokens = countRecordOf(data.tokens)
  const removedCounts = countRecordOf(data.removedCounts)
  const tokenUp = countRecordOf(data.tokenUp)
  const tokenDown = countRecordOf(data.tokenDown)
  const items = numOf(data.items)
  const total = numOf(data.total)
  if (added === undefined || viewNodes === undefined
    || viewHeader === undefined || viewSystem === undefined || system === undefined
    || tools === undefined || header === undefined
    || counts === null || tokens === null || removedCounts === null
    || tokenUp === null || tokenDown === null
    || items === undefined || total === undefined) return null
  return {
    added,
    viewNodes,
    viewHeader: viewHeader as HeaderRecord | null,
    viewSystem: viewSystem as SystemPromptNode | null,
    system: system as SystemPromptNode | null,
    tools,
    header: header as HeaderRecord | null,
    counts,
    tokens,
    removedCounts,
    tokenUp,
    tokenDown,
    items,
    total,
  }
}
