/**
 * The DeepSeek open-platform BALANCE route — the data behind the Context
 * Dashboard's header capsule (client/balance.ts).
 *
 * The platform exposes exactly one account endpoint (`GET /user/balance`);
 * reaching it needs the API key, which by design never rides to the browser,
 * so the HOST reads it and serves the redacted figures. The connection facts
 * resolve per request, exactly as the DeepSeek provider serves its own
 * requests: its settings row carries the credential ref and the optional
 * endpoint override, read through whichever face the running line serves
 * (deepseekSectionOf), and the credentials service resolves the ref to the
 * key. Any missing fact — the provider absent, no settings service, no key —
 * answers a typed `null`, as does a failed or malformed platform read: the
 * capsule renders nothing rather than a stale figure.
 *
 * The transport is Connection's fetch-route registry (the same authenticated
 * `/api` fence host/detail.ts mounts), registered through a deferred inject
 * so load order never matters and a harness without the registry simply
 * never arms the route. Identical reads share one outbound fetch while it is
 * in flight, and nothing outlives it: the platform's balance moves with every
 * billed request, so a remembered figure would disagree with the console page
 * the capsule links to.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'

/** The plugin's balance route, under the authenticated `/api` fence. */
export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The settings id the DeepSeek API-key provider has served its connection
 * section under: the V3 registered namespace, kept as the entry id on V4+
 * product profiles. */
const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** llm-deepseek's default credential ref (the env-var name its section resolves). */
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** The platform's public API root (llm-deepseek's PUBLIC_BASE_URL default). */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** One platform read's whole budget — never worth blocking the route longer. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * The harness `settings` service, as far as the route consumes it. The face
 * is generation-specific: V3 reads a registered section back (`get`), while
 * V4+ retired that face and projects every configurable entry instead
 * (`describe`) — the route folds over whichever the running line serves.
 */
interface SettingsHostFace {
  get?(ns: string): unknown
  describe?(): unknown
}

/** The harness `credentials` service, as far as the route consumes it. */
interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

/** The host `connection` service, as far as the route consumes it (host/detail.ts's seam). */
interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

/** Narrow an unknown value to a string-keyed record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** One platform amount ('110.00', or an already-numeric producer variant), or null. */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** The connection facts one read needs, as far as runtime can prove them. */
interface DeepSeekFacts { baseUrl: string; apiKey: string }

/**
 * The DeepSeek API-key provider's settings section, read through whichever
 * face the running line serves. V3's `get` reads the registered
 * `llm-deepseek` section directly; V4+ retired that face, so its `describe()`
 * projection is folded instead — the provider's row is the one whose served
 * value declares the top-level `apiKeyEnv` credential ref (the volatile shape
 * only that provider declares at the section root), preferred under the entry
 * ids the generations have served it as (`llm-deepseek` on product profiles,
 * `llm-deepseek-api-key` elsewhere). Rows fold in isolation — a hostile row
 * drops whole, valid siblings keep serving — and a describe that throws is no
 * section at all.
 */
function deepseekSectionOf(ctx: Context): Record<string, unknown> | null {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  const section = typeof settings?.get === 'function' ? asRecord(settings.get(DEEPSEEK_SETTINGS_NS)) : null
  if (section !== null) return section
  if (typeof settings?.describe !== 'function') return null
  try {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return null
    let shaped: Record<string, unknown> | null = null
    for (const row of rows) {
      try {
        const record = asRecord(row)
        if (record === null) continue
        const value = asRecord(record.value)
        if (value === null || typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv === '') continue
        if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === 'llm-deepseek-api-key') return value
        shaped ??= value
      } catch {
        continue
      }
    }
    return shaped
  } catch {
    return null
  }
}

/**
 * Resolve the DeepSeek connection facts exactly as llm-deepseek serves its
 * requests: its settings row for the credential ref and endpoint, the
 * credentials service for the key. `null` whenever any fact is missing —
 * the platform is simply not configured for this deployment.
 */
async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const section = deepseekSectionOf(ctx)
  if (section === null) return null
  const apiKeyEnv = typeof section.apiKeyEnv === 'string' && section.apiKeyEnv !== ''
    ? section.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const baseUrl = typeof section.baseURL === 'string' && section.baseURL !== ''
    ? section.baseURL
    : PUBLIC_BASE_URL
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  let hit: { value?: unknown } | undefined
  try {
    hit = await resolve(apiKeyEnv)
  } catch {
    return null
  }
  const apiKey = typeof hit?.value === 'string' ? hit.value : ''
  return apiKey === '' ? null : { baseUrl, apiKey }
}

/**
 * Narrow the platform's payload to the wire value (the boundary rigor every
 * parser owes untrusted input): each entry's currency and parts are re-proved
 * and the total is the two summed — the platform's own `total_balance` rounds
 * independently of them, so it can land a cent away from what the breakdown
 * beside it adds up to, and the viewer's arithmetic is the authority. An entry
 * failing the shape drops whole, and a payload with no valid entry is no
 * balance at all.
 */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // Bounded catch: a hostile entry may throw on property access — it drops
    // whole, and the entries that prove their shape keep serving.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === ''
        || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

/** The outbound platform fetch (test seam; the real read). */
type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

/** The outbound platform fetch through the real global fetch. */
const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

/** Test seam: replace the platform fetch; null restores the default. */
export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

/** Drop any in-flight read (test isolation). */
export function resetBalance(): void {
  inFlight = null
}

/**
 * One platform read for these facts, shared by the identical reads already in
 * flight. Each read that finds none goes to the platform: the account's
 * balance moves with every request the harness bills, so a remembered figure
 * would disagree with the console page the capsule links to. The client's own
 * open-time read is the rate limit. Every failure path — transport, timeout,
 * non-ok status, malformed payload — resolves `null`; the route never throws
 * into the transport.
 */
async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl.replace(/\/+$/, '') + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
      // Absent on purpose: any failure serves null — the capsule stays hidden.
    }
    return value
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // The only assignment point is guarded by `inFlight !== null`, so the
    // settled read's own clear is always the current value's.
    inFlight = null
  }
}

/**
 * Serve the balance route whenever the connection service composes (see
 * host/detail.ts for the load-order contract). The registration rides the
 * injected fiber: the service unloading withdraws the route. A rejecting
 * registry only closes the capsule — never the plugin.
 */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) return

    const handler = async (): Promise<Response> => {
      const facts = await resolveFacts(ctx)
      const value = facts !== null ? await readBalance(facts) : null
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    try {
      c.effect(() => register({
        path: BALANCE_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), 'dsh-context: balance route')
    } catch {
      return
    }
  })
}
