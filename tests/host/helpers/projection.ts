import assert from 'node:assert/strict'
import type { Config } from '../../../src/host/config'
import { resolveBounds } from '../../../src/host/config'
import { applyTimeline, type TimelineEvent, type TimelineState } from '../../../src/host/fold'
import type { RequestRecord } from '../../../src/shared/types'
import { buildTimelineView } from '../../../src/host/foldWire'
import type { ContextTimeline } from '../../../src/shared/types'
import { createTimelineState } from '../../../src/host/foldState'
import { createContextTimelineDefinition } from '../../../src/host/timeline'

export interface TimelineDefLike {
  key: string
  stateSchema: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } } }
  init(): TimelineState
  apply(state: TimelineState, event: TimelineEvent): TimelineState
  wire: {
    viewSchema: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }
    view(state: TimelineState): ContextTimeline
  }
}

export function timelineDef(config?: Config, slim = false): TimelineDefLike {
  return createContextTimelineDefinition(config ?? {}, () => slim) as unknown as TimelineDefLike
}

export function fullDef(config?: Config, slim = false): TimelineDefLike {
  const real = timelineDef(config, slim)
  const bounds = resolveBounds(config)
  return {
    ...real,
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: TimelineEvent) => applyTimeline(state, event, bounds),
    wire: { ...real.wire, view: (state: TimelineState) => buildTimelineView(state, bounds) },
  }
}

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

export function assertPlainJson<T>(state: T): T {
  const copy = snapshotJson(state)
  assert.ok(copy !== undefined, 'fold state must be losslessly JSON-serializable')
  return copy as T
}

function assertNoAbsentMembers(value: unknown, path = '$', seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) assert.fail(`${path}.${key} must stay ABSENT, never carry undefined`)
    assertNoAbsentMembers(member, `${path}.${key}`, seen)
  }
}

export interface TimelineDrive {
  def: TimelineDefLike
  state: TimelineState
  states: TimelineState[]
  view: ContextTimeline
}

export function driveTimeline(events: TimelineEvent[], config?: Config, headOnly = false): TimelineDrive {
  const def = headOnly ? timelineDef(config) : fullDef(config)
  let state = def.init()
  assertNoAbsentMembers(state)
  const states = [state]
  for (const ev of events) {
    state = def.apply(state, ev)
    assertNoAbsentMembers(state)
    states.push(state)
  }
  return { def, state, states, view: def.wire.view(state) }
}

export function assertStatesPlainJson(drive: TimelineDrive): void {
  for (const state of drive.states) assertPlainJson(state)
}

export function assertStable(state: TimelineState, event: TimelineEvent, def = timelineDef()): void {
  assert.equal(def.apply(state, event), state, 'uninteresting events must return the same reference')
}

export function requestsOf(state: TimelineState): RequestRecord[] {
  return state.requests.filter((r): r is RequestRecord => typeof (r as { system?: unknown }).system === 'number')
}
