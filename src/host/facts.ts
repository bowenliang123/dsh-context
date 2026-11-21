import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { createColdTimelineStates, type ColdTimelineStates } from './coldTimeline'
import type { DetailChannelGate } from './detail'
import type { CachedSnapshotFace, SessionsFace, StateProjectionsFace } from './faces'
import { type ColdReadGate } from './coldRead'
import { buildTimelineHead, eventsOf, requestRowsOf, serveCommand, tailOf } from './foldWire'
import { withCost, type CostSource } from './cost'
import { surfaceWindowOf, type TimelineState } from './foldState'
import { failure, mountPostRoute, readBody, reply } from './postRoute'
import { asRecord } from './record'
import type { SurfaceNodeWindow } from '../shared/types'

export const FACTS_ROUTE = '/api/dsh-context/facts'

const KERNEL_KEYS = ['sessionStats', 'tokenUsage', 'contextBreakdown'] as const

const DETAIL_PARTS = ['requests', 'nodes', 'events', 'files', 'commands', 'spans'] as const

const FACT_PARTS = new Set<string>(['head', 'series', 'stats', ...DETAIL_PARTS])

const WINDOW_FIELDS = ['requestsTail', 'nodesTail', 'eventsTail', 'filesTail', 'commandsTail', 'spansTail'] as const

type FactWindow = Record<typeof WINDOW_FIELDS[number], number>

function windowCapsOf(bounds: FoldBounds): FactWindow {
  return {
    requestsTail: bounds.maxRequestSteps,
    nodesTail: bounds.maxNodes,
    eventsTail: bounds.maxEvents,
    filesTail: bounds.maxFileOps,
    commandsTail: bounds.maxCommands,
    spansTail: bounds.maxSpans,
  }
}

interface FactPartRequest {
  parts: ReadonlySet<string>
  sessionId: string
  window: FactWindow
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

function windowFloorOf(items: readonly { seq: number }[], tail: number, floor: number | undefined): number | undefined {
  if (items.length <= tail) return floor
  return Math.max(floor ?? 0, items[items.length - tail - 1].seq)
}

function surfacePartOf(state: TimelineState, tail: number, archiveTail: number): SurfaceNodeWindow {
  const window = surfaceWindowOf(state, tail, archiveTail)
  return {
    ...window,
    nodes: window.nodes.map(node => ({ ...node })),
    archive: window.archive.map(node => ({ ...node })),
  }
}

function detailPartsOf(state: TimelineState, parts: ReadonlySet<string>, window: FactWindow, archiveTail: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (parts.has('requests')) out.requests = requestRowsOf(state, window.requestsTail)
  if (parts.has('nodes')) out.nodes = surfacePartOf(state, window.nodesTail, archiveTail)
  if (parts.has('events')) out.events = eventsOf(state, state.requests, window.eventsTail)
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
  archiveTail: number,
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
    ...(parts.has('series') ? { series: requestRowsOf(aligned ?? state, window.requestsTail) } : {}),
    ...(parts.has('stats') && kernel.values !== undefined ? { stats: kernel.values } : {}),
    ...(aligned === null ? {} : detailPartsOf(aligned, parts, window, archiveTail)),
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
  coldStates?: ColdTimelineStates
  coldReads?: ColdReadGate
  detailState?: (id: string) => Promise<TimelineState | null>
  idleSweepMs?: number
  cost?: CostSource
}

export function watchFactsChannel(ctx: Context, bounds: FoldBounds, deps: FactsChannelDeps = {}): void {
  const coldStates = deps.coldStates ?? createColdTimelineStates(ctx, bounds, {
    coldReads: deps.coldReads,
    idleSweepMs: deps.idleSweepMs,
  })
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
        coldStates.touch()
        const getSession = ((): ((id: string) => unknown) | undefined => {
          const sessions = c.get('sessions') as SessionsFace | undefined
          return typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
        })()
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
              value: valueOf(state as TimelineState, true, wanted, kernel, detailState, bounds.maxArchiveNodes, deps.cost),
            })
          }
          const entry = await coldStates.stateOf(wanted.sessionId)
          if (entry === null) return reply({ ok: true, value: null })
          const kernel = kernelOfCold(c.get('sessionProjectionCache') as CachedSnapshotFace | undefined, entry.header)
          return reply({
            ok: true,
            value: valueOf(entry.state, false, wanted, kernel, entry.state, bounds.maxArchiveNodes, deps.cost),
          })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
