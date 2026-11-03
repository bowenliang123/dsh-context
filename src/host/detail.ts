import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { asRecord } from './record'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { buildTimelineDetail, buildTimelineHead } from './foldWire'
import { DetailShadow, foldLog, observeFaceOf } from './detailShadow'
import type { ContextTimelineDetail, Snapshot } from '../shared/types'
import type { TimelineState } from './foldState'

export const DETAIL_ROUTE = '/api/dsh-context/detail'

const PAYLOAD_CACHE_MAX = 4

interface ColdPayload {
  persistence: unknown
  revision: string
  value: ContextTimelineDetail
}

function revisionOf(observation: unknown): string | undefined {
  const revision = (observation as { revision?: unknown } | null)?.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

function headOfDetail(detail: { rev: number; head?: unknown }): { rev: number; head?: unknown } {
  return { rev: detail.rev, head: detail.head }
}

function headPayloadOf(state: TimelineState): { rev: number; head: Snapshot } {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state) }
}

export interface DetailChannelGate {
  live: boolean
  retain(key: string, registration: unknown): void
  stateOf(session: unknown, key: string): unknown
}

interface ProjectionHandleLike {
  stateOf(session: unknown): unknown
}

function handleOf(value: unknown): ProjectionHandleLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const stateOf = (value as { stateOf?: unknown }).stateOf
  return typeof stateOf === 'function' ? value as ProjectionHandleLike : undefined
}

export function createDetailGate(ctx: Context): DetailChannelGate {
  const handles = new Map<string, ProjectionHandleLike>()
  return {
    live: false,
    retain(key: string, registration: unknown): void {
      if (registration === null || (typeof registration !== 'object' && typeof registration !== 'function')) return
      const then = (registration as { then?: unknown }).then
      if (typeof then !== 'function') return
      void Promise.resolve(registration as Promise<unknown>).then(
        (handle) => {
          const retained = handleOf(handle)
          if (retained !== undefined) handles.set(key, retained)
        },
        (error: unknown) => { ctx.logger.error(error) },
      )
    },
    stateOf(session: unknown, key: string): unknown {
      const handle = handles.get(key)
      if (handle !== undefined) return handle.stateOf(session)
      const projections = ctx.sessionProjections as unknown as { stateOf?(session: unknown, key: string): unknown } | undefined
      return typeof projections?.stateOf === 'function' ? projections.stateOf(session, key) : undefined
    },
  }
}

interface SessionsHostFace {
  get?(id: string): unknown
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

export function watchDetailChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate = makeColdReadGate(),
  gate: DetailChannelGate = createDetailGate(ctx),
): DetailChannelGate {
  const payloads = new Map<string, ColdPayload>()
  const shadow = new DetailShadow(ctx, bounds, coldReads, () => observeFaceOf(ctx))
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return

    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let headOnly = false
      try {
        const body: unknown = await request.json()
        sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
        headOnly = body !== null && typeof body === 'object' && (body as { head?: unknown }).head === true
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          const state = gate.stateOf(session, 'contextTimeline') as TimelineState | undefined
          if (state === undefined) return reply({ ok: true, value: null })
          if (headOnly) return reply({ ok: true, value: headPayloadOf(state) })
          const detailState = await shadow.stateOf(sessionId)
          if (detailState === null) return reply({ ok: true, value: null })
          return reply({ ok: true, value: buildTimelineDetail(detailState, bounds) })
        }
        const observe = observeFaceOf(ctx)
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          try {
            const persistence: unknown = ctx.get('sessionPersistence')
            const revision = revisionOf(observation)
            if (revision !== undefined) {
              const hit = payloads.get(sessionId)
              if (hit !== undefined && hit.revision === revision && hit.persistence === persistence) {
                payloads.delete(sessionId)
                payloads.set(sessionId, hit)
                return headOnly ? headOfDetail(hit.value) : hit.value
              }
            }
            const events = asRecord(observation)?.events
            if (!Array.isArray(events)) return null
            const state = (await foldLog(events, bounds)).state
            if (revision !== undefined) {
              const detail = buildTimelineDetail(state, bounds)
              payloads.delete(sessionId)
              payloads.set(sessionId, { persistence, revision, value: detail })
              for (const oldest of payloads.keys()) {
                if (payloads.size <= PAYLOAD_CACHE_MAX) break
                payloads.delete(oldest)
              }
              return headOnly ? headOfDetail(detail) : detail
            }
            if (headOnly) return headPayloadOf(state)
            return buildTimelineDetail(state, bounds)
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    if (!registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, DETAIL_ROUTE, handler, 'dsh-context: detail route')) return
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}
