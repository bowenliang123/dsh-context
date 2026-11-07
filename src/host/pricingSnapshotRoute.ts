import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { asRecord } from './record'
import { mountPostRoute } from './postRoute'

export const PRICING_SNAPSHOT_ROUTE = '/api/dsh-context/pricing-snapshot'
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_BOOK_CHARS = 2_000_000
const MAX_KEY_CHARS = 20_000
const MAX_ENTRIES = 20_000
const MAX_ENTRY_CHARS = 4_000_000
const MAX_PENDING_REQUESTS = 4
const DOMAIN_NAME = 'dsh_context_pricing'

export interface PricingSnapshot {
  version: 1
  revision: string
  book?: { at: number; data: unknown }
  entries: [string, number | null][]
}

interface TableLike {
  get(key: string): unknown
  put(key: string, value: PricingSnapshot): Promise<unknown>
  update(key: string, change: (current: unknown) => PricingSnapshot): Promise<unknown>
}

interface DomainLike {
  table(name: string): unknown
  close(): Promise<unknown>
}

interface FacilityLike {
  get(name: string): unknown
  open(spec: unknown): Promise<unknown>
}

function emptySnapshot(): PricingSnapshot {
  return { version: 1, revision: '', entries: [] }
}

function boundedEntries(entries: readonly [string, number | null][]): [string, number | null][] {
  const values = new Map<string, number | null>()
  let chars = 0
  for (const [key, value] of entries) {
    if (values.delete(key)) chars -= key.length
    values.set(key, value)
    chars += key.length
    while (values.size > MAX_ENTRIES || chars > MAX_ENTRY_CHARS) {
      const oldest = values.keys().next().value as string
      values.delete(oldest)
      chars -= oldest.length
    }
  }
  return [...values]
}

function snapshotOf(value: unknown): PricingSnapshot | null {
  const record = asRecord(value)
  if (record === null || record.version !== 1 || typeof record.revision !== 'string'
    || record.revision.length > MAX_BOOK_CHARS || !Array.isArray(record.entries)) return null
  const entries: [string, number | null][] = []
  for (const entry of record.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
      || entry[0].length > MAX_KEY_CHARS
      || (entry[1] !== null && (typeof entry[1] !== 'number' || !Number.isFinite(entry[1]) || entry[1] < 0))) return null
    entries.push([entry[0], entry[1] as number | null])
  }
  let book: PricingSnapshot['book']
  if (record.book !== undefined) {
    const raw = asRecord(record.book)
    if (raw === null || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0
      || !Object.hasOwn(raw, 'data')) return null
    try {
      const json = JSON.stringify(raw.data)
      if (json.length > MAX_BOOK_CHARS) return null
      book = { at: raw.at, data: JSON.parse(json) }
    } catch {
      return null
    }
  }
  return { version: 1, revision: record.revision, ...(book === undefined ? {} : { book }), entries: boundedEntries(entries) }
}

function mergeSnapshot(current: PricingSnapshot, incoming: PricingSnapshot): PricingSnapshot {
  if (current.revision !== incoming.revision) {
    return incoming.book !== undefined && incoming.book.at >= (current.book?.at ?? -1) ? incoming : current
  }
  const book = incoming.book !== undefined && incoming.book.at >= (current.book?.at ?? -1) ? incoming.book : current.book
  return {
    version: 1,
    revision: current.revision,
    ...(book === undefined ? {} : { book }),
    entries: boundedEntries([...current.entries, ...incoming.entries]),
  }
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function aborted(): Response {
  return reply({ ok: false, error: { code: 'dsh-context/aborted', message: 'pricing snapshot request aborted' } }, 499)
}

function invalid(): Response {
  return reply({ ok: false, error: { code: 'dsh-context/bad-request', message: 'invalid pricing snapshot' } }, 400)
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (reader === undefined) return undefined
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        return undefined
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    reader.releaseLock()
  }
}

async function openTable(facility: FacilityLike, retain: (domain: DomainLike) => void): Promise<TableLike | undefined> {
  try {
    let domain = asRecord(facility.get(DOMAIN_NAME))
    if (domain === null) {
      domain = asRecord(await facility.open({
        name: DOMAIN_NAME,
        version: 1,
        layout: 'per-record',
        tables: { snapshots: { valueSchema: z.unknown().transform(value => snapshotOf(value) ?? emptySnapshot()) } },
      }))
      if (domain !== null && typeof domain.close === 'function') retain(domain as unknown as DomainLike)
    }
    if (domain === null || typeof domain.table !== 'function') return undefined
    const table = asRecord((domain.table as (name: string) => unknown).call(domain, 'snapshots'))
    if (table === null || typeof table.get !== 'function' || typeof table.put !== 'function' || typeof table.update !== 'function') return undefined
    const face = table as unknown as TableLike
    if (face.get('current') === undefined) await face.put('current', emptySnapshot())
    return face
  } catch {
    return undefined
  }
}

export function watchPricingSnapshotRoute(ctx: Context): () => void {
  const fiber = mountPostRoute({
    ctx,
    deps: ['connection'],
    path: PRICING_SNAPSHOT_ROUTE,
    label: 'dsh-context: pricing snapshot route',
    handler(c) {
      let memory = emptySnapshot()
      let ready: Promise<TableLike | undefined> = Promise.resolve(undefined)
      let chain: Promise<unknown> = Promise.resolve()
      c.effect(() => {
        let owned: DomainLike | undefined
        const facility = asRecord(c.get('storageDomain'))
        if (facility !== null && typeof facility.get === 'function' && typeof facility.open === 'function') {
          ready = openTable(facility as unknown as FacilityLike, (domain) => { owned = domain })
        }
        return async () => {
          await ready
          await chain
          await owned?.close()
        }
      }, 'dsh-context: pricing snapshot domain')
      let persistenceFailed = false
      let pending = 0
      const serve = async (incoming: PricingSnapshot | undefined, signal: AbortSignal): Promise<Response> => {
        const table = persistenceFailed ? undefined : await ready
        if (signal.aborted) return aborted()
        if (table !== undefined) {
          try {
            const current = snapshotOf(table.get('current')) ?? emptySnapshot()
            memory = current
            if (incoming !== undefined) memory = snapshotOf(await table.update('current', value => mergeSnapshot(snapshotOf(value) ?? emptySnapshot(), incoming))) ?? current
            return reply({ ok: true, value: memory })
          } catch {
            persistenceFailed = true
          }
        }
        if (incoming !== undefined) memory = mergeSnapshot(memory, incoming)
        return reply({ ok: true, value: memory })
      }
      const parseAndServe = async (request: Request): Promise<Response> => {
        let incoming: PricingSnapshot | undefined
        try {
          const body = asRecord(await readBody(request))
          if (body === null) return invalid()
          if (Object.hasOwn(body, 'write')) {
            const parsed = snapshotOf(body.write)
            if (parsed === null) return invalid()
            incoming = parsed
          }
        } catch {
          return invalid()
        }
        return serve(incoming, request.signal)
      }
      return (request) => {
        if (pending >= MAX_PENDING_REQUESTS) {
          return Promise.resolve(reply({ ok: false, error: { code: 'dsh-context/busy', message: 'pricing snapshot request queue full' } }, 503))
        }
        pending++
        const result = chain.then(() => request.signal.aborted ? aborted() : parseAndServe(request)).finally(() => { pending-- })
        chain = Promise.allSettled([result])
        return result
      }
    },
  })
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}
