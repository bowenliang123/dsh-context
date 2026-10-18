import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import type { ContextHeaders, ContextTimeline } from '../../shared/types'

/** Per-owner derived values. Keyed weakly by the served projection (or a composite owner) so a superseded cache
 *  can be collected without a manual eviction pass. The detail store keeps at most a handful of payloads alive. */
const derived = new WeakMap<object, Map<string, unknown>>()

/**
 * Reuse a pure derivation across component remounts (tab switches, sidebar reopen) while the same served
 * projection object is current. The value must be a pure function of the projection and `key`.
 */
export function cachedByData<T>(owner: object, key: string, compute: () => T): T {
  let values = derived.get(owner)
  if (values === undefined) {
    values = new Map()
    derived.set(owner, values)
  }
  const hit = values.get(key)
  if (hit !== undefined) return hit as T
  const value = compute()
  values.set(key, value)
  return value
}

/** assemble() is a pure walk over the projection + header epoch; hover previews and remounts revisit the same steps. */
const NO_HEADERS = {}
const assembled = new WeakMap<ContextTimeline, WeakMap<object, Map<number | null, Assembled>>>()

export function assembleCached(data: ContextTimeline, headers: ContextHeaders | null, seq: number | null): Assembled {
  let byHeaders = assembled.get(data)
  if (byHeaders === undefined) {
    byHeaders = new WeakMap()
    assembled.set(data, byHeaders)
  }
  const headerKey = headers ?? NO_HEADERS
  let bySeq = byHeaders.get(headerKey)
  if (bySeq === undefined) {
    bySeq = new Map()
    byHeaders.set(headerKey, bySeq)
  }
  const hit = bySeq.get(seq)
  if (hit !== undefined) return hit
  const value = assemble(data, headers, seq)
  bySeq.set(seq, value)
  return value
}
