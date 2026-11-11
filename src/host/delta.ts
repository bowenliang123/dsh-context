import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { asRecord } from './record'
import { mountPostRoute, failure, leaseOf, observeOf, readBody, reply, revisionOf } from './postRoute'
import type { ColdReadGate } from './coldRead'
import type { DetailChannelGate } from './detail'
import { DetailShadow, foldLog } from './detailShadow'
import { makeFoldCache } from './foldCache'
import { createContextHeadersDefinition, headerRecordsOf, type HeadersState } from './headers'
import type { TimelineState } from './foldState'
import { assemble, type AssembleSource } from '../shared/assemble'
import { incrementOf } from '../shared/increment'
import { contextDeltaOf, type ContextDelta } from '../shared/delta'
import type { ContextHeaders, HeaderRecord } from '../shared/types'

export const DELTA_ROUTE = '/api/dsh-context/delta'

interface DeltaRequest {
  seq: number | null
  baseSeq: number | null
}

interface ColdState {
  revision: string
  state: TimelineState
  headers: HeaderRecord[]
}

function seqOf(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function deltaOf(
  state: TimelineState,
  headers: readonly HeaderRecord[],
  request: DeltaRequest,
): ContextDelta {
  const source: AssembleSource = {
    nodes: state.surface,
    archive: state.archived,
    ...(state.systems !== undefined ? { systems: state.systems } : {}),
  }
  const contextHeaders: ContextHeaders = { headers: [...headers] }
  const view = assemble(source, contextHeaders, request.seq)
  const base = request.baseSeq === null ? null : assemble(source, contextHeaders, request.baseSeq)
  const delta = contextDeltaOf(incrementOf(view, base), view)
  if (request.seq === null) delta.viewNodes = []
  return delta
}

function headersOfState(
  value: unknown,
  resolve?: (name: string) => string | undefined,
): HeaderRecord[] {
  const state = value as HeadersState | undefined
  return state === undefined || !Array.isArray(state.headers) ? [] : headerRecordsOf(state, resolve)
}

function headersOfEvents(
  events: readonly unknown[],
  resolve?: (name: string) => string | undefined,
): HeaderRecord[] {
  const definition = createContextHeadersDefinition(resolve)
  let state = definition.init()
  for (const event of events) {
    if (event !== null && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string') {
      state = definition.apply(state, event as never)
    }
  }
  return headerRecordsOf(state, resolve)
}

export function watchDeltaChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  gate: DetailChannelGate,
  shadow: DetailShadow,
  resolve?: (name: string) => string | undefined,
): void {
  const cache = makeFoldCache<ColdState>(ctx, { maxEntries: 2 })
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessions'],
    path: DELTA_ROUTE,
    label: 'dsh-context: delta route',
    gate,
    handler: (c) => {
      const sessions = c.get('sessions') as { get?(id: string): unknown } | undefined
      const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined

      return async (request: Request): Promise<Response> => {
        cache.touch()
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = asRecord(read.body)
        const sessionId = body?.sessionId
        const seq = seqOf(body?.seq)
        const baseSeq = seqOf(body?.baseSeq)
        if (typeof sessionId !== 'string' || sessionId === '' || seq === undefined || baseSeq === undefined) {
          return failure('dsh-context/bad-request', 'sessionId, seq and baseSeq are required')
        }

        try {
          const session = getSession?.(sessionId)
          if (session !== undefined && session !== null) {
            const state = await shadow.stateOf(sessionId)
            if (state === null) return reply({ ok: true, value: null })
            const headers = headersOfState(gate.stateOf(session, 'contextHeaders'), resolve)
            return reply({ ok: true, value: deltaOf(state, headers, { seq, baseSeq }) })
          }

          const observe = observeOf(c)
          if (observe === undefined) return reply({ ok: true, value: null })
          const value = await coldReads.admit(async () => {
            const observation = await observe(sessionId, { projectionMode: 'none' })
            const release = leaseOf(observation)
            try {
              const revision = revisionOf(observation)
              if (revision !== undefined) {
                const hit = cache.get(sessionId, entry => entry.revision === revision)
                if (hit !== undefined) return deltaOf(hit.state, hit.headers, { seq, baseSeq })
              }
              const events = asRecord(observation)?.events
              if (!Array.isArray(events)) return null
              const state = (await foldLog(events, bounds)).state
              const headers = headersOfEvents(events, resolve)
              if (revision !== undefined) cache.set(sessionId, { revision, state, headers })
              return deltaOf(state, headers, { seq, baseSeq })
            } finally {
              release()
            }
          })
          return reply({ ok: true, value: value ?? null })
        } catch (error: unknown) {
          return failure('gateway/internal', error instanceof Error ? error.message : String(error))
        }
      }
    },
  })
}
