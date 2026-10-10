/**
 * File activity — what the agent DID to files. The op-log generation's host fold
 * derives one record per executed file op over the whole log
 * (shared/fileOps.ts), so this module only filters and aggregates; older hosts
 * serve no `fileOps`, and the legacy path re-derives the ops from the served
 * nodes joined with the conversation window (window-bound).
 *
 * `before` is the exclusive upper seq bound (the next request's seq).
 */

import type { FileOpRecord, RequestRecord, SurfaceNode } from '../shared/types'
import { opsOfCall, parseCallArgs } from '../shared/fileOps'
// The harness's browser-safe file-address layer, inlined by the client bundle:
// the produced address is the `dsh-resource://file/…` spelling the preview claims.
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConversationNodeLike } from './services'

export type FileOp = FileOpRecord
export type FileOpKind = FileOpRecord['kind']
export type FileForm = 'text' | 'image' | 'dir'

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
  /** Set when `path` is a pathless search's PATTERN, not a file path — display must not relativize it. */
  pattern?: true
}

export interface FileKindTotal { files: number; ops: number }

export interface FileActivity {
  entries: FileEntry[]
  totals: Record<FileOpKind | 'image', FileKindTotal> & { added: number; removed: number }
}

export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXT.test(path)) return 'image'
  if (path.endsWith('/')) return 'dir'
  return 'text'
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

/** One row icon: the emoji, or a letter badge when `color` is set, plus the i18n key naming its bucket. */
export interface FileGlyph {
  glyph: string
  tip: string
  /** Language-badge fill; present only on the code-file buckets. */
  color?: string
  text?: string
}

/** Directory buckets by last path segment; then hidden dirs, then the plain folder. */
const DIR_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], '🧪', 'files.glyph.tests'],
  [['doc', 'docs', 'documentation'], '📚', 'files.glyph.docs'],
  [['node_modules', 'vendor', 'third_party', 'third-party', 'packages'], '📦', 'files.glyph.deps'],
  [['dist', 'build', 'out', 'target', 'release', 'debug', 'coverage', 'artifacts'], '🏗️', 'files.glyph.build'],
  [['scripts', 'tools', 'bin'], '🛠️', 'files.glyph.scripts'],
  [['config', 'configs', 'settings', '.config'], '⚙️', 'files.glyph.config'],
  [['assets', 'static', 'public', 'images', 'fonts', 'icons', 'media'], '🎨', 'files.glyph.assets'],
]

const LOCK_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']
const MAKE_NAMES = ['makefile', 'justfile', 'cmakelists.txt']
const TEST_NAME = /(^|[^a-z0-9])test([^a-z0-9]|$)|\.test\./

/** Language files render as letter badges over their language's color, before the emoji buckets. */
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

/** Badge text by fill luminance: white on dark shades, near-black (never pure black) on light ones. */
function badgeTextColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance < 0.6 ? '#ffffff' : '#1f2328'
}

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

export function glyphOf(path: string, form: FileForm): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return form === 'dir' ? dirGlyph(base) : fileGlyph(base)
}

const DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/** The absolute form of a real file path: verbatim when already absolute,
 * resolved against the workspace root when relative, undefined when a relative path has no root to resolve against. */
