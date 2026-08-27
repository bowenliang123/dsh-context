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
  /** Read ops only: what the call read — the 1-based `start` line and `count`
   * when the result meta reported the window, else just the `count` estimated
   * off the limit argument (`est: true`). */
  read?: { start: number; count: number } | { count: number; est: true }
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

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

/** The file's form — multimodal reads and image extensions scan apart; a trailing slash marks a directory target. */
export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXT.test(path)) return 'image'
  if (path.endsWith('/')) return 'dir'
  return 'text'
}

/** One row icon: the emoji — or, when `color` is set, a letter badge with that
 * fill and `glyph` as its label — plus the i18n key naming its bucket (the row's hover title). */
export interface FileGlyph {
  glyph: string
  tip: string
  /** Language-badge fill; present only on the code-file buckets. */
  color?: string
  /** Badge text color, riding along with `color` (white, or near-black on light fills). */
  text?: string
}

/** Directory buckets, by last path segment (lowercased, explicit plurals). Checked in order, then hidden dirs, then the plain folder. */
const DIR_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], '🧪', 'files.glyph.tests'],
  [['doc', 'docs', 'documentation'], '📚', 'files.glyph.docs'],
  [['node_modules', 'vendor', 'third_party', 'third-party', 'packages'], '📦', 'files.glyph.deps'],
  [['dist', 'build', 'out', 'target', 'release', 'debug', 'coverage', 'artifacts'], '🏗️', 'files.glyph.build'],
  [['scripts', 'tools', 'bin'], '🛠️', 'files.glyph.scripts'],
  [['config', 'configs', 'settings', '.config'], '⚙️', 'files.glyph.config'],
  [['assets', 'static', 'public', 'images', 'fonts', 'icons', 'media'], '🎨', 'files.glyph.assets'],
]

/** Lockfile base names that do not end in `.lock`. */
const LOCK_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']
const MAKE_NAMES = ['makefile', 'justfile', 'cmakelists.txt']
/** A test file by name: a standalone or delimited `test`, or an inline `.test.`. */
const TEST_NAME = /(^|[^a-z0-9])test([^a-z0-9]|$)|\.test\./

/**
 * Programming-language files render as letter badges over their language's
 * color (GitHub Linguist shades). Checked before the emoji buckets, so a
 * language file never falls through to one.
 */
const CODE_LANGS: (readonly [readonly string[], string, string, string])[] = [
  [['tsx'], 'TSX', '#3178c6', 'files.glyph.lang.ts'],
  [['ts'], 'TS', '#3178c6', 'files.glyph.lang.ts'],
  [['js', 'jsx', 'mjs', 'cjs'], 'JS', '#f7df1e', 'files.glyph.lang.js'],
  [['py', 'pyi', 'pyw'], 'PY', '#3572a5', 'files.glyph.python'],
  [['ipynb'], 'NB', '#da5b0b', 'files.glyph.notebook'],
  [['go'], 'GO', '#00add8', 'files.glyph.lang.go'],
  [['rs'], 'RS', '#dea584', 'files.glyph.lang.rust'],
  [['java'], 'JV', '#b07219', 'files.glyph.lang.java'],
  [['kt', 'kts'], 'KT', '#a97bff', 'files.glyph.lang.kotlin'],
  [['rb'], 'RB', '#701516', 'files.glyph.lang.ruby'],
  [['php'], 'PHP', '#4f5d95', 'files.glyph.lang.php'],
  [['c', 'h'], 'C', '#555555', 'files.glyph.lang.c'],
  [['cpp', 'cc', 'cxx', 'hpp'], 'C++', '#f34b7d', 'files.glyph.lang.cpp'],
  [['cs'], 'C#', '#178600', 'files.glyph.lang.csharp'],
  [['scala'], 'SC', '#c22d40', 'files.glyph.lang.scala'],
  [['lua'], 'LUA', '#000080', 'files.glyph.lang.lua'],
  [['dart'], 'DA', '#00b4ab', 'files.glyph.lang.dart'],
  [['swift'], 'SW', '#f05138', 'files.glyph.lang.swift'],
  [['vue'], 'VUE', '#41b883', 'files.glyph.lang.vue'],
  [['svelte'], 'SV', '#ff3e00', 'files.glyph.lang.svelte'],
  [['sh', 'bash', 'zsh', 'fish', 'ps1'], 'SH', '#89e051', 'files.glyph.shell'],
  [['html', 'htm', 'xhtml'], 'HT', '#e34c26', 'files.glyph.lang.html'],
  [['css', 'scss', 'sass', 'less', 'styl'], 'CSS', '#563d7c', 'files.glyph.style'],
  [['sql'], 'SQL', '#e38c00', 'files.glyph.database'],
]

