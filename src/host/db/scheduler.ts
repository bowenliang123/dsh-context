import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { FoldBounds } from '../config'
import { createTimelineState } from '../foldState'
import type { TimelineState } from '../foldState'
import { asRecord } from '../record'
import { admissionRows, admitRows, clearTombstones, familyRootOf, statusCounts, type ScanEntry } from './admission'
import { bumpGeneration, type Db } from './db'
import { applyFoldEvents, deleteSessionChildRows, decodeStateJson, markFoldStatus, writeSessionFold } from './foldSession'
import type { LiveWriter } from './live'
import { RowsSink, writeBatch } from './rows'
import { foldState, sessions, sessionTombstones } from './schema'
import { eq, sql } from 'drizzle-orm'

const TAIL_CONCURRENCY = 6

const SLICE_EVENTS = 2_000

const WORK_BUDGET_MS = 8_000

const ROUND_PAUSE_MS = 2_000

const MIN_REST_MS = 25

const INTERACTIVE_QUIET_MS = 500

const REAPER_INTERVAL_MS = 45_000

const REAPER_GRACE_MS = 60_000

const REAPER_MISSES = 2

const TOMBSTONE_TTL_MS = 7 * 86_400_000

export interface Coverage {
  complete: boolean
  remaining: number
  failed: number
  running: boolean
  total: number
  covered: number
  unsupported: number
  folding: number
  deleting: number
}

export interface ReaperStats {
  running: boolean
  lastRunAt: number
  candidates: number
  deletedSessions: number
  deletedChildRows: number
  failed: number
  tombstones: number
}

export interface SchedulerOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  yieldTo?: () => Promise<void>
  live: LiveWriter
  pluginOf?: (name: string) => string | undefined
  onGeneration?: () => void
  onInteractive?: () => boolean
  hydrationDelayMs?: number
  idleDelayMs?: number
  reaperIntervalMs?: number
}

interface SessionQueryFace {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

interface PersistenceFace {
  stat?(id: string): Promise<unknown>
  open?(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<HandleFace>
}

interface HandleFace {
  header: SessionHeader
  inheritedEventCount?: unknown
  read(offset: number, limit?: number, options?: { signal?: AbortSignal }): Promise<unknown>
  close(): Promise<void>
}

function headerOf(record: unknown): Record<string, unknown> | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null || typeof header.id !== 'string' || header.id === '') return null
  return header
}

function isEvent(value: unknown): value is SessionEvent {
  return value !== null && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

function eventsOf(value: unknown): SessionEvent[] {
  const raw = asRecord(value)?.events
  return Array.isArray(raw) ? raw.filter(isEvent) : []
}

function identityOf(stat: unknown): { path?: string; size?: number; mtime?: number; revision?: string } {
  const data = asRecord(stat)
  if (data === null) return {}
  const location = asRecord(data.location)
  const path = typeof location?.path === 'string' ? location.path : undefined
  const size = typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined
  const revision = typeof data.revision === 'string' ? data.revision : undefined
  const pathMtime = typeof location?.mtimeMs === 'number' ? location.mtimeMs : undefined
  return {
    ...(path === undefined ? {} : { path }),
    ...(size === undefined ? {} : { size }),
    ...(pathMtime === undefined ? {} : { mtime: pathMtime }),
    ...(revision === undefined ? {} : { revision }),
  }
}

function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

function isUnsupported(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith('SessionFormatUnsupported')
  } catch {
    return false
  }
}

