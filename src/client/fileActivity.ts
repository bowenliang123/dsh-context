/**
 * File activity — what the agent DID to files, derived client-side from the
 * timeline's served tool-result nodes (live tail + archive) joined with the
 * conversation snapshot for call arguments; no host or wire additions.
 *
 * One top-level tool-result surface node equals one executed call. Code Mode
 * (PTC) runs nested calls instead — those ride the conversation node's
 * `subCalls` tree, and each settled sub-dispatch folds as one op attributed
 * to the nested tool and located on its parent run_code result. A call whose
 * arguments have aged out of the conversation join names no target and is
 * skipped — every op the card counts, it can also row. Line deltas are
 * estimates read off the call ARGUMENTS (an edit's old/new strings, a write's
 * content), never off result payloads.
 *
 * A search resolves further when its result's bounded presentation meta names
 * the matched files: the ops then row per real file (with the match count),
 * and only a capped or malformed meta falls back to the call's own target —
 * the narrowing path, else the searched pattern.
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
  /**
   * Nested Code-Mode op only: the run_code result node the op ran under — the
   * locate target, because the op's own seq names the dispatch event, which
   * has no surface row. `gone` is the parent's stamp.
   */
  parent?: number
  /** Nested Code-Mode op only: the run_code program's model-authored description — why the file was touched. */
  program?: string
  /** Meta-attributed search op only: matched lines the result reported for this file. */
  hits?: number
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
 * The file purpose of one executed call. Like {@link kindOfTool} except for
 * the one file tool whose purpose follows its arguments: `str_replace_editor`
 * reads on `view` and writes on every other command (create / str_replace /
 * insert — an unknown command writes too; the call failed and the row keeps
 * its error flag).
 */
