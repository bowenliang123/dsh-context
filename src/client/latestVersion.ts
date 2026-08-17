/**
 * Latest published version of this plugin on the npm registry — the one
 * live check the Plugin info card performs. Fetched lazily on the first
 * card mount and cached module-wide (one request per page load). Every
 * failure mode (offline, CSP-blocked, non-200, malformed body) narrows to
 * null = no upgrade hint, so the card silently keeps its static version.
 */

import { PLUGIN_NAME } from './meta'

const REGISTRY_URL = 'https://registry.npmjs.org/' + PLUGIN_NAME + '/latest'

let cached: Promise<string | null> | null = null

export function fetchLatestVersion(): Promise<string | null> {
  if (!cached) {
    cached = fetch(REGISTRY_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body && typeof body.version === 'string' ? body.version : null))
      .catch(() => null)
  }
  return cached
}

/** Numeric semver compare (pre-release suffix ignored): is `latest` strictly newer than `current`? */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-', 1)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}
