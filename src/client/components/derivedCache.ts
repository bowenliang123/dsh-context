import { lruTouch } from '../boundedCache'
import { trimRetentionMap } from '../retention'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import type { ContextHeaders, ContextTimeline } from '../../shared/types'

const derived = new WeakMap<object, Map<string, unknown>>()

export function cachedByData<T>(owner: object, key: string, compute: () => T): T {
  let values = derived.get(owner)
  if (values === undefined) {
    values = new Map()
    derived.set(owner, values)
  }
  const hit = values.get(key)
  if (hit !== undefined) {
    lruTouch(values, key)
    return hit as T
  }
  const value = compute()
  values.set(key, value)
  trimRetentionMap(values, 'derivedOwner')
  return value
}

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
  if (hit !== undefined) {
    lruTouch(bySeq, seq)
    return hit
  }
  const value = assemble(data, headers, seq)
  bySeq.set(seq, value)
  trimRetentionMap(bySeq, 'derivedSeq')
  return value
}
