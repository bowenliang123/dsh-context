import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { asRecord } from './record'
import { mountPostRoute, failure, readBody, reply } from './postRoute'
import { createColdTimelineStates, type ColdTimelineStates } from './coldTimeline'
import type { ColdReadGate } from './coldRead'
import type { DetailChannelGate } from './detail'
import { DetailShadow } from './detailShadow'
import { headerRecordsOf, type HeadersState } from './headers'
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

export function watchDeltaChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
  gate: DetailChannelGate,
  shadow: DetailShadow,
  resolve?: (name: string) => string | undefined,
  coldStates?: ColdTimelineStates,
): void {
  const states = coldStates ?? createColdTimelineStates(ctx, bounds, { coldReads, resolve })
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
        states.touch()
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

          const entry = await states.stateOf(sessionId, { trustedOnly: true })
          if (entry === null) return reply({ ok: true, value: null })
          return reply({ ok: true, value: deltaOf(entry.state, entry.headers, { seq, baseSeq }) })
        } catch (error: unknown) {
          return failure('gateway/internal', error instanceof Error ? error.message : String(error))
        }
      }
    },
  })
}
