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

export function fmtTime(t: number): string {
  // en-GB 24-hour clock zero-pads HH:MM:SS without a helper; invalid dates must show '—' (toLocaleTimeString throws RangeError).
  const d = new Date(t)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}
