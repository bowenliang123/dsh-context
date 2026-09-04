/**
 * The harness-version gate's shared arithmetic — the supported dsh baseline
 * and the version compare behind it. Runtime code shared by BOTH halves (the
 * host probes and gates; the client displays what the wire record carries),
 * so this module must stay dependency-free.
 *
 * The baseline mirrors the support matrix (AGENTS.md "Compatibility" and the
 * package's `dsh.compatibility.dshReleases` declaration): the oldest dsh
 * release this plugin works on. A harness BELOW it gets the fallback units
 * (host/fallback.ts) instead of the real folds.
 */

/** The oldest supported dsh release (see the matrix note above). */
export const BASELINE_DSH_VERSION = '0.1.2-rc.1'

/**
 * Release-channel rank at an equal X.Y.Z: a final release outranks its
 * release candidates, which outrank betas, which outrank alphas
 * (正式版 > RC > Beta > Alpha).
 */
function channelRank(channel: 'alpha' | 'beta' | 'rc'): number {
  return channel === 'rc' ? 3 : channel === 'beta' ? 2 : 1
}
const RELEASE_RANK = 4

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Channel rank: RELEASE_RANK when there is no prerelease channel. */
  rank: number
  /** The prerelease serial within the channel (`rc.2` → 2); 0 when absent. */
  serial: number
}

/**
 * Parse `v?[major].[minor].[patch][-(alpha|beta|rc)[.N]][+build]`, or null
 * when the string is not that shape. Channels other than alpha/beta/rc
 * (nightly, dev, …) do not parse — the gate fails open on them.
 */
export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim())
  if (match === null) return null
  const channel = match[4]?.toLowerCase() as 'alpha' | 'beta' | 'rc' | undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rank: channel === undefined ? RELEASE_RANK : channelRank(channel),
    // The serial group is optional (typed `string` either way): truthiness
    // covers both the absent group and the impossible empty string.
    serial: match[5] ? Number(match[5]) : 0,
  }
}

/**
 * Total order over parsed versions: X.Y.Z numerically first, then the
 * channel rank, then the prerelease serial.
 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.rank !== b.rank) return a.rank - b.rank
  return a.serial - b.serial
}

/**
 * Compare two version strings (negative / zero / positive). An unparseable
 * side compares EQUAL — the gate only ever acts on a strict, proven
 * below-baseline result.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) return 0
  return compareParsed(x, y)
}

/**
 * Whether `version` satisfies the supported baseline. FAIL OPEN by design: a
 * version that cannot be parsed (a dev/nightly harness build) must not blank
 * a working deployment, so it passes — the gate trips only on a proven
 * below-baseline release.
 */
export function meetsBaseline(version: string, baseline: string = BASELINE_DSH_VERSION): boolean {
  const v = parseVersion(version)
  const b = parseVersion(baseline)
  if (v === null || b === null) return true
  return compareParsed(v, b) >= 0
}
