/**
 * Shape-driven readers over the durable session-event vocabulary — the ONE
 * place the plugin reconciles the two supported log generations:
 *
 *   - V0 (dsh 0.1.2-rc.1): `request/header.header.system`, `assistant/chunk`
 *     stream events, `SurfaceOp { start, end }`, `tool/code-dispatch`.
 *   - V3 (dsh 0.1.5-alpha.x+): `system/message` surface nodes,
 *     `assistant/message.data.stream` / `assistant/attempt.data.stream`,
 *     `SurfaceOp { startSeq, endSeq }`, `tool/ptc-dispatch`.
 *
 * The fold reads SHAPES, never a detected harness version: a session log is
 * written by exactly one generation, the two spellings are mutually
 * exclusive within it, and a deployment's version probe can be wrong (a
 * healed profile mirror may name a different release than the running
 * harness). Every reader is total over untrusted input — a malformed record
 * yields "nothing here", never a throw (the projection registry drives the
 * fold without an error boundary; one throw stalls the unit's push feed and
 * the browser waits on "loading" forever).
 *
 * @module dsh-context/host/log-shapes
 */

/**
 * Whether one raw stream chunk carries a token delta — the first-token marker
 * both generations share. Mirrors dsh-llm's `isTokenDelta` (a non-empty text
 * or reasoning fragment, or any Tool-call delta carrying arguments or a name);
 * a malformed chunk is simply not a token.
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

/** Per-kind decode spans (see {@link decodeSpansOfStream}). */
export type DecodeSpans = Record<DecodeKind, number>

/**
 * Per-kind decode spans inside one embedded assistant stream, tiling
 * [first block-start, endTime]: each `block-start` record owns the interval up
 * to the next one, the last one up to `endTime`. This is the V2+ shape, whose
 * timed stream rides the settlement (`assistant/message.data.stream`) instead
 * of separate `assistant/chunk` events. Total over untrusted input — a
 * malformed record is skipped, a non-finite boundary yields zero, and a stream
 * with no marker (or not an array) yields all zeros.
 */
export function decodeSpansOfStream(stream: unknown, endTime: number): DecodeSpans {
  const spans: DecodeSpans = { reasoning: 0, text: 0, toolarg: 0 }
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return spans
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
    if (kind !== undefined) spans[kind] += Math.max(0, time - since)
    kind = decodeKindOfBlock(chunk.blockType)
    since = time
  }
  if (kind !== undefined) spans[kind] += Math.max(0, endTime - since)
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
 * (`assistant/message.data.stream`, `assistant/attempt.data.stream` — the V2+
 * settlement that replaced the V0 `assistant/chunk` events), or undefined
 * when the stream carries no token. Mirrors dsh-llm's
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
 * Reads BOTH endpoint spellings: V3's `startSeq`/`endSeq` first, then V0's
 * `start`/`end` — each accepted only as a finite number, so a hostile op
 * with one good and one malformed endpoint degrades to append.
 */
export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; start?: unknown; end?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const start = typeof op.startSeq === 'number' ? op.startSeq : op.start
  const end = typeof op.endSeq === 'number' ? op.endSeq : op.end
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
