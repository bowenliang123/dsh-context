/**
 * One live check for the Plugin-info card: lazy with 1h TTL; the registry
 * list is tried in order (official npm first, npmmirror as a fallback) and
 * any failure — network error, non-ok response, missing/non-string version —
 * narrows to null for that source and moves on. Every source failing
 * resolves to null so the card silently keeps its static version.
 */

import { PLUGIN_NAME } from './meta'

const REGISTRY_URLS = [
  'https://registry.npmjs.org/' + PLUGIN_NAME + '/latest',
  'https://registry.npmmirror.com/' + PLUGIN_NAME + '/latest',
]

const TTL_MS = 60 * 60 * 1000

let cached: { at: number; promise: Promise<string | null> } | null = null

function readVersion(url: string): Promise<string | null> {
  return fetch(url)
    .then(res => (res.ok ? res.json() as Promise<{ version?: unknown }> : null))
    .then(body => (body !== null && typeof body.version === 'string' ? body.version : null))
    .catch(() => null)
}

export function fetchLatestVersion(): Promise<string | null> {
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    cached = {
      at: Date.now(),
      promise: (async () => {
        for (const url of REGISTRY_URLS) {
          const v = await readVersion(url)
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
