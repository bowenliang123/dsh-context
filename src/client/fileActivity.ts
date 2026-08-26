/**
 * File activity — what the agent DID to files, derived client-side from the
 * timeline's served tool-result nodes (live tail + archive) joined with the
 * conversation snapshot for call arguments; no host or wire additions.
 *
 * One tool-result surface node equals one executed call; a call whose
 * arguments have aged out of the conversation join names no target and is
 * skipped — every op the card counts, it can also row. Line deltas are
 * estimates read off the call ARGUMENTS (an
 * edit's old/new strings, a write's content), never off result payloads.
 *
 * Scope: `before` is the EXCLUSIVE upper seq bound (the next request's seq),
 * so the picked step's own calls — whose results land before the next
 * request — are included; null serves everything (the latest view).
 */

import type { RequestRecord, SurfaceNode } from '../shared/types'
import { parseCallArgs } from './callSummary'
import type { ConversationNodeLike } from './services'

export type FileOpKind = 'read' | 'write' | 'search'
export type FileForm = 'text' | 'image' | 'dir'

/** One executed file operation (a tool result with a resolved target path). */
export interface FileOp {
  seq: number
  /** Archive removal stamp — the locate target must precede it. */
  gone?: number
  kind: FileOpKind
  tool: string
  time?: number
  err: boolean
  added: number
  removed: number
  /** What was searched for, when a search named both a path and a pattern. */
  detail?: string
}

/** One file's aggregated activity; `ops` newest first. */
export interface FileEntry {
  path: string
  form: FileForm
  reads: number
  writes: number
  searches: number
  added: number
  removed: number
  errs: number
  ops: FileOp[]
}

export interface FileKindTotal { files: number; ops: number }

export interface FileActivity {
  /** Path-resolved files, most-recently-touched first. */
  entries: FileEntry[]
  totals: Record<FileOpKind | 'image', FileKindTotal> & { added: number; removed: number }
}

const KIND_BY_TOOL: Record<string, FileOpKind> = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'write',
  grep: 'search',
  glob: 'search',
}

/** The file purpose of a tool, or null for non-file tools (bash, web_search…). */
export function kindOfTool(tool: string | undefined): FileOpKind | null {
  if (tool === undefined) return null
  return KIND_BY_TOOL[tool] ?? null
}

/**
 * The operation's target path: the path-ish argument of read/write tools;
 * for searches the narrowing `path`, else the pattern itself (a pathless
 * grep/glob's target IS the pattern — the workspace-wide search text).
 */
export function pathOfArgs(tool: string, args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  if (tool === 'grep' || tool === 'glob') {
    const p = args.path
    if (typeof p === 'string' && p !== '') return p
    const pattern = args.pattern
    return typeof pattern === 'string' && pattern !== '' ? pattern : null
  }
  for (const k of ['file_path', 'filePath', 'path']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/** Rendered line count: '' is 0, a trailing newline closes its own line. */
export function linesOf(s: string): number {
  if (s === '') return 0
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return s.endsWith('\n') ? n : n + 1
}

/**
 * The signed line footprint of one call: an edit removes its old string and
 * adds its new one; a write adds its content (the pre-existing body, if any,
 * is unknowable from the arguments — the estimate stays honest about that).
 * Callers reach here only with parsed args (a null parse yields no path).
 */
function deltaOf(tool: string, args: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'edit') {
    const oldS = args.old_string
    const newS = args.new_string
    return {
      added: typeof newS === 'string' ? linesOf(newS) : 0,
      removed: typeof oldS === 'string' ? linesOf(oldS) : 0,
    }
  }
  if (tool === 'write') {
    const content = args.content
    return { added: typeof content === 'string' ? linesOf(content) : 0, removed: 0 }
  }
  return { added: 0, removed: 0 }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

/** The file's form — multimodal reads and image extensions scan apart; a trailing slash marks a directory target. */
export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXT.test(path)) return 'image'
  if (path.endsWith('/')) return 'dir'
  return 'text'
}

/** Fold every served tool-result node into per-file activity. */
export function activityOf(
  nodes: SurfaceNode[],
  convOf: (seq: number) => ConversationNodeLike | undefined,
  before: number | null,
): FileActivity {
  const totals: FileActivity['totals'] = {
    read: { files: 0, ops: 0 },
    write: { files: 0, ops: 0 },
    search: { files: 0, ops: 0 },
    image: { files: 0, ops: 0 },
    added: 0,
    removed: 0,
  }
  const byPath = new Map<string, FileEntry>()
  for (const n of nodes) {
    if (n.cat !== 'tool') continue
    if (before !== null && n.seq >= before) continue
    const kind = kindOfTool(n.tool)
    /* kind non-null ⟹ n.tool defined (kindOfTool's only other exit). */
    if (kind === null) continue
    const tool = n.tool as string
    const conv = convOf(n.seq)
    const args = parseCallArgs(conv?.call?.argsRaw)
    const path = pathOfArgs(tool, args)
    // A file-kind call whose arguments aged out of the retained window (or
    // name no target) has nothing to row — skipped, so counted means shown.
    if (path === null) continue
    totals[kind].ops++
    const { added, removed } = deltaOf(tool, args)
    const detail = kind === 'search'
      && typeof args.path === 'string' && args.path !== ''
      && typeof args.pattern === 'string' && args.pattern !== ''
      ? args.pattern
      : undefined
    const op: FileOp = {
      seq: n.seq,
      ...(n.gone !== undefined ? { gone: n.gone } : {}),
      kind,
      tool,
      ...(n.time !== undefined ? { time: n.time } : {}),
      // Parsed args ⟹ the conversation join carried this call; the assertion just restates it.
      err: n.err === true || (conv as ConversationNodeLike).isError === true,
      added,
      removed,
      ...(detail !== undefined ? { detail } : {}),
    }
    let entry = byPath.get(path)
    if (entry === undefined) {
      entry = { path, form: formOf(tool, path), reads: 0, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [] }
      byPath.set(path, entry)
    }
    if (kind === 'read') entry.reads++
    else if (kind === 'write') entry.writes++
    else entry.searches++
    entry.added += added
    entry.removed += removed
    if (op.err) entry.errs++
    entry.ops.push(op)
  }
  const entries = [...byPath.values()]
  for (const e of entries) {
    e.ops.sort((a, b) => b.seq - a.seq)
    if (e.reads > 0) totals.read.files++
    if (e.writes > 0) totals.write.files++
    if (e.searches > 0) totals.search.files++
    if (e.form === 'image') {
      totals.image.files++
      totals.image.ops += e.ops.length
    }
    totals.added += e.added
    totals.removed += e.removed
  }
  entries.sort((a, b) => b.ops[0].seq - a.ops[0].seq)
  return { entries, totals }
}

/**
 * The browser step whose assembled surface SHOWS an op's result node: the
 * first request dispatched after it while it was still alive (that step's
 * brief is where the result landed). A live node no request has consumed
 * yet reveals on the live surface; an archived node no retained step still
 * contains is not viewable anywhere (null → the row stays inert).
 */
export function locateStepOf(requests: RequestRecord[], seq: number, gone: number | undefined): number | 'live' | null {
  for (const r of requests) {
    if (r.seq > seq && (gone === undefined || gone > r.seq)) return r.seq
  }
  return gone === undefined ? 'live' : null
}
