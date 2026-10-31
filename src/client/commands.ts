import type { CommandRecord, CommandStats, SurfaceNode } from '../shared/types'
import { commandTool, programsOfCommand, programOfCommand, firstLineOf, hideableCdPrefix, shapeOfCmd } from '../shared/commands'
import type { CommandShape } from '../shared/commands'

export type Command = CommandRecord
export type CommandFilter = 'all' | 'failed' | 'slow' | 'background'
export type CommandSort = 'latest' | 'slowest'

export const SLOW_MS = 10_000

export function surfaceSeqOf(rec: CommandRecord): number | undefined {
  return rec.parent ?? rec.resultSeq
}

export function commandsOf(records: readonly CommandRecord[], archive: readonly SurfaceNode[]): Command[] {
  const goneBySeq = new Map<number, number>()
  for (const n of archive) if (n.gone !== undefined) goneBySeq.set(n.seq, n.gone)
  return records.map((rec) => {
    const key = surfaceSeqOf(rec)
    const gone = key === undefined ? undefined : goneBySeq.get(key)
    return gone !== undefined && rec.gone === undefined ? { ...rec, gone } : rec
  })
}

export function durationOf(rec: CommandRecord): number | undefined {
  return rec.end === undefined ? undefined : Math.max(0, rec.end - rec.start)
}

export function previewTextOf(cmd: string, workspace: string | undefined): string {
  return firstLineOf(cmd.slice(hideableCdPrefix(cmd, workspace)))
}

export function previewOf(rec: CommandRecord, workspace: string | undefined): string {
  return previewTextOf(rec.cmd, workspace)
}

export interface CommandView {
  rec: CommandRecord
  program: string
  programs: string[]
  preview: string
  shape: CommandShape
}

function viewOf(rec: CommandRecord, workspace: string | undefined): CommandView {
  const programs = rec.tool === 'bash' || rec.tool === 'pwsh' ? programsOfCommand(rec.cmd, rec.tool) : []
  const program = programs[0] ?? programOf(rec)
  const allPrograms = programs.length > 0 ? programs : [program]
  return { rec, program, programs: allPrograms, preview: previewOf(rec, workspace), shape: shapeOfCmd(rec.cmd) }
}

export function resultTextOf(node: unknown): string | null {
  const out: string[] = []
  const walk = (blocks: readonly unknown[]): void => {
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object'
        ? b as { type?: unknown; kind?: unknown; text?: unknown; content?: unknown }
        : null
      const kind = blk !== null ? (typeof blk.type === 'string' ? blk.type : typeof blk.kind === 'string' ? blk.kind : '') : ''
      if (kind === 'text' && typeof blk?.text === 'string' && blk.text !== '') out.push(blk.text)
      else if (kind === 'tool-result' && Array.isArray(blk?.content)) walk(blk.content)
    }
  }
  const rec = node !== null && typeof node === 'object' ? node as { content?: unknown; blocks?: unknown } : null
  const blocks = Array.isArray(rec?.content) ? rec.content : Array.isArray(rec?.blocks) ? rec.blocks : null
  if (blocks !== null) walk(blocks)
  return out.length > 0 ? out.join('\n') : null
}

export function viewsOf(records: readonly CommandRecord[], workspace: string | undefined): CommandView[] {
  return records.map(rec => viewOf(rec, workspace))
}

export function matchesFilter(rec: CommandRecord, filter: CommandFilter): boolean {
  if (filter === 'failed') return rec.status === 'failed' || rec.status === 'killed'
  if (filter === 'slow') {
    const d = durationOf(rec)
    return d !== undefined && d >= SLOW_MS
  }
  if (filter === 'background') return rec.background === true
  return true
}

export function matchesQuery(rec: CommandRecord, q: string, program: string | readonly string[] = programOf(rec)): boolean {
  if (q === '') return true
  const needle = q.toLowerCase()
  if (rec.cmd.toLowerCase().includes(needle)) return true
  if (rec.description !== undefined && rec.description.toLowerCase().includes(needle)) return true
  if (rec.cwd !== undefined && rec.cwd.toLowerCase().includes(needle)) return true
  const programs = typeof program === 'string' ? [program] : program
  return programs.some(name => name.toLowerCase().includes(needle))
}

export function byLatest(a: CommandRecord, b: CommandRecord): number {
  return (b.time - a.time) || (b.seq - a.seq)
}

export function bySlowest(a: CommandRecord, b: CommandRecord): number {
  return (durationOf(b) ?? -1) - (durationOf(a) ?? -1) || byLatest(a, b)
}

export function tallyOfCommands(records: readonly CommandRecord[]): CommandStats {
  const stats: CommandStats = { runs: 0, failed: 0, ms: 0, bg: 0 }
  for (const rec of records) {
    if (rec.background === true) stats.bg += 1
    if (rec.status === 'running') continue
    stats.runs += 1
    if (rec.status === 'failed' || rec.status === 'killed') stats.failed += 1
    const d = durationOf(rec)
    if (d !== undefined) stats.ms += d
  }
  return stats
}

export function programOf(rec: CommandRecord): string {
  const tool = commandTool(rec.tool)
  return tool === null ? rec.tool : programOfCommand(tool, rec.cmd)
}

export interface ProgramCount {
  name: string
  n: number
  runs: number
}

export function programsOf(views: readonly CommandView[]): ProgramCount[] {
  const counts = new Map<string, { n: number; runs: number }>()
  for (const view of views) {
    const seen = new Set<string>()
    for (const name of view.programs) {
      let count = counts.get(name)
      if (count === undefined) {
        count = { n: 0, runs: 0 }
        counts.set(name, count)
      }
      count.n++
      if (!seen.has(name)) {
        count.runs++
        seen.add(name)
      }
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, ...count }))
    .sort((a, b) => (b.n - a.n) || (a.name < b.name ? -1 : 1))
}

export interface CommandAttention {
  slowest?: { cmd: string; ms: number }
  failing?: { program: string; count: number }
  repeats?: { cmd: string; count: number }
  background?: number
}

export function attentionOf(views: readonly CommandView[]): CommandAttention {
  const out: CommandAttention = {}
  let slowest: { cmd: string; ms: number } | undefined
  const failByProgram = new Map<string, number>()
  const repeats = new Map<string, number>()
  let background = 0
  for (const view of views) {
    const rec = view.rec
    const d = durationOf(rec)
    if (rec.status !== 'running' && d !== undefined && d >= 1000 && (slowest === undefined || d > slowest.ms)) {
      slowest = { cmd: rec.cmd, ms: d }
    }
    if (rec.status === 'failed' || rec.status === 'killed') {
      for (const program of new Set(view.programs)) failByProgram.set(program, (failByProgram.get(program) ?? 0) + 1)
    }
    if (rec.background === true) background++
    if (rec.status !== 'running') repeats.set(rec.cmd, (repeats.get(rec.cmd) ?? 0) + 1)
  }
  if (slowest !== undefined) out.slowest = slowest
  let failing: { program: string; count: number } | undefined
  for (const [program, count] of failByProgram) {
    if (failing === undefined || count > failing.count) failing = { program, count }
  }
  if (failing !== undefined) out.failing = failing
  let top: { cmd: string; count: number } | undefined
  for (const [cmd, count] of repeats) {
    if (count >= 2 && (top === undefined || count > top.count)) top = { cmd, count }
  }
  if (top !== undefined) out.repeats = top
  if (background > 0) out.background = background
  return out
}
