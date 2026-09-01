/** `fmt`: the k/M suffix style shared by bars/details/stats; `fmtTime`: local HH:MM:SS. */

export function fmt(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M'
  if (a >= 1000) return sign + (a / 1000).toFixed(1) + 'k'
  return sign + String(Math.round(a))
}

/** Byte sizes for attachment metadata (1 kB = 1000 B, matching the k/M style of `fmt`). */
export function fmtBytes(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n) || n < 0) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB'
  if (n >= 1000) return (n / 1000).toFixed(1) + ' kB'
  return String(Math.round(n)) + ' B'
}

/**
 * Cache-hit share of billed prompt-side input (`reads` over `billed`),
 * TRUNCATED to two decimals (cut, not round) — same formula as the harness
 * chat stats line's '缓存命中' figure and the stats board's cell. Null when
 * nothing was billed. The 1e-9 epsilon absorbs only float noise (integer
 * token counts never sit that close to a boundary).
 */
export function cacheHitPercent(reads: number, billed: number): string | null {
  if (!(billed > 0)) return null
  const hundredths = Math.trunc((reads / billed) * 10000 + 1e-9)
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`
}

export function fmtTime(t: number): string {
  // en-GB 24-hour clock zero-pads HH:MM:SS without a helper; invalid dates must show '—' (toLocaleTimeString throws RangeError).
  const d = new Date(t)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Share of a whole as a compact leading percentage for the slice rows:
 * '—' when nothing totals, '0.0%' for empty slices, '<0.1%' for non-zero
 * crumbs a 0.1%-precision figure would erase. One decimal everywhere; shares
 * cap at 100% (parallel tool time can over-run the wall it belongs to).
 */
export function fmtShare(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—'
  if (part <= 0) return '0.0%'
  const pct = Math.min(1, part / total) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1)}%`
}

/**
 * Whole-session durations for the timing card, in the locale's units: raw ms
 * under a second, one-decimal seconds under a minute, then m/s and h/m.
 * Non-finite or non-positive input shows the dash (callers render their empty
 * state anyway).
 */
export function fmtDuration(ms: number, lang: 'zh' | 'en'): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const zh = lang === 'zh'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}${zh ? '秒' : 's'}`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (ms < 3_600_000) return zh ? `${m}分${s}秒` : `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return zh ? `${h}时${m % 60}分` : `${h}h ${m % 60}m`
}
