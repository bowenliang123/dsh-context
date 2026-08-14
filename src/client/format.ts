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
  const d = new Date(t)
  function p(x: number) { return (x < 10 ? '0' : '') + x }
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
