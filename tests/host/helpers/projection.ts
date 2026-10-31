import assert from 'node:assert/strict'
import type { Config } from '../../../src/host/config'
import { resolveBounds } from '../../../src/host/config'
import type { TimelineEvent, TimelineState } from '../../../src/host/fold'
import { applyTimeline } from '../../../src/host/fold'
import { createTimelineState } from '../../../src/host/foldState'
import { buildTimelineDetail, buildTimelineHead } from '../../../src/host/foldWire'
import type { ContextTimeline } from '../../../src/shared/types'
import { createContextTimelineDefinition } from '../../../src/host/timeline'

export interface TimelineDefLike {
  key: string
  stateSchema: { parse(value: unknown): unknown }
  init(): TimelineState
  apply(state: TimelineState, event: TimelineEvent): TimelineState
  wire: {
    viewSchema: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }
    view(state: TimelineState): ContextTimeline
  }
}

function fullView(state: TimelineState, bounds: ReturnType<typeof resolveBounds>): ContextTimeline {
  const detail = buildTimelineDetail(state, bounds)
  const head = detail.head ?? buildTimelineHead(state)
  const { counts: _counts, last: _last, detailRev: _detailRev, ...scalars } = head
  const { rev: _rev, head: _head, ...collections } = detail
  return { ...scalars, ...collections } as unknown as ContextTimeline
}

export function timelineDef(config?: Config, slim = false): TimelineDefLike {
  const production = createContextTimelineDefinition(config ?? {})
  const bounds = resolveBounds(config ?? {})
  return {
    ...production,
    init: () => createTimelineState(!slim),
    apply: (state: TimelineState, event: TimelineEvent) => applyTimeline(state, event, bounds),
    wire: {
      viewSchema: production.wire.viewSchema,
      view: slim
        ? production.wire.view
        : (state: TimelineState) => fullView(state, bounds),
    },
  } as unknown as TimelineDefLike
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

export function driveTimeline(events: TimelineEvent[], config?: Config): TimelineDrive {
  const def = timelineDef(config)
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
