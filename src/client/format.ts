/**
 * Number/time formatting for the UI. `fmt` uses the same k/M suffix style
 * everywhere (bars, details, stats); `fmtTime` renders a local HH:MM:SS.
 */

export function fmt(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function fmtTime(t: number): string {
  // en-GB with a 24-hour clock renders the same local HH:MM:SS the manual
  // zero-pad produced, without the hand-rolled p() helper.
  // An invalid timestamp (garbage from a corrupt payload) must show a dash,
  // never throw — `toLocaleTimeString` raises RangeError on Invalid Date.
  const d = new Date(t)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}
