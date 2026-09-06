/**
 * The file-operation parser — the ONE derivation of "what the agent did to
 * files" from a settled file-tool call. Shared by both halves: the host fold
 * books the op log from the durable tool lifecycle (tool/call +
 * tool/result + tool/code-dispatch), and the client's INLINE-generation
 * fallback re-derives ops from the conversation-window join when an older
 * host serves no `fileOps`.
 *
 * Tool coverage matches the harness's built-ins on every supported baseline
 * (0.1.2-rc.1): read / read_image / write / edit (tool-fs) and grep / glob
 * (tool-fs-search), plus the Anthropic-style `str_replace_editor` (view
 * reads, every other command writes). Line deltas are estimates read off the
 * call ARGUMENTS (an edit's old/new strings, a write's content), never off
 * result payloads. A search resolves further when its result's bounded
 * presentation meta names the matched files — the ops then row per real
 * file with the match count, and only a capped (`truncated`) or malformed
 * meta falls back to the call's own target (the narrowing path, else the
 * searched pattern itself).
 */

import type { FileOpRecord } from './types'

/** Parse a call's raw JSON arguments; non-string/malformed/non-record inputs yield null. */
export function parseCallArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const KIND_BY_TOOL: Record<string, FileOpRecord['kind']> = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'write',
  grep: 'search',
  glob: 'search',
}

/** The file purpose of a tool, or null for non-file tools (bash, web_search…). */
export function kindOfTool(tool: string | undefined): FileOpRecord['kind'] | null {
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
export function kindOfCall(tool: string, args: Record<string, unknown> | null): FileOpRecord['kind'] | null {
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

/** The exact window a read's result meta reports: `offset` plus the retained
 * `lines` array (the same bounded payload the read card renders from). Null
 * for a foreign or malformed meta. */
function readWindowOf(meta: unknown): { start: number; count: number } | null {
  if (meta === null || typeof meta !== 'object') return null
  const m = meta as { path?: unknown; offset?: unknown; lines?: unknown }
  if (typeof m.path !== 'string' || m.path === '') return null
  if (typeof m.offset !== 'number' || !Number.isFinite(m.offset) || m.offset < 1) return null
  if (!Array.isArray(m.lines) || m.lines.length === 0) return null
  return { start: m.offset, count: m.lines.length }
}

/** The limit estimate: the tool reads up to `limit` lines from `offset`;
 * absent when the call reads unbounded. */
function readEstimateOf(args: Record<string, unknown>): { count: number; est: true } | undefined {
  const limit = args.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { count: Math.floor(limit), est: true }
    : undefined
}

/** What a read op shows: the exact window off the result meta, else the
 * limit estimate, else nothing (an unbounded read names no footprint). */
function readOf(meta: unknown, args: Record<string, unknown>): { start: number; count: number } | { count: number; est: true } | undefined {
  const win = readWindowOf(meta)
  if (win !== null) return { start: win.start, count: win.count }
  return readEstimateOf(args)
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

/**
 * The one-shot per-call op assembly, uniform across every producer: the
 * host's call/result pairing (args off the armed call, meta off the
 * result), the nested Code-Mode settle (no meta exists on a dispatch — the
 * read window and per-file search attribution degrade to the argument-only
 * forms), and the client's inline-generation join fallback. Returns zero to
 * N records: a search with the complete matched-file meta rows per file;
 * any other file call rows once; a non-file tool (or a call whose arguments
 * resolve no target) rows nothing.
 */
export function opsOfCall(input: {
  seq: number
  tool: string
  argsRaw?: unknown
  meta?: unknown
  err?: boolean
  time?: number
  gone?: number
  parent?: number
  program?: string
}): FileOpRecord[] {
  const args = parseCallArgs(input.argsRaw)
  const kind = kindOfCall(input.tool, args)
  if (kind === null) return []
  const stamp: FileOpRecord = {
    seq: input.seq,
    kind,
    tool: input.tool,
    err: input.err === true,
    added: 0,
    removed: 0,
    path: '',
    ...(input.time !== undefined ? { time: input.time } : {}),
    ...(input.gone !== undefined ? { gone: input.gone } : {}),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.program !== undefined ? { program: input.program } : {}),
  }
  // A search whose result meta carries the COMPLETE matched-file list rows
  // its ops per real file — even when the call's own arguments failed to
  // parse (the detail line just drops out). The call's own target (the
  // searched path, or the pattern for a workspace-wide search) rows TOO —
  // "what was searched" and "what got hit" both count; only the degenerate
  // single-file search (the target IS the sole matched file) skips the
  // duplicate target row.
  if (kind === 'search') {
    const files = searchFilesOf(input.meta)
    if (files !== null) {
      const detail = searchDetailOf(args)
      const target = args !== null ? pathOfArgs(input.tool, args) : null
      const narrowed = args !== null && typeof args.path === 'string' && args.path !== ''
      const targetOps: FileOpRecord[] = target !== null && !files.some(f => f.path === target)
        ? [{
          ...stamp,
          path: target,
          ...(narrowed && detail !== undefined ? { detail } : {}),
          ...(narrowed ? {} : { pattern: true as const }),
        }]
        : []
      return [
        ...targetOps,
        ...files.map(f => ({
          ...stamp,
          path: f.path,
          ...(detail !== undefined ? { detail } : {}),
          ...(f.hits > 0 ? { hits: f.hits } : {}),
        })),
      ]
    }
  }
  if (args === null) return []
  const path = pathOfArgs(input.tool, args)
  if (path === null) return []
  const { added, removed } = deltaOf(input.tool, args)
  const narrowed = typeof args.path === 'string' && args.path !== ''
  const detail = kind === 'search' && narrowed ? searchDetailOf(args) : undefined
  const read = kind === 'read' ? readOf(input.meta, args) : undefined
  return [{
    ...stamp,
    path,
    added,
    removed,
    ...(detail !== undefined ? { detail } : {}),
    ...(read !== undefined ? { read } : {}),
    ...(kind === 'search' && !narrowed ? { pattern: true as const } : {}),
  }]
}
