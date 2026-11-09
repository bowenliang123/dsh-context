import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FoldBounds } from './config'
import { foldLog } from './detailShadow'
import type { DetailChannelGate } from './detail'
import type { CachedSnapshotFace, SessionsFace, StateProjectionsFace } from './faces'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { makeFoldCache } from './foldCache'
import { buildTimelineHead, eventsOf, requestRowsOf, serveCommand } from './foldWire'
import { withCost, type CostSource } from './cost'
import { TIMING_SPANS_MAX, type TimelineState } from './foldState'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply, revisionOf } from './postRoute'
import { asRecord } from './record'
import { serviceIdentityOf } from './serviceIdentity'

export const FACTS_ROUTE = '/api/dsh-context/facts'

function coldCursorOf(events: readonly unknown[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const seq = asRecord(events[i])?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) return 'cold-seq:' + String(seq)
  }
  return 'cold-seq:-1'
}

const KERNEL_KEYS = ['sessionStats', 'tokenUsage', 'contextBreakdown'] as const

const DETAIL_PARTS = ['requests', 'nodes', 'events', 'files', 'commands', 'spans'] as const

const FACT_PARTS = new Set<string>(['head', 'series', 'stats', ...DETAIL_PARTS])

const STATE_CACHE_MAX = 4
const WINDOW_FIELDS = ['requestsTail', 'nodesTail', 'eventsTail', 'filesTail', 'commandsTail', 'spansTail'] as const

type FactWindow = Record<typeof WINDOW_FIELDS[number], number>

function windowCapsOf(bounds: FoldBounds): FactWindow {
  return {
    requestsTail: bounds.maxRequestSteps,
    nodesTail: bounds.maxNodes,
    eventsTail: bounds.maxEvents,
    filesTail: bounds.maxFileOps,
    commandsTail: bounds.maxCommands,
    spansTail: TIMING_SPANS_MAX,
  }
}

interface FactPartRequest {
  parts: ReadonlySet<string>
  sessionId: string
  window: FactWindow
}

interface ColdState {
  persistence: unknown
  revision: string
  state: TimelineState
}

interface KernelFacts {
  asOfSeq?: number
  values?: Record<string, unknown>
}

function tailNumber(value: unknown, fallback: number, limit: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(limit, Math.max(1, Math.floor(value)))
}

function windowOf(body: Record<string, unknown>, caps: FactWindow): FactWindow {
  const raw = asRecord(body.window)
  if (raw === null) return caps
  const window = { ...caps }
  for (const field of WINDOW_FIELDS) window[field] = tailNumber(raw[field], caps[field], caps[field])
  return window
}

function partsOf(body: unknown, caps: FactWindow): FactPartRequest | null {
  const data = asRecord(body)
  if (data === null) return null
  const sessionId = data.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const window = windowOf(data, caps)
  const requested = data.parts
  if (!Array.isArray(requested)) return { sessionId, parts: FACT_PARTS, window }
  const parts = new Set<string>()
  for (const entry of requested) {
    if (typeof entry === 'string' && FACT_PARTS.has(entry)) parts.add(entry)
  }
  return { sessionId, parts: parts.size > 0 ? parts : FACT_PARTS, window }
}