export function kindOfCall(tool: string, args: Record<string, unknown> | null): FileOpKind | null {
  if (tool === 'str_replace_editor') return args !== null && args.command === 'view' ? 'read' : 'write'
  return kindOfTool(tool)
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

/** The added/removed pair of one content-bearing argument set, or zeros. */
function pairOf(added: unknown, removed: unknown): { added: number; removed: number } {
  return {
    added: typeof added === 'string' ? linesOf(added) : 0,
    removed: typeof removed === 'string' ? linesOf(removed) : 0,
  }
}

/**
 * The signed line footprint of one call: an edit removes its old string and
 * adds its new one; a write adds its content (the pre-existing body, if any,
 * is unknowable from the arguments — the estimate stays honest about that);
 * `str_replace_editor` splits the same shapes across its commands. Callers
 * reach here only with parsed args (a null parse yields no path).
 */
function deltaOf(tool: string, args: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'edit') return pairOf(args.new_string, args.old_string)
  if (tool === 'write') return pairOf(args.content, undefined)
  if (tool === 'str_replace_editor') {
    if (args.command === 'str_replace') return pairOf(args.new_str, args.old_str)
    if (args.command === 'insert') return pairOf(args.new_str, undefined)
    if (args.command === 'create') return pairOf(args.file_text, undefined)
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

/**
 * A search op's detail: the pattern, with the include filter appended when
 * one narrowed the call. A patternless (malformed) search has no detail.
 */
function searchDetailOf(args: Record<string, unknown> | null): string | undefined {
  const pattern = args?.pattern
  if (typeof pattern !== 'string' || pattern === '') return undefined
  const include = args?.include
  return typeof include === 'string' && include !== '' ? `${pattern} (${include})` : pattern
}

/**
 * The files a search demonstrably reached, read off the result's bounded
 * presentation meta (grep groups matched lines by file; glob lists paths).
 * Only the COMPLETE list attributes: a capped search (`truncated`) names a
 * partial file set, and a malformed meta names none — both fall back to the
 * call's own target. Each entry carries the reported match count.
 */
function searchFilesOf(meta: unknown): { path: string; hits: number }[] | null {
  if (meta === null || typeof meta !== 'object') return null
  const m = meta as { shape?: unknown; truncated?: unknown; files?: unknown; paths?: unknown }
  if (m.truncated !== false) return null
  const files: { path: string; hits: number }[] = []
  if (m.shape === 'matches' && Array.isArray(m.files)) {
    for (const f of m.files) {
      if (f === null || typeof f !== 'object') continue
      const group = f as { path?: unknown; matches?: unknown }
      if (typeof group.path === 'string' && group.path !== '' && Array.isArray(group.matches)) {
        files.push({ path: group.path, hits: group.matches.length })
      }
    }
  } else if (m.shape === 'paths' && Array.isArray(m.paths)) {
    for (const p of m.paths) {
      if (typeof p === 'string' && p !== '') files.push({ path: p, hits: 0 })
    }
  }
  return files.length > 0 ? files : null
}

/** One settled nested call of a Code-Mode tree, as far as the fold consumes it. */
interface SubCall {
  name: string
  argsRaw: string
  seq: number
  time?: number
  err: boolean
  subCalls?: readonly unknown[]
}

/**
 * Narrow one block of a conversation node's `subCalls` tree to a settled
 * nested call, or null. The join is defensive — a running call has no result
 * kind yet, and any malformed block is dropped, never thrown. (Null and
 * non-object blocks never reach here: the folding loop pre-filters them.)
 */
function subCallOf(block: unknown): SubCall | null {
  const b = block as Record<string, unknown>
  if (b.kind !== 'tool-result') return null
  if (b.call === null || typeof b.call !== 'object') return null
  const call = b.call as { name?: unknown; argsRaw?: unknown }
  if (typeof call.name !== 'string' || typeof call.argsRaw !== 'string') return null
  if (typeof b.seq !== 'number' || !Number.isFinite(b.seq)) return null
  return {
    name: call.name,
    argsRaw: call.argsRaw,
    seq: b.seq,
    ...(typeof b.time === 'number' ? { time: b.time } : {}),
    ...(b.isError === true ? { err: true } : { err: false }),
    ...(Array.isArray(b.subCalls) ? { subCalls: b.subCalls } : {}),
  }
}

/** The run_code call's model-authored description — the nested ops' "why". */
function programOf(conv: ConversationNodeLike | undefined): string | undefined {
  const description = parseCallArgs(conv?.call?.argsRaw)?.description
  return typeof description === 'string' && description !== '' ? description : undefined
}

/**
 * Depth guard for nested Code-Mode trees. The SDK bindings exclude `run_code`
 * itself, so a real tree is one level deep; the cap only bounds defensive
 * re-entry over a malformed join.
 */
const SUBCALL_MAX_DEPTH = 8

/**
 * Fold one nested Code-Mode tree: every settled sub-dispatch whose arguments
 * resolve to a file target books one op, attributed to the nested tool and
 * located on the parent run_code result. `seen` holds the already-visited
 * blocks, so a malformed (cyclic) join cannot loop.
 */
function foldSubCalls(
  blocks: readonly unknown[],
  parent: SurfaceNode,
  program: string | undefined,
  add: (op: FileOp, path: string) => void,
  seen: Set<object>,
  depth: number,
): void {
  if (depth > SUBCALL_MAX_DEPTH) return
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || seen.has(block)) continue
    seen.add(block)
    const sub = subCallOf(block)
    if (sub !== null) {
      const args = parseCallArgs(sub.argsRaw)
      const kind = args !== null ? kindOfCall(sub.name, args) : null
      const path = kind !== null ? pathOfArgs(sub.name, args) : null
      if (args !== null && kind !== null && path !== null) {
        const { added, removed } = deltaOf(sub.name, args)
        const detail = kind === 'search' && typeof args.path === 'string' && args.path !== ''
          ? searchDetailOf(args)
          : undefined
        add({
          seq: sub.seq,
          ...(parent.gone !== undefined ? { gone: parent.gone } : {}),
          kind,
          tool: sub.name,
          ...(sub.time !== undefined ? { time: sub.time } : {}),
          err: sub.err,
          added,
          removed,
          ...(detail !== undefined ? { detail } : {}),
          parent: parent.seq,
          ...(program !== undefined ? { program } : {}),
        }, path)
      }
      if (sub.subCalls !== undefined) foldSubCalls(sub.subCalls, parent, program, add, seen, depth + 1)
    }
  }
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
  /** Book one executed op under its file; the totals and the entry move together. */
  const add = (op: FileOp, path: string): void => {
    totals[op.kind].ops++
    let entry = byPath.get(path)
    if (entry === undefined) {
      entry = { path, form: formOf(op.tool, path), reads: 0, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [] }
      byPath.set(path, entry)
    }
    if (op.kind === 'read') entry.reads++
    else if (op.kind === 'write') entry.writes++
    else entry.searches++
    entry.added += op.added
    entry.removed += op.removed
    if (op.err) entry.errs++
    entry.ops.push(op)
  }
  for (const n of nodes) {
    if (n.cat !== 'tool') continue
    if (before !== null && n.seq >= before) continue
    const tool = n.tool
    if (tool === undefined) continue
    const conv = convOf(n.seq)
    const staticKind = kindOfTool(tool)
    // Args are read for the file-kind tools only — any other call (bash, web
    // search…) contributes nothing at the top level and walks only its
    // nested tree, if any.
    const args = staticKind !== null || tool === 'str_replace_editor'
      ? parseCallArgs(conv?.call?.argsRaw)
      : null
    const kind = staticKind ?? kindOfCall(tool, args)
    if (kind !== null) {
      const err = n.err === true || (conv as ConversationNodeLike).isError === true
      // A search whose result meta carries the COMPLETE matched-file list
      // rows its ops per real file; a capped or malformed meta falls back to
      // the call's own target (the narrowing path, else the pattern).
      const files = kind === 'search' ? searchFilesOf(conv?.meta) : null
      if (files !== null) {
        const detail = searchDetailOf(args)
        for (const f of files) {
          add({
            seq: n.seq,
            ...(n.gone !== undefined ? { gone: n.gone } : {}),
            kind,
            tool,
            ...(n.time !== undefined ? { time: n.time } : {}),
            err,
            added: 0,
            removed: 0,
            ...(detail !== undefined ? { detail } : {}),
            ...(f.hits > 0 ? { hits: f.hits } : {}),
          }, f.path)
        }
      } else if (args !== null) {
        const path = pathOfArgs(tool, args)
        if (path !== null) {
          const { added, removed } = deltaOf(tool, args)
          const detail = kind === 'search'
            && typeof args.path === 'string' && args.path !== ''
            ? searchDetailOf(args)
            : undefined
          add({
            seq: n.seq,
            ...(n.gone !== undefined ? { gone: n.gone } : {}),
            kind,
            tool,
            ...(n.time !== undefined ? { time: n.time } : {}),
            err,
            added,
            removed,
            ...(detail !== undefined ? { detail } : {}),
          }, path)
        }
      }
    }
    // Nested Code-Mode calls (PTC): one settled sub-dispatch is one op.
    const subCalls = conv?.subCalls
    if (subCalls !== undefined && subCalls.length > 0) {
      foldSubCalls(subCalls, n, programOf(conv), add, new Set<object>(), 1)
    }
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
