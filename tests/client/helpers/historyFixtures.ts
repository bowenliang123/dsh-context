import type { FileOpRecord, HistoryPage, HistoryPart, HistoryRow, RequestRecord, SurfaceNode } from '../../../src/shared/types'
import { T0 } from './factsFixtures'

export function request(seq: number): RequestRecord {
  return {
    seq, time: T0 + seq, turn: 1, step: seq, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 5, total: 15,
  }
}

export function pageOf(part: HistoryPart, rows: HistoryRow[], rev = 1): HistoryPage {
  return {
    rev,
    live: true,
    part,
    rows,
    first: 0,
    last: rows.length - 1,
    total: rows.length,
    atStart: true,
    atEnd: true,
  }
}

export function node(seq: number): SurfaceNode {
  return { seq, cat: 'user', tokens: seq }
}

export function fileOp(seq: number, path: string): FileOpRecord {
  return { seq, path, kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }
}
