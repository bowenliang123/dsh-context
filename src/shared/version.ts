export const BASELINE_DSH_VERSION = '0.2.0-rc.2'

function channelRank(channel: 'alpha' | 'beta' | 'rc'): number {
  return channel === 'rc' ? 3 : channel === 'beta' ? 2 : 1
}
const RELEASE_RANK = 4

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  rank: number
  serial: number
}

export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim())
  if (match === null) return null
  const channel = match[4]?.toLowerCase() as 'alpha' | 'beta' | 'rc' | undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rank: channel === undefined ? RELEASE_RANK : channelRank(channel),
    serial: match[5] ? Number(match[5]) : 0,
  }
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.rank !== b.rank) return a.rank - b.rank
  return a.serial - b.serial
}

export function meetsBaseline(version: string, baseline: string = BASELINE_DSH_VERSION): boolean {
  const v = parseVersion(version)
  const b = parseVersion(baseline)
  if (v === null || b === null) return true
  return compareParsed(v, b) >= 0
}

export function isNewerRelease(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (a === null || b === null) return false
  return compareParsed(a, b) > 0
}
