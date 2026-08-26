/**
 * One live check for the Plugin-info card: lazy with 1h TTL; registries
 * are tried strictly in order — official npm first, npmmirror only as a
 * fallback — and one-at-a-time, never in parallel. Each source's failure
 * (non-ok response, missing/non-string version, network error) advances
 * to the next one; only an all-source failure resolves to null so the
 * card silently keeps its static version.
 */

import { PLUGIN_NAME } from './meta'

const REGISTRY_HOSTS = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

const TTL_MS = 60 * 60 * 1000

let cached: { at: number; promise: Promise<string | null> } | null = null

function readVersion(host: string): Promise<string | null> {
  return fetch(host + '/' + PLUGIN_NAME + '/latest')
    .then(res => (res.ok ? res.json() as Promise<{ version?: unknown }> : null))
    .then(body => (body !== null && typeof body.version === 'string' ? body.version : null))
    .catch(() => null)
}

export function fetchLatestVersion(): Promise<string | null> {
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    cached = {
      at: Date.now(),
      promise: (async () => {
        for (const host of REGISTRY_HOSTS) {
          const v = await readVersion(host)
          if (v !== null) return v
        }
        return null
      })(),
    }
  }
  return cached.promise
}

/** Numeric semver compare (pre-release suffix ignored): is `latest` strictly newer than `current`? */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-', 1)[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}