export function absPathOf(path: string, workspace: string | undefined): string | undefined {
  if (path.startsWith('/') || DRIVE_PATH.test(path)) return path
  if (workspace === undefined || workspace === '' || path.startsWith('.')) return undefined
  return workspace.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/** The session-scoped `dsh-resource://file/…` preview address, built by the
 * harness's own `fileAddressFor`, so every route to one file settles on one
 * tab. Undefined for a search pattern, a directory, a missing session, or a path the encoder rejects. */
export function previewAddressOf(
  path: string,
  form: FileForm,
  pattern: boolean | undefined,
  sessionId: string | undefined,
  workspace: string | undefined,
): string | undefined {
  if (pattern === true || form === 'dir' || sessionId === undefined || sessionId === '') return undefined
  try {
    return fileAddressFor(sessionId, workspace, path)
  } catch {
    // A lone surrogate in an untrusted log path fails URI encoding: not previewable, never a thrown render.
    return undefined
  }
}

/** The row's display path: inside the workspace (or already workspace-relative)
 * it shortens to a './'-prefixed relative; other forms stay verbatim. */
export function displayPathOf(path: string, workspace: string | undefined): string {
  const root = workspace !== undefined && workspace.length > 1 ? workspace.replace(/\/+$/, '') : undefined
  if (root !== undefined) {
    if (path === root) return './'
    if (path.startsWith(root + '/')) return './' + path.slice(root.length + 1)
  }
  if (path.startsWith('/') || DRIVE_PATH.test(path) || path.startsWith('.')) return path
  return './' + path
}

/** Fold op records into per-file activity: scope-filtered, aggregated per path, ops newest first. */
function aggregateOps(ops: readonly FileOp[], before: number | null): FileActivity {
  const totals: FileActivity['totals'] = {
    read: { files: 0, ops: 0 },
    write: { files: 0, ops: 0 },
    search: { files: 0, ops: 0 },
    image: { files: 0, ops: 0 },
    added: 0,
    removed: 0,
  }
  const byPath = new Map<string, FileEntry>()
  for (const op of ops) {
    // A nested op's scope key is its parent result's seq.
    const key = op.parent ?? op.seq
    if (before !== null && key >= before) continue
    totals[op.kind].ops++
    let entry = byPath.get(op.path)
    if (entry === undefined) {
      entry = {
        path: op.path,
        form: formOf(op.tool, op.path),
        reads: 0,
        writes: 0,
        searches: 0,
        added: 0,
        removed: 0,
        errs: 0,
        ops: [],
        ...(op.pattern === true ? { pattern: true as const } : {}),
      }
      byPath.set(op.path, entry)
    }
    if (op.kind === 'read') entry.reads++
    else if (op.kind === 'write') entry.writes++
    else entry.searches++
    entry.added += op.added
    entry.removed += op.removed
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

/** The op-log generation's read of the card: fold-derived records, with `gone` joined from the detail's archive at render time.
 */
export function activityOfOps(ops: readonly FileOpRecord[], archive: readonly SurfaceNode[], before: number | null): FileActivity {
  const goneBySeq = new Map<number, number>()
  for (const n of archive) if (n.gone !== undefined) goneBySeq.set(n.seq, n.gone)
  const joined = ops.map((op) => {
    const gone = goneBySeq.get(op.parent ?? op.seq)
    return gone !== undefined && op.gone === undefined ? { ...op, gone } : op
  })
  return aggregateOps(joined, before)
}

interface SubCall {
  name: string
  argsRaw: string
  seq: number
  time?: number
  err: boolean
  subCalls?: readonly unknown[]
}

/** Narrow one block of a node's `subCalls` tree to a settled nested call; a running or malformed block is dropped. */
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

/** Depth guard for nested Code-Mode trees: the SDK bindings exclude `run_code` itself, so a real tree is one level deep. */
const SUBCALL_MAX_DEPTH = 8

/** The legacy nested walk: every settled sub-dispatch whose arguments resolve to
 * a file target books one op, located on the parent run_code result. `seen`
 * holds visited blocks, so a malformed cyclic join cannot loop. */
function foldSubCalls(
  blocks: readonly unknown[],
  parent: SurfaceNode,
  program: string | undefined,
  ops: FileOp[],
  seen: Set<object>,
  depth: number,
): void {
  if (depth > SUBCALL_MAX_DEPTH) return
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || seen.has(block)) continue
    seen.add(block)
    const sub = subCallOf(block)
    if (sub !== null) {
      ops.push(...opsOfCall({
        seq: sub.seq,
        tool: sub.name,
        argsRaw: sub.argsRaw,
        err: sub.err,
        ...(sub.time !== undefined ? { time: sub.time } : {}),
        ...(parent.gone !== undefined ? { gone: parent.gone } : {}),
        parent: parent.seq,
        ...(program !== undefined ? { program } : {}),
      }))
      if (sub.subCalls !== undefined) foldSubCalls(sub.subCalls, parent, program, ops, seen, depth + 1)
    }
  }
}

/** The INLINE generation's derivation from the served nodes joined with the
 * conversation window (window-bound). Anything that throws while folding a node drops that node and the walk carries on. */
export function activityOf(
  nodes: SurfaceNode[],
  convOf: (seq: number) => ConversationNodeLike | undefined,
  before: number | null,
): FileActivity {
  const ops: FileOp[] = []
  for (const n of nodes) {
    if (n.cat !== 'tool') continue
    if (before !== null && n.seq >= before) continue
    const tool = n.tool
    if (tool === undefined) continue
    try {
      const conv = convOf(n.seq)
      ops.push(...opsOfCall({
        seq: n.seq,
        tool,
        argsRaw: conv?.call?.argsRaw,
        meta: conv?.meta,
        err: n.err === true || conv?.isError === true,
        ...(n.time !== undefined ? { time: n.time } : {}),
        ...(n.gone !== undefined ? { gone: n.gone } : {}),
      }))
      // Nested Code-Mode calls (PTC): one settled sub-dispatch is one op.
      const subCalls = conv?.subCalls
      if (subCalls !== undefined && subCalls.length > 0) {
        foldSubCalls(subCalls, n, programOf(conv), ops, new Set<object>(), 1)
      }
    } catch {
      // The guard exists so malformed join data can never matter.
    }
  }
  return aggregateOps(ops, null)
}

/** The browser step whose surface SHOWS an op's result node: the first request dispatched after it while it was still
 * alive. Sorted here because the wire's append order is not guaranteed (restored rows can re-order) — the same rule
 * the browser's own entry stamps read. */
export function locateStepOf(requests: RequestRecord[], seq: number, gone: number | undefined): number | 'live' | null {
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  for (const r of sorted) {
    if (r.seq > seq && (gone === undefined || gone > r.seq)) return r.seq
  }
  return gone === undefined ? 'live' : null
}
