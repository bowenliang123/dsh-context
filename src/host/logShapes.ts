export function isTokenChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
}

export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

export function decodeKindOfBlock(blockType: unknown): DecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

function runFirstTokenTime(record: Record<string, unknown>): number | undefined {
  const time0 = record.time0
  if (typeof time0 !== 'number' || !Number.isFinite(time0)) return undefined
  if (record.type === 'tool-call-chunks' && record.name !== undefined) return time0
  const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
  if (!Array.isArray(fragments)) return undefined
  const dt: readonly unknown[] = Array.isArray(record.dt) ? record.dt as unknown[] : []
  let time = time0
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const step = dt[index - 1]
      if (typeof step !== 'number' || !Number.isFinite(step)) return undefined
      time += step
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

export interface DecodeSpan {
  kind: DecodeKind
  start: number
  end: number
}

export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  return streamTimingOf(stream, Number.NaN).firstToken
}

export interface StreamTiming {
  firstToken?: number
  spans: DecodeSpan[]
}

export function streamTimingOf(stream: unknown, endTime: number): StreamTiming {
  const spans: DecodeSpan[] = []
  const result: StreamTiming = { spans }
  if (!Array.isArray(stream)) return result
  const markersReadable = Number.isFinite(endTime)
  let firstToken: number | undefined
  let kind: DecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind === undefined || to <= since) return
    spans.push({ kind, start: since, end: to })
  }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type === 'chunk') {
      const chunk = r.chunk !== null && typeof r.chunk === 'object' ? r.chunk as { type?: unknown; blockType?: unknown } : null
      const time = r.time
      if (!Number.isFinite(time)) continue
      if (markersReadable && chunk !== null && chunk.type === 'block-start') {
        close(time as number)
        kind = decodeKindOfBlock(chunk.blockType)
        since = time as number
      } else if (firstToken === undefined && isTokenChunk(chunk)) {
        firstToken = time as number
      }
      if (!markersReadable && firstToken !== undefined) break
      continue
    }
    if (firstToken === undefined) firstToken = runFirstTokenTime(r)
    if (!markersReadable && firstToken !== undefined) break
  }
  if (markersReadable) close(endTime)
  if (firstToken !== undefined) result.firstToken = firstToken
  return result
}

export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const { startSeq: start, endSeq: end } = op
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
