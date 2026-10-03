/**
 * Shape-driven readers over the durable session-event vocabulary — the ONE
 * place the plugin's log spellings meet. The supported range (dsh
 * 0.1.5-rc.1+, session formats V3/V4) speaks ONE dialect:
 * `system/message` surface nodes, `assistant/message.data.stream` /
 * `assistant/attempt.data.stream` (packed delta runs plus raw chunk
 * records), `SurfaceOp { startSeq, endSeq }`, `tool/ptc-dispatch`.
 *
 * The fold still reads SHAPES, never a detected harness version: the raw log
 * is untrusted input at every layer, and the supported harness refuses —
 * never rewrites — a legacy-format log, so anything that reaches these
 * readers is current-dialect or hostile. Every reader is total over
 * untrusted input — a malformed record yields "nothing here", never a throw
 * (the projection registry drives the fold without an error boundary; one
 * throw stalls the unit's push feed and the browser waits on "loading"
 * forever).
 *
 * @module dsh-context/host/log-shapes
 */

/**
 * Whether one raw stream chunk carries a token delta — the first-token
 * marker, mirroring dsh-llm's `isTokenDelta` (a non-empty text or reasoning
 * fragment, or any Tool-call delta carrying arguments or a name); a
 * malformed chunk is simply not a token.
 */
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

/**
 * The decode bucket a stream's `block-start.blockType` names: the model's
 * thinking, the answer text, or the tool-call arguments. Undefined for an
 * unknown/hostile marker, whose interval then stays unattributed rather than
 * poisoning a bucket.
 */
export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

/** Map one `blockType` to its timing bucket (see {@link DecodeKind}). */
export function decodeKindOfBlock(blockType: unknown): DecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

/** Per-kind decode spans (see {@link decodeTallyOfStream}). */
export type DecodeSpans = Record<DecodeKind, number>

/** Per-kind count of opened decode blocks (see {@link decodeTallyOfStream}). */
export type DecodeCounts = Record<DecodeKind, number>

/** Both decode tallies of one stream: the spans that price the split and the marker counts that qualify its rows. */
export interface DecodeTally {
  spans: DecodeSpans
  blocks: DecodeCounts
}

/**
 * Per-kind decode spans AND counted `block-start` markers inside one embedded
 * assistant stream, tiling [first block-start, endTime]: each `block-start`
 * record owns the interval up to the next one, the last one up to `endTime`.
 * Total over untrusted input — a malformed record is skipped whole (a
 * marker with an unusable time anchors no span and counts nothing), a
 * non-finite boundary yields zero, and a stream with no marker (or not an
 * array) yields all zeros.
 */
export function decodeTallyOfStream(stream: unknown, endTime: number): DecodeTally {
  const tally: DecodeTally = { spans: { reasoning: 0, text: 0, toolarg: 0 }, blocks: { reasoning: 0, text: 0, toolarg: 0 } }
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return tally
  let kind: DecodeKind | undefined
  let since = 0
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (kind !== undefined) tally.spans[kind] += Math.max(0, time - since)
    kind = decodeKindOfBlock(chunk.blockType)
    if (kind !== undefined) tally.blocks[kind] += 1
    since = time
  }
  if (kind !== undefined) tally.spans[kind] += Math.max(0, endTime - since)
  return tally
}

/** One ordered decode span of a stream's block sequence (see {@link decodeSpansOfStream}). */
export interface DecodeSpan {
  kind: DecodeKind
  start: number
  end: number
}

/**
 * The ORDERED decode spans of one embedded assistant stream — the same
 * ownership rule as {@link decodeTallyOfStream} (each `block-start` marker
 * owns the interval up to the next one, the last one up to `endTime`), but
 * keeping the sequence: the timing strip paints the decode window in stream
 * order. Total over untrusted input, mirroring the tally: a malformed record
 * is skipped whole, an unknown `blockType` leaves its interval unspanned
 * (the caller's residue fill owns it), a zero/negative-length span drops
 * out, and a stream with no marker (or not an array) yields none.
 */
export function decodeSpansOfStream(stream: unknown, endTime: number): DecodeSpan[] {
  const spans: DecodeSpan[] = []
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return spans
  let kind: DecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind !== undefined && to > since) spans.push({ kind, start: since, end: to })
  }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    close(time)
    kind = decodeKindOfBlock(chunk.blockType)
    since = time
  }
  close(endTime)
  return spans
}

/**
 * The first token's instant inside one PACKED delta run (`text-chunks` /
 * `reasoning-chunks` / `tool-call-chunks`): the run's base time plus the
 * accumulated inter-member deltas, taken at the first qualifying member —
 * a name-bearing Tool-call run starts at its first member. Mirrors dsh-llm's
 * `runFirstTokenTime`; a non-finite base or delta yields undefined rather
 * than a NaN instant.
 */
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

/**
 * The first token's instant inside an embedded assistant stream
 * (`assistant/message.data.stream`, `assistant/attempt.data.stream`), or
 * undefined when the stream carries no token. Mirrors dsh-llm's
 * `assistantStreamFirstTokenTime` over the compact record union.
 */
export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type === 'chunk') {
      const time = r.time
      if (typeof time === 'number' && Number.isFinite(time) && isTokenChunk(r.chunk)) return time
      continue
    }
    const time = runFirstTokenTime(r)
    if (time !== undefined) return time
  }
  return undefined
}

/**
 * The inclusive surface range a replacement op covers, or null for `append`
 * and for any unrecognized/hostile op (which the fold treats as an append).
 * The `startSeq`/`endSeq` endpoints are each accepted only as a finite
 * number, so a hostile op with one malformed endpoint degrades to append.
 */
export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const { startSeq: start, endSeq: end } = op
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}

/** The newest usage chunk, with a message's top-level sample taking precedence. */
export function usageOfSettlement(type: string, data: Record<string, unknown> | undefined): unknown {
  if (type === 'assistant/message' && data?.usage !== undefined) return data.usage
  const stream = data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i] as { type?: unknown; chunk?: { type?: unknown; usage?: unknown } | null } | null
    if (record !== null && typeof record === 'object' && record.type === 'chunk'
      && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}
