import type { CommandRecord, CommandStatus, CommandPage } from '../shared/types'
import { COMMANDS_ROUTE } from './apiRoutes'
import { postRoute } from './route'
import { asRecord } from './services'

const STATUSES: ReadonlySet<unknown> = new Set<CommandStatus>(['running', 'completed', 'failed', 'killed'])
const FLAG_KEYS = ['cmdTruncated', 'background', 'codeMode', 'exitInferred', 'timedOut', 'stopped', 'denied', 'outTruncated', 'stderr', 'derived'] as const
const NUM_KEYS = ['resultSeq', 'parent', 'turn', 'step', 'end', 'exit', 'outChars', 'timeoutMs', 'gone'] as const
const STR_KEYS = ['description', 'cwd', 'sandbox', 'signal'] as const

function finiteOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function commandOf(value: unknown): CommandRecord | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const seq = finiteOf(rec.seq)
  const time = finiteOf(rec.time)
  const start = finiteOf(rec.start)
  const tool = stringOf(rec.tool)
  const cmd = stringOf(rec.cmd)
  const status = STATUSES.has(rec.status) ? rec.status as CommandStatus : undefined
  if (seq === undefined || time === undefined || start === undefined
    || tool === undefined || cmd === undefined || status === undefined) return null
  if (typeof rec.err !== 'boolean') return null
  const out: CommandRecord = { seq, time, tool, cmd, start, status, err: rec.err }
  for (const key of NUM_KEYS) {
    const num = finiteOf(rec[key])
    if (num !== undefined) out[key] = num
  }
  for (const key of STR_KEYS) {
    const str = stringOf(rec[key])
    if (str !== undefined) out[key] = str
  }
  for (const key of FLAG_KEYS) if (rec[key] === true) out[key] = true
  return out
}

export function commandPageOf(value: unknown): CommandPage | null {
  const data = asRecord(value)
  if (data === null || typeof data.atStart !== 'boolean' || !Array.isArray(data.commands)) return null
  const total = finiteOf(data.total)
  if (total === undefined || total < 0) return null
  const commands: CommandRecord[] = []
  for (const entry of data.commands) {
    const rec = commandOf(entry)
    if (rec !== null) commands.push(rec)
  }
  return { commands, atStart: data.atStart, total }
}

export type CommandPageFetcher = (beforeSeq: number) => Promise<CommandPage | null>

export function makeCommandPager(
  sessionId: string,
  limit?: number,
): CommandPageFetcher | undefined {
  if (sessionId === '') return undefined
  return beforeSeq => postRoute(
    COMMANDS_ROUTE,
    { sessionId, beforeSeq, ...(limit === undefined ? {} : { limit }) },
    commandPageOf,
    { label: 'command page' },
  )
}
