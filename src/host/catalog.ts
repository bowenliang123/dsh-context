import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pricesBookOf, type ModelBook } from '../shared/pricing'
import { asRecord } from './record'

export const CATALOG_TTL_MS = 60 * 60 * 1000

const PRICES_FAILURE_BACKOFF_MS = 30_000

const VERSION_URLS = [
  'https://registry.npmjs.org/dsh-context/latest',
  'https://registry.npmmirror.com/dsh-context/latest',
]

const PRICES_URL = 'https://models.dev/api.json'

const FETCH_TIMEOUT_MS = 8_000

export type CatalogFetcher = (url: string, init: RequestInit) => Promise<Response>

export interface CatalogOptions {
  fetch?: CatalogFetcher
  now?: () => number
  currentVersion?: string
  ttlMs?: number
}

export interface CatalogEntry<T> {
  value: T | null
  ready: boolean
  failed: boolean
  checkedAt: number
}

interface Slot<T> {
  value: T | null
  at: number
  failed: boolean
  inflight: Promise<void> | null
}

export interface CatalogService {
  ensure(): void
  book(): ModelBook | null
  pricesVersion(): number
  version(): Promise<CatalogEntry<string>>
  prices(): Promise<CatalogEntry<void>>
  currentVersion(): string | undefined
  dispose(): void
}

function slotOf<T>(): Slot<T> {
  return { value: null, at: 0, failed: false, inflight: null }
}

function readVersion(body: unknown): string | null {
  const version = asRecord(body)?.version
  return typeof version === 'string' && version !== '' ? version : null
}

export function createCatalogService(options: CatalogOptions = {}): CatalogService {
  const fetcher: CatalogFetcher = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS
  const current = options.currentVersion ?? currentVersionOf()
  const version = slotOf<string>()
  const prices = slotOf<void>()
  const books = { book: null as ModelBook | null, failed: false, version: 0 }
  let disposed = false

  const fresh = (at: number): boolean => at !== 0 && now() - at < ttlMs

  const readJson = async (url: string): Promise<unknown> => {
    const response = await fetcher(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`catalog fetch ${response.status}`)
    return response.json()
  }

  const ensureVersion = (): void => {
    if (disposed || version.inflight !== null || fresh(version.at)) return
    version.inflight = (async () => {
      try {
        for (const url of VERSION_URLS) {
          try {
            const latest = readVersion(await readJson(url))
            if (latest === null) continue
            version.value = latest
            version.at = now()
            version.failed = false
            return
          } catch {
          }
        }
        version.failed = true
        version.at = now()
      } finally {
        version.inflight = null
      }
    })()
  }

  const ensurePrices = (): void => {
    if (disposed || prices.inflight !== null || books.book !== null && fresh(prices.at)) return
    if (books.book === null && books.failed && prices.at !== 0 && now() - prices.at < PRICES_FAILURE_BACKOFF_MS) return
    prices.inflight = (async () => {
      try {
        const book = pricesBookOf(await readJson(PRICES_URL))
        if (book === null) {
          books.failed = true
          prices.at = now()
          return
        }
        books.book = book
        books.failed = false
        prices.at = now()
        books.version++
      } catch {
        books.failed = true
        prices.at = now()
      } finally {
        prices.inflight = null
      }
    })()
  }

  return {
    ensure(): void {
      ensurePrices()
    },
    book(): ModelBook | null {
      return books.book
    },
    pricesVersion(): number {
      return books.version
    },
    async version(): Promise<CatalogEntry<string>> {
      ensureVersion()
      if (version.inflight !== null) await version.inflight
      return { value: version.value, ready: version.value !== null, failed: version.failed, checkedAt: version.at }
    },
    async prices(): Promise<CatalogEntry<void>> {
      ensurePrices()
      if (prices.inflight !== null) await prices.inflight
      return { value: null, ready: books.book !== null, failed: books.failed, checkedAt: prices.at }
    },
    currentVersion(): string | undefined {
      return current
    },
    dispose(): void {
      disposed = true
      books.book = null
    },
  }
}

function currentVersionOf(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('dsh-context/package.json')), 'utf8'))
    const version = asRecord(parsed)?.version
    /* v8 ignore next 1 */
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    /* v8 ignore next 1 */
    return undefined
  }
}
