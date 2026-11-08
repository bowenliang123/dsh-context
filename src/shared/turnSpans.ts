import type { ContextEventRecord, RequestRecord } from './types'

export function attachTurnSpans(events: readonly ContextEventRecord[], requests: readonly RequestRecord[]): ContextEventRecord[] {
  const out = events.map(event => ({ ...event }))
  let ri = 0
  for (const event of out) {
    while (ri < requests.length && requests[ri].seq <= event.seq) ri++
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      event.turn = next.turn
      event.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      event.fromTurn = prev.turn
      event.fromStep = prev.step
    }
  }
  return out
}
