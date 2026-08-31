// Fold drivers for the host specs: run event envelopes through the REAL
// projection units the plugin registers (no harness plumbing — the units are
// pure init/apply/view), with the framework's own serializer pinned on every
// intermediate state.

import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../../../src/host/config'
import type { TimelineEvent, TimelineState } from '../../../src/host/fold'
import type { HeadersState } from '../../../src/host/headers'
import type { ContextHeaders, ContextTimeline } from '../../../src/shared/types'
import { createContextTimelineDefinition } from '../../../src/host/timeline'
import { createContextHeadersDefinition } from '../../../src/host/headers'

/**
 * The fold's declared contract takes the core `SessionEvent` union; the log
 * also carries declaration-merged plugin events (compaction/*), so the fold
 * widens to TimelineEvent (src/host/fold.ts). These widened faces mirror the
 * supported registry contract (src/host/compat.ts: stateSchema + required
 * `wire`, zero-arg `init` — see ProjectionDefinition) and perform the ONE
 * documented cast inside the helper, keeping every spec call site clean.
 */
export interface TimelineDefLike {
  key: string
  init(): TimelineState
  apply(state: TimelineState, event: TimelineEvent): TimelineState
  wire: { view(state: TimelineState): ContextTimeline }
}

export interface HeadersDefLike {
  key: string
  init(): HeadersState
  apply(state: HeadersState, event: TimelineEvent): HeadersState
  wire: { view(state: HeadersState): ContextHeaders }
}

export function timelineDef(config?: Config): TimelineDefLike {
  return createContextTimelineDefinition(config ?? {}) as unknown as TimelineDefLike
}

export function headersDef(): HeadersDefLike {
  return createContextHeadersDefinition() as unknown as HeadersDefLike
}

/**
 * Lossless-JSON probe and detach, inlined with the dsh `snapshotJsonValue`
 * semantics (the export left `@deepseek-ai/dsh-session` in 0.1.2-alpha.2, and
 * the test fixtures must track no single dsh face). Returns undefined when the
 * value is not losslessly JSON-serializable: an undefined/function/symbol
 * member, a non-finite number, a non-plain object, or a cycle. Shared with the
 * compat matrix's registry driver (tests/host/compat/registryDriver.ts).
 */
export function snapshotJson(value: unknown, ancestors: Set<object> = new Set()): unknown {
  switch (typeof value) {
    case 'string': case 'boolean': return value
    case 'number': return Number.isFinite(value) ? value : undefined
    case 'object': break
    default: return undefined
  }
  if (value === null) return null
  if (ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return undefined
        const entry = snapshotJson(value[index], ancestors)
        if (entry === undefined) return undefined
        out.push(entry)
      }
      return out
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return undefined
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const entry = snapshotJson((value as Record<string, unknown>)[key], ancestors)
      if (entry === undefined) return undefined
      out[key] = entry
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/**
 * The projection-cache precondition: every state the fold produces must be
 * losslessly JSON-serializable (a single undefined property fails EVERY cache
 * write for the session — see TimelineState). Returns the detached copy.
 */
export function assertPlainJson<T>(state: T): T {
  const copy = snapshotJson(state)
  assert.ok(copy !== undefined, 'fold state must be losslessly JSON-serializable')
  return copy as T
}

export interface TimelineDrive {
  def: TimelineDefLike
  state: TimelineState
  /** Every intermediate state, including init (index = events folded). */
  states: TimelineState[]
  view: ContextTimeline
}

/** Fold the whole log through the timeline unit and serve the wire view. */
export function driveTimeline(events: TimelineEvent[], config?: Config): TimelineDrive {
  const def = timelineDef(config)
  let state = def.init()
  const states = [state]
  for (const ev of events) {
    state = def.apply(state, ev)
    states.push(state)
  }
  return { def, state, states, view: def.wire.view(state) }
}

/** Pin the plain-JSON precondition on every intermediate fold state. */
export function assertStatesPlainJson(drive: TimelineDrive): void {
  for (const state of drive.states) assertPlainJson(state)
}

/** Reference-stability probe: an uninteresting event must return the SAME state. */
export function assertStable(state: TimelineState, event: TimelineEvent, def = timelineDef()): void {
  assert.equal(def.apply(state, event), state, 'uninteresting events must return the same reference')
}

export type { SessionEvent }
