import { DetailStore, type FactPart, type FactsRead } from '../../../src/client/timelineSource'
import type { ContextTimeline, RequestRecord } from '../../../src/shared/types'

export const T0 = 1_700_000_000_000

export function head(rev: number): ContextTimeline {
  return {
    ok: true,
    current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
    counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0, skills: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    detailRev: rev,
  }
}

export function series(rev: number): RequestRecord[] {
  return [{ seq: rev, time: T0, total: 15, turn: 1, step: 0, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 5 }]
}

export function core(rev: number): FactsRead {
  return { rev, live: true, asOfSeq: rev, parts: { head: head(rev), series: series(rev) } }
}

export function storeOf(
  readCore: () => Promise<unknown>,
  readPart: (part: FactPart, window: unknown) => Promise<unknown> = async () => null,
): DetailStore {
  const fetchers = {
    core: async () => readCore() as never,
    part: async (part: FactPart, window: unknown) => readPart(part, window) as never,
  }
  return new DetailStore(fetchers, 0)
}