/**
 * Badge text by fill luminance: white on dark shades, near-black on light
 * ones (the JS yellow, the shell green) — a fixed dark tone, never pure
 * black, so it sits quietly next to the white badges.
 */
function badgeTextColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance < 0.6 ? '#ffffff' : '#1f2328'
}

/** Extension buckets for non-code files, most specific first. */
const EXT_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env'], '⚙️', 'files.glyph.config'],
  [['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'xml'], '🧾', 'files.glyph.data'],
  [['md', 'mdx', 'markdown', 'rst', 'adoc', 'org'], '📝', 'files.glyph.markdown'],
  [['log'], '📜', 'files.glyph.log'],
  [['csv', 'tsv', 'xls', 'xlsx', 'ods'], '📊', 'files.glyph.sheet'],
  [['pdf', 'doc', 'docx', 'odt', 'rtf'], '📕', 'files.glyph.document'],
  [['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar'], '🗜️', 'files.glyph.archive'],
  [['ttf', 'otf', 'woff', 'woff2', 'eot'], '🔤', 'files.glyph.font'],
  [['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'ogg'], '🎬', 'files.glyph.media'],
]

function dirGlyph(base: string): FileGlyph {
  if (base === '' || base === '.') return { glyph: '🏠', tip: 'files.glyph.root' }
  const name = base.toLowerCase()
  for (const [names, glyph, tip] of DIR_BUCKETS) {
    if (names.includes(name)) return { glyph, tip }
  }
  if (name.startsWith('.')) return { glyph: '🗄️', tip: 'files.glyph.hidden' }
  return { glyph: '📁', tip: 'files.form.dir' }
}

function fileGlyph(base: string): FileGlyph {
  const name = base.toLowerCase()
  const dot = name.lastIndexOf('.')
  // A dot at position 0 is a dotfile, not an extension — `.env` below reads by name.
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (name.endsWith('.lock') || LOCK_NAMES.includes(name)) return { glyph: '🔒', tip: 'files.glyph.lock' }
  if (TEST_NAME.test(name)) return { glyph: '🧪', tip: 'files.glyph.tests' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { glyph: '🐳', tip: 'files.glyph.docker' }
  if (MAKE_NAMES.includes(name)) return { glyph: '🛠️', tip: 'files.glyph.scripts' }
  if (name === '.gitignore' || name === '.gitattributes') return { glyph: '🚫', tip: 'files.glyph.ignore' }
  if (name === 'license' || name.startsWith('license.') || name === 'copying') return { glyph: '⚖️', tip: 'files.glyph.license' }
  if (name === '.env' || name.startsWith('.env.')) return { glyph: '⚙️', tip: 'files.glyph.config' }
  if (ext !== '') {
    for (const [exts, label, color, tip] of CODE_LANGS) {
      if (exts.includes(ext)) return { glyph: label, tip, color, text: badgeTextColor(color) }
    }
    for (const [exts, glyph, tip] of EXT_BUCKETS) {
      if (exts.includes(ext)) return { glyph, tip }
    }
  }
  return { glyph: '📄', tip: 'files.form.text' }
}

/** The row icon for one file entry: form first (image/dir), then the file-name tables. */
export function glyphOf(path: string, form: FileForm): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return form === 'dir' ? dirGlyph(base) : fileGlyph(base)
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
        const read = kind === 'read' ? readOf(undefined, args) : undefined
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
          ...(read !== undefined ? { read } : {}),
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
    // One node's join data can never take the card down: anything that throws
    // while folding it (a hostile conversation node, a drifted host) drops
    // that node and the walk carries on.
    try {
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
        // The join may have aged this node out entirely (conv undefined).
        const err = n.err === true || conv?.isError === true
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
            const read = kind === 'read' ? readOf(conv?.meta, args) : undefined
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
              ...(read !== undefined ? { read } : {}),
            }, path)
          }
        }
      }
      // Nested Code-Mode calls (PTC): one settled sub-dispatch is one op.
      const subCalls = conv?.subCalls
      if (subCalls !== undefined && subCalls.length > 0) {
        foldSubCalls(subCalls, n, programOf(conv), add, new Set<object>(), 1)
      }
    } catch {
      // Unreachable with well-formed join data; the guard exists so it can
      // never matter.
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
