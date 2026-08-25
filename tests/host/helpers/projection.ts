// Fold drivers for the host specs: run event envelopes through the REAL
// projection units the plugin registers (no harness plumbing — the units are
// pure init/apply/view), with the framework's own serializer pinned on every
// intermediate state.

import assert from 'node:assert/strict'
import { snapshotJsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../../../src/host/config'
import type { TimelineEvent, TimelineState } from '../../../src/host/fold'
import type { HeadersState } from '../../../src/host/headers'
import type { ContextHeaders, ContextTimeline } from '../../../src/shared/types'
import { createContextTimelineDefinition } from '../../../src/host/timeline'
import { createContextHeadersDefinition } from '../../../src/host/headers'

/**
 * The fold's declared contract takes the core `SessionEvent` union; the log
 * also carries declaration-merged plugin events (compaction/*), so the fold
 * widens to TimelineEvent (src/host/fold.ts). These widened faces perform the
 * ONE documented cast inside the helper, keeping every spec call site clean.
 */
export interface TimelineDefLike {
  key: string
  init(): TimelineState
  apply(state: TimelineState, event: TimelineEvent): TimelineState
  view(state: TimelineState): ContextTimeline
}

export interface HeadersDefLike {
  key: string
  init(): HeadersState
  apply(state: HeadersState, event: TimelineEvent): HeadersState
  view(state: HeadersState): ContextHeaders
}

export function timelineDef(config?: Config): TimelineDefLike {
  return createContextTimelineDefinition(config ?? {}) as unknown as TimelineDefLike
}

export function headersDef(): HeadersDefLike {
  return createContextHeadersDefinition() as unknown as HeadersDefLike
}

/**
 * The projection-cache precondition: every state the fold produces must be
 * losslessly JSON-serializable (a single undefined property fails EVERY cache
 * write for the session — see TimelineState). Returns the detached copy.
 */
export function assertPlainJson<T>(state: T): T {
  const copy = snapshotJsonValue(state)
  assert.ok(copy !== undefined, 'fold state must be losslessly JSON-serializable')
  return copy
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
  return { def, state, states, view: def.view(state) }
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
