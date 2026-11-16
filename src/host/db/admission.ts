import { eq } from 'drizzle-orm'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { asRecord } from '../record'
import type { Db } from './db'
import { bumpGeneration } from './db'
import { sessionTombstones, sessions } from './schema'
import type { FoldStatus } from './schema'
import { searchTextOf } from './rows'

const MIRROR_KEYS = new Set<string>(['title', 'sessionListMetadata'])

export interface ScanEntry {
  id: string
  header: Record<string, unknown>
  live: boolean
  session?: unknown
}

export interface WorkspaceMirror {
  archived: Set<string>
  groups: Map<string, string>
}

export function workspaceMirror(ctx: Context): WorkspaceMirror {
  const mirror: WorkspaceMirror = { archived: new Set(), groups: new Map() }
  const registry = asRecord(ctx.get('workspaceRegistry'))
  if (registry === null) return mirror
  try {
    const list = typeof registry.list === 'function' ? (registry.list as () => unknown).bind(registry) : undefined
    const listed: unknown = list === undefined ? [] : list()
    if (Array.isArray(listed)) {
      for (const item of listed) {
        const workspace = asRecord(item)
        const title = typeof workspace?.title === 'string' && workspace.title !== '' ? workspace.title : undefined
        if (title === undefined || !Array.isArray(workspace?.sessionIds)) continue
        for (const id of workspace.sessionIds) {
          if (typeof id === 'string' && id !== '' && !mirror.groups.has(id)) mirror.groups.set(id, title)
        }
      }
    }
  } catch {}
  try {
    const value: unknown = registry.archivedSessionIds
    if (Array.isArray(value)) {
      for (const id of value) if (typeof id === 'string' && id !== '') mirror.archived.add(id)
    }
  } catch {}
  return mirror
}

function runningOf(ctx: Context, id: string): boolean {
  const agents = asRecord(ctx.get('agents'))
  if (agents === null || typeof agents.get !== 'function') return false
  try {
    const agent = asRecord((agents.get as (id: string) => unknown)(id))
    return agent?.status === 'running'
  } catch {
    return false
  }
}

function projectionValues(ctx: Context, entry: ScanEntry): Record<string, unknown> {
  try {
    if (entry.live && entry.session !== undefined) {
      const projections = ctx.get('sessionProjections') as { snapshot?(session: unknown, keys: ReadonlySet<string>): unknown } | undefined
      if (typeof projections?.snapshot === 'function') {
        return asRecord(asRecord(projections.snapshot(entry.session, MIRROR_KEYS))?.values) ?? {}
      }
      return {}
    }
    const cache = ctx.get('sessionProjectionCache') as { cachedSnapshot?(header: unknown, keys: ReadonlySet<string>): unknown } | undefined
    if (typeof cache?.cachedSnapshot === 'function') {
      return asRecord(asRecord(cache.cachedSnapshot(entry.header, MIRROR_KEYS))?.values) ?? {}
    }
  } catch {}
  return {}
}

