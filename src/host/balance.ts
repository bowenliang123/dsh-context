import { asRecord } from './record'
import { amountOf } from '../shared/decode'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { mountPostRoute, reply } from './postRoute'

export const BALANCE_ROUTE = '/api/dsh-context/balance'

const DEEPSEEK_PROVIDER = 'deepseek-official'

const DEEPSEEK_SETTINGS_IDS = ['llm-deepseek', 'web-deepseek-api', 'web-search-deepseek']

const PUBLIC_BASE_URL = 'https://api.deepseek.com'

const FETCH_TIMEOUT_MS = 10_000

interface SettingsHostFace {
  describe?(options?: { redactSecrets?: boolean }): unknown
}

interface LlmHostFace {
  listConfigurableProviders?(): unknown
}

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

interface DeepSeekFacts { baseUrl: string; apiKey: string }

interface DeepSeekRow {
  apiKeyEnv: string
  baseURL?: string
}

function deepseekSettingsIds(ctx: Context): string[] {
  const ids: string[] = []
  const llm = ctx.get('llm') as LlmHostFace | undefined
  if (typeof llm?.listConfigurableProviders === 'function') {
    try {
      const entries = llm.listConfigurableProviders()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          try {
            const record = asRecord(entry)
            if (record === null || record.provider !== DEEPSEEK_PROVIDER) continue
            const id = record.settingsNs
            if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
          } catch {
            continue
          }
        }
      }
    } catch {
    }
  }
  for (const id of DEEPSEEK_SETTINGS_IDS) if (!ids.includes(id)) ids.push(id)
  return ids
}

function deepseekRowsOf(ctx: Context): DeepSeekRow[] {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  if (typeof settings?.describe !== 'function') return []
  let rows: unknown
  try {
    rows = settings.describe({ redactSecrets: true })
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    try {
      const record = asRecord(row)
      if (record === null) continue
      const id = record.ns
      const value = asRecord(record.value)
      if (typeof id !== 'string' || value === null || byId.has(id)) continue
      byId.set(id, value)
    } catch {
      continue
    }
  }
  const deepseekRows: DeepSeekRow[] = []
  for (const id of deepseekSettingsIds(ctx)) {
    const value = byId.get(id)
    if (value === undefined) continue
    const apiKeyEnv = value.apiKeyEnv
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') continue
    const baseURL = value.baseURL
    deepseekRows.push({
      apiKeyEnv,
      baseURL: typeof baseURL === 'string' && baseURL !== '' ? baseURL : undefined,
    })
  }
  return deepseekRows
}

function platformRootOf(baseURL: string | undefined): string {
  if (baseURL === undefined) return PUBLIC_BASE_URL
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return PUBLIC_BASE_URL
    return url.origin
  } catch {
    return PUBLIC_BASE_URL
  }
}

async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  const tried = new Set<string>()
  for (const row of deepseekRowsOf(ctx)) {
    if (tried.has(row.apiKeyEnv)) continue
    tried.add(row.apiKeyEnv)
    let hit: { value?: unknown } | undefined
    try {
      hit = await resolve(row.apiKeyEnv)
    } catch {
      continue
    }
    const apiKey = typeof hit?.value === 'string' ? hit.value : ''
    if (apiKey === '') continue
    return { baseUrl: platformRootOf(row.baseURL), apiKey }
  }
  return null
}

export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
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

type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

const inFlight = new Map<string, Promise<PlatformBalance | null>>()

export function resetBalance(): void {
  inFlight.clear()
}

async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  const key = facts.baseUrl + '\u0000' + facts.apiKey
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending
  const promise = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
    }
    return value
  })()
  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}

export function watchBalanceChannel(ctx: Context): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: BALANCE_ROUTE,
    label: 'dsh-context: balance route',
    handler: () => async (): Promise<Response> => {
      const facts = await resolveFacts(ctx)
      const value = facts !== null ? await readBalance(facts) : null
      return reply({ ok: true, value })
    },
  })
}
