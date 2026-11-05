import type { FileOpRecord, RequestRecord, SurfaceNode } from '../shared/types'
import { opsOfCall, parseCallArgs } from '../shared/fileOps'
import { leafNameOf } from '../shared/attachment'
import { fileAddressFor, isAbsoluteWorkspacePath, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
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
  ops: FileOp[]
  pattern?: true
}

export function surfaceSeqOf(op: FileOp): number {
  return op.parent ?? op.seq
}

export interface FileKindTotal { files: number; ops: number }

export interface FileActivity {
  entries: FileEntry[]
  totals: Record<FileOpKind | 'image', FileKindTotal> & { added: number; removed: number }
}

export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXT.test(path)) return 'image'
  if (path.endsWith('/') || path.endsWith('\\')) return 'dir'
  return 'text'
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

export interface FileGlyph {
  glyph: string
  tip: string
  color?: string
  text?: string
}

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

export function baseNameOf(path: string): string {
  return leafNameOf(trimSeps(path))
}

export function glyphOf(path: string, form: FileForm): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const base = baseNameOf(path)
  return form === 'dir' ? dirGlyph(base) : fileGlyph(base)
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path)
}

function trimSeps(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function dotPathOf(path: string, windows: boolean): string {
  const sep = windows ? '\\' : '/'
  const native = windows ? path.replace(/\//g, '\\') : path
  const trimmed = native
    .replace(windows ? /^\\+/ : /^\/+/, '')
    .replace(windows ? /\\{2,}/g : /\/{2,}/g, sep)
  const dotPrefix = windows ? /^(?:\.\\)+/ : /^(?:\.\/)+/
  const bare = trimmed.replace(dotPrefix, '')
  if (bare === '' || bare === '.') return '.'
  if (bare === '..' || bare.startsWith('..' + sep)) return bare
  return '.' + sep + bare
}

function windowsDisplayPathOf(path: string, workspace: string | undefined): string {
  const full = path.replace(/\//g, '\\')
  const root = workspace === undefined ? '' : trimSeps(workspace.replace(/\//g, '\\'))
  if (root !== '') {
    const lowerRoot = root.toLowerCase()
    const lowerFull = full.toLowerCase()
    if (lowerFull === lowerRoot) return '.'
    if (lowerFull.startsWith(lowerRoot + '\\')) return dotPathOf(full.slice(root.length + 1), true)
  }
  if (isAbsoluteWorkspacePath(full)) return full
  return dotPathOf(full, true)
}

function posixDisplayPathOf(path: string, workspace: string | undefined): string {
  if (workspace === '/') {
    if (path === '/') return '.'
    if (path.startsWith('/')) return dotPathOf(path.slice(1), false)
  }
  const root = workspace === undefined ? '' : trimSeps(workspace)
  if (root !== '') {
    if (path === root) return '.'
    if (path.startsWith(root + '/')) return dotPathOf(path.slice(root.length + 1), false)
  }
  if (path.startsWith('/')) return path
  return dotPathOf(path, false)
}

export function absPathOf(path: string, workspace: string | undefined): string | undefined {
  if (isAbsoluteWorkspacePath(path)) return isWindowsPath(path) ? path.replace(/\//g, '\\') : path
  if (workspace === undefined || workspace === '' || path.startsWith('.')) return undefined
  const resolved = resolveWorkspacePath(workspace, path)
  return isWindowsPath(workspace) ? resolved.replace(/\//g, '\\') : resolved
}

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
    return undefined
  }
}

export function displayPathOf(path: string, workspace: string | undefined): string {
  return displayStyleOf(path, workspace) === 'windows'
    ? windowsDisplayPathOf(path, workspace)
    : posixDisplayPathOf(path, workspace)
}

export type DisplayStyle = 'windows' | 'posix'

export function displayStyleOf(path: string, workspace: string | undefined): DisplayStyle {
  if (path.startsWith('/')) return 'posix'
  if (isWindowsPath(path) || (workspace !== undefined && isWindowsPath(workspace))) return 'windows'
  return workspace === undefined && path.includes('\\') ? 'windows' : 'posix'
}

export function totalsOf(entries: readonly FileEntry[]): FileActivity['totals'] {
  const totals: FileActivity['totals'] = {
    read: { files: 0, ops: 0 },
    write: { files: 0, ops: 0 },
    search: { files: 0, ops: 0 },
    image: { files: 0, ops: 0 },
    added: 0,
    removed: 0,
  }
  for (const e of entries) {
    if (e.reads > 0) totals.read.files++
    if (e.writes > 0) totals.write.files++
    if (e.searches > 0) totals.search.files++
    totals.read.ops += e.reads
    totals.write.ops += e.writes
    totals.search.ops += e.searches
    if (e.form === 'image') {
      totals.image.files++
      totals.image.ops += e.ops.length
    }
    totals.added += e.added
    totals.removed += e.removed
  }
  return totals
}

function aggregateOps(ops: readonly FileOp[], before: number | null): FileActivity {
  const byPath = new Map<string, FileEntry>()
  for (const op of ops) {
    const key = surfaceSeqOf(op)
    if (before !== null && key >= before) continue
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
    entry.ops.push(op)
  }
  const entries = [...byPath.values()]
  for (const e of entries) e.ops.sort((a, b) => b.seq - a.seq)
  entries.sort((a, b) => b.ops[0].seq - a.ops[0].seq)
  return { entries, totals: totalsOf(entries) }
}

export function mergeByDisplay(entries: readonly FileEntry[], workspace: string | undefined): FileEntry[] {
  const byDisplay = new Map<string, FileEntry>()
  for (const e of entries) {
    const key = e.pattern === true ? 'p:' + e.path : displayPathOf(e.path, workspace)
    const prev = byDisplay.get(key)
    if (prev === undefined) {
      byDisplay.set(key, { ...e, ops: [...e.ops] })
      continue
    }
    prev.reads += e.reads
    prev.writes += e.writes
    prev.searches += e.searches
    prev.added += e.added
    prev.removed += e.removed
    prev.ops.push(...e.ops)
    if (isAbsoluteWorkspacePath(e.path)) prev.path = e.path
  }
  for (const e of byDisplay.values()) e.ops.sort((a, b) => b.seq - a.seq)
  return [...byDisplay.values()]
}

export function activityOfOps(ops: readonly FileOpRecord[], archive: readonly SurfaceNode[], before: number | null): FileActivity {
  const goneBySeq = new Map<number, number>()
  for (const n of archive) if (n.gone !== undefined) goneBySeq.set(n.seq, n.gone)
  const joined = ops.map((op) => {
    const gone = goneBySeq.get(surfaceSeqOf(op))
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

function programOf(conv: ConversationNodeLike | undefined): string | undefined {
  const description = parseCallArgs(conv?.call?.argsRaw)?.description
  return typeof description === 'string' && description !== '' ? description : undefined
}

const SUBCALL_MAX_DEPTH = 8

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
      const subCalls = conv?.subCalls
      if (subCalls !== undefined && subCalls.length > 0) {
        foldSubCalls(subCalls, n, programOf(conv), ops, new Set<object>(), 1)
      }
    } catch {
    }
  }
  return aggregateOps(ops, null)
}

export function locateStepOf(requests: RequestRecord[], seq: number, gone: number | undefined): number | 'live' | null {
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  for (const r of sorted) {
    if (r.seq > seq && (gone === undefined || gone > r.seq)) return r.seq
  }
  return gone === undefined ? 'live' : null
}