function asOfSeqOf(value: unknown): number | undefined {
  const seq = asRecord(value)?.asOfSeq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

function pickedValuesOf(block: unknown): Record<string, unknown> | undefined {
  const values = asRecord(asRecord(block)?.values)
  if (values === null) return undefined
  const picked: Record<string, unknown> = {}
  for (const key of KERNEL_KEYS) {
    if (values[key] !== undefined) picked[key] = values[key]
  }
  return Object.keys(picked).length > 0 ? picked : undefined
}

function kernelOf(block: unknown): KernelFacts {
  const asOfSeq = asOfSeqOf(block)
  const values = pickedValuesOf(block)
  return {
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    ...(values === undefined ? {} : { values }),
  }
}

function kernelOfLive(projections: StateProjectionsFace | undefined, session: unknown): KernelFacts {
  if (projections?.snapshot === undefined) return {}
  try {
    return kernelOf(projections.snapshot.call(projections, session, KERNEL_KEYS))
  } catch {
    return {}
  }
}

function kernelOfCold(cache: CachedSnapshotFace | undefined, header: unknown): KernelFacts {
  if (cache?.cachedSnapshot === undefined || header === undefined) return {}
  try {
    return kernelOf(cache.cachedSnapshot.call(cache, header, KERNEL_KEYS))
  } catch {
    return {}
  }
}

function tailOf<T>(items: readonly T[], tail: number): T[] {
  return items.length > tail ? items.slice(items.length - tail) : [...items]
}

function windowFloorOf(items: readonly { seq: number }[], tail: number, floor: number | undefined): number | undefined {
  if (items.length <= tail) return floor
  return Math.max(floor ?? 0, items[items.length - tail - 1].seq)
}

function surfacePartOf(state: TimelineState, tail: number): Record<string, unknown> {
  const surface = state.surface
  const overflowCount = Math.max(0, surface.length - tail)
  const overflow = overflowCount > 0 ? surface.slice(0, overflowCount) : []
  const kept = surface.slice(overflowCount)
  const pinned = overflow.filter(node => node.cat === 'inject' || node.cat === 'skill')
  const nodes = pinned.length > 0 ? [...pinned, ...kept] : kept
  const droppedNodes = overflowCount - pinned.length
  const part: Record<string, unknown> = {
    nodes: nodes.map(node => ({ ...node })),
    droppedNodes,
    archive: state.archived.map(node => ({ ...node })),
  }
  if (droppedNodes > 0) {
    let floor = 0
    for (const node of overflow) {
      if (node.cat !== 'inject' && node.cat !== 'skill') floor = Math.max(floor, node.seq)
    }
    part.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) part.archiveFloor = state.archiveFloor
  return part
}

function detailPartsOf(state: TimelineState, parts: ReadonlySet<string>, window: FactWindow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const requests = parts.has('requests') || parts.has('events') ? requestRowsOf(state) : []
  if (parts.has('requests')) out.requests = tailOf(requests, window.requestsTail)
  if (parts.has('nodes')) out.nodes = surfacePartOf(state, window.nodesTail)
  if (parts.has('events')) out.events = tailOf(eventsOf(state, requests), window.eventsTail)
  if (parts.has('files')) {
    const fileOpsFloor = windowFloorOf(state.fileOps, window.filesTail, state.fileOpsFloor)
    out.files = {
      fileOps: tailOf(state.fileOps, window.filesTail).map(op => ({ ...op })),
      ...(fileOpsFloor === undefined ? {} : { fileOpsFloor }),
    }
  }
  if (parts.has('commands')) {
    const commandsFloor = windowFloorOf(state.commands, window.commandsTail, state.commandsFloor)
    out.commands = {
      commands: tailOf(state.commands, window.commandsTail).map(serveCommand),
      ...(commandsFloor === undefined ? {} : { commandsFloor }),
      ...(state.commandStats === undefined ? {} : { commandStats: { ...state.commandStats } }),
    }
  }
  if (parts.has('spans')) out.spans = tailOf(state.spans, window.spansTail).map(span => ({ ...span }))
  return out
}

function detailPartsRequested(parts: ReadonlySet<string>): string[] {
  return DETAIL_PARTS.filter(part => parts.has(part))
}

function valueOf(
  state: TimelineState,
  live: boolean,
  request: FactPartRequest,
  kernel: KernelFacts,
  detailState: TimelineState | null,
  cost?: CostSource,
): Record<string, unknown> {
  const { parts, window } = request
  const rev = state.detailRev ?? 0
  const aligned = detailState !== null && (detailState.detailRev ?? 0) === rev ? detailState : null
  const detailRequested = detailPartsRequested(parts)
  const missing = [
    ...(aligned === null ? detailRequested : []),
    ...(aligned === null && parts.has('series') ? ['series'] : []),
  ]
  const partsValue: Record<string, unknown> = {
    ...(parts.has('head') ? { head: withCost(cost, buildTimelineHead(state)) } : {}),
    ...(parts.has('series') ? { series: requestRowsOf(aligned ?? state) } : {}),
    ...(parts.has('stats') && kernel.values !== undefined ? { stats: kernel.values } : {}),
    ...(aligned === null ? {} : detailPartsOf(aligned, parts, window)),
  }
  return {
    rev,
    live,
    ...(kernel.asOfSeq === undefined ? {} : { asOfSeq: kernel.asOfSeq }),
    parts: partsValue,
    ...(missing.length > 0 ? { missing } : {}),
  }
}

export interface FactsChannelDeps {
  gates?: DetailChannelGate
  coldReads?: ColdReadGate
  detailState?: (id: string) => Promise<TimelineState | null>
  stateCacheMax?: number
  idleSweepMs?: number
  cost?: CostSource
}

export function watchFactsChannel(ctx: Context, bounds: FoldBounds, deps: FactsChannelDeps = {}): void {
  const stateCacheMax = deps.stateCacheMax ?? STATE_CACHE_MAX
  const stateCache = makeFoldCache<ColdState>(ctx, {
    maxEntries: stateCacheMax,
    idleMs: deps.idleSweepMs,
  })
  const coldReads = deps.coldReads ?? makeColdReadGate()
  const caps = windowCapsOf(bounds)
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: FACTS_ROUTE,
    label: 'dsh-context: facts route',
    handler: (c) => {
      const gates = deps.gates

      const stateOfLive = (session: unknown): unknown => {
        if (gates !== undefined) return gates.stateOf(session, 'contextTimeline')
        const projections = c.get('sessionProjections') as StateProjectionsFace | undefined
        if (projections?.stateOf === undefined) return undefined
        return projections.stateOf.call(projections, session, 'contextTimeline')
      }

      const liveDetailState = async (sessionId: string): Promise<TimelineState | null> => {
        const read = deps.detailState
        if (read === undefined) return null
        try {
          return await read(sessionId)
        } catch {
          return null
        }
      }

      return async (request: Request): Promise<Response> => {
        stateCache.touch()
        const getSession = ((): ((id: string) => unknown) | undefined => {
          const sessions = c.get('sessions') as SessionsFace | undefined
          return typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
        })()
        const observe = observeOf(c)
        const read = await readBody(request)
        if (!read.ok) return read.response
        const wanted = partsOf(read.body, caps)
        if (wanted === null) return failure('dsh-context/bad-request', 'missing sessionId')
        const wantedDetail = detailPartsRequested(wanted.parts)
        try {
          const session = getSession?.(wanted.sessionId)
          if (session !== undefined && session !== null) {
            const state = stateOfLive(session)
            if (state === null || state === undefined) return reply({ ok: true, value: null })
            const projections = c.get('sessionProjections') as StateProjectionsFace | undefined
            const kernel = kernelOfLive(projections, session)
            const needsDetail = wantedDetail.length > 0 || wanted.parts.has('series')
            const detailState = needsDetail ? await liveDetailState(wanted.sessionId) : null
            return reply({
              ok: true,
              value: valueOf(state as TimelineState, true, wanted, kernel, detailState, deps.cost),
            })
          }
          if (observe === undefined) return reply({ ok: true, value: null })
          const value = await coldReads.admit(async () => {
            const observation = await observe(wanted.sessionId, { projectionMode: 'none' })
            const release = leaseOf(observation)
            try {
              const persistence = serviceIdentityOf(c.get('sessionPersistence'))
              const events = asRecord(observation)?.events
              if (!Array.isArray(events)) return null
              const revision = revisionOf(observation) ?? coldCursorOf(events)
              const header = asRecord(observation)?.header
              const cached = stateCache.get(wanted.sessionId, entry => entry.revision === revision && entry.persistence === persistence)
              if (cached !== undefined) {
                const kernel = kernelOfCold(c.get('sessionProjectionCache') as CachedSnapshotFace | undefined, header)
                return valueOf(cached.state, false, wanted, kernel, cached.state, deps.cost)
              }
              const state = (await foldLog(events as SessionEvent[], bounds)).state
              stateCache.set(wanted.sessionId, { persistence, revision, state })
              const kernel = kernelOfCold(c.get('sessionProjectionCache') as CachedSnapshotFace | undefined, header)
              return valueOf(state, false, wanted, kernel, state, deps.cost)
            } finally {
              release()
            }
          })
          return reply({ ok: true, value: value ?? null })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
