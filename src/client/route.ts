import { PLUGIN_NAME } from './meta'
import { asRecord } from './wire'

export class RouteError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'RouteError'
  }
}

interface RouteOptions {
  signal?: AbortSignal
  label?: string
}

type RouteDecoder<T> = (value: unknown) => T | null

export interface RouteEnvelope<T> {
  value: T | null
  revision?: string
  unchanged: boolean
}

async function readEnvelope(route: string, body: unknown, options: RouteOptions): Promise<Record<string, unknown>> {
  const label = options.label ?? route
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) throw new RouteError(`${PLUGIN_NAME}: ${label} route HTTP ${response.status}`, response.status)
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new RouteError(`${PLUGIN_NAME}: ${label} read failed`)
  }
  const envelope = asRecord(parsed)
  if (envelope === null || envelope.ok !== true) throw new RouteError(`${PLUGIN_NAME}: ${label} read failed`)
  return envelope
}

function revisionOf(envelope: Record<string, unknown>): string | undefined {
  const revision = envelope.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

export async function postRouteEnvelope<T>(
  route: string,
  body: unknown,
  decode: RouteDecoder<T>,
  options: RouteOptions = {},
): Promise<RouteEnvelope<T>> {
  const envelope = await readEnvelope(route, body, options)
  const revision = revisionOf(envelope)
  if (envelope.unchanged === true) {
    return { value: null, unchanged: true, ...(revision === undefined ? {} : { revision }) }
  }
  if (envelope.value === null) return { value: null, unchanged: false, ...(revision === undefined ? {} : { revision }) }
  const value = decode(envelope.value)
  if (value === null) throw new RouteError(`${PLUGIN_NAME}: ${options.label ?? route} read malformed`)
  return { value, unchanged: false, ...(revision === undefined ? {} : { revision }) }
}

export async function postRoute<T>(
  route: string,
  body: unknown,
  decode: RouteDecoder<T>,
  options: RouteOptions = {},
): Promise<T | null> {
  const read = await postRouteEnvelope(route, body, decode, options)
  return read.value
}

export async function postRouteQuietly<T>(
  route: string,
  body: unknown,
  decode: RouteDecoder<T>,
  options: RouteOptions = {},
): Promise<T | null> {
  try {
    return await postRoute(route, body, decode, options)
  } catch {
    return null
  }
}