export class BackfillScheduler {
  private running = false
  private requested = false
  private disposed = false
  private readonly abort = new AbortController()
  private hydrationTimer: ReturnType<typeof setTimeout> | null = null
  private reaperTimer: ReturnType<typeof setTimeout> | null = null
  private firstRoute = false
  private phase: 'open' | 'hydrating' | 'ready' | 'degraded' | 'rebuilding' = 'open'
  private hydrating = false
  private degraded = false
  private integrity: 'pending' | 'ok' | 'failed' = 'pending'
  private lastInteractiveAt = 0
  private lastScanAt = 0
  private workMs = 0
  private readonly misses = new Map<string, { since: number; rounds: number }>()
  private readonly reaper: ReaperStats = {
    running: false, lastRunAt: 0, candidates: 0, deletedSessions: 0, deletedChildRows: 0, failed: 0, tombstones: 0,
  }
  private tailChecked = false
  private readonly dirty = new Set<string>()
  private readonly warmedLive = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly db: Db,
    private readonly bounds: FoldBounds,
    private readonly options: SchedulerOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms))
  }

  private yieldTo(): Promise<void> {
    return this.options.yieldTo?.() ?? new Promise(resolve => setTimeout(resolve, 0))
  }

  startupPhase(): 'open' | 'hydrating' | 'ready' | 'degraded' | 'rebuilding' {
    return this.phase
  }

  isHydrating(): boolean {
    return this.hydrating
  }

  integrityState(): 'pending' | 'ok' | 'failed' {
    return this.integrity
  }

  setIntegrity(state: 'ok' | 'failed'): void {
    this.integrity = state
  }

  setDegraded(): void {
    this.degraded = true
    this.phase = 'degraded'
  }

  setPhase(phase: 'open' | 'hydrating' | 'ready' | 'degraded' | 'rebuilding'): void {
    this.phase = phase
  }

  noteRoute(): void {
    const now = this.now()
    this.lastInteractiveAt = now
    if (!this.firstRoute) {
      this.firstRoute = true
      this.scheduleHydration(this.options.hydrationDelayMs ?? 1_500)
    }
    if (now - this.lastScanAt >= 5_000 && !this.running) {
      this.lastScanAt = now
      const timer = setTimeout(() => {
        if (!this.disposed) this.request()
      }, 0)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  noteInteractive(): void {
    this.lastInteractiveAt = this.now()
  }

  scheduleHydration(delayMs: number): void {
    if (this.hydrationTimer !== null || this.disposed) return
    this.hydrationTimer = setTimeout(() => {
      this.hydrationTimer = null
      this.request()
      this.scheduleReaper()
    }, delayMs)
    ;(this.hydrationTimer as { unref?: () => void }).unref?.()
  }

  start(): void {
    this.scheduleHydration(this.options.idleDelayMs ?? 5_000)
  }

  request(): void {
    if (this.running) {
      this.requested = true
      return
    }
    if (this.disposed || this.degraded) return
    this.requested = false
    this.running = true
    this.hydrating = true
    this.phase = 'hydrating'
    void this.runPass().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-context: storage backfill stopped (${messageOf(error)})`)
    }).finally(() => {
      this.running = false
      this.hydrating = false
      if (!this.disposed && !this.degraded && this.integrity !== 'failed') this.phase = 'ready'
      if (this.requested) {
        this.requested = false
        this.request()
      }
    })
  }

  coverage(): Coverage {
    const counts = statusCounts(this.db)
    const complete = counts.remaining === 0 && counts.failed === 0
    return {
      complete,
      remaining: counts.remaining,
      failed: counts.failed,
      running: this.running,
      total: counts.total,
      covered: counts.covered,
      unsupported: counts.unsupported,
      folding: counts.folding,
      deleting: counts.deleting,
    }
  }

  reaperStats(): ReaperStats {
    return { ...this.reaper }
  }

  runOnce(): Promise<void> {
    return this.runPass()
  }

  reapOnce(): Promise<void> {
    return this.runReaper()
  }

  private scheduleReaper(): void {
    if (this.reaperTimer !== null || this.disposed) return
    this.reaperTimer = setTimeout(() => {
      this.reaperTimer = null
      void this.runReaper()
      this.scheduleReaper()
    }, this.options.reaperIntervalMs ?? REAPER_INTERVAL_MS)
    ;(this.reaperTimer as { unref?: () => void }).unref?.()
  }

  private async listEntries(signal: AbortSignal): Promise<ScanEntry[] | null> {
    const query = this.ctx.get('sessionQuery') as SessionQueryFace | undefined
    if (query === undefined || typeof query.listSessions !== 'function') return null
    let listed: unknown
    try {
      listed = await query.listSessions(signal)
    } catch {
      return null
    }
    if (!Array.isArray(listed)) return null
    const sessionsFace = this.ctx.get('sessions') as { get?(id: string): unknown } | undefined
    const entries: ScanEntry[] = []
    for (const record of listed) {
      const header = headerOf(record)
      if (header === null) continue
      const data = asRecord(record)
      const live = data?.live === true
      const cwd = typeof header.cwd === 'string'
      if (!live && !cwd) continue
      let session: unknown
      try {
        session = sessionsFace?.get?.(header.id as string)
      } catch {}
      entries.push({ id: header.id as string, header, live, ...(session === undefined ? {} : { session }) })
    }
    return entries
  }

  private persistence(): PersistenceFace | undefined {
    const persistence = asRecord(this.ctx.get('sessionPersistence'))
    return (persistence ?? undefined)
  }

  private async readLog(id: string, offset: number): Promise<{ events: SessionEvent[]; header?: SessionHeader }> {
    const persistence = this.persistence()
    if (persistence === undefined || typeof persistence.open !== 'function') return { events: [] }
    const handle = await persistence.open(id, 'read', { signal: this.abort.signal })
    try {
      const events = eventsOf(await handle.read(offset, undefined, { signal: this.abort.signal }))
      return { events, header: handle.header }
    } finally {
      try {
        await handle.close()
      } catch {}
    }
  }

  private aborted(): boolean {
    return this.abort.signal.aborted
  }

  private async verifyTails(): Promise<void> {
    if (this.tailChecked) return
    const persistence = this.persistence()
    if (persistence === undefined || typeof persistence.open !== 'function') return
    this.tailChecked = true
    const rows = this.db.select({ id: sessions.id, lastSeq: sessions.lastSeq }).from(sessions)
      .where(sql`${sessions.lastSeq} >= 0`).all()
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.aborted()) return
        if (cursor >= rows.length) return
        const row = rows[cursor++]
        if (this.options.live.isLive(row.id)) continue
        let log: Awaited<ReturnType<BackfillScheduler['readLog']>>
        try {
          log = await this.readLog(row.id, row.lastSeq)
        } catch {
          continue
        }
        if (this.aborted()) return
        if (log.events.length > 0 && log.events[0].seq === row.lastSeq) continue
        deleteSessionChildRows(this.db, row.id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(TAIL_CONCURRENCY, rows.length) }, worker))
  }

  private async refreshIdentities(entries: readonly ScanEntry[]): Promise<void> {
    const persistence = this.persistence()
    if (persistence === undefined || typeof persistence.stat !== 'function') return
    const statOf = (id: string): unknown => persistence.stat?.(id)
    const cold = entries.filter(entry => !entry.live).slice()
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (cursor >= cold.length) return
        const entry = cold[cursor++]
        const row = this.db.select({
          revision: sessions.logRevision,
          path: sessions.logPath,
          size: sessions.logSize,
          mtime: sessions.logMtime,
          status: sessions.foldStatus,
          lastSeq: sessions.lastSeq,
        }).from(sessions).where(eq(sessions.id, entry.id)).get()
        if (row === undefined || row.status !== 'ok' || row.lastSeq < 0) continue
        let stat: unknown
        try {
          stat = await statOf(entry.id)
        } catch {
          continue
        }
        if (stat === undefined) continue
        const identity = identityOf(stat)
        const changed = identity.revision !== undefined
          ? row.revision !== identity.revision
          : (identity.path !== undefined && row.path !== identity.path)
            || (identity.size !== undefined && row.size !== identity.size)
            || (identity.mtime !== undefined && row.mtime !== identity.mtime)
        if (changed) this.dirty.add(entry.id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, cold.length) }, worker))
  }

  private async runPass(): Promise<void> {
    const entries = await this.listEntries(this.abort.signal)
    if (entries === null) return
    const rows = admissionRows(this.ctx, entries)
    admitRows(this.db, rows)
    clearTombstones(this.db, entries.map(entry => entry.id))
    await this.refreshIdentities(entries)
    await this.verifyTails()
    for (const entry of entries) {
      if (!entry.live || this.warmedLive.has(entry.id)) continue
      if (this.db.select({ sessionId: foldState.sessionId }).from(foldState)
        .where(eq(foldState.sessionId, entry.id)).get() !== undefined) continue
      this.warmedLive.add(entry.id)
      await this.options.live.warm(entry.id, entry.header)
    }
    const liveIds = new Set(entries.filter(entry => entry.live).map(entry => entry.id))
    const queue = this.db.select({ id: sessions.id, status: sessions.foldStatus, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(sql`${sessions.foldStatus} in ('pending', 'failed', 'folding')`)
      .orderBy(sql`${sessions.updatedAt} desc`)
      .all()
    const queued = new Set(queue.map(row => row.id))
    for (const id of this.dirty) {
      if (queued.has(id)) continue
      const row = this.db.select({ updatedAt: sessions.updatedAt }).from(sessions).where(eq(sessions.id, id)).get()
      if (row !== undefined) queue.push({ id, status: 'ok', updatedAt: row.updatedAt })
    }
    queue.sort((left, right) => right.updatedAt - left.updatedAt)
    this.workMs = 0
    for (const row of queue) {
      if (this.abort.signal.aborted) return
      if (liveIds.has(row.id) || this.options.live.isLive(row.id)) continue
      await this.foldOne(row.id)
      this.dirty.delete(row.id)
      await this.rest()
    }
    this.reaper.candidates = this.misses.size
    this.reaper.tombstones = this.db.select({ id: sessionTombstones.id }).from(sessionTombstones).all().length
  }

  private async rest(): Promise<void> {
    const interactive = this.options.onInteractive?.() === true
    if (interactive || this.now() - this.lastInteractiveAt < INTERACTIVE_QUIET_MS) {
      await this.sleep(50)
    }
    if (this.workMs >= WORK_BUDGET_MS) {
      this.workMs = 0
      this.ctx.logger.info(`dsh-context: storage backfill pausing after ${Math.round(WORK_BUDGET_MS / 1000)}s; resuming shortly`)
      await this.sleep(ROUND_PAUSE_MS)
      return
    }
    await this.sleep(MIN_REST_MS)
  }

  private async foldOne(id: string): Promise<void> {
    if (this.db.select({ id: sessionTombstones.id }).from(sessionTombstones).where(eq(sessionTombstones.id, id)).get() !== undefined) {
      markFoldStatus(this.db, id, 'pending')
      return
    }
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (row === undefined) return
    const persistence = this.persistence()
    const started = this.now()
    try {
      let stat: unknown
      if (typeof persistence?.stat === 'function') {
        try {
          stat = await persistence.stat(id)
        } catch {}
      }
      if (stat === undefined && row.logPath !== null) {
        const { statSync } = await import('node:fs')
        try {
          const info = statSync(row.logPath)
          stat = { location: { path: row.logPath }, sizeBytes: info.size, mtimeMs: info.mtimeMs }
        } catch {
          markFoldStatus(this.db, id, 'pending')
          return
        }
      }
      const identity = identityOf(stat)
      const incremental = row.foldStatus === 'ok'
        && row.lastSeq >= -1
        && this.db.select({ lastSeq: foldState.lastSeq }).from(foldState).where(eq(foldState.sessionId, id)).get() !== undefined
        && (row.logRevision === null || identity.revision === undefined || row.logRevision === identity.revision)
        && (row.logRevision !== null || row.logPath === null || identity.path === undefined || row.logPath === identity.path)
      let base: TimelineState | undefined
      let offset = 0
      if (incremental) {
        const stored = this.db.select({ lastSeq: foldState.lastSeq, stateJson: foldState.stateJson })
          .from(foldState).where(eq(foldState.sessionId, id)).get() as { lastSeq: number; stateJson: string }
        const decoded = decodeStateJson(stored.stateJson)
        if (decoded !== null) {
          base = decoded
          offset = stored.lastSeq + 1
        }
      }
      const log = await this.readLog(id, offset)
      if (base !== undefined && offset > 0 && log.events.length > 0) {
        const first = log.events[0].seq
        if (first > offset) base = undefined
      }
      const state = base ?? createTimelineState()
      state.isSeeded = row.isSeeded === 1
      if (base === undefined) deleteSessionChildRows(this.db, id)
      const sink = new RowsSink(id, this.options.pluginOf, state.nextSpanSeq)
      let lastSeq = offset - 1
      let working = state
      for (let start = 0; start < log.events.length; start += SLICE_EVENTS) {
        if (this.abort.signal.aborted) return
        const slice = log.events.slice(start, start + SLICE_EVENTS) as unknown as import('../foldState').TimelineEvent[]
        const folded = applyFoldEvents(this.db, id, working, slice, this.bounds, sink)
        working = folded.state
        lastSeq = Math.max(lastSeq, folded.lastSeq)
        if (start + SLICE_EVENTS < log.events.length) await this.yieldTo()
      }
      if (sink.drainSize() > 0) writeBatch(this.db, sink.take(), id)
      writeSessionFold(this.db, {
        sessionId: id,
        title: row.title,
        cwd: row.cwd,
        isSeeded: row.isSeeded === 1,
        pluginOf: this.options.pluginOf,
        now: this.options.now,
      }, working, lastSeq, 'ok')
      this.db.update(sessions).set({
        logPath: identity.path ?? row.logPath,
        logSize: identity.size ?? row.logSize,
        logMtime: identity.mtime ?? row.logMtime,
        logRevision: identity.revision ?? row.logRevision,
      }).where(eq(sessions.id, id)).run()
      this.workMs += this.now() - started
      bumpGeneration(this.db)
      this.options.onGeneration?.()
    } catch (error: unknown) {
      if (this.abort.signal.aborted) return
      if (isUnsupported(error)) {
        markFoldStatus(this.db, id, 'unsupported', messageOf(error))
      } else {
        markFoldStatus(this.db, id, 'failed', messageOf(error))
      }
      this.ctx.logger.warn(`dsh-context: storage fold for "${id}" failed: ${messageOf(error)}`)
    }
  }

  private async runReaper(): Promise<void> {
    if (this.disposed || this.running) return
    const entries = await this.listEntries(this.abort.signal)
    if (entries === null) return
    const persistence = this.persistence()
    if (persistence === undefined || typeof persistence.stat !== 'function') return
    const listed = new Set(entries.map(entry => entry.id))
    const live = new Set(entries.filter(entry => entry.live).map(entry => entry.id))
    const rows = this.db.select({ id: sessions.id, status: sessions.foldStatus, logPath: sessions.logPath, foldedAt: sessions.foldedAt })
      .from(sessions).all()
    const now = this.now()
    const candidates: string[] = []
    for (const row of rows) {
      if (listed.has(row.id) || live.has(row.id) || this.options.live.isLive(row.id)) {
        this.misses.delete(row.id)
        continue
      }
      if (row.status === 'folding') continue
      if (row.status === 'deleting') {
        candidates.push(row.id)
        continue
      }
      if (now - row.foldedAt < REAPER_GRACE_MS) continue
      const miss = this.misses.get(row.id)
      if (miss === undefined) {
        this.misses.set(row.id, { since: now, rounds: 1 })
        continue
      }
      miss.rounds++
      if (miss.rounds < REAPER_MISSES || now - miss.since < REAPER_GRACE_MS) continue
      let stat: unknown
      try {
        stat = await persistence.stat(row.id)
      } catch {
        continue
      }
      if (stat !== undefined) continue
      if (row.logPath !== null) {
        const { existsSync } = await import('node:fs')
        if (existsSync(row.logPath)) continue
      } else if (now - miss.since < 86_400_000) {
        continue
      }
      candidates.push(row.id)
    }
    this.reaper.running = true
    this.reaper.candidates = candidates.length
    try {
      for (const id of candidates) {
        if (this.abort.signal.aborted) return
        this.reaper.deletedSessions += this.deleteSession(id, now)
        this.misses.delete(id)
      }
      this.reaper.lastRunAt = now
      this.reaper.tombstones = this.db.select({ id: sessionTombstones.id }).from(sessionTombstones).all().length
      const expiry = now - TOMBSTONE_TTL_MS
      const expired = Number(this.db.delete(sessionTombstones).where(sql`${sessionTombstones.deletedAt} < ${expiry}`).run().changes)
      if (expired > 0) bumpGeneration(this.db)
    } catch (error: unknown) {
      this.reaper.failed++
      this.ctx.logger.warn(`dsh-context: reaper failed: ${messageOf(error)}`)
    } finally {
      this.reaper.running = false
    }
  }

  private deleteSession(id: string, now: number): number {
    this.db.insert(sessionTombstones).values({ id, deletedAt: now, reason: 'missing-from-list' }).onConflictDoNothing().run()
    this.db.update(sessions).set({ foldStatus: 'deleting' }).where(eq(sessions.id, id)).run()
    const tables = [
      ['header_tools', 'epoch_seq'], ['header_epochs', 'seq'], ['timing_spans', 'span_seq'],
      ['skill_loads', 'seq'], ['file_ops', 'seq'], ['events', 'seq'], ['system_prompts', 'seq'],
      ['surface_nodes', 'seq'], ['tool_calls', 'seq'], ['steps', 'seq'], ['requests', 'seq'],
    ] as const
    let deleted = 0
    for (const [table, key] of tables) {
      for (;;) {
        const result = this.db.run(sql`delete from ${sql.identifier(table)} where ${sql.identifier('session_id')} = ${id}
          and ${sql.identifier(key)} in (
            select ${sql.identifier(key)} from ${sql.identifier(table)} where ${sql.identifier('session_id')} = ${id} limit 2000
          )`)
        const changes = Number(result.changes)
        deleted += changes
        if (changes < 2_000) break
      }
    }
    this.db.delete(foldState).where(eq(foldState.sessionId, id)).run()
    this.db.delete(sessions).where(eq(sessions.id, id)).run()
    this.rerootFamilies()
    this.reaper.deletedChildRows += deleted
    bumpGeneration(this.db)
    return deleted + 1
  }

  private rerootFamilies(): void {
    const rows = this.db.select({ id: sessions.id, familyRoot: sessions.familyRoot }).from(sessions).all()
    for (const row of rows) {
      const root = familyRootOf(this.db, row.id)
      if (root !== row.familyRoot) {
        this.db.update(sessions).set({ familyRoot: root, detailRev: sql`${sessions.detailRev} + 1` }).where(eq(sessions.id, row.id)).run()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    if (this.hydrationTimer !== null) clearTimeout(this.hydrationTimer)
    if (this.reaperTimer !== null) clearTimeout(this.reaperTimer)
    this.hydrationTimer = null
    this.reaperTimer = null
  }
}
