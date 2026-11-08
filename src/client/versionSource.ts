import { useEffect, useState } from 'react'
import { VERSION_ROUTE } from './apiRoutes'
import { postRoute } from './route'
import { asRecord } from './services'
import { PLUGIN_VERSION } from './meta'

const CACHE_TTL_MS = 60 * 60 * 1000

const RETRY_MS = 30_000

const RETRY_MAX = 5

interface VersionRead {
  ready: boolean
  failed: boolean
  checkedAt: number
  current: string | null
  latest?: string
}

function versionOf(value: unknown): VersionRead | null {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return null
  if (typeof data.ready !== 'boolean' || typeof data.failed !== 'boolean' || typeof data.checkedAt !== 'number') return null
  return {
    ready: data.ready,
    failed: data.failed,
    checkedAt: data.checkedAt,
    current: typeof data.current === 'string' ? data.current : null,
    ...(typeof data.latest === 'string' && data.latest !== '' ? { latest: data.latest } : {}),
  }
}

let cached: { at: number; read: VersionRead | null } | null = null
let inflight: Promise<VersionRead | null> | null = null

function parseVersion(version: string): number[] {
  return version.replace(/^v/, '').split('-', 1)[0].split('.').map(n => parseInt(n, 10) || 0)
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

function ttlOf(read: VersionRead | null): number {
  return read?.ready === true ? CACHE_TTL_MS : RETRY_MS
}

export async function readVersion(): Promise<VersionRead | null> {
  if (cached !== null && Date.now() - cached.at < ttlOf(cached.read)) return cached.read
  if (inflight !== null) return inflight
  inflight = postRoute(VERSION_ROUTE, {}, versionOf, { label: 'version' })
    .then((read) => {
      cached = { at: Date.now(), read }
      return read
    }, () => {
      cached = { at: Date.now(), read: null }
      return null
    })
    .finally(() => { inflight = null })
  return inflight
}

export function resetVersionSource(): void {
  cached = null
  inflight = null
}

export function useNewerVersion(): string | null {
  const [latest, setLatest] = useState<string | null>(null)
  useEffect(() => {
    if (PLUGIN_VERSION.includes('-dev')) return
    let on = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const read = (): void => {
      void readVersion().then((entry) => {
        if (!on) return
        if (entry?.ready === true && entry.latest !== undefined) {
          if (isNewerVersion(entry.latest, PLUGIN_VERSION)) setLatest(entry.latest)
          return
        }
        attempts++
        if (attempts >= RETRY_MAX) return
        timer = setTimeout(read, RETRY_MS)
      })
    }
    read()
    return () => {
      on = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
  return latest
}