function titleOf(value: unknown, cwd: string | undefined, id: string): string {
  if (typeof value === 'string' && value !== '') return value
  if (cwd !== undefined) {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

export interface AdmissionRow {
  id: string
  createdAt: number
  cwd: string | null
  parentSession: string | null
  origin: 'subagent' | null
  isSeeded: number
  delegationDepth: number | null
  agentPreset: string | null
  familyRoot: string
  title: string
  blank: number
  lastPromptAt: number | null
  updatedAt: number
  archived: number
  workspaceTitle: string | null
  running: number
  searchText: string
}

export function admissionRows(ctx: Context, entries: readonly ScanEntry[]): AdmissionRow[] {
  const workspace = workspaceMirror(ctx)
  const rows: AdmissionRow[] = []
  for (const entry of entries) {
    const header = entry.header
    const values = projectionValues(ctx, entry)
    const metadata = asRecord(values.sessionListMetadata)
    const lastPromptAt = typeof metadata?.lastPromptAt === 'number' && Number.isFinite(metadata.lastPromptAt)
      ? metadata.lastPromptAt
      : null
    const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : 0
    const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    const title = titleOf(values.title, cwd ?? undefined, entry.id)
    const group = workspace.groups.get(entry.id) ?? null
    rows.push({
      id: entry.id,
      createdAt,
      cwd,
      parentSession: typeof header.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : null,
      origin: header.origin === 'subagent' ? 'subagent' : null,
      isSeeded: header.isSeeded === true ? 1 : 0,
      delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
      familyRoot: entry.id,
      title,
      blank: metadata?.blank === true ? 1 : 0,
      lastPromptAt,
      updatedAt: Math.max(createdAt, lastPromptAt ?? 0),
      archived: workspace.archived.has(entry.id) ? 1 : 0,
      workspaceTitle: group,
      running: runningOf(ctx, entry.id) ? 1 : 0,
      searchText: searchTextOf(title, cwd, null),
    })
  }
  return rows
}

export function familyRootOf(db: Db, id: string): string {
  const seen = new Set<string>()
  let current = id
  for (;;) {
    if (seen.has(current)) return id
    seen.add(current)
    const row = db.select({
      id: sessions.id,
      origin: sessions.origin,
      parentSession: sessions.parentSession,
    }).from(sessions).where(eq(sessions.id, current)).get()
    if (row === undefined) return id
    if (row.origin !== 'subagent' || row.parentSession === null) return row.id
    current = row.parentSession
  }
}

export function admitRows(db: Db, rows: readonly AdmissionRow[]): void {
  const state = { changed: false }
  db.transaction(() => {
    for (const row of rows) {
      const existing = db.select({
        title: sessions.title,
        cwd: sessions.cwd,
        parentSession: sessions.parentSession,
        origin: sessions.origin,
        blank: sessions.blank,
        lastPromptAt: sessions.lastPromptAt,
        updatedAt: sessions.updatedAt,
        archived: sessions.archived,
        workspaceTitle: sessions.workspaceTitle,
        running: sessions.running,
        lastUser: sessions.lastUser,
        familyRoot: sessions.familyRoot,
      }).from(sessions).where(eq(sessions.id, row.id)).get()
      if (existing === undefined
        || existing.title !== row.title
        || existing.cwd !== row.cwd
        || existing.parentSession !== row.parentSession
        || existing.origin !== row.origin
        || existing.blank !== row.blank
        || existing.lastPromptAt !== row.lastPromptAt
        || existing.updatedAt !== row.updatedAt
        || existing.archived !== row.archived
        || existing.workspaceTitle !== row.workspaceTitle
        || existing.running !== row.running) {
        state.changed = true
      }
      db.insert(sessions).values({
        id: row.id,
        createdAt: row.createdAt,
        cwd: row.cwd,
        parentSession: row.parentSession,
        origin: row.origin,
        isSeeded: row.isSeeded,
        delegationDepth: row.delegationDepth,
        agentPreset: row.agentPreset,
        familyRoot: row.familyRoot,
        title: row.title,
        blank: row.blank,
        lastPromptAt: row.lastPromptAt,
        updatedAt: row.updatedAt,
        archived: row.archived,
        workspaceTitle: row.workspaceTitle,
        running: row.running,
        searchText: searchTextOf(row.title, row.cwd, existing?.lastUser),
        foldStatus: 'pending',
      }).onConflictDoUpdate({
        target: sessions.id,
        set: {
          cwd: row.cwd,
          parentSession: row.parentSession,
          origin: row.origin,
          title: row.title,
          blank: row.blank,
          lastPromptAt: row.lastPromptAt,
          updatedAt: row.updatedAt,
          archived: row.archived,
          workspaceTitle: row.workspaceTitle,
          running: row.running,
          searchText: searchTextOf(row.title, row.cwd, existing?.lastUser),
        },
      }).run()
    }
    for (const row of rows) {
      const resolved = familyRootOf(db, row.id)
      const before = db.select({ familyRoot: sessions.familyRoot }).from(sessions).where(eq(sessions.id, row.id)).get()
      if (before?.familyRoot === resolved) continue
      state.changed = true
      db.update(sessions).set({ familyRoot: resolved })
        .where(eq(sessions.id, row.id)).run()
    }
  }, { behavior: 'immediate' })
  if (state.changed) bumpGeneration(db)
}

export function clearTombstones(db: Db, ids: readonly string[]): void {
  let changed = 0
  for (const id of ids) changed += Number(db.delete(sessionTombstones).where(eq(sessionTombstones.id, id)).run().changes)
  if (changed > 0) bumpGeneration(db)
}

export interface StatusCounts {
  total: number
  covered: number
  remaining: number
  failed: number
  unsupported: number
  folding: number
  deleting: number
  pending: number
}

export function statusCounts(db: Db): StatusCounts {
  const rows = db.select({ status: sessions.foldStatus }).from(sessions).all()
  const counts: StatusCounts = {
    total: rows.length,
    covered: 0,
    remaining: 0,
    failed: 0,
    unsupported: 0,
    folding: 0,
    deleting: 0,
    pending: 0,
  }
  for (const row of rows) {
    const status: FoldStatus = row.status
    if (status === 'ok') counts.covered++
    else if (status === 'failed') counts.failed++
    else if (status === 'unsupported') counts.unsupported++
    else if (status === 'folding') counts.folding++
    else if (status === 'deleting') counts.deleting++
    else counts.pending++
  }
  counts.remaining = counts.total - counts.covered - counts.unsupported
  return counts
}
